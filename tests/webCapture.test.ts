import { describe, expect, it } from "vitest";
import { containedSize, paddedRegion } from "../web/src/capture";

describe("web capture geometry", () => {
  it("keeps a high-resolution overview within its maximum edge", () => {
    expect(containedSize(3840, 2160, 1920)).toEqual({ width: 1920, height: 1080 });
    expect(containedSize(1280, 720, 1920)).toEqual({ width: 1280, height: 720 });
  });

  it("pads a changed crop without crossing normalized bounds", () => {
    expect(paddedRegion({ x: 0.01, y: 0.95, width: 0.1, height: 0.04 }, 0.03)).toEqual({
      x: 0,
      y: 0.9199999999999999,
      width: 0.14,
      height: 0.08000000000000007,
    });
  });
});
