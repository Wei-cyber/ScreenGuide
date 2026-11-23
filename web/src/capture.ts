import { detectChangedRegion, type ChangedRegion } from "../../src/shared/frame";

export interface ScreenObservation {
  overviewDataUrl: string;
  width: number;
  height: number;
  detailDataUrl?: string;
  detailRegion?: ChangedRegion;
  capturedAt: number;
}

export interface CaptureCallbacks {
  onObservation: (observation: ScreenObservation) => void;
  onEnded: () => void;
  onError: (message: string) => void;
}

export function containedSize(width: number, height: number, maximumEdge: number) {
  const scale = Math.min(1, maximumEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function paddedRegion(region: ChangedRegion, padding = 0.035): ChangedRegion {
  const x = Math.max(0, region.x - padding);
  const y = Math.max(0, region.y - padding);
  const right = Math.min(1, region.x + region.width + padding);
  const bottom = Math.min(1, region.y + region.height + padding);
  return { x, y, width: right - x, height: bottom - y };
}

function canvasDataUrl(canvas: HTMLCanvasElement, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not encode the shared screen."));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not read the shared screen."));
      reader.readAsDataURL(blob);
    }, "image/jpeg", quality);
  });
}

export class BrowserCapture {
  private stream?: MediaStream;
  private video?: HTMLVideoElement;
  private timer?: number;
  private settleTimer?: number;
  private previousProxy?: Uint8Array;
  private pendingRegion?: ChangedRegion;
  private lastObservationAt = 0;
  private paused = false;
  private encoding = false;

  constructor(private readonly callbacks: CaptureCallbacks) {}

  async start(video: HTMLVideoElement) {
    this.video = video;
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 6, max: 10 },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
      audio: false,
    });
    const track = this.stream.getVideoTracks()[0];
    if (!track) throw new Error("No screen video was provided.");
    track.addEventListener("ended", () => this.callbacks.onEnded(), { once: true });
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    await this.observe({ x: 0, y: 0, width: 1, height: 1 });
    this.timer = window.setInterval(() => void this.sample(), 250);
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    for (const track of this.stream?.getVideoTracks() ?? []) track.enabled = !paused;
    if (paused && this.settleTimer !== undefined) window.clearTimeout(this.settleTimer);
    if (!paused) {
      this.previousProxy = undefined;
      window.setTimeout(() => void this.observe({ x: 0, y: 0, width: 1, height: 1 }), 150);
    }
  }

  stop() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    if (this.settleTimer !== undefined) window.clearTimeout(this.settleTimer);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    if (this.video) this.video.srcObject = null;
    this.timer = undefined;
    this.settleTimer = undefined;
    this.stream = undefined;
    this.previousProxy = undefined;
  }

  private async sample() {
    if (this.paused || this.encoding || !this.video || this.video.readyState < 2) return;
    const proxy = document.createElement("canvas");
    proxy.width = 80;
    proxy.height = 45;
    const context = proxy.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(this.video, 0, 0, proxy.width, proxy.height);
    const current = new Uint8Array(context.getImageData(0, 0, proxy.width, proxy.height).data);
    if (!this.previousProxy) {
      this.previousProxy = current;
      return;
    }
    const change = detectChangedRegion(this.previousProxy, current, proxy.width, proxy.height, 14, 3, 2);
    this.previousProxy = current;
    if (!change.changed || !change.region) return;

    this.pendingRegion = change.region;
    if (this.settleTimer !== undefined) window.clearTimeout(this.settleTimer);
    const elapsed = Date.now() - this.lastObservationAt;
    const delay = Math.max(320, 1_200 - elapsed);
    this.settleTimer = window.setTimeout(() => {
      const region = this.pendingRegion;
      this.pendingRegion = undefined;
      if (region) void this.observe(region);
    }, delay);
  }

  private async observe(changedRegion: ChangedRegion) {
    if (this.paused || this.encoding || !this.video) return;
    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    if (!sourceWidth || !sourceHeight) return;
    this.encoding = true;
    try {
      const overviewSize = containedSize(sourceWidth, sourceHeight, 1920);
      const overview = document.createElement("canvas");
      overview.width = overviewSize.width;
      overview.height = overviewSize.height;
      overview.getContext("2d")?.drawImage(this.video, 0, 0, overview.width, overview.height);
      const overviewDataUrl = await canvasDataUrl(overview, 0.78);

      const detailRegion = paddedRegion(changedRegion);
      const shouldCrop = detailRegion.width * detailRegion.height < 0.72;
      let detailDataUrl: string | undefined;
      if (shouldCrop) {
        const sx = Math.round(detailRegion.x * sourceWidth);
        const sy = Math.round(detailRegion.y * sourceHeight);
        const sw = Math.max(1, Math.round(detailRegion.width * sourceWidth));
        const sh = Math.max(1, Math.round(detailRegion.height * sourceHeight));
        const detailSize = containedSize(sw, sh, 1600);
        const detail = document.createElement("canvas");
        detail.width = detailSize.width;
        detail.height = detailSize.height;
        detail.getContext("2d")?.drawImage(this.video, sx, sy, sw, sh, 0, 0, detail.width, detail.height);
        detailDataUrl = await canvasDataUrl(detail, 0.86);
      }

      this.lastObservationAt = Date.now();
      this.callbacks.onObservation({
        overviewDataUrl,
        width: sourceWidth,
        height: sourceHeight,
        detailDataUrl,
        detailRegion: detailDataUrl ? detailRegion : undefined,
        capturedAt: this.lastObservationAt,
      });
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error.message : "Screen capture failed.");
    } finally {
      this.encoding = false;
    }
  }
}
