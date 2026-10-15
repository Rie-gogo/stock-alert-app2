import { z } from "zod";

/** Decision facts and later outcomes have distinct timestamps and evidence IDs. */
export const aiDecisionKnowledgeSchema = z
  .object({
    knowledgeId: z.string().min(1).max(180),
    symbol: z.string().min(1).max(16),
    side: z.enum(["long", "short"]),
    decisionFacts: z
      .object({
        asOf: z.string().datetime({ offset: true }),
        eventIds: z.array(z.string().min(1)).min(1).max(100),
        facts: z.array(z.string().min(1).max(1000)).min(1).max(100),
      })
      .strict(),
    decisionReason: z.string().min(1).max(2000),
    actualOutcome: z
      .object({
        observedAt: z.string().datetime({ offset: true }),
        eventIds: z.array(z.string().min(1)).min(1).max(100),
        result: z.string().min(1).max(2000),
      })
      .strict(),
    lessonCandidate: z.string().min(1).max(2000),
    counterexamples: z.array(z.string().min(1).max(1000)).max(100),
    uncertainty: z.array(z.string().min(1).max(1000)).min(1).max(100),
    status: z.enum(["candidate", "validated", "rejected"]),
  })
  .strict()
  .refine(
    row =>
      Date.parse(row.actualOutcome.observedAt) >=
      Date.parse(row.decisionFacts.asOf),
    { message: "outcome_must_not_precede_decision" }
  );
export type AiDecisionKnowledge = z.infer<typeof aiDecisionKnowledgeSchema>;
