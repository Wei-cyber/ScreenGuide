import { describe, expect, it } from "vitest";
import { isExplicitSessionEndRequest } from "../src/main/realtime";

describe("explicit session end intent", () => {
  it.each([
    "Please end the session",
    "Stop ScreenGuide",
    "end it",
    "I want to end it",
    "Can you close the coaching session?",
    "I would like to quit this session",
  ])("accepts an unambiguous request: %s", (text) => {
    expect(isExplicitSessionEndRequest(text)).toBe(true);
  });

  it.each([
    "Do not end the session",
    "Stop talking and show me the button",
    "Pause for a moment",
    "The task is complete",
    "I am done with this step",
    "Close the File menu",
  ])("does not confuse task language with ending coaching: %s", (text) => {
    expect(isExplicitSessionEndRequest(text)).toBe(false);
  });
});
