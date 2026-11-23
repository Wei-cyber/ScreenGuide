import { describe, expect, it } from "vitest";
import { resolveCoachStatus } from "../src/shared/coachStatus";

describe("coach status", () => {
  it("is ready only when the active session has no pending work", () => {
    expect(resolveCoachStatus({
      active: true,
      capturePending: false,
      realtimeStatus: "ready",
      audioPlaying: false,
    })).toBe("ready");
  });

  it.each([
    { active: false, capturePending: false, realtimeStatus: "ready" as const, audioPlaying: false },
    { active: true, capturePending: true, realtimeStatus: "ready" as const, audioPlaying: false },
    { active: true, capturePending: false, realtimeStatus: "wait" as const, audioPlaying: false },
    { active: true, capturePending: false, realtimeStatus: "ready" as const, audioPlaying: true },
  ])("waits while inactive, capturing, processing, or playing audio", (inputs) => {
    expect(resolveCoachStatus(inputs)).toBe("wait");
  });
});
