import { randomUUID } from "node:crypto";
import type { RtSourceEvent } from "../drizzle/schema";
import {
  acquireRtCurrentEngineLock,
  getLatestRtTradeAt,
  insertRtRealtimeDecisionEvent,
  releaseRtCurrentEngineLock,
} from "./db";
import type { KabuOrderBook } from "./kabuStation";
import {
  getCandleCounters,
  getDashboardStatus,
  getOpenPositions,
  getSignalHistory,
  getSymbolPnlMap,
  type RtCandle1Min,
} from "./realtimeSimEngine";
import { sha256Stable } from "./runtimeIdentity";

export const CURRENT_REALTIME_AUDIT_VERSION = "current-realtime-audit-v1";
const CURRENT_ENGINE_LOCK_NAME = "current-realtime-engine-v1";
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 100;

export type CurrentEngineResult = {
  symbol: string;
  tradeDate: string;
  candleTime: string;
  action: "entry" | "exit" | "stop_loss" | "take_profit" | "forced_close" | "none";
  reason?: string;
  pnl?: number;
};

export type AuditedCurrentEngineResult = {
  result: CurrentEngineResult;
  audit: {
    saved: boolean;
    engineSequence: number | null;
    resultType: "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";
    routeId: string | null;
    marginUsedBefore: number;
    marginUsedAfter: number;
    stateHashBefore: string;
    stateHashAfter: string;
    causalityStatus: "pass" | "violation" | "unverified" | "not_applicable";
    causalityReason: string;
    error?: string;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createOwnerToken(sourceEventId: string): string {
  return sha256Stable({
    scope: CURRENT_ENGINE_LOCK_NAME,
    sourceEventId,
    nonce: randomUUID(),
  });
}

async function acquireWithWait(sourceEventId: string): Promise<string> {
  const ownerToken = createOwnerToken(sourceEventId);
  const deadline = Date.now() + LOCK_WAIT_MS;
  do {
    if (await acquireRtCurrentEngineLock({
      lockName: CURRENT_ENGINE_LOCK_NAME,
      ownerToken,
      leaseMs: 30_000,
    })) return ownerToken;
    await sleep(LOCK_RETRY_MS);
  } while (Date.now() < deadline);
  throw new Error(`current_engine_lock_timeout:${sourceEventId}`);
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * 現行売買ファイルを変更せずに取得できる外部状態だけを保存する。
 * pending内部状態は8035 parity版が別状態で保持し、coverageで未収録を明示する。
 */
export function captureRealtimeAuditState(symbol: string) {
  const dashboard = getDashboardStatus();
  const positions = getOpenPositions()
    .map(position => ({ ...position }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const counters = sortRecord(getCandleCounters());
  const pnl = sortRecord(getSymbolPnlMap());
  const latestSymbolSignals = getSignalHistory(100)
    .filter(event => event.symbol === symbol)
    .slice(0, 10)
    .map(event => ({ ...event }));
  return {
    version: CURRENT_REALTIME_AUDIT_VERSION,
    coverage: {
      externalRuntimeState: true,
      openPositions: true,
      symbolPnl: true,
      candleCounters: true,
      latestSymbolSignals: true,
      internalPendingState: false,
      internalFiredSets: false,
    },
    currentTradeDate: dashboard.currentTradeDate,
    lastCandleReceivedAt: dashboard.lastCandleReceivedAt,
    symbol,
    symbolCandleCount: counters[symbol] ?? 0,
    symbolPnl: pnl[symbol] ?? 0,
    counters,
    pnl,
    positions,
    latestSymbolSignals,
  };
}

/** 接続監視用の壁時計値を除外し、同じ入力列なら同じ値になる状態ハッシュを作る。 */
export function hashRealtimeAuditState(state: ReturnType<typeof captureRealtimeAuditState>): string {
  const { lastCandleReceivedAt: _volatileObservedAt, ...deterministicState } = state;
  return sha256Stable(deterministicState);
}

export function resolveRealtimeRouteId(reason: string | null | undefined): string | null {
  const value = reason ?? "";
  const routes: Array<[RegExp, string]> = [
    [/東京エレクトロン(?:始値方向付き)?短期ブレイク.*LONG/i, "8035_open_direction_breakout_long"],
    [/東京エレクトロン(?:始値方向付き)?短期ブレイク.*SHORT/i, "8035_open_direction_breakout_short"],
    [/キオクシア確認型前場LONG/i, "285A_confirmed_morning_long"],
    [/反転LONG/i, "reversal_long"],
    [/反転SHORT/i, "reversal_short"],
    [/順張りLONG/i, "trend_long"],
    [/順張りSHORT/i, "trend_short"],
    [/大台割れSHORT|安全CB/i, "safe_cb_short"],
    [/安値反転ブレイクLONG/i, "low_reversal_break_long"],
    [/高値失速ブレイクSHORT/i, "high_fade_break_short"],
    [/後場安値更新SHORT/i, "afternoon_low_break_short"],
    [/寄り付き.*SHORT/i, "opening_break_short"],
    [/確認型.*LONG/i, "confirmed_break_long"],
    [/15本安値更新/i, "sumco_15bar_breakdown_short"],
    [/10本高値更新/i, "ten_bar_breakout_long"],
  ];
  return routes.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

function classifyResult(result: CurrentEngineResult, hasPositionAfter: boolean, auditReason?: string | null) {
  if (result.action === "entry") return "entry" as const;
  if (["exit", "stop_loss", "take_profit", "forced_close"].includes(result.action)) return "exit" as const;
  const reason = auditReason ?? result.reason ?? "";
  if (/pending|確認待ち|保留/i.test(reason)) return "pending" as const;
  if (/block|reject|拒否|margin|証拠金/i.test(reason)) return "rejected" as const;
  if (hasPositionAfter) return "hold" as const;
  return "no_signal" as const;
}

function evaluateCausality(input: {
  result: CurrentEngineResult;
  latestTrade: Awaited<ReturnType<typeof getLatestRtTradeAt>>;
  board: Omit<KabuOrderBook, "symbol" | "receivedAt"> | null;
}) {
  const trade = input.latestTrade;
  if (input.result.action === "entry") {
    return {
      status: "violation" as const,
      reason: "current_engine_bar_close_fill_is_not_executable_after_candle_receipt",
    };
  }
  if (trade && /時間決済|最大保有|前場強制決済/.test(trade.reason)) {
    return {
      status: "violation" as const,
      reason: "completed_bar_open_or_intrabar_price_used_after_candle_receipt",
    };
  }
  if (["stop_loss", "take_profit"].includes(input.result.action)) {
    return {
      status: "unverified" as const,
      reason: "bar_high_low_triggered_simulated_fill_requires_separate_execution_model",
    };
  }
  if (input.result.action === "none") {
    return {
      status: "pass" as const,
      reason: "no_fill_price_used",
    };
  }
  return {
    status: input.board?.currentPrice ? "pass" as const : "unverified" as const,
    reason: input.board?.currentPrice
      ? "board_current_price_observed_at_or_before_decision"
      : "board_current_price_missing",
  };
}

function currentMarginUsed(): number {
  return Math.round(getOpenPositions().reduce(
    (sum, position) => sum + position.entryPrice * position.shares,
    0,
  ));
}

function parseBoardObservedAtMs(tradeDate: string, value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : `${tradeDate}T${value}`;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+09:00`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeDelta(later: number | null | undefined, earlier: number | null | undefined): number | null {
  if (later === null || later === undefined || earlier === null || earlier === undefined) return null;
  return Math.max(0, later - earlier);
}

export async function processCurrentEngineAudited(input: {
  sourceEvent: RtSourceEvent;
  candle: RtCandle1Min;
  board: Omit<KabuOrderBook, "symbol" | "receivedAt"> | null;
  inputHash: string;
  run: () => Promise<CurrentEngineResult>;
}): Promise<AuditedCurrentEngineResult> {
  const ownerToken = await acquireWithWait(input.sourceEvent.sourceEventId);
  const stateBefore = captureRealtimeAuditState(input.candle.symbol);
  const stateHashBefore = hashRealtimeAuditState(stateBefore);
  const marginUsedBefore = currentMarginUsed();
  const decisionStartedAtMs = Date.now();
  let result: CurrentEngineResult | null = null;
  try {
    result = await input.run();
    const decisionCompletedAtMs = Date.now();
    const latestTrade = result.action === "none"
      ? null
      : await getLatestRtTradeAt({
          tradeDate: input.candle.tradeDate,
          symbol: input.candle.symbol,
          tradeTime: input.candle.candleTime,
        });
    const stateAfter = captureRealtimeAuditState(input.candle.symbol);
    const stateHashAfter = hashRealtimeAuditState(stateAfter);
    const marginUsedAfter = currentMarginUsed();
    const positionAfter = getOpenPositions().find(position => position.symbol === input.candle.symbol);
    const beforeSignalKeys = new Set(stateBefore.latestSymbolSignals.map(signal => JSON.stringify(signal)));
    const decisionSignal = stateAfter.latestSymbolSignals.find(signal => signal.time === input.candle.candleTime
      && !beforeSignalKeys.has(JSON.stringify(signal)));
    const auditReason = latestTrade?.reason ?? result.reason ?? decisionSignal?.reason ?? null;
    const resultType = classifyResult(result, Boolean(positionAfter), auditReason);
    const routeId = resolveRealtimeRouteId(auditReason);
    const causality = evaluateCausality({ result, latestTrade, board: input.board });
    const boardObservedAtMs = parseBoardObservedAtMs(input.candle.tradeDate, input.board?.currentPriceTime);
    const availabilityTimeline = {
      sourceEventId: input.sourceEvent.sourceEventId,
      candleLogicalAt: `${input.candle.tradeDate}T${input.candle.candleTime}:00+09:00`,
      boardObservedAt: input.board?.currentPriceTime ?? null,
      boardObservedAtMs,
      relayAssembledAtMs: input.sourceEvent.relayReceivedAtMs,
      relaySentAtMs: input.sourceEvent.relaySentAtMs,
      cloudReceivedAtMs: input.sourceEvent.cloudReceivedAtMs,
      decisionStartedAtMs,
      decisionCompletedAtMs,
    };
    const latency = {
      relayAssemblyToSendMs: nonNegativeDelta(input.sourceEvent.relaySentAtMs, input.sourceEvent.relayReceivedAtMs),
      relaySendToCloudMs: nonNegativeDelta(input.sourceEvent.cloudReceivedAtMs, input.sourceEvent.relaySentAtMs),
      cloudToDecisionStartMs: nonNegativeDelta(decisionStartedAtMs, input.sourceEvent.cloudReceivedAtMs),
      decisionDurationMs: nonNegativeDelta(decisionCompletedAtMs, decisionStartedAtMs),
      boardAgeAtDecisionMs: nonNegativeDelta(decisionStartedAtMs, boardObservedAtMs),
    };
    try {
      const saved = await insertRtRealtimeDecisionEvent({
        sourceEventDbId: input.sourceEvent.id,
        sourceEventId: input.sourceEvent.sourceEventId,
        relaySessionId: input.sourceEvent.relaySessionId,
        eventSeq: input.sourceEvent.eventSeq,
        tradeDate: input.candle.tradeDate,
        symbol: input.candle.symbol,
        candleTime: input.candle.candleTime,
        decisionStartedAtMs,
        decisionCompletedAtMs,
        resultType,
        routeId,
        side: latestTrade?.side ?? positionAfter?.side ?? null,
        reason: auditReason,
        inputHash: input.inputHash,
        stateBeforeJson: stateBefore,
        stateAfterJson: stateAfter,
        stateHashBefore,
        stateHashAfter,
        signalReferencePrice: String(input.candle.close),
        marketObservedPrice: input.board?.currentPrice ? String(input.board.currentPrice) : null,
        boardPriceTime: input.board?.currentPriceTime ?? null,
        executablePriceProxy: input.board?.currentPrice ? String(input.board.currentPrice) : null,
        simulatedBarFillPrice: latestTrade ? String(latestTrade.price) : null,
        brokerExecutionPrice: null,
        shares: latestTrade?.shares ?? positionAfter?.shares ?? null,
        amount: latestTrade?.amount ?? null,
        marginUsedBefore,
        marginUsedAfter,
        causalityStatus: causality.status,
        causalityReason: causality.reason,
        resultJson: {
          result,
          trade: latestTrade,
          decisionSignal: decisionSignal ?? null,
          stateCoverage: stateAfter.coverage,
          availabilityTimeline,
          latency,
          priceLabels: {
            signalReferencePrice: "candle.close",
            marketObservedPrice: "board.currentPrice_observed_before_or_at_decision",
            executablePriceProxy: "board.currentPrice_as_dry_run_executable_price_proxy",
            simulatedBarFillPrice: "rt_trades.price_from_bar_simulation",
            brokerExecutionPrice: "unavailable_in_dry_run",
          },
        },
      });
      return {
        result,
        audit: {
          saved: true,
          engineSequence: saved.id,
          resultType,
          routeId,
          marginUsedBefore,
          marginUsedAfter,
          stateHashBefore,
          stateHashAfter,
          causalityStatus: causality.status,
          causalityReason: causality.reason,
        },
      };
    } catch (auditError) {
      console.error("[RealtimeAudit] 現行判断は完了したが監査台帳保存に失敗:", auditError);
      return {
        result,
        audit: {
          saved: false,
          engineSequence: null,
          resultType,
          routeId,
          marginUsedBefore,
          marginUsedAfter,
          stateHashBefore,
          stateHashAfter,
          causalityStatus: causality.status,
          causalityReason: causality.reason,
          error: String(auditError),
        },
      };
    }
  } finally {
    try {
      await releaseRtCurrentEngineLock({ lockName: CURRENT_ENGINE_LOCK_NAME, ownerToken });
    } catch (releaseError) {
      console.error("[RealtimeAudit] 現行エンジンリース解放失敗:", releaseError);
    }
  }
}
