import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const SYMBOLS = [
  "285A",
  "3436",
  "5803",
  "6146",
  "6526",
  "6857",
  "6976",
  "6981",
  "8035",
  "9984",
];

const CHECKPOINTS = {
  "09:15": { cutoff: "09:14", effectiveFrom: "09:15", validUntil: "09:29" },
  "09:30": { cutoff: "09:29", effectiveFrom: "09:30", validUntil: "09:44" },
  "09:45": { cutoff: "09:44", effectiveFrom: "09:45", validUntil: "09:59" },
  "10:00": { cutoff: "09:59", effectiveFrom: "10:00", validUntil: "10:14" },
  "10:15": { cutoff: "10:14", effectiveFrom: "10:15", validUntil: "10:29" },
  "10:30": { cutoff: "10:29", effectiveFrom: "10:30", validUntil: "10:44" },
  "10:45": { cutoff: "10:44", effectiveFrom: "10:45", validUntil: "10:59" },
  "11:00": { cutoff: "10:59", effectiveFrom: "11:00", validUntil: "11:14" },
  "11:15": { cutoff: "11:14", effectiveFrom: "11:15", validUntil: "11:29" },
  "11:30": { cutoff: "11:29", effectiveFrom: "11:30", validUntil: "12:34" },
  "12:35": { cutoff: "12:34", effectiveFrom: "12:35", validUntil: "12:59" },
  "13:00": { cutoff: "12:59", effectiveFrom: "13:00", validUntil: "13:29" },
  "13:30": { cutoff: "13:29", effectiveFrom: "13:30", validUntil: "13:59" },
  "14:00": { cutoff: "13:59", effectiveFrom: "14:00", validUntil: "14:29" },
  "14:30": { cutoff: "14:29", effectiveFrom: "14:30", validUntil: "14:59" },
  "15:00": { cutoff: "14:59", effectiveFrom: "15:00", validUntil: "15:19" },
};

const symbolSchema = z.enum(SYMBOLS);
const forecastRowSchema = z
  .object({
    symbol: symbolSchema,
    direction: z.enum([
      "strong_up",
      "up",
      "range",
      "down",
      "strong_down",
      "insufficient",
      "stale",
    ]),
    forecastLow: z.number().positive().nullable(),
    forecastHigh: z.number().positive().nullable(),
    zoneType: z.enum(["pullback", "return_sell", "none"]),
    zoneLow: z.number().positive().nullable(),
    zoneHigh: z.number().positive().nullable(),
    confirmPrice: z.number().positive().nullable(),
    protectiveStop: z.number().finite().positive().optional(),
    knowledgeIds: z.array(z.string().min(1).max(180)).max(100).optional(),
    firstTarget: z.number().positive().nullable(),
    stretchTarget: z.number().positive().nullable(),
    baselineDecision: z.enum(["maintained", "adjusted", "reference_only"]),
    aiAdjustment: z
      .object({
        reason: z.string().min(1).max(320),
        exceptionReason: z.string().max(320).nullable(),
      })
      .strict(),
    rationale: z.string().min(1).max(480),
    evidenceUsed: z.array(z.string().min(1).max(120)).min(1).max(10),
    macroAgreement: z.enum(["aligned", "conflicted", "mixed", "unavailable"]),
    confidenceBasis: z.array(z.string().min(1).max(120)).min(1).max(10),
  })
  .strict();

const dailyOutputSchema = z
  .object({
    forecasts: z.array(forecastRowSchema).length(10),
    marketSummary: z.string().min(1).max(600),
    globalReasonCodes: z.array(z.string().min(1).max(120)).min(1).max(10),
  })
  .strict();

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
/** Separate from entry forecasts. No quantity: every exit closes all shares. */
const aiPositionManagementPlanSchema = z
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

const controlSchema = z
  .object({
    symbol: symbolSchema,
    planDecision: z.enum(["maintained", "adjusted", "disabled"]),
    changeReason: z.string().min(1).max(480),
    entryWindowStart: z.string().regex(/^\d{2}:\d{2}$/),
    entryWindowEnd: z.string().regex(/^\d{2}:\d{2}$/),
    forceExitTime: z.string().regex(/^\d{2}:\d{2}$/),
    entryPolicy: z.enum(["entry_allowed", "manage_only"]).optional(),
    openPositionAction: z.enum([
      "keep",
      "tighten_only",
      "exit_next_event_if_direction_changed",
    ]),
    learningEvidenceUsed: z.array(z.string().min(1).max(160)).max(500),
  })
  .strict();

const outputSchema = z
  .object({
    managementPlans: z.array(aiPositionManagementPlanSchema).max(20).optional(),
    forecast: dailyOutputSchema,
    controls: z.array(controlSchema).length(10),
    checkpointSummary: z.string().min(1).max(600),
  })
  .strict();

const submissionSchema = z.object({
  sourceRevisionId: z.string().min(1),
  morningSourceSnapshotId: z.string().min(1),
  tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkpoint: z.enum(Object.keys(CHECKPOINTS)),
  capturedAtMs: z.number().int().positive(),
  sourceMode: z.enum(["scheduled_ai_forecast", "manual_dry_run"]),
  inputHash: z.string().min(1),
  aiFinalForecast: z.unknown(),
  generatorId: z.string().min(1),
  promptVersion: z.string().min(1),
  generatorMetadata: z.record(z.string(), z.unknown()).optional(),
});

const inputSchema = z.object({
  aiCurrentPositions: z
    .array(
      z.object({
        positionId: z.string().optional(),
        symbol: symbolSchema,
        side: z.enum(["long", "short"]),
        entrySourceEventId: z.string(),
      })
    )
    .optional(),
  managementDecisionEvents: z
    .array(z.object({ symbol: symbolSchema, sourceEventId: z.string() }))
    .optional(),
  latestLearningReview: z
    .object({
      review: z
        .object({
          knowledge: z.array(z.object({ knowledgeId: z.string() })).optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
  tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkpoint: z.enum(Object.keys(CHECKPOINTS)),
  cutoffCandleTime: z.string().regex(/^\d{2}:\d{2}$/),
  effectiveFrom: z.string().regex(/^\d{2}:\d{2}$/),
  validUntil: z.string().regex(/^\d{2}:\d{2}$/),
  morningSourceSnapshotId: z.string().min(1),
  inputHash: z.string().min(1),
  priorData: z.object({
    symbols: z.array(
      z.object({
        symbol: symbolSchema,
        baseline: z.object({
          atr5: z.number().positive().nullable(),
          forecastLow: z.number().positive().nullable(),
          forecastHigh: z.number().positive().nullable(),
          zoneLow: z.number().positive().nullable(),
          zoneHigh: z.number().positive().nullable(),
          confirmPrice: z.number().positive().nullable(),
          protectiveStop: z.number().finite().positive().optional(),
          knowledgeIds: z.array(z.string().min(1).max(180)).max(100).optional(),
          firstTarget: z.number().positive().nullable(),
        }),
      })
    ),
  }),
  aiSessionStrategyJournal: z
    .array(
      z.object({
        symbol: symbolSchema,
        entrySourceEventId: z.string().min(1),
      })
    )
    .optional(),
  aiCurrentStrategyPositions: z
    .array(
      z.object({
        symbol: symbolSchema,
      })
    )
    .optional(),
});

function jpxTickSize(price) {
  if (price < 1_000) return 0.1;
  if (price < 3_000) return 0.5;
  if (price < 5_000) return 1;
  if (price < 30_000) return 5;
  if (price < 50_000) return 10;
  if (price < 300_000) return 50;
  if (price < 500_000) return 100;
  if (price < 3_000_000) return 500;
  return 1_000;
}

function jstDateTime(epochMs) {
  const value = new Date(epochMs + 9 * 60 * 60 * 1_000).toISOString();
  return { date: value.slice(0, 10), time: value.slice(11, 16) };
}

function zodReason(prefix, error) {
  const first = error.issues[0];
  const path = first?.path?.length ? `:${first.path.join(".")}` : "";
  return `${prefix}${path}`;
}

/** Mirrors the server's deterministic validation without making a network call. */
export function validateAiIntradayPreflight(rawSubmission, rawInput) {
  const reasons = [];
  const submissionResult = submissionSchema.safeParse(rawSubmission);
  if (!submissionResult.success) {
    return {
      valid: false,
      reasonCodes: [
        zodReason("submission_schema_invalid", submissionResult.error),
      ],
    };
  }
  const inputResult = inputSchema.safeParse(rawInput);
  if (!inputResult.success) {
    return {
      valid: false,
      reasonCodes: [zodReason("input_schema_invalid", inputResult.error)],
    };
  }

  const submission = submissionResult.data;
  const input = inputResult.data;
  const spec = CHECKPOINTS[submission.checkpoint];

  if (
    !/^ai-intraday-forecast:\d{4}-\d{2}-\d{2}:\d{4}:[a-z0-9._:-]{1,100}$/i.test(
      submission.sourceRevisionId
    )
  )
    reasons.push("ai_intraday_source_revision_id_invalid");
  if (
    !submission.sourceRevisionId.startsWith(
      `ai-intraday-forecast:${submission.tradeDate}:${submission.checkpoint.replace(":", "")}:`
    )
  )
    reasons.push("ai_intraday_source_revision_checkpoint_mismatch");

  const captured = jstDateTime(submission.capturedAtMs);
  if (
    captured.date !== submission.tradeDate ||
    captured.time < submission.checkpoint ||
    captured.time > spec.validUntil
  )
    reasons.push("ai_intraday_capture_outside_checkpoint_window_jst");

  if (submission.tradeDate !== input.tradeDate)
    reasons.push("local_trade_date_mismatch");
  if (submission.checkpoint !== input.checkpoint)
    reasons.push("local_checkpoint_mismatch");
  if (submission.morningSourceSnapshotId !== input.morningSourceSnapshotId)
    reasons.push("ai_intraday_morning_snapshot_mismatch");
  if (submission.inputHash !== input.inputHash)
    reasons.push("ai_intraday_input_hash_mismatch");
  if (
    input.cutoffCandleTime !== spec.cutoff ||
    input.effectiveFrom !== spec.effectiveFrom ||
    input.validUntil !== spec.validUntil
  )
    reasons.push("local_checkpoint_spec_mismatch");

  const outputResult = outputSchema.safeParse(submission.aiFinalForecast);
  if (!outputResult.success) {
    reasons.push(
      zodReason("ai_intraday_output_schema_invalid", outputResult.error)
    );
    return { valid: false, reasonCodes: Array.from(new Set(reasons)) };
  }

  const output = outputResult.data;
  const baselineBySymbol = new Map(
    input.priorData.symbols.map(item => [item.symbol, item.baseline])
  );
  const forecastSymbols = new Set();
  for (const row of output.forecast.forecasts) {
    if (forecastSymbols.has(row.symbol))
      reasons.push(`duplicate_symbol:${row.symbol}`);
    forecastSymbols.add(row.symbol);
    const baseline = baselineBySymbol.get(row.symbol);
    if (!baseline) {
      reasons.push(`baseline_missing:${row.symbol}`);
      continue;
    }
    const directional = ["strong_up", "up", "down", "strong_down"].includes(
      row.direction
    );
    const prices = [
      row.forecastLow,
      row.forecastHigh,
      row.zoneLow,
      row.zoneHigh,
      row.confirmPrice,
      row.firstTarget,
      row.stretchTarget,
    ];
    if (!directional && prices.some(value => value !== null))
      reasons.push(`non_directional_prices_present:${row.symbol}`);
    if (!directional && row.zoneType !== "none")
      reasons.push(`non_directional_zone_type_invalid:${row.symbol}`);
    if (directional && prices.some(value => value === null))
      reasons.push(`directional_prices_missing:${row.symbol}`);
    if (
      directional &&
      !(
        row.forecastLow < row.zoneLow &&
        row.zoneLow <= row.zoneHigh &&
        row.zoneHigh < row.forecastHigh
      )
    )
      reasons.push(`price_order_invalid:${row.symbol}`);
    if (
      directional &&
      ["strong_up", "up"].includes(row.direction) &&
      !(
        row.confirmPrice >= row.zoneLow &&
        row.confirmPrice <= row.zoneHigh &&
        row.firstTarget > row.confirmPrice &&
        row.stretchTarget >= row.firstTarget
      )
    )
      reasons.push(`long_levels_invalid:${row.symbol}`);
    if (
      directional &&
      ["strong_down", "down"].includes(row.direction) &&
      !(
        row.confirmPrice >= row.zoneLow &&
        row.confirmPrice <= row.zoneHigh &&
        row.firstTarget < row.confirmPrice &&
        row.stretchTarget <= row.firstTarget
      )
    )
      reasons.push(`short_levels_invalid:${row.symbol}`);

    if (baseline.atr5 && row.baselineDecision === "adjusted") {
      const compared = [
        [row.forecastLow, baseline.forecastLow],
        [row.forecastHigh, baseline.forecastHigh],
        [row.zoneLow, baseline.zoneLow],
        [row.zoneHigh, baseline.zoneHigh],
        [row.confirmPrice, baseline.confirmPrice],
        [row.firstTarget, baseline.firstTarget],
      ];
      const exceeded = compared.some(
        ([actual, original]) =>
          actual !== null &&
          original !== null &&
          Math.abs(actual - original) >
            baseline.atr5 * 0.75 + jpxTickSize(actual)
      );
      if (exceeded && !row.aiAdjustment.exceptionReason)
        reasons.push(
          `adjustment_exceeds_075_atr_without_exception:${row.symbol}`
        );
    }
  }
  for (const symbol of SYMBOLS)
    if (!forecastSymbols.has(symbol)) reasons.push(`missing_symbol:${symbol}`);

  const knownKnowledge = new Set(
    (input.latestLearningReview?.review?.knowledge ?? []).map(
      row => row.knowledgeId
    )
  );
  const commandIds = new Set();
  const positionIds = new Set();
  for (const command of output.managementPlans ?? []) {
    if (commandIds.has(command.planId) || positionIds.has(command.positionId))
      reasons.push(`duplicate_management_command:${command.planId}`);
    commandIds.add(command.planId);
    positionIds.add(command.positionId);
    if (
      !(input.aiCurrentPositions ?? []).some(
        row =>
          (row.positionId ??
            `${row.symbol}:${row.side}:${row.entrySourceEventId}`) ===
            command.positionId &&
          row.symbol === command.symbol &&
          row.side === command.side
      )
    )
      reasons.push(`management_position_not_open:${command.positionId}`);
    if (
      !(input.managementDecisionEvents ?? []).some(
        row =>
          row.symbol === command.symbol &&
          row.sourceEventId === command.basedOnEventId
      )
    )
      reasons.push(`management_basis_event_unknown:${command.basedOnEventId}`);
    if (
      command.validUntil <= input.effectiveFrom ||
      command.validUntil > "15:20"
    )
      reasons.push(`management_valid_until_invalid:${command.planId}`);
    for (const id of command.knowledgeIds)
      if (!knownKnowledge.has(id))
        reasons.push(`management_knowledge_unknown:${id}`);
  }
  for (const row of output.forecast.forecasts) {
    for (const id of row.knowledgeIds ?? [])
      if (!knownKnowledge.has(id))
        reasons.push(`entry_knowledge_unknown:${id}`);
  }
  const controlBySymbol = new Map();
  const openStrategySymbols = new Set(
    (input.aiCurrentStrategyPositions ?? []).map(item => item.symbol)
  );
  for (const control of output.controls) {
    if (controlBySymbol.has(control.symbol))
      reasons.push(`duplicate_control_symbol:${control.symbol}`);
    controlBySymbol.set(control.symbol, control);
    if (
      control.entryWindowStart < input.effectiveFrom ||
      control.entryWindowEnd > input.validUntil ||
      control.entryWindowStart > control.entryWindowEnd
    )
      reasons.push(`entry_window_outside_checkpoint:${control.symbol}`);
    if (
      submission.checkpoint === "11:30" &&
      (control.entryWindowStart < "12:30" || control.entryWindowEnd > "12:34")
    )
      reasons.push(`lunch_entry_window_invalid:${control.symbol}`);
    if (
      submission.checkpoint === "11:30" &&
      !openStrategySymbols.has(control.symbol) &&
      control.planDecision !== "disabled"
    )
      reasons.push(`lunch_flat_symbol_must_be_disabled:${control.symbol}`);
    if (
      control.forceExitTime < control.entryWindowEnd ||
      control.forceExitTime > "15:20"
    )
      reasons.push(`force_exit_time_invalid:${control.symbol}`);
  }
  for (const symbol of SYMBOLS) {
    const control = controlBySymbol.get(symbol);
    if (!control) reasons.push(`missing_control_symbol:${symbol}`);
    const required = (input.aiSessionStrategyJournal ?? [])
      .filter(item => item.symbol === symbol)
      .map(item => `session_trade:signal_quality:${item.entrySourceEventId}`);
    for (const evidence of required)
      if (!control?.learningEvidenceUsed.includes(evidence))
        reasons.push(`session_trade_evidence_missing:${symbol}:${evidence}`);
  }

  return {
    valid: reasons.length === 0,
    reasonCodes: Array.from(new Set(reasons)),
  };
}

export function inferAiIntradayInputPath(forecastFile, payload) {
  return resolve(
    dirname(forecastFile),
    `runtime-ai-intraday-input-${payload.tradeDate}-${String(payload.checkpoint).replace(":", "")}.json`
  );
}

export async function validateAiIntradayFiles(forecastFile, inputFile) {
  const payload = JSON.parse(await readFile(forecastFile, "utf8"));
  const resolvedInput =
    inputFile ?? inferAiIntradayInputPath(forecastFile, payload);
  const input = JSON.parse(await readFile(resolvedInput, "utf8"));
  return {
    ...validateAiIntradayPreflight(payload, input),
    payload,
    inputFile: resolvedInput,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const forecastFile = args[0];
  const inputFlag = args.indexOf("--input");
  const inputFile = inputFlag >= 0 ? args[inputFlag + 1] : undefined;
  if (!forecastFile || (inputFlag >= 0 && !inputFile))
    throw new Error(
      "usage: node scripts/ai-intraday-preflight.mjs /secure/path/intraday-forecast.json [--input /secure/path/intraday-input.json]"
    );
  const startedAt = Date.now();
  const result = await validateAiIntradayFiles(forecastFile, inputFile);
  if (!result.valid)
    throw new Error(
      `ai_intraday_preflight_failed:${result.reasonCodes.join(",")}`
    );
  console.log(
    JSON.stringify(
      {
        status: "valid",
        sourceRevisionId: result.payload.sourceRevisionId,
        tradeDate: result.payload.tradeDate,
        checkpoint: result.payload.checkpoint,
        validationMs: Date.now() - startedAt,
      },
      null,
      2
    )
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
