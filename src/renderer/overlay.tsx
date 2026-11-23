import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CoachStatus, GuidanceStep, SessionSnapshot } from "../shared/types";
import "./styles.css";

function Overlay() {
  const [guidance, setGuidance] = useState<GuidanceStep | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [coachStatus, setCoachStatus] = useState<CoachStatus>("wait");
  useEffect(() => {
    const offGuidance = window.screenGuide.onGuidance(setGuidance);
    const offSnapshot = window.screenGuide.onSnapshot(setSnapshot);
    const offCoachStatus = window.screenGuide.onCoachStatus(setCoachStatus);
    return () => { offGuidance(); offSnapshot(); offCoachStatus(); };
  }, []);
  useEffect(() => {
    if (guidance?.delivery !== "visual") return;
    const timer = window.setTimeout(() => setGuidance(null), 1600);
    return () => window.clearTimeout(timer);
  }, [guidance]);
  const active = snapshot?.state === "active";
  if (!active && !guidance) return null;
  return <div className="overlay-root">
    {active && <div className={`coach-status-pill ${coachStatus}`} role="status" aria-live="polite"><span />{coachStatus === "ready" ? "Ready — talk now" : "Please wait"}</div>}
    {guidance?.target && <div className="target-highlight" style={{ left: `${guidance.target.x * 100}%`, top: `${guidance.target.y * 100}%`, width: `${guidance.target.width * 100}%`, height: `${guidance.target.height * 100}%` }}><span /></div>}
    {guidance?.delivery === "visual" && <div className="visual-ack" aria-label="Progress recognized">✓</div>}
    {/* Live caption intentionally disabled for now. Voice guidance and the visual highlight remain active. */}
    {/* <div className={`overlay-instruction ${guidance.status}`}><span className="overlay-kicker">SCREENGUIDE · {guidance.status === "completed" ? "DONE" : "NEXT"}</span><strong>{guidance.instruction}</strong><small>{guidance.explanation}</small></div> */}
  </div>;
}

createRoot(document.getElementById("root")!).render(<Overlay />);
