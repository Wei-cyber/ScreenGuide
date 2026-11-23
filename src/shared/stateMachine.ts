import type { SessionState } from "./types";

const transitions: Record<SessionState, SessionState[]> = {
  setup: ["ready", "error"],
  ready: ["connecting", "setup", "error"],
  connecting: ["active", "error", "completed"],
  active: ["paused", "completed", "error"],
  paused: ["active", "completed", "error"],
  completed: ["ready", "connecting"],
  error: ["ready", "connecting", "completed"],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return from === to || transitions[from].includes(to);
}

export function transition(from: SessionState, to: SessionState): SessionState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid session transition: ${from} -> ${to}`);
  }
  return to;
}
