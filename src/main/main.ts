import path from "node:path";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } from "electron";
import { IPC } from "../shared/ipc";
import { resolveCoachStatus } from "../shared/coachStatus";
import { detectChangedRegion, type ChangedRegion } from "../shared/frame";
import { transition } from "../shared/stateMachine";
import type {
  CaptureSource,
  CoachStatus,
  GuidanceStep,
  SessionConfig,
  SessionSnapshot,
  SessionState,
} from "../shared/types";
import { RealtimeClient } from "./realtime";
import { activateCapturedWindow } from "./windows";

let controlWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let realtime: RealtimeClient | null = null;
let captureTimer: NodeJS.Timeout | null = null;
let observationTimer: NodeJS.Timeout | null = null;
let captureInFlight = false;
let captureLoopId = 0;
let state: SessionState = "setup";
let connection: SessionSnapshot["connection"] = "disconnected";
let config: SessionConfig | null = null;
let previousDiffFrame: Uint8Array | undefined;
let lastGuidance: GuidanceStep | null = null;
let sessionError: string | undefined;
let diagnosticsPath: string | undefined;
let diagnosticFrameIndex = 0;
let diagnosticWriteChain = Promise.resolve();
let pendingChangedRegion: ChangedRegion | undefined;
let pendingChangedPixels = 0;
let activeSettledCaptures = 0;
let realtimeCoachStatus: CoachStatus = "wait";
let audioPlaying = false;
let lastCoachStatus: CoachStatus | undefined;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const CAPTURE_POLL_INTERVAL_MS = 400;
const OBSERVATION_SETTLE_MS = 700;
const OVERVIEW_MAX_EDGE = 1600;
const MAX_SOURCE_EDGE = 3840;
const PROXY_WIDTH = 320;
const PROXY_HEIGHT = 180;
const DIFF_WIDTH = 64;
const DIFF_HEIGHT = 36;

// ScreenGuide is a lightweight coaching UI. Software rendering avoids a blank
// window on Windows systems where Electron's GPU subprocess cannot initialize.
app.disableHardwareAcceleration();

function snapshot(): SessionSnapshot {
  return {
    state,
    connection,
    sourceName: config?.sourceName,
    goal: config?.goal,
    error: sessionError,
    captureActive: state === "active",
    diagnosticsPath,
  };
}

function broadcastSnapshot(): SessionSnapshot {
  const value = snapshot();
  controlWindow?.webContents.send(IPC.snapshotEvent, value);
  overlayWindow?.webContents.send(IPC.snapshotEvent, value);
  return value;
}

function broadcastCoachStatus(): CoachStatus {
  const next = resolveCoachStatus({
    active: state === "active",
    capturePending: observationTimer !== null || activeSettledCaptures > 0,
    realtimeStatus: realtimeCoachStatus,
    audioPlaying,
  });
  if (next !== lastCoachStatus) {
    lastCoachStatus = next;
    overlayWindow?.webContents.send(IPC.coachStatusEvent, next);
  }
  if (state === "active") overlayWindow?.showInactive();
  return next;
}

function setState(next: SessionState, error?: string): void {
  state = transition(state, next);
  sessionError = error;
  broadcastSnapshot();
  broadcastCoachStatus();
}

function emitSystem(text: string): void {
  controlWindow?.webContents.send(IPC.transcriptEvent, {
    id: `${Date.now()}-system`,
    role: "system",
    text,
    createdAt: Date.now(),
  });
}

function createControlWindow(): void {
  controlWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: "#080b10",
    title: "ScreenGuide",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  controlWindow.setMenuBarVisibility(false);
  controlWindow.setContentProtection(true);
  controlWindow.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[control-load] ${code}: ${description}`);
  });
  controlWindow.webContents.on("preload-error", (_event, _preloadPath, error) => {
    console.error(`[control-preload] ${error.message}`);
  });
  controlWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[control-renderer] ${details.reason}`);
  });
  controlWindow.webContents.on("did-finish-load", () => {
    void controlWindow?.webContents
      .executeJavaScript(`JSON.stringify({ bridge: typeof window.screenGuide, body: document.body.innerText.slice(0, 80) })`)
      .then((result) => console.info(`[control-ready] ${result}`))
      .catch((error: Error) => console.error(`[control-inspect] ${error.message}`));
  });
  controlWindow.once("ready-to-show", () => controlWindow?.show());
  if (isDev) void controlWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}/index.html`);
  else void controlWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  controlWindow.on("closed", () => {
    controlWindow = null;
  });
}

function createOverlayWindow(): void {
  const display = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setContentProtection(true);
  if (isDev) void overlayWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}/overlay.html`);
  else void overlayWindow.loadFile(path.join(__dirname, "../../dist/overlay.html"));
}

function positionOverlay(windowBounds?: Electron.Rectangle): void {
  if (!overlayWindow) return;
  if (windowBounds && config?.sourceKind === "window") {
    overlayWindow.setBounds(screen.screenToDipRect(null, windowBounds));
    return;
  }
  const selected = config?.displayId
    ? screen.getAllDisplays().find((display) => String(display.id) === config?.displayId)
    : undefined;
  const target = selected ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  overlayWindow.setBounds(target.bounds);
}

async function presentSharedSource(): Promise<boolean> {
  if (!config) return false;
  overlayWindow?.hide();
  controlWindow?.minimize();

  if (config.sourceKind === "screen") {
    positionOverlay();
    return true;
  }

  const result = await activateCapturedWindow(config.sourceId);
  positionOverlay(result?.bounds);
  if (!result?.activated) {
    emitSystem("Windows could not automatically focus the shared window. Select it from the taskbar, then coaching will continue.");
  }
  return result?.activated === true;
}

function restoreControlWindow(): void {
  overlayWindow?.hide();
  if (!controlWindow) return;
  if (controlWindow.isMinimized()) controlWindow.restore();
  controlWindow.show();
  controlWindow.focus();
}

async function listSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.id.startsWith("screen:") ? "screen" : "window",
    displayId: source.display_id || undefined,
    thumbnailDataUrl: source.thumbnail.toDataURL(),
  }));
}

function sourceCaptureSize(source: SessionConfig): { width: number; height: number } {
  if (source.sourceKind === "screen") {
    const display = source.displayId
      ? screen.getAllDisplays().find((candidate) => String(candidate.id) === source.displayId)
      : screen.getPrimaryDisplay();
    if (display) {
      const width = Math.max(1, Math.round(display.size.width * display.scaleFactor));
      const height = Math.max(1, Math.round(display.size.height * display.scaleFactor));
      const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(width, height));
      return { width: Math.round(width * scale), height: Math.round(height * scale) };
    }
  }
  return { width: 2560, height: 2560 };
}

function unionChangedRegions(left: ChangedRegion | undefined, right: ChangedRegion | undefined): ChangedRegion | undefined {
  if (!left) return right;
  if (!right) return left;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

function cropChangedRegion(image: Electron.NativeImage, region: ChangedRegion | undefined): Buffer | undefined {
  if (!region || region.width * region.height >= 0.7) return undefined;
  const size = image.getSize();
  const x = Math.max(0, Math.floor(region.x * size.width));
  const y = Math.max(0, Math.floor(region.y * size.height));
  const right = Math.min(size.width, Math.ceil((region.x + region.width) * size.width));
  const bottom = Math.min(size.height, Math.ceil((region.y + region.height) * size.height));
  const width = right - x;
  const height = bottom - y;
  if (width < 24 || height < 24) return undefined;
  return image.crop({ x, y, width, height }).toJPEG(82);
}

async function configureDiagnostics(enabled: boolean): Promise<void> {
  diagnosticsPath = undefined;
  diagnosticFrameIndex = 0;
  diagnosticWriteChain = Promise.resolve();
  if (!enabled) return;
  const sessionName = new Date().toISOString().replace(/[:.]/g, "-");
  const nextPath = path.join(app.getPath("documents"), "ScreenGuide Diagnostics", sessionName);
  await mkdir(nextPath, { recursive: true });
  diagnosticsPath = nextPath;
}

function queueDiagnosticWrite(
  overview: Buffer,
  detail: Buffer | undefined,
  metadata: Record<string, unknown>,
): void {
  if (!diagnosticsPath) return;
  const folder = diagnosticsPath;
  const index = ++diagnosticFrameIndex;
  const stem = String(index).padStart(5, "0");
  const overviewName = `${stem}-overview.jpg`;
  const detailName = detail ? `${stem}-detail.jpg` : undefined;
  diagnosticWriteChain = diagnosticWriteChain
    .then(async () => {
      await writeFile(path.join(folder, overviewName), overview);
      if (detail && detailName) await writeFile(path.join(folder, detailName), detail);
      await appendFile(path.join(folder, "frames.jsonl"), `${JSON.stringify({
        ...metadata,
        overview: overviewName,
        detail: detailName,
      })}\n`, "utf8");
    })
    .catch(() => {
      diagnosticsPath = undefined;
      broadcastSnapshot();
      emitSystem("Diagnostic screenshot saving stopped because the folder could not be written.");
    });
}

async function captureSettledObservation(
  loopId: number,
  activeConfig: SessionConfig,
  activeRealtime: RealtimeClient,
  changedRegion: ChangedRegion | undefined,
  changedPixels: number,
): Promise<void> {
  if (loopId !== captureLoopId || state !== "active" || realtime !== activeRealtime) return;
  try {
    const sources = await desktopCapturer.getSources({
      types: [activeConfig.sourceKind],
      thumbnailSize: sourceCaptureSize(activeConfig),
      fetchWindowIcons: false,
    });
    const selected = sources.find((source) => source.id === activeConfig.sourceId);
    if (!selected || selected.thumbnail.isEmpty()) {
      await failSession("The shared screen or window is no longer available. Choose it again to continue.");
      return;
    }

    const image = selected.thumbnail;
    const size = image.getSize();
    const overviewScale = Math.min(1, OVERVIEW_MAX_EDGE / Math.max(size.width, size.height));
    const overviewImage = overviewScale < 1
      ? image.resize({ width: Math.round(size.width * overviewScale), height: Math.round(size.height * overviewScale), quality: "good" })
      : image;
    const overviewJpeg = overviewImage.toJPEG(72);
    const detailJpeg = cropChangedRegion(image, changedRegion);
    if (loopId !== captureLoopId || state !== "active" || realtime !== activeRealtime) return;
    activeRealtime.sendFrame({
      overviewDataUrl: `data:image/jpeg;base64,${overviewJpeg.toString("base64")}`,
      detailDataUrl: detailJpeg ? `data:image/jpeg;base64,${detailJpeg.toString("base64")}` : undefined,
      changedRegion: detailJpeg ? changedRegion : undefined,
    });
    queueDiagnosticWrite(overviewJpeg, detailJpeg, {
      capturedAt: new Date().toISOString(),
      sourceName: activeConfig.sourceName,
      sourceSize: size,
      overviewSize: overviewImage.getSize(),
      changedPixels,
      changedRegion,
      settledForMs: OBSERVATION_SETTLE_MS,
    });
  } catch {
    if (state !== "active") return;
    await failSession("Screen capture failed. Pause, then reselect the source and try again.");
  }
}

function scheduleSettledObservation(
  loopId: number,
  activeConfig: SessionConfig,
  activeRealtime: RealtimeClient,
  region: ChangedRegion | undefined,
  changedPixels: number,
): void {
  pendingChangedRegion = unionChangedRegions(pendingChangedRegion, region);
  pendingChangedPixels += changedPixels;
  if (observationTimer) clearTimeout(observationTimer);
  observationTimer = setTimeout(() => {
    observationTimer = null;
    const settledRegion = pendingChangedRegion;
    const settledPixels = pendingChangedPixels;
    pendingChangedRegion = undefined;
    pendingChangedPixels = 0;
    activeSettledCaptures += 1;
    broadcastCoachStatus();
    void captureSettledObservation(loopId, activeConfig, activeRealtime, settledRegion, settledPixels)
      .finally(() => {
        activeSettledCaptures = Math.max(0, activeSettledCaptures - 1);
        broadcastCoachStatus();
      });
  }, OBSERVATION_SETTLE_MS);
  broadcastCoachStatus();
}

async function pollForChanges(loopId: number): Promise<void> {
  if (loopId !== captureLoopId || state !== "active" || !config || !realtime) return;
  const activeConfig = config;
  const activeRealtime = realtime;
  try {
    const sources = await desktopCapturer.getSources({
      types: [activeConfig.sourceKind],
      thumbnailSize: { width: PROXY_WIDTH, height: PROXY_HEIGHT },
      fetchWindowIcons: false,
    });
    const selected = sources.find((source) => source.id === activeConfig.sourceId);
    if (!selected || selected.thumbnail.isEmpty()) {
      await failSession("The shared screen or window is no longer available. Choose it again to continue.");
      return;
    }
    const diffFrame = selected.thumbnail
      .resize({ width: DIFF_WIDTH, height: DIFF_HEIGHT, quality: "good" })
      .toBitmap();
    const change = detectChangedRegion(previousDiffFrame, diffFrame, DIFF_WIDTH, DIFF_HEIGHT);
    previousDiffFrame = Uint8Array.from(diffFrame);
    if (!change.changed) return;
    scheduleSettledObservation(loopId, activeConfig, activeRealtime, change.region, change.changedPixels);
  } catch {
    if (state !== "active") return;
    await failSession("Screen capture failed. Pause, then reselect the source and try again.");
  }
}

async function captureTick(loopId: number): Promise<void> {
  if (loopId !== captureLoopId || state !== "active") return;
  if (captureInFlight) {
    captureTimer = setTimeout(() => void captureTick(loopId), 50);
    return;
  }

  captureInFlight = true;
  try {
    await pollForChanges(loopId);
  } finally {
    captureInFlight = false;
    if (loopId === captureLoopId && state === "active") {
      captureTimer = setTimeout(() => void captureTick(loopId), CAPTURE_POLL_INTERVAL_MS);
    }
  }
}

function startCaptureLoop(): void {
  stopCaptureLoop();
  const loopId = captureLoopId;
  captureTimer = setTimeout(() => void captureTick(loopId), 0);
}

function stopCaptureLoop(): void {
  captureLoopId += 1;
  if (captureTimer) clearTimeout(captureTimer);
  if (observationTimer) clearTimeout(observationTimer);
  captureTimer = null;
  observationTimer = null;
  pendingChangedRegion = undefined;
  pendingChangedPixels = 0;
}

async function failSession(message: string): Promise<void> {
  stopCaptureLoop();
  realtime?.disconnect();
  connection = "failed";
  restoreControlWindow();
  if (state !== "error") setState("error", message);
}

async function startSession(input: SessionConfig): Promise<SessionSnapshot> {
  const apiKey = input.apiKey.trim();
  const goal = input.goal.trim();
  if (!apiKey.startsWith("sk-") || apiKey.length < 20) throw new Error("Enter a valid OpenAI API key.");
  if (!goal) throw new Error("Describe what you want to accomplish.");
  if (!input.sourceId) throw new Error("Choose a screen or window to share.");

  if (state === "completed" || state === "error") state = "ready";
  config = { ...input, apiKey, goal };
  sessionError = undefined;
  previousDiffFrame = undefined;
  lastGuidance = null;
  realtimeCoachStatus = "wait";
  audioPlaying = false;
  lastCoachStatus = undefined;
  try {
    await configureDiagnostics(Boolean(input.saveDiagnostics));
  } catch {
    diagnosticsPath = undefined;
    emitSystem("Diagnostic screenshot saving could not be enabled. Coaching will continue without saving images.");
  }
  setState("connecting");
  positionOverlay();

  realtime?.disconnect();
  realtime = new RealtimeClient();
  realtime.on("connection", (next) => {
    connection = next;
    broadcastSnapshot();
  });
  realtime.on("transcript", (entry) => controlWindow?.webContents.send(IPC.transcriptEvent, entry));
  realtime.on("audio", (audio) => controlWindow?.webContents.send(IPC.audioEvent, audio));
  realtime.on("status", (next) => {
    realtimeCoachStatus = next;
    broadcastCoachStatus();
  });
  realtime.on("guidance", (guidance) => {
    lastGuidance = guidance;
    controlWindow?.webContents.send(IPC.guidanceEvent, guidance);
    overlayWindow?.webContents.send(IPC.guidanceEvent, guidance);
    overlayWindow?.showInactive();
  });
  realtime.on("endSession", () => stopSession());
  realtime.on("error", (message) => {
    emitSystem(message);
    if (/rejected|connection closed|unable to connect/i.test(message)) void failSession(message);
  });

  try {
    await realtime.connect(apiKey, goal);
    await presentSharedSource();
    setState("active");
    broadcastCoachStatus();
    startCaptureLoop();
    if (diagnosticsPath) {
      emitSystem(`Live coaching started. The exact AI overview and detail images are being saved to ${diagnosticsPath}`);
    } else {
      emitSystem("Live coaching started. Screen images and microphone audio are sent to OpenAI only while this session is active.");
    }
  } catch (error) {
    await failSession(error instanceof Error ? error.message : "Unable to connect to OpenAI.");
  } finally {
    if (config) config.apiKey = "";
    input.apiKey = "";
  }
  return snapshot();
}

function pauseSession(): SessionSnapshot {
  if (state !== "active") return snapshot();
  stopCaptureLoop();
  realtime?.setPaused(true);
  setState("paused");
  restoreControlWindow();
  emitSystem("Coaching paused. No screen images or microphone audio are being sent.");
  return snapshot();
}

async function resumeSession(): Promise<SessionSnapshot> {
  if (state !== "paused") return snapshot();
  await presentSharedSource();
  realtime?.setPaused(false);
  previousDiffFrame = undefined;
  realtimeCoachStatus = "wait";
  setState("active");
  broadcastCoachStatus();
  startCaptureLoop();
  emitSystem("Coaching resumed.");
  return snapshot();
}

function stopSession(): SessionSnapshot {
  stopCaptureLoop();
  realtime?.disconnect();
  realtime = null;
  realtimeCoachStatus = "wait";
  audioPlaying = false;
  connection = "disconnected";
  previousDiffFrame = undefined;
  lastGuidance = null;
  overlayWindow?.webContents.send(IPC.guidanceEvent, null);
  restoreControlWindow();
  if (["active", "paused", "connecting", "error"].includes(state)) setState("completed");
  config = null;
  return snapshot();
}

function registerIpc(): void {
  ipcMain.handle(IPC.listSources, listSources);
  ipcMain.handle(IPC.setReady, () => {
    if (state === "setup" || state === "completed" || state === "error") setState("ready");
    return snapshot();
  });
  ipcMain.handle(IPC.start, (_event, input: SessionConfig) => startSession(input));
  ipcMain.handle(IPC.pause, pauseSession);
  ipcMain.handle(IPC.resume, resumeSession);
  ipcMain.handle(IPC.focusSource, presentSharedSource);
  ipcMain.handle(IPC.stop, stopSession);
  ipcMain.handle(IPC.snapshot, () => snapshot());
  ipcMain.on(IPC.audioInput, (_event, audio: string) => {
    if (state === "active") realtime?.sendAudio(audio);
  });
  ipcMain.on(IPC.userText, (_event, text: string) => {
    if (state === "active") realtime?.sendUserText(text);
  });
  ipcMain.on(IPC.audioPlayback, (_event, active: boolean) => {
    audioPlaying = active === true;
    broadcastCoachStatus();
  });
}

function registerShortcuts(): void {
  globalShortcut.register("CommandOrControl+Shift+Space", () => {
    if (state === "active") pauseSession();
    else if (state === "paused") void resumeSession();
  });
  globalShortcut.register("CommandOrControl+Shift+Escape", stopSession);
}

app.whenReady().then(() => {
  registerIpc();
  createControlWindow();
  createOverlayWindow();
  registerShortcuts();
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  stopCaptureLoop();
  realtime?.disconnect();
  globalShortcut.unregisterAll();
});
