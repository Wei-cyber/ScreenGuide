import { describe, expect, it } from "vitest";
import { resolveGuidanceDelivery } from "../src/shared/guidancePolicy";
import type { GuidanceStep } from "../src/shared/types";

const step = (overrides: Partial<GuidanceStep> = {}): GuidanceStep => ({
  stepId: "step-1",
  instruction: "Open the File menu",
  explanation: "The import command is there.",
  confidence: 0.9,
  status: "waiting",
  delivery: "spoken",
  ...overrides,
});

describe("three-level guidance policy", () => {
  it("keeps routine observations silent", () => {
    expect(resolveGuidanceDelivery(step({ delivery: "silent" }), {
      previous: step(),
      trigger: "observation",
      lastSpokenAt: 1_000,
      now: 2_000,
    })).toBe("silent");
  });

  it("allows a visual-only progress acknowledgement", () => {
    expect(resolveGuidanceDelivery(step({ delivery: "visual" }), {
      previous: step(),
      trigger: "observation",
    })).toBe("visual");
  });

  it("suppresses a repeated spoken instruction during the cooldown", () => {
    expect(resolveGuidanceDelivery(step(), {
      previous: step(),
      trigger: "observation",
      lastSpokenAt: 1_000,
      now: 5_000,
    })).toBe("silent");
  });

  it("speaks for new steps, direct user turns, blockers, and completion", () => {
    expect(resolveGuidanceDelivery(step({ stepId: "step-2", delivery: "silent" }), {
      previous: step(),
      trigger: "observation",
    })).toBe("spoken");
    expect(resolveGuidanceDelivery(step({ delivery: "silent" }), {
      previous: step(),
      trigger: "user",
    })).toBe("spoken");
    expect(resolveGuidanceDelivery(step({ status: "blocked", delivery: "silent" }), {
      previous: step(),
      trigger: "observation",
    })).toBe("spoken");
    expect(resolveGuidanceDelivery(step({ status: "completed", delivery: "visual" }), {
      previous: step(),
      trigger: "observation",
    })).toBe("spoken");
  });
});
