import { contextBridge, ipcRenderer } from "electron";
import type { CoachStatus, GuidanceStep, ScreenGuideApi, SessionSnapshot, StartSessionInput, TranscriptEntry } from "../shared/types";

// Sandboxed Electron preloads may only require a small set of built-in modules.
// Keep channel names local so the emitted preload is a single-module script.
const IPC = {
  listSources: "sources:list",
  setReady: "session:ready",
  start: "session:start",
  pause: "session:pause",
  resume: "session:resume",
  focusSource: "session:focus-source",
  stop: "session:stop",
  snapshot: "session:snapshot",
  audioInput: "session:audio-input",
  userText: "session:user-text",
  audioPlayback: "session:audio-playback",
  snapshotEvent: "event:snapshot",
  transcriptEvent: "event:transcript",
  audioEvent: "event:audio",
  guidanceEvent: "event:guidance",
  coachStatusEvent: "event:coach-status",
} as const;

function subscription<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ScreenGuideApi = {
  listSources: () => ipcRenderer.invoke(IPC.listSources),
  setReady: () => ipcRenderer.invoke(IPC.setReady),
  startSession: (input: StartSessionInput) => ipcRenderer.invoke(IPC.start, input),
  pauseSession: () => ipcRenderer.invoke(IPC.pause),
  resumeSession: () => ipcRenderer.invoke(IPC.resume),
  focusSource: () => ipcRenderer.invoke(IPC.focusSource),
  stopSession: () => ipcRenderer.invoke(IPC.stop),
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  sendAudio: (audio) => ipcRenderer.send(IPC.audioInput, audio),
  sendUserText: (text) => ipcRenderer.send(IPC.userText, text),
  setAudioPlayback: (active) => ipcRenderer.send(IPC.audioPlayback, active),
  onSnapshot: (callback) => subscription<SessionSnapshot>(IPC.snapshotEvent, callback),
  onTranscript: (callback) => subscription<TranscriptEntry>(IPC.transcriptEvent, callback),
  onAudio: (callback) => subscription<string>(IPC.audioEvent, callback),
  onGuidance: (callback) => subscription<GuidanceStep | null>(IPC.guidanceEvent, callback),
  onCoachStatus: (callback) => subscription<CoachStatus>(IPC.coachStatusEvent, callback),
};

contextBridge.exposeInMainWorld("screenGuide", api);
