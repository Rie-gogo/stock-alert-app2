import type { RtRealtimeDecisionEvent, RtSourceEvent } from "../drizzle/schema";
import {
  getRtRealtimeDecisionEventsForDate,
  getRtSourceEventsForDate,
  upsertRtReplayComparison,
} from "./db";
import { sha256Stable } from "./runtimeIdentity";
import {
  TEL_AUDIT_EVALUATION_START_DATE,
  TEL_CURRENT_PARITY_VERSION,
  applyTelCurrentParityTransition,
  createEmptyTelCurrentParityState,
  type TelCurrentParityState,
  type TelParityInput,
  type TelParityRoute,
} from "./telCurrentParity";

type ParsedReplayInput = Omit<TelParityInput, "marginUsedBefore" | "evaluationMode">;

function parseReplayInput(event: RtSourceEvent): ParsedReplayInput | null {
  if (!event.payloadJson || typeof event.payloadJson !== "object") return null;
  const raw = event.payloadJson as Record<string, unknown>;
  if (raw.symbol !== "8035"
    || typeof raw.tradeDate !== "string"
    || typeof raw.candleTime !== "string"
    || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => typeof value === "number")) {
    return null;
  }
  return {
    sourceEventId: event.sourceEventId,
    candle: {
      symbol: "8035",
      tradeDate: raw.tradeDate,
      candleTime: raw.candleTime,
      open: raw.open as number,
      high: raw.high as number,
      low: raw.low as number,
      close: raw.close as number,
      volume: raw.volume as number,
    },
    board: raw.board ?? null,
  };
}

function replayRouteToAuditRoute(route: TelParityRoute | null | undefined): string | null {
  if (!route) return null;
  return ({
    open_direction_breakout_long: "8035_open_direction_breakout_long",
    open_direction_breakout_short: "8035_open_direction_breakout_short",
    fallback_trend_long: "trend_long",
    fallback_trend_short: "trend_short",
  } satisfies Record<TelParityRoute, string>)[route];
}

function currentAction(event: RtRealtimeDecisionEvent): "entry" | "exit" | "none" {
  const resultJson = event.resultJson && typeof event.resultJson === "object"
    ? event.resultJson as Record<string, unknown>
    : {};
  const result = resultJson.result && typeof resultJson.result === "object"
    ? resultJson.result as Record<string, unknown>
    : {};
  if (result.action === "entry") return "entry";
  if (["exit", "stop_loss", "take_profit", "forced_close"].includes(String(result.action))) return "exit";
  return "none";
}

function replayAction(decision: Record<string, unknown>): "entry" | "exit" | "none" {
  if (decision.action === "entry") return "entry";
  if (decision.action === "exit") return "exit";
  return "none";
}

function normalizeCurrentPosition(event: RtRealtimeDecisionEvent) {
  const state = event.stateAfterJson && typeof event.stateAfterJson === "object"
    ? event.stateAfterJson as Record<string, unknown>
    : {};
  const positions = Array.isArray(state.positions) ? state.positions : [];
  const position = positions.find(item => item && typeof item === "object"
    && (item as Record<string, unknown>).symbol === "8035") as Record<string, unknown> | undefined;
  if (!position) return null;
  return {
    side: position.side ?? null,
    entryPrice: Number(position.entryPrice ?? 0),
    shares: Number(position.shares ?? 0),
    entryTime: position.entryTime ?? null,
  };
}

function normalizeReplayPosition(state: TelCurrentParityState) {
  if (!state.position) return null;
  return {
    side: state.position.side,
    entryPrice: state.position.entryPrice,
    shares: state.position.shares,
    entryTime: state.position.entryTime,
  };
}

function makeDiff(input: {
  realtime: RtRealtimeDecisionEvent;
  replayState: TelCurrentParityState;
  replayDecision: Record<string, unknown>;
}) {
  const current = {
    action: currentAction(input.realtime),
    routeId: input.realtime.routeId,
    position: normalizeCurrentPosition(input.realtime),
    symbolCandleCount: Number((input.realtime.stateAfterJson as Record<string, unknown> | null)?.symbolCandleCount ?? 0),
  };
  const replayRoute = typeof input.replayDecision.route === "string"
    ? replayRouteToAuditRoute(input.replayDecision.route as TelParityRoute)
    : null;
  const replay = {
    action: replayAction(input.replayDecision),
    routeId: replayRoute,
    position: normalizeReplayPosition(input.replayState),
    symbolCandleCount: input.replayState.candles.length,
  };
  const fields: Record<string, { realtime: unknown; replay: unknown }> = {};
  for (const key of ["action", "position", "symbolCandleCount"] as const) {
    if (JSON.stringify(current[key]) !== JSON.stringify(replay[key])) {
      fields[key] = { realtime: current[key], replay: replay[key] };
    }
  }
  if ((current.action !== "none" || replay.action !== "none") && current.routeId !== replay.routeId) {
    fields.routeId = { realtime: current.routeId, replay: replay.routeId };
  }
  return {
    matched: Object.keys(fields).length === 0,
    mismatchType: Object.keys(fields)[0] ?? null,
    fields,
    current,
    replay,
    coverage: {
      internalPendingState: false,
      internalFiredSets: false,
      note: "現行固定売買ファイルを変更しないため、内部pending/firedはparity版の再起動監査で補完",
    },
  };
}

function replayWithSerializedRestart(inputs: TelParityInput[], splitIndex: number) {
  let state = createEmptyTelCurrentParityState();
  for (let index = 0; index < inputs.length; index += 1) {
    if (index === splitIndex) state = JSON.parse(JSON.stringify(state)) as TelCurrentParityState;
    state = applyTelCurrentParityTransition(state, inputs[index]).nextState;
  }
  return sha256Stable(state);
}

export async function compareTelCurrentParityForDate(tradeDate: string) {
  if (tradeDate < TEL_AUDIT_EVALUATION_START_DATE) {
    return { skipped: "before_evaluation_start" as const, tradeDate };
  }
  const [sourceEvents, realtimeEvents] = await Promise.all([
    getRtSourceEventsForDate(tradeDate),
    getRtRealtimeDecisionEventsForDate(tradeDate),
  ]);
  const sourceById = new Map(sourceEvents.map(event => [event.sourceEventId, event]));
  const ordered = realtimeEvents.filter(event => event.symbol === "8035");
  let state = createEmptyTelCurrentParityState();
  let firstMismatchSaved = false;
  let matched = 0;
  let mismatched = 0;
  let invalidPayloads = 0;
  const replayInputs: TelParityInput[] = [];
  const details: Array<Record<string, unknown>> = [];

  for (const realtime of ordered) {
    const source = sourceById.get(realtime.sourceEventId);
    const parsed = source ? parseReplayInput(source) : null;
    if (!parsed) {
      invalidPayloads += 1;
      await upsertRtReplayComparison({
        baselineVersion: TEL_CURRENT_PARITY_VERSION,
        sourceEventDbId: realtime.sourceEventDbId,
        sourceEventId: realtime.sourceEventId,
        engineSequence: realtime.id,
        tradeDate,
        symbol: "8035",
        candleTime: realtime.candleTime,
        matchStatus: "skipped",
        isFirstMismatch: false,
        mismatchType: "invalid_or_missing_payload",
        realtimeDecisionId: realtime.id,
        realtimeStateHash: realtime.stateHashAfter,
        replayStateHash: null,
        diffJson: { sourceFound: Boolean(source) },
        replayResultJson: null,
      });
      continue;
    }
    const input: TelParityInput = {
      ...parsed,
      marginUsedBefore: realtime.marginUsedBefore ?? 0,
      evaluationMode: "capital_constrained",
    };
    replayInputs.push(input);
    const transition = applyTelCurrentParityTransition(state, input);
    state = transition.nextState;
    const diff = makeDiff({ realtime, replayState: state, replayDecision: transition.decision });
    const isFirstMismatch = !diff.matched && !firstMismatchSaved;
    if (isFirstMismatch) firstMismatchSaved = true;
    if (diff.matched) matched += 1;
    else {
      mismatched += 1;
      details.push({
        engineSequence: realtime.id,
        sourceEventId: realtime.sourceEventId,
        candleTime: realtime.candleTime,
        mismatchType: diff.mismatchType,
        fields: diff.fields,
      });
    }
    await upsertRtReplayComparison({
      baselineVersion: TEL_CURRENT_PARITY_VERSION,
      sourceEventDbId: realtime.sourceEventDbId,
      sourceEventId: realtime.sourceEventId,
      engineSequence: realtime.id,
      tradeDate,
      symbol: "8035",
      candleTime: realtime.candleTime,
      matchStatus: diff.matched ? "match" : "mismatch",
      isFirstMismatch,
      mismatchType: diff.mismatchType,
      realtimeDecisionId: realtime.id,
      realtimeStateHash: realtime.stateHashAfter,
      replayStateHash: sha256Stable(state),
      diffJson: diff,
      replayResultJson: {
        resultType: transition.resultType,
        decision: transition.decision,
        stateHash: sha256Stable(state),
      },
    });
  }

  const uninterruptedHash = replayWithSerializedRestart(replayInputs, -1);
  const restartChecks = [
    Math.floor(replayInputs.length / 3),
    Math.floor(replayInputs.length / 2),
    Math.floor(replayInputs.length * 2 / 3),
  ].filter((value, index, values) => value > 0 && value < replayInputs.length && values.indexOf(value) === index)
    .map(splitIndex => ({
      splitIndex,
      stateHash: replayWithSerializedRestart(replayInputs, splitIndex),
    }));
  const restartMatched = restartChecks.every(check => check.stateHash === uninterruptedHash);
  return {
    skipped: false as const,
    baselineVersion: TEL_CURRENT_PARITY_VERSION,
    tradeDate,
    processed: replayInputs.length,
    matched,
    mismatched,
    invalidPayloads,
    firstMismatch: details[0] ?? null,
    restartAudit: {
      uninterruptedHash,
      checks: restartChecks,
      matched: restartMatched,
    },
  };
}
