export function averageHash(bitmap: Uint8Array, width: number, height: number): string {
  if (width <= 0 || height <= 0 || bitmap.length < width * height * 4) return "";
  const values: number[] = [];
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    values.push((bitmap[index] + bitmap[index + 1] + bitmap[index + 2]) / 3);
  }
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.map((value) => (value >= average ? "1" : "0")).join("");
}

export function hammingDistance(left: string, right: string): number {
  if (!left || left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) distance += 1;
  }
  return distance;
}

export function frameChanged(previous: string | undefined, next: string, threshold = 8): boolean {
  return !previous || hammingDistance(previous, next) >= threshold;
}

export interface ChangedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameChangeResult {
  changed: boolean;
  changedPixels: number;
  region?: ChangedRegion;
}

/**
 * Detects localized UI changes on a small BGRA proxy image. Unlike a global
 * perceptual hash, this retains dropdowns, tooltips, and other small regions.
 */
export function detectChangedRegion(
  previous: Uint8Array | undefined,
  current: Uint8Array,
  width: number,
  height: number,
  channelThreshold = 20,
  minimumChangedPixels = 3,
  marginPixels = 2,
): FrameChangeResult {
  const requiredLength = width * height * 4;
  if (width <= 0 || height <= 0 || current.length < requiredLength) {
    return { changed: false, changedPixels: 0 };
  }
  if (!previous || previous.length < requiredLength) {
    return { changed: true, changedPixels: width * height, region: { x: 0, y: 0, width: 1, height: 1 } };
  }

  let changedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const difference = (
        Math.abs(current[index] - previous[index])
        + Math.abs(current[index + 1] - previous[index + 1])
        + Math.abs(current[index + 2] - previous[index + 2])
      ) / 3;
      if (difference < channelThreshold) continue;
      changedPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (changedPixels < minimumChangedPixels) return { changed: false, changedPixels };
  const left = Math.max(0, minX - marginPixels);
  const top = Math.max(0, minY - marginPixels);
  const right = Math.min(width, maxX + 1 + marginPixels);
  const bottom = Math.min(height, maxY + 1 + marginPixels);
  return {
    changed: true,
    changedPixels,
    region: {
      x: left / width,
      y: top / height,
      width: (right - left) / width,
      height: (bottom - top) / height,
    },
  };
}
