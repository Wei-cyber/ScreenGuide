import type { GuidanceStep, NormalizedRect } from "./types";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function isNormalizedRect(value: unknown): value is NormalizedRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  if (![rect.x, rect.y, rect.width, rect.height].every(isFiniteNumber)) return false;
  return (
    (rect.x as number) >= 0 &&
    (rect.y as number) >= 0 &&
    (rect.width as number) > 0 &&
    (rect.height as number) > 0 &&
    (rect.x as number) + (rect.width as number) <= 1 &&
    (rect.y as number) + (rect.height as number) <= 1
  );
}

export function parseGuidance(value: unknown): GuidanceStep | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.stepId !== "string" ||
    candidate.stepId.trim().length === 0 ||
    typeof candidate.instruction !== "string" ||
    candidate.instruction.trim().length === 0 ||
    typeof candidate.explanation !== "string" ||
    !isFiniteNumber(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1 ||
    !["waiting", "completed", "blocked"].includes(String(candidate.status)) ||
    !["silent", "visual", "spoken"].includes(String(candidate.delivery))
  ) {
    return null;
  }

  const parsed: GuidanceStep = {
    stepId: candidate.stepId.trim().slice(0, 80),
    instruction: candidate.instruction.trim().slice(0, 500),
    explanation: candidate.explanation.trim().slice(0, 800),
    confidence: candidate.confidence,
    status: candidate.status as GuidanceStep["status"],
    delivery: candidate.delivery as GuidanceStep["delivery"],
  };

  if (isNormalizedRect(candidate.target) && candidate.confidence >= 0.72) {
    parsed.target = candidate.target;
  }

  return parsed;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
