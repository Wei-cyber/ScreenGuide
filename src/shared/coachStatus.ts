import type { CoachStatus } from "./types";

export interface CoachStatusInputs {
  active: boolean;
  capturePending: boolean;
  realtimeStatus: CoachStatus;
  audioPlaying: boolean;
}

export function resolveCoachStatus(inputs: CoachStatusInputs): CoachStatus {
  return inputs.active
    && !inputs.capturePending
    && inputs.realtimeStatus === "ready"
    && !inputs.audioPlaying
    ? "ready"
    : "wait";
}
