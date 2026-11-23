import type { CoachStatus, GuidanceStep, TranscriptEntry } from "../../src/shared/types";
import { resolveGuidanceDelivery, type GuidanceTrigger } from "../../src/shared/guidancePolicy";
import { parseGuidance } from "../../src/shared/validation";
import type { ScreenObservation } from "./capture";

export type WebConnectionState = "disconnected" | "connecting" | "connected" | "failed";

export interface RealtimeCallbacks {
  onConnection: (state: WebConnectionState) => void;
  onCoachStatus: (status: CoachStatus) => void;
  onGuidance: (guidance: GuidanceStep | null) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onError: (message: string) => void;
}

interface ServerEvent {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  transcript?: string;
  error?: { message?: string };
  item?: { type?: string; name?: string; call_id?: string; arguments?: string };
}

export class RealtimeCoach {
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private microphone?: MediaStream;
  private paused = false;
  private responseMode: "guidance" | "voice" | undefined;
  private trigger: GuidanceTrigger = "observation";
  private pendingObservation?: ScreenObservation;
  private pendingText?: string;
  private pendingVoice?: GuidanceStep;
  private currentObservationItemId?: string;
  private previousGuidance?: GuidanceStep;
  private lastSpokenAt?: number;
  private handledCalls = new Set<string>();

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  async connect(endpoint: string, accessCode: string, goal: string, audio: HTMLAudioElement) {
    this.callbacks.onConnection("connecting");
    const peer = new RTCPeerConnection();
    this.peer = peer;
    peer.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(peer.connectionState) && !this.paused) {
        this.callbacks.onConnection("failed");
        this.callbacks.onError("The realtime connection closed. Start a new session to reconnect.");
      }
    };
    peer.ontrack = (event) => {
      audio.srcObject = event.streams[0];
      void audio.play().catch(() => undefined);
    };

    this.microphone = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    for (const track of this.microphone.getAudioTracks()) peer.addTrack(track, this.microphone);

    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.addEventListener("message", (message) => this.handleMessage(String(message.data)));
    channel.addEventListener("close", () => {
      if (!this.paused) this.callbacks.onConnection("failed");
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const headers: Record<string, string> = {
      "Content-Type": "application/sdp",
      "X-ScreenGuide-Goal": encodeURIComponent(goal),
    };
    if (accessCode.trim()) headers.Authorization = `Bearer ${accessCode.trim()}`;
    const response = await fetch(endpoint, { method: "POST", headers, body: offer.sdp });
    const answerSdp = await response.text();
    if (!response.ok) throw new Error(answerSdp || `Session setup failed (${response.status}).`);
    await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    await this.waitForChannel(channel);
    this.callbacks.onConnection("connected");
    this.setStatus("ready");
    this.flushPending();
  }

  sendObservation(observation: ScreenObservation) {
    if (this.paused) return;
    if (this.responseMode || this.channel?.readyState !== "open") {
      this.pendingObservation = observation;
      return;
    }
    this.responseMode = "guidance";
    this.trigger = "observation";
    this.setStatus("wait");
    const content: Array<Record<string, unknown>> = [
      {
        type: "input_text",
        text: observation.detailDataUrl && observation.detailRegion
          ? `New screen observation. The second image is a detail crop from normalized region ${JSON.stringify(observation.detailRegion)} of the first image.`
          : "New screen observation. Decide whether this materially changes the current coaching step.",
      },
      { type: "input_image", image_url: observation.overviewDataUrl, detail: "high" },
    ];
    if (observation.detailDataUrl) {
      content.push({ type: "input_image", image_url: observation.detailDataUrl, detail: "high" });
    }
    const itemId = `sg_frame_${crypto.randomUUID()}`;
    this.currentObservationItemId = itemId;
    this.send({
      type: "conversation.item.create",
      item: { id: itemId, type: "message", role: "user", content },
    });
    this.send({ type: "response.create", response: { output_modalities: ["text"] } });
  }

  sendUserText(text: string) {
    const trimmed = text.trim().slice(0, 500);
    if (!trimmed || this.paused) return;
    if (this.responseMode || this.channel?.readyState !== "open") {
      this.pendingText = trimmed;
      return;
    }
    this.callbacks.onTranscript(this.entry("user", trimmed));
    this.responseMode = "guidance";
    this.trigger = "user";
    this.setStatus("wait");
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: trimmed }] },
    });
    this.send({ type: "response.create", response: { output_modalities: ["text"] } });
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.updateMicrophone();
    if (paused) {
      if (this.responseMode) this.send({ type: "response.cancel" });
      this.callbacks.onCoachStatus("wait");
    } else if (!this.responseMode) {
      this.setStatus("ready");
      this.flushPending();
    }
  }

  close() {
    this.paused = true;
    for (const track of this.microphone?.getTracks() ?? []) track.stop();
    this.channel?.close();
    this.peer?.close();
    this.microphone = undefined;
    this.channel = undefined;
    this.peer = undefined;
    this.responseMode = undefined;
    this.pendingObservation = undefined;
    this.pendingText = undefined;
    this.callbacks.onConnection("disconnected");
  }

  private handleMessage(raw: string) {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    if (event.type === "error") {
      this.callbacks.onError(event.error?.message || "The realtime service reported an error.");
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      this.trigger = "user";
      this.responseMode = "guidance";
      this.setStatus("wait");
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript?.trim()) {
      this.callbacks.onTranscript(this.entry("user", event.transcript.trim()));
      return;
    }
    if (event.type === "response.function_call_arguments.done") {
      this.handleFunction(event.call_id, event.name, event.arguments);
      return;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      this.handleFunction(event.item.call_id, event.item.name, event.item.arguments);
      return;
    }
    if (event.type === "response.done") this.finishResponse();
  }

  private handleFunction(callId?: string, name?: string, rawArguments?: string) {
    if (!callId || name !== "display_guidance" || this.handledCalls.has(callId)) return;
    this.handledCalls.add(callId);
    let parsed: GuidanceStep | null = null;
    try {
      parsed = parseGuidance(JSON.parse(rawArguments || "{}"));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      this.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: false }) },
      });
      this.callbacks.onError("The coach returned an invalid guidance step; it was ignored.");
      return;
    }
    const delivery = resolveGuidanceDelivery(parsed, {
      previous: this.previousGuidance,
      trigger: this.trigger,
      lastSpokenAt: this.lastSpokenAt,
    });
    const guidance = { ...parsed, delivery };
    this.previousGuidance = guidance;
    if (delivery !== "silent") {
      this.callbacks.onGuidance(guidance);
      this.callbacks.onTranscript(this.entry("assistant", guidance.instruction));
    }
    if (delivery === "spoken") {
      this.pendingVoice = guidance;
      this.lastSpokenAt = Date.now();
    }
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ displayed: delivery !== "silent" }) },
    });
  }

  private finishResponse() {
    if (this.responseMode === "guidance" && this.currentObservationItemId) {
      this.send({ type: "conversation.item.delete", item_id: this.currentObservationItemId });
      this.currentObservationItemId = undefined;
    }
    if (this.paused) {
      this.pendingVoice = undefined;
      this.responseMode = undefined;
      return;
    }
    if (this.responseMode === "guidance" && this.pendingVoice) {
      const guidance = this.pendingVoice;
      this.pendingVoice = undefined;
      this.responseMode = "voice";
      const spoken = guidance.explanation
        ? `${guidance.instruction} ${guidance.explanation}`
        : guidance.instruction;
      this.send({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          tool_choice: "none",
          instructions: `Say this coaching message naturally and concisely, without adding anything: ${spoken}`,
        },
      });
      return;
    }
    this.responseMode = undefined;
    if (!this.paused) {
      this.setStatus("ready");
      window.setTimeout(() => this.flushPending(), 120);
    }
  }

  private flushPending() {
    if (this.paused || this.responseMode) return;
    if (this.pendingText) {
      const text = this.pendingText;
      this.pendingText = undefined;
      this.sendUserText(text);
      return;
    }
    if (this.pendingObservation) {
      const observation = this.pendingObservation;
      this.pendingObservation = undefined;
      this.sendObservation(observation);
    }
  }

  private setStatus(status: CoachStatus) {
    this.callbacks.onCoachStatus(status);
    this.updateMicrophone(status === "ready");
  }

  private updateMicrophone(enabled?: boolean) {
    const shouldEnable = enabled ?? (!this.paused && !this.responseMode);
    for (const track of this.microphone?.getAudioTracks() ?? []) track.enabled = shouldEnable;
  }

  private send(event: Record<string, unknown>) {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(event));
  }

  private entry(role: TranscriptEntry["role"], text: string): TranscriptEntry {
    return { id: crypto.randomUUID(), role, text, createdAt: Date.now() };
  }

  private waitForChannel(channel: RTCDataChannel) {
    if (channel.readyState === "open") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("The realtime channel timed out.")), 15_000);
      channel.addEventListener("open", () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
      channel.addEventListener("close", () => {
        window.clearTimeout(timeout);
        reject(new Error("The realtime channel closed during setup."));
      }, { once: true });
    });
  }
}
