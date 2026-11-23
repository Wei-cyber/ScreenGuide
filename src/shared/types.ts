export type SessionState =
  | "setup"
  | "ready"
  | "connecting"
  | "active"
  | "paused"
  | "completed"
  | "error";

export type RealtimeConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export type CoachStatus = "ready" | "wait";

export interface CaptureSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  displayId?: string;
  thumbnailDataUrl: string;
}

export interface SessionConfig {
  apiKey: string;
  goal: string;
  sourceId: string;
  sourceName: string;
  sourceKind: "screen" | "window";
  displayId?: string;
  saveDiagnostics?: boolean;
  visionModel?: string;
}

export interface CaptureFrame {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
  fingerprint: string;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type GuidanceDelivery = "silent" | "visual" | "spoken";

export interface GuidanceStep {
  stepId: string;
  instruction: string;
  explanation: string;
  target?: NormalizedRect;
  confidence: number;
  status: "waiting" | "completed" | "blocked";
  delivery: GuidanceDelivery;
}

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
}

export interface SessionSnapshot {
  state: SessionState;
  connection: RealtimeConnectionState;
  sourceName?: string;
  goal?: string;
  error?: string;
  captureActive: boolean;
  diagnosticsPath?: string;
}

export interface StartSessionInput extends SessionConfig {}

export interface ScreenGuideApi {
  listSources(): Promise<CaptureSource[]>;
  setReady(): Promise<SessionSnapshot>;
  startSession(input: StartSessionInput): Promise<SessionSnapshot>;
  pauseSession(): Promise<SessionSnapshot>;
  resumeSession(): Promise<SessionSnapshot>;
  focusSource(): Promise<boolean>;
  stopSession(): Promise<SessionSnapshot>;
  getSnapshot(): Promise<SessionSnapshot>;
  sendAudio(base64Pcm16: string): void;
  sendUserText(text: string): void;
  setAudioPlayback(active: boolean): void;
  onSnapshot(callback: (snapshot: SessionSnapshot) => void): () => void;
  onTranscript(callback: (entry: TranscriptEntry) => void): () => void;
  onAudio(callback: (base64Pcm16: string) => void): () => void;
  onGuidance(callback: (step: GuidanceStep | null) => void): () => void;
  onCoachStatus(callback: (status: CoachStatus) => void): () => void;
}
