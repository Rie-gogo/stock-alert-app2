import { z } from "zod";

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
/** Separate from entry forecasts. No quantity: every exit closes all shares. */
export const aiPositionManagementPlanSchema = z
  .object({
    planId: z.string().min(1).max(180),
    positionId: z.string().min(1).max(180),
    symbol: z.string().min(1).max(16),
    side: z.enum(["long", "short"]),
    basedOnEventId: z.string().min(1).max(180),
    action: z.enum(["hold", "take_profit", "exit"]),
    protectiveStop: z.number().finite().positive(),
    hardStop: z.number().finite().positive().optional(),
    validUntil: time,
    reason: z.string().min(1).max(1000),
    knowledgeIds: z.array(z.string().min(1).max(180)).max(100),
  })
  .strict();
export type AiPositionManagementPlan = z.infer<
  typeof aiPositionManagementPlanSchema
>;

/** The entry event is immutable and unique within a symbol/side trading day. */
export function aiPositionId(
  symbol: string,
  side: string,
  entrySourceEventId: string
) {
  return `${symbol}:${side}:${entrySourceEventId}`;
}
