import { describe, expect, it } from "vitest";
// The runtime validator is JavaScript because the sender executes it directly with node.
// @ts-expect-error the runtime module intentionally has no declaration file
import { validateAiIntradayPreflight } from "../scripts/ai-intraday-preflight.mjs";

const symbols = [
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
] as const;

function fixture() {
  const input = {
    tradeDate: "2026-10-14",
    checkpoint: "10:00",
    cutoffCandleTime: "09:59",
    effectiveFrom: "10:00",
    validUntil: "10:14",
    morningSourceSnapshotId: "ai-daily-forecast:2026-10-14:codex-0830-v1",
    inputHash: "a".repeat(64),
    priorData: {
      symbols: symbols.map(symbol => ({
        symbol,
        baseline: {
          atr5: 10,
          forecastLow: 90,
          forecastHigh: 120,
          zoneLow: 100,
          zoneHigh: 105,
          confirmPrice: 103,
          firstTarget: 110,
        },
      })),
    },
    aiSessionStrategyJournal: [
      { symbol: "285A", entrySourceEventId: "event-1" },
    ],
    aiCurrentStrategyPositions: [],
  };
  const payload = {
    sourceRevisionId: "ai-intraday-forecast:2026-10-14:1000:codex-v1",
    morningSourceSnapshotId: input.morningSourceSnapshotId,
    tradeDate: input.tradeDate,
    checkpoint: input.checkpoint,
    capturedAtMs: Date.parse("2026-10-14T01:03:00Z"),
    sourceMode: "scheduled_ai_forecast",
    inputHash: input.inputHash,
    generatorId: "codex-scheduled-task",
    promptVersion: "test",
    aiFinalForecast: {
      forecast: {
        forecasts: symbols.map(symbol => ({
          symbol,
          direction: "range",
          forecastLow: null,
          forecastHigh: null,
          zoneType: "none",
          zoneLow: null,
          zoneHigh: null,
          confirmPrice: null,
          firstTarget: null,
          stretchTarget: null,
          baselineDecision: "reference_only",
          aiAdjustment: { reason: "test", exceptionReason: null },
          rationale: "test",
          evidenceUsed: ["test"],
          macroAgreement: "mixed",
          confidenceBasis: ["test"],
        })),
        marketSummary: "test",
        globalReasonCodes: ["test"],
      },
      controls: symbols.map(symbol => ({
        symbol,
        planDecision: "disabled",
        changeReason: "test",
        entryWindowStart: "10:00",
        entryWindowEnd: "10:14",
        forceExitTime: "10:14",
        openPositionAction: "keep",
        learningEvidenceUsed:
          symbol === "285A" ? ["session_trade:signal_quality:event-1"] : [],
      })),
      checkpointSummary: "test",
    },
  };
  return { input, payload };
}

describe("AI intraday preflight", () => {
  it("accepts a delayed cutoff but rejects a cutoff outside the checkpoint window", () => {
    const { input, payload } = fixture();
    input.cutoffCandleTime = "10:02";
    expect(validateAiIntradayPreflight(payload, input).valid).toBe(true);
    for (const cutoff of ["09:58", "10:14", "10:15"]) {
      input.cutoffCandleTime = cutoff;
      expect(validateAiIntradayPreflight(payload, input).reasonCodes).toContain("local_checkpoint_spec_mismatch");
    }
  });
  it("accepts a server-compatible payload", () => {
    const { input, payload } = fixture();
    expect(validateAiIntradayPreflight(payload, input)).toEqual({
      valid: true,
      reasonCodes: [],
    });
  });

  it("accepts explicit management-only independently of tightening", () => {
    const { input, payload } = fixture();
    Object.assign(payload.aiFinalForecast.controls[0], {
      entryPolicy: "manage_only",
      openPositionAction: "tighten_only",
    });
    expect(validateAiIntradayPreflight(payload, input).valid).toBe(true);
  });

  it("rejects a LONG confirm price outside its entry zone", () => {
    const { input, payload } = fixture();
    payload.aiFinalForecast.forecast.forecasts[0] = {
      ...payload.aiFinalForecast.forecast.forecasts[0],
      direction: "up",
      forecastLow: 90,
      forecastHigh: 130,
      zoneType: "pullback",
      zoneLow: 100,
      zoneHigh: 110,
      confirmPrice: 111,
      firstTarget: 120,
      stretchTarget: 125,
      baselineDecision: "adjusted",
      aiAdjustment: { reason: "test", exceptionReason: "test" },
    };
    const result = validateAiIntradayPreflight(payload, input);
    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain("long_levels_invalid:285A");
  });

  it("rejects missing same-day strategy evidence", () => {
    const { input, payload } = fixture();
    payload.aiFinalForecast.controls[0].learningEvidenceUsed = [];
    const result = validateAiIntradayPreflight(payload, input);
    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain(
      "session_trade_evidence_missing:285A:session_trade:signal_quality:event-1"
    );
  });

  it("rejects a lunch-break entry window before the 12:30 reopen", () => {
    const { input, payload } = fixture();
    input.checkpoint = "11:30";
    input.cutoffCandleTime = "11:29";
    input.effectiveFrom = "11:30";
    input.validUntil = "12:34";
    payload.checkpoint = "11:30";
    payload.sourceRevisionId = "ai-intraday-forecast:2026-10-14:1130:codex-v1";
    payload.capturedAtMs = Date.parse("2026-10-14T02:33:00Z");
    for (const control of payload.aiFinalForecast.controls) {
      control.entryWindowStart = "11:30";
      control.entryWindowEnd = "12:34";
      control.forceExitTime = "12:34";
    }
    const result = validateAiIntradayPreflight(payload, input);
    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain("lunch_entry_window_invalid:285A");
  });

  it("rejects a non-disabled 11:30 plan for a flat symbol", () => {
    const { input, payload } = fixture();
    input.checkpoint = "11:30";
    input.cutoffCandleTime = "11:29";
    input.effectiveFrom = "11:30";
    input.validUntil = "12:34";
    payload.checkpoint = "11:30";
    payload.sourceRevisionId = "ai-intraday-forecast:2026-10-14:1130:codex-v1";
    payload.capturedAtMs = Date.parse("2026-10-14T02:33:00Z");
    for (const control of payload.aiFinalForecast.controls) {
      control.entryWindowStart = "12:30";
      control.entryWindowEnd = "12:34";
      control.forceExitTime = "12:34";
    }
    payload.aiFinalForecast.controls[0].planDecision = "maintained";
    const result = validateAiIntradayPreflight(payload, input);
    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain(
      "lunch_flat_symbol_must_be_disabled:285A"
    );
  });
});

it("validates the separate management wire schema and its causal references before sending", () => {
  const { input, payload } = fixture();
  const command = {
    planId: "m",
    positionId: "285A:long:event-1",
    symbol: "285A",
    side: "long",
    basedOnEventId: "observed",
    action: "hold",
    protectiveStop: 95,
    validUntil: "10:30",
    reason: "context",
    knowledgeIds: [],
  };
  Object.assign(input, {
    aiCurrentPositions: [
      {
        symbol: "285A",
        side: "long",
        entrySourceEventId: "event-1",
        positionId: command.positionId,
      },
    ],
    managementDecisionEvents: [{ symbol: "285A", sourceEventId: "observed" }],
  });
  Object.assign(payload.aiFinalForecast, { managementPlans: [command] });
  expect(validateAiIntradayPreflight(payload, input).valid).toBe(true);
  command.basedOnEventId = "future";
  expect(validateAiIntradayPreflight(payload, input).reasonCodes).toContain(
    "management_basis_event_unknown:future"
  );
});
