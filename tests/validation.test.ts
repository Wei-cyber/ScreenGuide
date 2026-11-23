import { describe, expect, it } from "vitest";
import { parseGuidance, redactSecrets } from "../src/shared/validation";

describe("guidance validation", () => {
  it("accepts guidance and retains a confident normalized target", () => {
    const result = parseGuidance({
      stepId: "step-1",
      instruction: "Open Display settings",
      explanation: "This is where Night light is configured.",
      target: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      confidence: 0.9,
      status: "waiting",
      delivery: "spoken",
    });
    expect(result?.target).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.1 });
  });

  it("drops uncertain or out-of-bounds targets without dropping the instruction", () => {
    const result = parseGuidance({
      stepId: "step-2",
      instruction: "Look for Night light",
      explanation: "It may be lower on the page.",
      target: { x: 0.9, y: 0.2, width: 0.3, height: 0.1 },
      confidence: 0.6,
      status: "waiting",
      delivery: "visual",
    });
    expect(result?.target).toBeUndefined();
    expect(result?.instruction).toContain("Night light");
  });

  it("rejects malformed guidance", () => expect(parseGuidance({ instruction: "Click" })).toBeNull());
});

describe("secret redaction", () => {
  it("redacts API keys and bearer tokens", () => {
    const result = redactSecrets("API key=sk-example_1234567890 Authorization: Bearer sk-other_123456789");
    expect(result).not.toContain("example");
    expect(result).not.toContain("other");
    expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
