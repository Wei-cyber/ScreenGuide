import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CoachStatus, GuidanceStep, TranscriptEntry } from "../../src/shared/types";
import { BrowserCapture } from "./capture";
import { RealtimeCoach, type WebConnectionState } from "./realtime";
import "./styles.css";

type Phase = "setup" | "connecting" | "active" | "paused" | "error";

const defaultEndpoint = import.meta.env.VITE_SESSION_ENDPOINT || "/api/session";

function friendlyError(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Screen or microphone permission was not granted. Start again and allow both permissions.";
  }
  return error instanceof Error ? error.message : "The session could not start.";
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const captureRef = useRef<BrowserCapture | undefined>(undefined);
  const coachRef = useRef<RealtimeCoach | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("setup");
  const [connection, setConnection] = useState<WebConnectionState>("disconnected");
  const [status, setStatus] = useState<CoachStatus>("wait");
  const [goal, setGoal] = useState("");
  const [endpoint, setEndpoint] = useState(defaultEndpoint);
  const [accessCode, setAccessCode] = useState("");
  const [guidance, setGuidance] = useState<GuidanceStep | null>(null);
  const [history, setHistory] = useState<TranscriptEntry[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [sourceRatio, setSourceRatio] = useState(16 / 9);

  const canStart = goal.trim().length >= 3 && endpoint.trim().length > 0 && phase !== "connecting";
  const active = phase === "active" || phase === "paused" || phase === "connecting";
  const summary = useMemo(() => history
    .filter((entry) => entry.role === "assistant")
    .map((entry) => `• ${entry.text}`)
    .join("\n"), [history]);

  async function start() {
    if (!canStart || !videoRef.current || !audioRef.current) return;
    setError("");
    setGuidance(null);
    setHistory([]);
    setPhase("connecting");
    setStatus("wait");

    const coach = new RealtimeCoach({
      onConnection: setConnection,
      onCoachStatus: setStatus,
      onGuidance: setGuidance,
      onTranscript: (entry) => setHistory((entries) => [...entries, entry].slice(-50)),
      onError: (message) => setError(message),
    });
    const capture = new BrowserCapture({
      onObservation: (observation) => coach.sendObservation(observation),
      onEnded: () => end("Screen sharing ended."),
      onError: (message) => setError(message),
    });
    coachRef.current = coach;
    captureRef.current = capture;

    try {
      await capture.start(videoRef.current);
      setSourceRatio(videoRef.current.videoWidth / videoRef.current.videoHeight || 16 / 9);
      await coach.connect(endpoint.trim(), accessCode, goal.trim(), audioRef.current);
      setPhase("active");
    } catch (caught) {
      capture.stop();
      coach.close();
      setError(friendlyError(caught));
      setPhase("error");
    }
  }

  function togglePause() {
    const shouldPause = phase === "active";
    coachRef.current?.setPaused(shouldPause);
    captureRef.current?.setPaused(shouldPause);
    if (audioRef.current) {
      if (shouldPause) audioRef.current.pause();
      else void audioRef.current.play().catch(() => undefined);
    }
    setPhase(shouldPause ? "paused" : "active");
    setStatus(shouldPause ? "wait" : "ready");
  }

  function end(reason = "") {
    captureRef.current?.stop();
    coachRef.current?.close();
    captureRef.current = undefined;
    coachRef.current = undefined;
    setConnection("disconnected");
    setPhase("setup");
    setStatus("wait");
    setGuidance(null);
    setError(reason);
  }

  function ask() {
    const text = question.trim();
    if (!text || status !== "ready" || phase !== "active") return;
    coachRef.current?.sendUserText(text);
    setQuestion("");
  }

  async function copySummary() {
    if (!summary) return;
    await navigator.clipboard.writeText(`ScreenGuide session: ${goal}\n\n${summary}`);
  }

  return (
    <main className="app-shell">
      <audio ref={audioRef} autoPlay />
      <header className="topbar">
        <a className="brand" href="./" aria-label="ScreenGuide home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>ScreenGuide</span>
          <small>Web</small>
        </a>
        {active && (
          <div className={`status-pill status-${status}`} role="status" aria-live="polite">
            <span />{status === "ready" ? "Ready" : "Wait"}
          </div>
        )}
      </header>

      <section className={active ? "workspace" : "welcome"}>
        {!active && (
          <div className="setup-card">
            <p className="eyebrow">A coach beside you, not in control</p>
            <h1>Show your screen.<br />Learn by doing.</h1>
            <p className="intro">
              Choose a screen or app, describe what you want to accomplish, and ScreenGuide will teach one step at a time.
            </p>

            {error && <div className="error-banner" role="alert">{error}</div>}

            <label className="field">
              <span>What do you want to accomplish?</span>
              <textarea
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                maxLength={500}
                rows={3}
                placeholder="For example: Import a point cloud in CloudCompare and inspect its properties"
              />
            </label>

            <details className="connection-settings">
              <summary>Connection settings</summary>
              <label className="field compact">
                <span>Session service</span>
                <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://your-session-service.example/api/session" />
              </label>
              <label className="field compact">
                <span>Access code <em>optional locally</em></span>
                <input type="password" autoComplete="off" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} />
              </label>
            </details>

            <button className="primary-button" disabled={!canStart} onClick={() => void start()}>
              Choose screen and begin
            </button>
            <p className="privacy-note">
              Screens and microphone audio are sent live for coaching and are not saved by this app. ScreenGuide never clicks or types.
            </p>
          </div>
        )}

        <div className={active ? "preview-column" : "preview-hidden"} aria-hidden={!active}>
          <div className="preview-frame" style={{ aspectRatio: sourceRatio }}>
            <video
              ref={videoRef}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                setSourceRatio(video.videoWidth / video.videoHeight || 16 / 9);
              }}
            />
            {guidance?.target && (
              <div
                className="target-box"
                style={{
                  left: `${guidance.target.x * 100}%`,
                  top: `${guidance.target.y * 100}%`,
                  width: `${guidance.target.width * 100}%`,
                  height: `${guidance.target.height * 100}%`,
                }}
              />
            )}
            {phase === "paused" && <div className="paused-cover">Paused</div>}
            {phase === "connecting" && <div className="paused-cover">Connecting…</div>}
          </div>
          <div className="capture-row">
            <span><i />Sharing now</span>
            <span>{connection === "connected" ? "Realtime connected" : "Setting up"}</span>
          </div>
        </div>

        {active && (
          <aside className="coach-panel">
            <div className="goal-block">
              <span>Goal</span>
              <p>{goal}</p>
            </div>

            <div className="guidance-card" aria-live="polite">
              <span className="step-label">Current step</span>
              <h2>{guidance?.instruction || (phase === "connecting" ? "Connecting your coach…" : "Looking at your screen…")}</h2>
              {guidance?.explanation && <p>{guidance.explanation}</p>}
            </div>

            {error && <div className="error-banner" role="alert">{error}</div>}

            <div className="ask-row">
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") ask(); }}
                disabled={status !== "ready" || phase !== "active"}
                placeholder={status === "ready" ? "Or type a question…" : "Please wait…"}
                aria-label="Ask the coach"
              />
              <button onClick={ask} disabled={!question.trim() || status !== "ready" || phase !== "active"}>Ask</button>
            </div>

            <div className="session-actions">
              <button onClick={togglePause}>{phase === "paused" ? "Resume" : "Pause"}</button>
              <button onClick={() => void copySummary()} disabled={!summary}>Copy notes</button>
              <button className="stop-button" onClick={() => end()}>End</button>
            </div>
          </aside>
        )}
      </section>

      {!active && (
        <footer>
          <span>Voice + vision coaching</span>
          <span>Best in Chrome or Edge</span>
          <span>Share an app window when possible</span>
        </footer>
      )}
    </main>
  );
}

const rootElement = document.getElementById("root")!;
const hotGlobal = globalThis as typeof globalThis & {
  __screenGuideRoot?: ReturnType<typeof createRoot>;
};
const appRoot = hotGlobal.__screenGuideRoot ?? createRoot(rootElement);
hotGlobal.__screenGuideRoot = appRoot;
appRoot.render(<StrictMode><App /></StrictMode>);
