import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CaptureSource, GuidanceStep, SessionSnapshot, TranscriptEntry } from "../shared/types";
import { MicrophoneStream, RealtimePcmPlayer } from "./audio";
import "./styles.css";

const initialSnapshot: SessionSnapshot = {
  state: "setup",
  connection: "disconnected",
  captureActive: false,
};

function App() {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [goal, setGoal] = useState("");
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [loadingSources, setLoadingSources] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [guidance, setGuidance] = useState<GuidanceStep | null>(null);
  const [draft, setDraft] = useState("");
  const [formError, setFormError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [saveDiagnostics, setSaveDiagnostics] = useState(false);
  const mic = useRef(new MicrophoneStream());
  const player = useRef(new RealtimePcmPlayer((active) => window.screenGuide.setAudioPlayback(active)));
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const active = snapshot.state === "active" || snapshot.state === "paused";
  const selectedSource = useMemo(() => sources.find((source) => source.id === sourceId), [sources, sourceId]);

  useEffect(() => {
    const unsubscribers = [
      window.screenGuide.onSnapshot((value) => {
        setSnapshot(value);
        mic.current.setMuted(value.state !== "active");
        if (value.state === "completed" || value.state === "error") {
          player.current.stop();
          setGuidance(null);
        }
      }),
      window.screenGuide.onTranscript((entry) => setTranscript((current) => [...current, entry])),
      window.screenGuide.onGuidance(setGuidance),
      window.screenGuide.onAudio((audio) => player.current.play(audio)),
    ];
    void window.screenGuide.getSnapshot().then(setSnapshot);
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      mic.current.stop();
      player.current.stop();
    };
  }, []);

  useEffect(() => transcriptEnd.current?.scrollIntoView({ behavior: "smooth" }), [transcript]);

  async function prepareMicrophone(): Promise<void> {
    setFormError("");
    try {
      await mic.current.start((audio) => window.screenGuide.sendAudio(audio));
      mic.current.setMuted(true);
      setMicReady(true);
    } catch {
      setMicReady(false);
      setFormError("Microphone access was denied. Enable it in Windows Privacy & security settings, then retry.");
    }
  }

  async function finishOnboarding(): Promise<void> {
    if (!apiKey.trim()) {
      setFormError("Enter your OpenAI API key before continuing.");
      return;
    }
    if (!micReady) {
      setFormError("Test the microphone before continuing.");
      return;
    }
    setFormError("");
    await window.screenGuide.setReady();
    await refreshSources();
  }

  async function refreshSources(): Promise<void> {
    setLoadingSources(true);
    setFormError("");
    try {
      const next = await window.screenGuide.listSources();
      setSources(next);
      if (!next.some((source) => source.id === sourceId)) setSourceId(next[0]?.id ?? "");
    } catch {
      setFormError("Screen sources could not be loaded. Check Windows screen-capture permissions.");
    } finally {
      setLoadingSources(false);
    }
  }

  async function start(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedSource || !goal.trim()) {
      setFormError("Add a goal and choose what ScreenGuide may see.");
      return;
    }
    setFormError("");
    setTranscript([]);
    setGuidance(null);
    mic.current.setMuted(false);
    try {
      const result = await window.screenGuide.startSession({
        apiKey,
        goal,
        sourceId: selectedSource.id,
        sourceName: selectedSource.name,
        sourceKind: selectedSource.kind,
        displayId: selectedSource.displayId,
        saveDiagnostics,
      });
      setSnapshot(result);
      if (result.state === "error") setFormError(result.error ?? "Unable to start coaching.");
    } catch (error) {
      mic.current.setMuted(true);
      setFormError(error instanceof Error ? error.message : "Unable to start coaching.");
    }
  }

  async function togglePause(): Promise<void> {
    const next = snapshot.state === "active"
      ? await window.screenGuide.pauseSession()
      : await window.screenGuide.resumeSession();
    setSnapshot(next);
  }

  async function stop(): Promise<void> {
    const next = await window.screenGuide.stopSession();
    mic.current.setMuted(true);
    player.current.stop();
    setSnapshot(next);
    setGuidance(null);
  }

  async function returnToTask(): Promise<void> {
    await window.screenGuide.focusSource();
  }

  function sendText(event: FormEvent): void {
    event.preventDefault();
    const text = draft.trim();
    if (!text || snapshot.state !== "active") return;
    window.screenGuide.sendUserText(text);
    setDraft("");
  }

  function copySummary(): void {
    const text = transcript.map((entry) => `${entry.role === "assistant" ? "ScreenGuide" : entry.role}: ${entry.text}`).join("\n\n");
    if (text) void navigator.clipboard.writeText(text);
  }

  if (snapshot.state === "setup") {
    return (
      <main className="onboarding-shell">
        <section className="brand-panel">
          <div className="brand-mark"><span /></div>
          <div>
            <p className="eyebrow">Meet ScreenGuide</p>
            <h1>Learn by doing,<br /><em>with a guide beside you.</em></h1>
            <p className="lead">Share one screen or window. ScreenGuide watches for progress and talks you through the next move—without ever taking control.</p>
          </div>
          <div className="privacy-promise">
            <span className="pulse-dot" />
            <div><strong>Private by default.</strong><small>No cloud history. Your key stays in memory, and screenshots are saved only when you enable diagnostic capture.</small></div>
          </div>
        </section>
        <section className="setup-panel">
          <div className="step-label">SETUP · 1 OF 1</div>
          <h2>Make it yours</h2>
          <p>Your key stays in memory for this app session and is sent only to OpenAI.</p>
          <label className="field-label" htmlFor="api-key">OpenAI API key</label>
          <div className="secret-field">
            <input id="api-key" type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" autoComplete="off" spellCheck={false} />
            <button type="button" className="text-button" onClick={() => setShowKey((current) => !current)}>{showKey ? "Hide" : "Show"}</button>
          </div>
          <div className="mic-check">
            <div className="mic-icon">⌁</div>
            <div><strong>Microphone</strong><small>{micReady ? "Ready for voice coaching" : "Used only while coaching is active"}</small></div>
            <button type="button" className={micReady ? "status-ready" : "secondary-button"} onClick={prepareMicrophone}>{micReady ? "✓ Ready" : "Test mic"}</button>
          </div>
          <div className="notice"><span>◈</span><p>You choose exactly what to share. Say “end the session,” use the End session button, or press <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Esc</kbd> to stop.</p></div>
          {formError && <p className="error-banner" role="alert">{formError}</p>}
          <button className="primary-button" type="button" onClick={finishOnboarding}>Continue <span>→</span></button>
        </section>
      </main>
    );
  }

  if (!active && snapshot.state !== "connecting") {
    return (
      <main className="app-shell setup-view">
        <Header snapshot={snapshot} />
        <section className="goal-layout">
          <form className="goal-card" onSubmit={start}>
            <p className="eyebrow">NEW SESSION</p>
            <h1>What are we working on?</h1>
            <p className="muted">Describe the outcome, then choose the one place ScreenGuide may observe.</p>
            <label className="field-label" htmlFor="goal">Your goal</label>
            <textarea id="goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="For example: Help me turn on Night light in Windows Settings" rows={3} maxLength={500} />
            <div className="source-heading"><div><span className="field-label">Share one source</span><small>{sources.length} available</small></div><button type="button" className="text-button" onClick={refreshSources}>{loadingSources ? "Looking…" : "Refresh"}</button></div>
            <div className="source-grid" aria-label="Available screens and windows">
              {sources.map((source) => (
                <button key={source.id} type="button" className={`source-card ${sourceId === source.id ? "selected" : ""}`} onClick={() => setSourceId(source.id)} aria-pressed={sourceId === source.id}>
                  <div className="source-preview"><img src={source.thumbnailDataUrl} alt="" /></div>
                  <div><strong>{source.name}</strong><small>{source.kind === "screen" ? "Entire screen" : "Application window"}</small></div>
                  <span className="radio-indicator" />
                </button>
              ))}
              {!loadingSources && sources.length === 0 && <div className="empty-source">No sources found. Check capture permissions, then refresh.</div>}
            </div>
            <label className="diagnostic-toggle">
              <input type="checkbox" checked={saveDiagnostics} onChange={(event) => setSaveDiagnostics(event.target.checked)} />
              <span><strong>Save AI screenshots for testing</strong><small>Writes only the overview and detail crop sent to the AI under Documents\ScreenGuide Diagnostics. Off by default.</small></span>
            </label>
            {formError && <p className="error-banner" role="alert">{formError}</p>}
            {snapshot.error && <p className="error-banner" role="alert">{snapshot.error}</p>}
            <button className="primary-button" type="submit" disabled={!goal.trim() || !selectedSource}>Start live coaching <span>→</span></button>
          </form>
          <aside className="how-card">
            <span className="mini-orbit">✦</span>
            <h3>You stay in control</h3>
            <ol><li><span>1</span><p><strong>ScreenGuide observes</strong><small>A fresh view is sent only when your screen changes.</small></p></li><li><span>2</span><p><strong>You get one clear step</strong><small>Listen, read, or follow a visual highlight.</small></p></li><li><span>3</span><p><strong>You make the move</strong><small>ScreenGuide never clicks or types for you.</small></p></li></ol>
          </aside>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell session-view">
      <Header snapshot={snapshot} />
      <section className="session-grid">
        <div className="coach-column">
          <div className="session-title"><div><p className="eyebrow">YOUR GOAL</p><h2>{snapshot.goal}</h2></div><div className={`live-pill ${snapshot.state}`}><span />{snapshot.state === "active" ? "LIVE" : snapshot.state.toUpperCase()}</div></div>
          <article className={`guidance-card ${guidance?.status ?? "waiting"} ${guidance?.delivery ?? ""}`}>
            <div className="guidance-number">{guidance?.delivery === "visual" ? "✓" : guidance ? guidance.stepId.replace(/\D/g, "").slice(0, 2) || "•" : "…"}</div>
            <div>
              <p className="eyebrow">{guidance?.status === "completed" ? "GOAL COMPLETE" : guidance?.delivery === "visual" ? "ON TRACK" : "NEXT STEP"}</p>
              <h1>{guidance?.instruction ?? (snapshot.state === "connecting" ? "Connecting your coach…" : "Looking at the shared screen…")}</h1>
              <p>{guidance?.explanation ?? "ScreenGuide will offer one clear move when it understands what is visible."}</p>
            </div>
          </article>
          <div className="controls">
            <button className="pause-button" onClick={togglePause} disabled={snapshot.state === "connecting"}>{snapshot.state === "paused" ? "▶ Resume" : "Ⅱ Pause"}</button>
            <button className="task-button" onClick={returnToTask} disabled={snapshot.state !== "active"}>Return to task</button>
            <button className="stop-button" onClick={stop}>■ End session</button>
            <span className="capture-note"><i />{snapshot.state === "active" ? `Observing ${snapshot.sourceName}` : "Capture is off"}</span>
          </div>
          <form className="message-form" onSubmit={sendText}><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask a question or describe what happened…" disabled={snapshot.state !== "active"} /><button type="submit" aria-label="Send message">↑</button></form>
        </div>
        <aside className="transcript-panel">
          <div className="transcript-header"><div><p className="eyebrow">SESSION</p><h3>Conversation</h3></div><button className="text-button" onClick={copySummary}>Copy</button></div>
          <div className="transcript-list" aria-live="polite">
            {transcript.length === 0 && <div className="transcript-empty"><span>◎</span><p>Your conversation will appear here.</p></div>}
            {transcript.map((entry) => <div key={entry.id} className={`transcript-entry ${entry.role}`}><span>{entry.role === "assistant" ? "SG" : entry.role === "user" ? "YOU" : "•"}</span><p>{entry.text}</p></div>)}
            <div ref={transcriptEnd} />
          </div>
          <div className="privacy-footer"><span>⌁</span><p><strong>{snapshot.diagnosticsPath ? "Diagnostic capture enabled" : "Private by design"}</strong><small>{snapshot.diagnosticsPath ? `AI screenshots are being saved to ${snapshot.diagnosticsPath}` : "This conversation disappears when you close ScreenGuide."}</small></p></div>
        </aside>
      </section>
    </main>
  );
}

function Header({ snapshot }: { snapshot: SessionSnapshot }) {
  return <header className="app-header"><div className="wordmark"><div className="brand-mark small"><span /></div><strong>ScreenGuide</strong></div><div className="header-status"><span className={snapshot.captureActive ? "capturing" : ""} />{snapshot.captureActive ? "Screen sharing is on" : "Private mode"}</div></header>;
}

createRoot(document.getElementById("root")!).render(<App />);
