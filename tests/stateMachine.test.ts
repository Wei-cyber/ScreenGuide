import { describe, expect, it } from "vitest";
import { canTransition, transition } from "../src/shared/stateMachine";

describe("session state machine", () => {
  it("supports the expected happy path", () => {
    expect(transition("setup", "ready")).toBe("ready");
    expect(transition("ready", "connecting")).toBe("connecting");
    expect(transition("connecting", "active")).toBe("active");
    expect(transition("active", "paused")).toBe("paused");
    expect(transition("paused", "active")).toBe("active");
    expect(transition("active", "completed")).toBe("completed");
  });

  it("rejects unsafe jumps", () => {
    expect(canTransition("setup", "active")).toBe(false);
    expect(() => transition("ready", "paused")).toThrow(/Invalid session transition/);
  });
});
