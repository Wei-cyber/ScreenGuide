import { describe, expect, it } from "vitest";
import { windowHandleFromSourceId } from "../src/main/windows";

describe("Windows capture source IDs", () => {
  it("extracts only a numeric handle from a window source", () => {
    expect(windowHandleFromSourceId("window:123456:0")).toBe("123456");
  });

  it("rejects screens and malformed or injectable handles", () => {
    expect(windowHandleFromSourceId("screen:0:0")).toBeNull();
    expect(windowHandleFromSourceId("window:12;Remove-Item:0")).toBeNull();
    expect(windowHandleFromSourceId("window::0")).toBeNull();
  });
});
