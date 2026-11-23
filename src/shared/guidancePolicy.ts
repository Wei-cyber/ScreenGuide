import type { GuidanceDelivery, GuidanceStep } from "./types";

export type GuidanceTrigger = "observation" | "user" | "continuation";

export interface GuidancePolicyContext {
  previous?: GuidanceStep;
  trigger: GuidanceTrigger;
  lastSpokenAt?: number;
  now?: number;
}

const REPEAT_COOLDOWN_MS = 20_000;

/**
 * Enforces ScreenGuide's three-level response policy independently of model
 * phrasing. Direct user turns, new steps, blockers, and completion may speak.
 * Repeated observations are kept silent even if the model asks to narrate them.
 */
export function resolveGuidanceDelivery(
  guidance: GuidanceStep,
  context: GuidancePolicyContext,
): GuidanceDelivery {
  if (context.trigger === "user") return "spoken";
  if (guidance.status === "completed" || guidance.status === "blocked") return "spoken";

  const previous = context.previous;
  if (!previous || previous.stepId !== guidance.stepId) return "spoken";
  if (guidance.delivery === "silent" || guidance.delivery === "visual") return guidance.delivery;

  const instructionChanged = previous.instruction.trim().toLocaleLowerCase()
    !== guidance.instruction.trim().toLocaleLowerCase();
  if (instructionChanged) return "spoken";

  const now = context.now ?? Date.now();
  if (context.lastSpokenAt !== undefined && now - context.lastSpokenAt >= REPEAT_COOLDOWN_MS) {
    return "spoken";
  }
  return "silent";
}
