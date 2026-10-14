import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  rtAiIntradayForecastSnapshots,
  rtForwardShadowStates,
  rtForwardShadowTrades,
  rtShadowDispatchQueue,
  rtStrategyVersions,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS,
  sha256Stable,
} from "./runtimeIdentity";

export const AI_SHADOW_LEDGER_REPAIR_ID =
  "ai-shadow-ledger-repair:2026-10-14:v1";
export const AI_SHADOW_LEDGER_REPAIR_TRADE_DATE = "2026-10-14";

const MODES = ["signal_quality", "capital_constrained"] as const;
type Mode = (typeof MODES)[number];
type Symbol = "285A" | "6526" | "6857";

const EXIT_SPECS = {
  "285A": {
    entrySourceEventId: "20261013T235044Z-ebfda979c552:2685",
    candleTime: "12:30",
    open: 14910,
    high: 14995,
    low: 14880,
    close: 14885,
    exitPrice: 14885,
    exitReason: "ai_direction_revision_exit",
  },
  "6526": {
    entrySourceEventId: "20261013T235044Z-ebfda979c552:2885",
    candleTime: "13:00",
    open: 1999.5,
    high: 2001,
    low: 1999.5,
    close: 2001,
    exitPrice: 2001,
    exitReason: "ai_force_exit_time",
  },
  "6857": {
    entrySourceEventId: "20261013T235044Z-ebfda979c552:2929",
    candleTime: "12:30",
    open: 41040,
    high: 41170,
    low: 41040,
    close: 41090,
    exitPrice: 41020,
    exitReason: "first_target",
  },
} as const;

const SYMBOLS = Object.keys(EXIT_SPECS) as Symbol[];
const VERSIONS = Object.fromEntries(
  SYMBOLS.map(symbol => [
    symbol,
    RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS[symbol],
  ])
) as Record<Symbol, string>;

type RepairTrade = {
  id: number;
  strategyVersion: string;
  evaluationMode: Mode;
  symbol: string;
  side: "long" | "short";
  entrySourceEventId: string;
  entryTradeDate: string;
  entryPrice: unknown;
  shares: number;
  exitSourceEventId: string | null;
  exitTradeDate: string | null;
  exitCandleTime: string | null;
  exitPrice: unknown;
  exitReason: string | null;
  pnl: number | null;
  pnlAfterAdverseExit: number | null;
  realizedR: unknown;
  closedAt: Date | null;
};

type RepairState = {
  id: number;
  strategyVersion: string;
  evaluationMode: Mode;
  stateJson: unknown;
  stateHash: string;
  lastSourceEventId: string | null;
};

type RepairQueueRow = {
  sourceEventId: string;
  engineSequence: number;
  tradeDate: string;
  symbol: string;
  inputJson: unknown;
};

type RepairSnapshot = {
  sourceRevisionId: string;
  tradeDate: string;
  checkpoint: string;
  qualityStatus: string;
  forecastJson: unknown;
};

export type AiShadowLedgerRepairSource = {
  trades: RepairTrade[];
  states: RepairState[];
  queueRows: RepairQueueRow[];
  snapshot: RepairSnapshot | null;
  versionStatuses: Array<{ versionId: string; status: string; statusReason: string | null }>;
};

type RepairUpdate = {
  symbol: Symbol;
  evaluationMode: Mode;
  strategyVersion: string;
  tradeId: number;
  stateId: number;
  entrySourceEventId: string;
  exitSourceEventId: string;
  exitCandleTime: string;
  exitPrice: number;
  exitReason: string;
  shares: number;
  pnl: number;
  realizedR: number;
  initialRiskPerShare: number;
  beforeTradeHash: string;
  beforeStateHash: string;
  nextStateJson: Record<string, unknown>;
  nextStateHash: string;
};

export type AiShadowLedgerRepairPlan = {
  repairId: string;
  tradeDate: string;
  status: "pending" | "already_applied";
  planHash: string;
  updates: RepairUpdate[];
  summary: Array<{
    symbol: Symbol;
    evaluationMode: Mode;
    exitCandleTime: string;
    exitPrice: number;
    exitReason: string;
    pnl: number;
  }>;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function number(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`repair_number_invalid:${String(value)}`);
  return parsed;
}

function key(symbol: Symbol, mode: Mode): string {
  return `${symbol}:${mode}`;
}

function assertScope(tradeDate: string): void {
  if (tradeDate !== AI_SHADOW_LEDGER_REPAIR_TRADE_DATE)
    throw new Error(`repair_scope_rejected:${tradeDate}`);
}

function candle(row: RepairQueueRow) {
  const value = object(object(row.inputJson).candle);
  return {
    tradeDate: String(value.tradeDate ?? ""),
    candleTime: String(value.candleTime ?? ""),
    open: number(value.open),
    high: number(value.high),
    low: number(value.low),
    close: number(value.close),
  };
}

function resolveExitEvents(rows: RepairQueueRow[]): Record<Symbol, RepairQueueRow> {
  return Object.fromEntries(SYMBOLS.map(symbol => {
    const expected = EXIT_SPECS[symbol];
    const candidates = rows.filter(row => {
      if (row.symbol !== symbol || row.tradeDate !== AI_SHADOW_LEDGER_REPAIR_TRADE_DATE)
        return false;
      const value = candle(row);
      return value.candleTime === expected.candleTime;
    });
    if (candidates.length === 0) throw new Error(`repair_exit_event_missing:${symbol}:${expected.candleTime}`);
    for (const row of candidates) {
      const value = candle(row);
      if (
        value.tradeDate !== AI_SHADOW_LEDGER_REPAIR_TRADE_DATE ||
        value.open !== expected.open ||
        value.high !== expected.high ||
        value.low !== expected.low ||
        value.close !== expected.close
      ) throw new Error(`repair_exit_candle_mismatch:${symbol}:${expected.candleTime}`);
    }
    const selected = [...candidates].sort((a, b) => b.engineSequence - a.engineSequence)[0];
    return [symbol, selected];
  })) as Record<Symbol, RepairQueueRow>;
}

function validateSnapshot(snapshot: RepairSnapshot | null): void {
  if (!snapshot) throw new Error("repair_1130_snapshot_missing");
  if (
    snapshot.sourceRevisionId !== "ai-intraday-forecast:2026-10-14:1130:codex-v1" ||
    snapshot.tradeDate !== AI_SHADOW_LEDGER_REPAIR_TRADE_DATE ||
    snapshot.checkpoint !== "11:30" ||
    snapshot.qualityStatus === "invalid"
  ) throw new Error("repair_1130_snapshot_identity_invalid");
  const final = object(object(snapshot.forecastJson).aiFinalForecast);
  const forecast = object(final.forecast);
  const forecasts = Array.isArray(forecast.forecasts) ? forecast.forecasts : [];
  const controls = Array.isArray(final.controls) ? final.controls : [];
  const row = (symbol: Symbol) => object(forecasts.find(item => object(item).symbol === symbol));
  const control = (symbol: Symbol) => object(controls.find(item => object(item).symbol === symbol));
  const up = (direction: unknown) => direction === "up" || direction === "strong_up";
  const down = (direction: unknown) => direction === "down" || direction === "strong_down";
  if (!down(row("285A").direction) || control("285A").openPositionAction !== "exit_next_event_if_direction_changed")
    throw new Error("repair_1130_285a_plan_mismatch");
  if (!up(row("6526").direction) || control("6526").openPositionAction !== "tighten_only" || number(row("6526").firstTarget) !== 2012 || control("6526").forceExitTime !== "13:00")
    throw new Error("repair_1130_6526_plan_mismatch");
  if (!up(row("6857").direction) || control("6857").openPositionAction !== "tighten_only" || number(row("6857").firstTarget) !== 41020 || control("6857").forceExitTime !== "13:00")
    throw new Error("repair_1130_6857_plan_mismatch");
}

function marker(stateJson: unknown) {
  const actions = object(stateJson).lastActions;
  if (!Array.isArray(actions)) return null;
  return actions.map(object).find(action => action.repairId === AI_SHADOW_LEDGER_REPAIR_ID) ?? null;
}

function canonicalPlan(plan: Omit<AiShadowLedgerRepairPlan, "planHash">) {
  return {
    repairId: plan.repairId,
    tradeDate: plan.tradeDate,
    status: plan.status,
    updates: plan.updates,
    summary: plan.summary,
  };
}

export function buildAiShadowLedgerRepairPlanForTest(
  source: AiShadowLedgerRepairSource
): AiShadowLedgerRepairPlan {
  validateSnapshot(source.snapshot);
  const exitEvents = resolveExitEvents(source.queueRows);
  const trades = new Map<string, RepairTrade>();
  const states = new Map<string, RepairState>();
  for (const trade of source.trades) {
    const symbol = SYMBOLS.find(value => value === trade.symbol);
    const mode = MODES.find(value => value === trade.evaluationMode);
    if (!symbol || !mode || trade.strategyVersion !== VERSIONS[symbol])
      throw new Error(`repair_trade_scope_invalid:${trade.id}`);
    const rowKey = key(symbol, mode);
    if (trades.has(rowKey)) throw new Error(`repair_trade_duplicate:${rowKey}`);
    trades.set(rowKey, trade);
  }
  for (const state of source.states) {
    const symbol = SYMBOLS.find(value => VERSIONS[value] === state.strategyVersion);
    const mode = MODES.find(value => value === state.evaluationMode);
    if (!symbol || !mode) throw new Error(`repair_state_scope_invalid:${state.id}`);
    const rowKey = key(symbol, mode);
    if (states.has(rowKey)) throw new Error(`repair_state_duplicate:${rowKey}`);
    states.set(rowKey, state);
  }
  if (trades.size !== 6 || states.size !== 6)
    throw new Error(`repair_row_count_invalid:${trades.size}:${states.size}`);

  const openCount = Array.from(trades.values()).filter(row => row.exitSourceEventId === null).length;
  if (openCount !== 0 && openCount !== 6)
    throw new Error(`repair_partial_trade_state:${openCount}`);

  const summary: AiShadowLedgerRepairPlan["summary"] = [];
  const updates: RepairUpdate[] = [];
  for (const symbol of SYMBOLS) {
    const expected = EXIT_SPECS[symbol];
    const exitEvent = exitEvents[symbol];
    for (const evaluationMode of MODES) {
      const rowKey = key(symbol, evaluationMode);
      const trade = trades.get(rowKey)!;
      const state = states.get(rowKey)!;
      if (
        trade.entryTradeDate !== AI_SHADOW_LEDGER_REPAIR_TRADE_DATE ||
        trade.entrySourceEventId !== expected.entrySourceEventId ||
        trade.side !== "long" ||
        trade.shares <= 0
      ) throw new Error(`repair_entry_identity_invalid:${rowKey}`);
      if (sha256Stable(state.stateJson) !== state.stateHash)
        throw new Error(`repair_state_hash_invalid:${rowKey}`);
      const pnl = Math.round((expected.exitPrice - number(trade.entryPrice)) * trade.shares);

      if (openCount === 0) {
        const audit = marker(state.stateJson);
        const initialRiskPerShare = number(audit?.initialRiskPerShare);
        const expectedR = pnl / (initialRiskPerShare * trade.shares);
        if (
          trade.exitSourceEventId !== exitEvent.sourceEventId ||
          trade.exitTradeDate !== AI_SHADOW_LEDGER_REPAIR_TRADE_DATE ||
          trade.exitCandleTime !== expected.candleTime ||
          number(trade.exitPrice) !== expected.exitPrice ||
          trade.exitReason !== expected.exitReason ||
          trade.pnl !== pnl ||
          trade.pnlAfterAdverseExit !== pnl ||
          Math.abs(number(trade.realizedR) - expectedR) > 0.000001 ||
          trade.closedAt === null ||
          object(state.stateJson).position !== null ||
          audit?.exitSourceEventId !== exitEvent.sourceEventId
        ) throw new Error(`repair_applied_receipt_invalid:${rowKey}`);
        summary.push({
          symbol,
          evaluationMode,
          exitCandleTime: expected.candleTime,
          exitPrice: expected.exitPrice,
          exitReason: expected.exitReason,
          pnl,
        });
        continue;
      }

      const stateJson = object(state.stateJson);
      const position = object(stateJson.position);
      if (
        stateJson.tradeDate !== AI_SHADOW_LEDGER_REPAIR_TRADE_DATE ||
        position.entrySourceEventId !== expected.entrySourceEventId ||
        position.side !== "long" ||
        number(position.entryPrice) !== number(trade.entryPrice) ||
        number(position.shares) !== trade.shares
      ) throw new Error(`repair_open_state_mismatch:${rowKey}`);
      const initialRiskPerShare = position.initialRiskPerShare === undefined
        ? Math.abs(number(position.entryPrice) - number(position.stopPrice))
        : number(position.initialRiskPerShare);
      if (!(initialRiskPerShare > 0)) throw new Error(`repair_initial_risk_invalid:${rowKey}`);
      const realizedR = pnl / (initialRiskPerShare * trade.shares);
      const nextStateJson = {
        ...stateJson,
        position: null,
        lastActions: [{
          type: "historical_ledger_reconciliation",
          repairId: AI_SHADOW_LEDGER_REPAIR_ID,
          causalCheckpoint: "11:30",
          exitSourceEventId: exitEvent.sourceEventId,
          exitCandleTime: expected.candleTime,
          exitPrice: expected.exitPrice,
          exitReason: expected.exitReason,
          initialRiskPerShare,
          immutableForwardEventsChanged: false,
        }],
      };
      updates.push({
        symbol,
        evaluationMode,
        strategyVersion: VERSIONS[symbol],
        tradeId: trade.id,
        stateId: state.id,
        entrySourceEventId: expected.entrySourceEventId,
        exitSourceEventId: exitEvent.sourceEventId,
        exitCandleTime: expected.candleTime,
        exitPrice: expected.exitPrice,
        exitReason: expected.exitReason,
        shares: trade.shares,
        pnl,
        realizedR,
        initialRiskPerShare,
        beforeTradeHash: sha256Stable(trade),
        beforeStateHash: state.stateHash,
        nextStateJson,
        nextStateHash: sha256Stable(nextStateJson),
      });
      summary.push({
        symbol,
        evaluationMode,
        exitCandleTime: expected.candleTime,
        exitPrice: expected.exitPrice,
        exitReason: expected.exitReason,
        pnl,
      });
    }
  }
  const status = openCount === 0 ? "already_applied" : "pending";
  if (status === "already_applied") {
    const statusMap = new Map(source.versionStatuses.map(row => [row.versionId, row]));
    for (const symbol of SYMBOLS) {
      const version = statusMap.get(VERSIONS[symbol]);
      if (version?.status !== "stopped" || !version.statusReason?.includes(AI_SHADOW_LEDGER_REPAIR_ID))
        throw new Error(`repair_version_receipt_missing:${symbol}`);
    }
  }
  const base = {
    repairId: AI_SHADOW_LEDGER_REPAIR_ID,
    tradeDate: AI_SHADOW_LEDGER_REPAIR_TRADE_DATE,
    status,
    updates,
    summary: summary.sort((a, b) => `${a.symbol}:${a.evaluationMode}`.localeCompare(`${b.symbol}:${b.evaluationMode}`)),
  } as const;
  return { ...base, planHash: sha256Stable(canonicalPlan(base)) };
}

async function loadSource(db: any): Promise<AiShadowLedgerRepairSource> {
  const versionIds = Object.values(VERSIONS);
  const entryIds = Object.values(EXIT_SPECS).map(row => row.entrySourceEventId);
  const [trades, states, queueRows, snapshots, versionStatuses] = await Promise.all([
    db.select().from(rtForwardShadowTrades).where(and(
      inArray(rtForwardShadowTrades.strategyVersion, versionIds),
      eq(rtForwardShadowTrades.entryTradeDate, AI_SHADOW_LEDGER_REPAIR_TRADE_DATE),
      inArray(rtForwardShadowTrades.entrySourceEventId, entryIds),
    )),
    db.select().from(rtForwardShadowStates).where(inArray(rtForwardShadowStates.strategyVersion, versionIds)),
    db.select().from(rtShadowDispatchQueue).where(and(
      eq(rtShadowDispatchQueue.tradeDate, AI_SHADOW_LEDGER_REPAIR_TRADE_DATE),
      inArray(rtShadowDispatchQueue.symbol, SYMBOLS),
    )),
    db.select().from(rtAiIntradayForecastSnapshots).where(and(
      eq(rtAiIntradayForecastSnapshots.tradeDate, AI_SHADOW_LEDGER_REPAIR_TRADE_DATE),
      eq(rtAiIntradayForecastSnapshots.checkpoint, "11:30"),
    )).orderBy(desc(rtAiIntradayForecastSnapshots.id)).limit(1),
    db.select({
      versionId: rtStrategyVersions.versionId,
      status: rtStrategyVersions.status,
      statusReason: rtStrategyVersions.statusReason,
    }).from(rtStrategyVersions).where(inArray(rtStrategyVersions.versionId, versionIds)),
  ]);
  return {
    trades: trades as RepairTrade[],
    states: states as RepairState[],
    queueRows: queueRows as RepairQueueRow[],
    snapshot: (snapshots[0] as RepairSnapshot | undefined) ?? null,
    versionStatuses,
  };
}

export async function prepareAiShadowLedgerRepair(tradeDate: string) {
  assertScope(tradeDate);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const source = await loadSource(db);
  const planA = buildAiShadowLedgerRepairPlanForTest(source);
  const planB = buildAiShadowLedgerRepairPlanForTest(source);
  if (planA.planHash !== planB.planHash)
    throw new Error(`repair_plan_nondeterministic:${planA.planHash}:${planB.planHash}`);
  return planA;
}

export async function applyAiShadowLedgerRepair(input: {
  tradeDate: string;
  expectedPlanHash: string;
}) {
  assertScope(input.tradeDate);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const initial = buildAiShadowLedgerRepairPlanForTest(await loadSource(db));
  if (initial.status === "already_applied")
    return { ...initial, operationStatus: "duplicate" as const };
  if (initial.planHash !== input.expectedPlanHash)
    throw new Error(`repair_plan_hash_mismatch:${input.expectedPlanHash}:${initial.planHash}`);

  await db.transaction(async tx => {
    const current = buildAiShadowLedgerRepairPlanForTest(await loadSource(tx));
    if (current.status === "already_applied") return;
    if (current.planHash !== input.expectedPlanHash)
      throw new Error(`repair_plan_changed_before_apply:${input.expectedPlanHash}:${current.planHash}`);
    for (const update of current.updates) {
      await tx.update(rtForwardShadowTrades).set({
        exitSourceEventId: update.exitSourceEventId,
        exitTradeDate: AI_SHADOW_LEDGER_REPAIR_TRADE_DATE,
        exitCandleTime: update.exitCandleTime,
        exitPrice: String(update.exitPrice),
        exitReason: update.exitReason,
        pnl: update.pnl,
        pnlAfterAdverseExit: update.pnl,
        realizedR: String(update.realizedR),
        closedAt: new Date(),
      }).where(and(
        eq(rtForwardShadowTrades.id, update.tradeId),
        eq(rtForwardShadowTrades.strategyVersion, update.strategyVersion),
        eq(rtForwardShadowTrades.evaluationMode, update.evaluationMode),
        eq(rtForwardShadowTrades.entrySourceEventId, update.entrySourceEventId),
        isNull(rtForwardShadowTrades.exitSourceEventId),
      ));
      await tx.update(rtForwardShadowStates).set({
        stateJson: update.nextStateJson,
        stateHash: update.nextStateHash,
      }).where(and(
        eq(rtForwardShadowStates.id, update.stateId),
        eq(rtForwardShadowStates.strategyVersion, update.strategyVersion),
        eq(rtForwardShadowStates.evaluationMode, update.evaluationMode),
        eq(rtForwardShadowStates.stateHash, update.beforeStateHash),
      ));
    }
    for (const symbol of SYMBOLS) {
      await tx.update(rtStrategyVersions).set({
        status: "stopped",
        statusReason: `historical_ledger_reconciled:${AI_SHADOW_LEDGER_REPAIR_ID}:${current.planHash}`,
      }).where(eq(rtStrategyVersions.versionId, VERSIONS[symbol]));
    }
    const receipt = buildAiShadowLedgerRepairPlanForTest(await loadSource(tx));
    if (receipt.status !== "already_applied")
      throw new Error("repair_transaction_receipt_invalid");
  });

  const receipt = buildAiShadowLedgerRepairPlanForTest(await loadSource(db));
  if (receipt.status !== "already_applied") throw new Error("repair_post_commit_receipt_invalid");
  return { ...receipt, operationStatus: "applied" as const };
}


