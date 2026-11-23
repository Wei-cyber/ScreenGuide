import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import { resolveGuidanceDelivery, type GuidanceTrigger } from "../shared/guidancePolicy";
import { parseGuidance, redactSecrets } from "../shared/validation";
import type {
  CoachStatus,
  GuidanceStep,
  NormalizedRect,
  RealtimeConnectionState,
  TranscriptEntry,
} from "../shared/types";

const MODEL = "gpt-realtime-2.1";
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;

export interface ScreenObservation {
  overviewDataUrl: string;
  detailDataUrl?: string;
  changedRegion?: NormalizedRect;
}

interface RealtimeClientEvents {
  connection: [RealtimeConnectionState];
  transcript: [TranscriptEntry];
  audio: [string];
  guidance: [GuidanceStep];
  status: [CoachStatus];
  endSession: [string];
  error: [string];
}

interface RealtimeServerEvent {
  type?: string;
  delta?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { message?: unknown };
  item?: {
    type?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
  };
}

const DISPLAY_GUIDANCE_TOOL = {
  type: "function",
  name: "display_guidance",
  description: "Display exactly one safe, user-performed coaching step. Use normalized coordinates only when the target is clearly visible.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      stepId: { type: "string" },
      instruction: { type: "string" },
      explanation: { type: "string" },
      target: {
        type: "object",
        additionalProperties: false,
        properties: {
          x: { type: "number", minimum: 0, maximum: 1 },
          y: { type: "number", minimum: 0, maximum: 1 },
          width: { type: "number", exclusiveMinimum: 0, maximum: 1 },
          height: { type: "number", exclusiveMinimum: 0, maximum: 1 },
        },
        required: ["x", "y", "width", "height"],
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      status: { type: "string", enum: ["waiting", "completed", "blocked"] },
      delivery: {
        type: "string",
        enum: ["silent", "visual", "spoken"],
        description: "silent for routine observation, visual for expected progress, spoken only for a new action, blocker, uncertainty, direct answer, or completion.",
      },
    },
    required: ["stepId", "instruction", "explanation", "confidence", "status", "delivery"],
  },
} as const;

const END_SESSION_TOOL = {
  type: "function",
  name: "end_session",
  description: "End ScreenGuide only when the user explicitly asks to end, stop, close, or quit the coaching session, or clearly confirms a prior question asking whether to end. Never call this merely because the task is complete.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      reason: {
        type: "string",
        enum: ["user_requested"],
      },
    },
    required: ["reason"],
  },
} as const;

function systemPrompt(goal: string): string {
  return `You are ScreenGuide, a calm Windows screen coach. The user's goal is: ${goal}

Teach one small step at a time and call display_guidance once for each new screen or user evaluation. Reuse the same stepId until the user's required action genuinely changes. After receiving its function result, do not call it again for that evaluation; if delivery was spoken, briefly say the approved guidance aloud. Never narrate every screenshot or describe routine visual changes aloud. Use delivery silent when the required action has not changed or a change is irrelevant. Use delivery visual for a brief confirmation that expected progress occurred; keep the same stepId and do not introduce the next instruction. Use delivery spoken only for the first instruction, a genuinely new user action, a blocker or uncertainty, a direct user question, or goal completion. Never repeat an instruction merely because another frame arrived. Wait for visible progress or the user before advancing.

Never click, type, submit, purchase, delete, change security settings, or claim you acted. The human performs every action. If the screen is unclear or sensitive, ask the user to clarify without guessing. Do not request passwords, payment data, authentication codes, private keys, or other secrets.

When the goal is visibly complete, call display_guidance with status completed and delivery spoken, tell the user it appears complete, and ask whether they want to end the coaching session. Goal completion does NOT end the session by itself. Call end_session only when the user explicitly asks to end/stop/close/quit ScreenGuide, or clearly answers yes to your direct question about ending it. If intent is ambiguous, ask. A request to pause, stop talking, stop an application action, or revise the task is not a request to end ScreenGuide.

Coordinates are always normalized to the FULL OVERVIEW image: x and y are top-left, width and height are size. A second image may be a high-resolution detail crop; use it to read small controls, but convert any location back into the full-overview coordinate system described with that crop. Omit target unless the element is clearly visible. Keep spoken replies concise and instructional.`;
}

function decodeEvent(data: RawData): RealtimeServerEvent | null {
  try {
    return JSON.parse(data.toString()) as RealtimeServerEvent;
  } catch {
    return null;
  }
}

/** High-confidence local fallback; nuanced or contextual requests go to the model. */
export function isExplicitSessionEndRequest(text: string): boolean {
  const normalized = text
    .toLocaleLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  if (/\b(don't|do not|never|not)\s+(end|stop|close|quit|terminate|exit)\b/.test(normalized)) return false;

  return (
    /\b(end|stop|close|quit|terminate|exit)\s+(this\s+|the\s+)?(session|coaching session|coaching|screenguide|screen guide)\b/.test(normalized)
    || /\b(i want|i'd like|i would like|please|can you|could you)\s+(to\s+)?(end|stop|close|quit|terminate)\s+(this\s+|the\s+)?(session|coaching session|coaching|screenguide|screen guide)\b/.test(normalized)
    || /^(i want|i'd like|i would like|please|can you|could you)\s+(to\s+)?(end|stop|close|quit|terminate)(\s+(it|now|please))?$/.test(normalized)
    || /^(please\s+)?(end|stop|close|quit)(\s+(it|now|please))?$/.test(normalized)
  );
}

export class RealtimeClient extends EventEmitter<RealtimeClientEvents> {
  private socket?: WebSocket;
  private intentionalClose = false;
  private handledCalls = new Set<string>();
  private assistantText = "";
  private pendingGoal?: string;
  private connectResolve?: () => void;
  private connectReject?: (error: Error) => void;
  private connectTimer?: NodeJS.Timeout;
  private lastServerError?: string;
  private responseInProgress = false;
  private pendingFrames: ScreenObservation[] = [];
  private pendingUserText: string[] = [];
  private continuationPending = false;
  private paused = false;
  private activeResponseTrigger?: GuidanceTrigger;
  private lastGuidance?: GuidanceStep;
  private lastSpokenAt?: number;
  private status: CoachStatus = "wait";
  private endRequested = false;

  async connect(apiKey: string, goal: string): Promise<void> {
    this.intentionalClose = false;
    this.pendingGoal = goal;
    this.lastServerError = undefined;
    this.paused = false;
    this.endRequested = false;
    this.resetResponseQueue();
    this.lastGuidance = undefined;
    this.lastSpokenAt = undefined;
    this.setStatus("wait");
    this.emit("connection", "connecting");

    await new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimer = setTimeout(() => {
        this.rejectConnection("OpenAI did not finish creating the Realtime session.");
        this.socket?.close();
      }, 15_000);

      const socket = new WebSocket(REALTIME_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      this.socket = socket;
      const fail = (error: Error) => {
        this.emit("connection", "failed");
        this.rejectConnection(this.safeError(error.message));
      };
      socket.once("error", fail);
      socket.once("open", () => {
        socket.off("error", fail);
        socket.on("error", (error) => this.emit("error", this.safeError(error.message)));
        socket.on("message", (data) => this.handleEvent(decodeEvent(data)));
        socket.on("close", (code, reason) => {
          this.emit("connection", this.intentionalClose ? "disconnected" : "failed");
          if (!this.intentionalClose) {
            const reasonText = reason.toString().trim();
            const message = this.lastServerError ?? (reasonText || `Realtime connection closed (${code}).`);
            this.rejectConnection(message);
            this.emit("error", message);
          }
        });
      });
    });
  }

  sendFrame(observation: ScreenObservation): void {
    if (!this.isOpen() || this.paused || this.endRequested) return;
    this.setStatus("wait");
    if (this.responseInProgress) {
      if (this.pendingFrames.length < 2) this.pendingFrames.push(observation);
      else this.pendingFrames[1] = observation;
      return;
    }
    this.sendFrameNow(observation);
  }

  sendAudio(base64Pcm16: string): void {
    if (!this.isOpen() || this.paused || this.endRequested || !base64Pcm16) return;
    this.send({ type: "input_audio_buffer.append", audio: base64Pcm16 });
  }

  sendUserText(text: string): void {
    const safe = text.trim().slice(0, 2_000);
    if (!this.isOpen() || this.paused || this.endRequested || !safe) return;
    this.emitTranscript("user", safe);
    if (isExplicitSessionEndRequest(safe)) {
      this.requestSessionEnd("The user explicitly asked to end the session.");
      return;
    }
    this.setStatus("wait");
    if (this.responseInProgress) {
      this.pendingUserText.push(safe);
      this.pendingUserText = this.pendingUserText.slice(-3);
      return;
    }
    this.sendUserTextNow(safe);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.setStatus("wait");
      this.pendingFrames = [];
      this.pendingUserText = [];
      this.continuationPending = false;
    } else if (!this.responseInProgress) {
      this.setStatus("ready");
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearConnectionWait();
    this.socket?.close();
    this.socket = undefined;
    this.handledCalls.clear();
    this.assistantText = "";
    this.paused = false;
    this.endRequested = false;
    this.resetResponseQueue();
    this.lastGuidance = undefined;
    this.lastSpokenAt = undefined;
    this.setStatus("wait");
  }

  private sendFrameNow(observation: ScreenObservation): void {
    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: "Latest full-screen overview. Continue only if the screen meaningfully changed." },
      { type: "input_image", image_url: observation.overviewDataUrl, detail: "high" },
    ];
    if (observation.detailDataUrl && observation.changedRegion) {
      content.push({
        type: "input_text",
        text: `High-resolution crop of the changed region. In the full overview it occupies ${JSON.stringify(observation.changedRegion)}. Read details from this crop, but return display_guidance coordinates in the full-overview coordinate system.`,
      });
      content.push({ type: "input_image", image_url: observation.detailDataUrl, detail: "high" });
    }
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content },
    });
    this.requestResponse("observation", ["text"]);
  }

  private sendUserTextNow(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.requestResponse("user");
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private send(event: Record<string, unknown>): void {
    if (this.isOpen()) this.socket?.send(JSON.stringify(event));
  }

  private handleEvent(event: RealtimeServerEvent | null): void {
    if (!event || typeof event.type !== "string") return;
    const type = event.type;
    if (type === "session.created") {
      const goal = this.pendingGoal;
      if (!goal) return;
      this.send({
        type: "session.update",
        session: {
          type: "realtime",
          model: MODEL,
          instructions: systemPrompt(goal),
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: { model: "gpt-realtime-whisper", language: "en" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 650,
                create_response: true,
              },
            },
            output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "marin" },
          },
          tools: [DISPLAY_GUIDANCE_TOOL, END_SESSION_TOOL],
          tool_choice: "auto",
        },
      });
      return;
    }
    if (type === "session.updated") {
      this.pendingGoal = undefined;
      this.clearConnectionWait();
      const resolve = this.connectResolve;
      this.connectResolve = undefined;
      this.connectReject = undefined;
      this.emit("connection", "connected");
      this.setStatus("ready");
      resolve?.();
      return;
    }
    if (type === "error") {
      const message = this.safeError(String(event.error?.message ?? "OpenAI returned an unknown error."));
      this.lastServerError = message;
      this.setStatus("wait");
      this.rejectConnection(message);
      this.emit("error", message);
      return;
    }
    if (type === "response.created") {
      this.responseInProgress = true;
      this.activeResponseTrigger ??= "user";
      this.setStatus("wait");
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      this.activeResponseTrigger = "user";
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      this.setStatus("wait");
      return;
    }
    if (type === "response.done") {
      this.responseInProgress = false;
      this.activeResponseTrigger = undefined;
      this.flushResponseQueue();
      return;
    }
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      if (typeof event.delta === "string") this.emit("audio", event.delta);
      return;
    }
    if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
      if (typeof event.delta === "string") this.assistantText += event.delta;
      return;
    }
    if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
      const text = String(event.transcript ?? this.assistantText).trim();
      this.assistantText = "";
      if (text) this.emitTranscript("assistant", text);
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const text = String(event.transcript ?? "").trim();
      if (text) {
        this.emitTranscript("user", text);
        if (isExplicitSessionEndRequest(text)) this.requestSessionEnd("The user explicitly asked to end the session.");
      }
      return;
    }
    if (type === "response.function_call_arguments.done") {
      this.handleToolCall(String(event.call_id ?? ""), String(event.name ?? ""), String(event.arguments ?? ""));
      return;
    }
    if (type === "response.output_item.done" && event.item?.type === "function_call") {
      this.handleToolCall(
        String(event.item.call_id ?? ""),
        String(event.item.name ?? ""),
        String(event.item.arguments ?? ""),
      );
    }
  }

  private handleToolCall(callId: string, name: string, argumentText: string): void {
    if (!callId || !["display_guidance", "end_session"].includes(name) || this.handledCalls.has(callId)) return;
    this.handledCalls.add(callId);
    if (name === "end_session") {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ ending: true }),
        },
      });
      this.requestSessionEnd("The user asked ScreenGuide to end the session.");
      return;
    }
    if (name !== "display_guidance") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentText);
    } catch {
      this.emit("error", "The coach returned malformed guidance. Waiting for the next observation.");
      return;
    }
    const parsedGuidance = parseGuidance(parsed);
    if (!parsedGuidance) {
      this.emit("error", "The coach returned invalid guidance. Waiting for the next observation.");
      return;
    }
    const delivery = resolveGuidanceDelivery(parsedGuidance, {
      previous: this.lastGuidance,
      trigger: this.activeResponseTrigger ?? "user",
      lastSpokenAt: this.lastSpokenAt,
    });
    const guidance: GuidanceStep = { ...parsedGuidance, delivery };
    this.lastGuidance = guidance;
    if (delivery !== "silent") this.emit("guidance", guidance);
    if (delivery === "spoken") this.lastSpokenAt = Date.now();
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({
          displayed: delivery !== "silent",
          targetShown: delivery !== "silent" && Boolean(guidance.target),
          delivery,
        }),
      },
    });
    this.continuationPending = delivery === "spoken";
  }

  private requestSessionEnd(reason: string): void {
    if (this.endRequested) return;
    this.endRequested = true;
    this.pendingFrames = [];
    this.pendingUserText = [];
    this.continuationPending = false;
    this.setStatus("wait");
    this.emit("endSession", reason);
  }

  private emitTranscript(role: TranscriptEntry["role"], text: string): void {
    this.emit("transcript", {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role,
      text,
      createdAt: Date.now(),
    });
  }

  private requestResponse(trigger: GuidanceTrigger, outputModalities?: Array<"text" | "audio">): boolean {
    if (!this.isOpen() || this.paused || this.endRequested || this.responseInProgress) return false;
    this.responseInProgress = true;
    this.setStatus("wait");
    this.activeResponseTrigger = trigger;
    this.send({
      type: "response.create",
      ...(outputModalities ? { response: { output_modalities: outputModalities } } : {}),
    });
    return true;
  }

  private flushResponseQueue(): void {
    if (this.endRequested) return;
    if (this.paused || !this.isOpen()) {
      this.resetResponseQueue();
      return;
    }
    if (this.continuationPending) {
      this.continuationPending = false;
      this.requestResponse("continuation");
      return;
    }
    const text = this.pendingUserText.shift();
    if (text) {
      this.sendUserTextNow(text);
      return;
    }
    const frame = this.pendingFrames.shift();
    if (frame) {
      this.sendFrameNow(frame);
      return;
    }
    this.setStatus("ready");
  }

  private resetResponseQueue(): void {
    this.responseInProgress = false;
    this.pendingFrames = [];
    this.pendingUserText = [];
    this.continuationPending = false;
    this.activeResponseTrigger = undefined;
  }

  private safeError(message: string): string {
    const redacted = redactSecrets(message);
    if (/401|api key|authentication/i.test(redacted)) return "The API key was rejected. Check it and try again.";
    if (/429|rate limit/i.test(redacted)) return "OpenAI rate limit reached. Pause briefly, then try again.";
    return redacted.slice(0, 300);
  }

  private rejectConnection(message: string): void {
    const reject = this.connectReject;
    if (!reject) return;
    this.clearConnectionWait();
    this.connectResolve = undefined;
    this.connectReject = undefined;
    reject(new Error(message));
  }

  private clearConnectionWait(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  private setStatus(next: CoachStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.emit("status", next);
  }
}
