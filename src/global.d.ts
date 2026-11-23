import type { ScreenGuideApi } from "./shared/types";

declare global {
  interface Window {
    screenGuide: ScreenGuideApi;
  }
}

export {};
