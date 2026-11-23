import { describe, expect, it } from "vitest";
import { averageHash, detectChangedRegion, frameChanged, hammingDistance } from "../src/shared/frame";

describe("frame change detection", () => {
  it("creates a stable average hash", () => {
    const pixels = new Uint8Array([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
    expect(averageHash(pixels, 2, 1)).toBe("01");
  });

  it("measures changes and skips nearly identical frames", () => {
    expect(hammingDistance("0000", "0101")).toBe(2);
    expect(frameChanged("0000000000", "0000000001", 2)).toBe(false);
    expect(frameChanged("0000000000", "1110000000", 2)).toBe(true);
  });

  it("detects a small localized menu while ignoring a one-pixel cursor change", () => {
    const width = 16;
    const height = 9;
    const previous = new Uint8Array(width * height * 4);
    const menuFrame = previous.slice();
    for (let y = 1; y <= 4; y += 1) {
      for (let x = 0; x <= 2; x += 1) {
        const index = (y * width + x) * 4;
        menuFrame[index] = 240;
        menuFrame[index + 1] = 240;
        menuFrame[index + 2] = 240;
      }
    }
    const menuChange = detectChangedRegion(previous, menuFrame, width, height);
    expect(menuChange.changed).toBe(true);
    expect(menuChange.region?.x).toBe(0);
    expect(menuChange.region?.width).toBeLessThan(0.5);

    const cursorFrame = previous.slice();
    cursorFrame[0] = 255;
    cursorFrame[1] = 255;
    cursorFrame[2] = 255;
    expect(detectChangedRegion(previous, cursorFrame, width, height).changed).toBe(false);
  });
});
