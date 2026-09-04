import type { RtSignalCandidate, RtSignalCandidateTrade } from "../drizzle/schema";
import {
  getOpenRtSignalCandidateTrades,
  upsertRtSignalCandidateTrade,
} from "./db";
import { CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION } from "./currentSignalCandidateRegistry";
import type { RtCandle1Min } from "./realtimeSimEngine";

type VirtualState = {
  armedAt: string | null;
  mfePct: number;
  maePct: number;
};

function parseState(trade: RtSignalCandidateTrade): VirtualState {
  const raw = trade.stateJson && typeof trade.stateJson === "object"
    ? trade.stateJson as Partial<VirtualState>
    : {};
  return {
    armedAt: typeof raw.armedAt === "string" ? raw.armedAt : null,
    mfePct: Number.isFinite(Number(raw.mfePct)) ? Number(raw.mfePct) : 0,
    maePct: Number.isFinite(Number(raw.maePct)) ? Number(raw.maePct) : 0,
  };
}

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function pricePnl(side: "long" | "short", entry: number, exit: number, shares: number): number {
  return Math.round((side === "long" ? exit - entry : entry - exit) * shares);
}

function favorablePct(side: "long" | "short", entry: number, high: number, low: number): number {
  return side === "long" ? ((high - entry) / entry) * 100 : ((entry - low) / entry) * 100;
}

function adversePct(side: "long" | "short", entry: number, high: number, low: number): number {
  return side === "long" ? ((entry - low) / entry) * 100 : ((high - entry) / entry) * 100;
}

function evaluateExit(input: {
  trade: RtSignalCandidateTrade;
  candle: RtCandle1Min;
  state: VirtualState;
}): { exitPrice: number; exitReason: string } | null {
  const { trade, candle, state } = input;
  const entry = Number(trade.entryPrice);
  const slPct = Number(trade.slPct);
  const tpPct = Number(trade.tpPct);
  const side = trade.side;

  if (candle.tradeDate !== trade.tradeDate) {
    return { exitPrice: candle.open, exitReason: "next_session_first_open_exit" };
  }

  if (side === "long") {
    const sl = entry * (1 - slPct / 100);
    if (candle.low <= sl) return { exitPrice: Math.min(candle.open, sl), exitReason: "stop_loss" };
    const tp = entry * (1 + tpPct / 100);
    if (candle.high >= tp) return { exitPrice: Math.max(candle.open, tp), exitReason: "take_profit" };
  } else {
    const sl = entry * (1 + slPct / 100);
    if (candle.high >= sl) return { exitPrice: Math.max(candle.open, sl), exitReason: "stop_loss" };
    const tp = entry * (1 - tpPct / 100);
    if (candle.low <= tp) return { exitPrice: Math.min(candle.open, tp), exitReason: "take_profit" };
  }

  const routeSpec = (trade.stateJson as any)?.routeSpec as {
    sessionExitTime?: string | null;
    maxHoldingMinutes?: number | null;
    timeExitPriceMode?: "next_bar_open" | "boundary_close" | null;
    profitProtection?: { triggerPct: number; floorPct: number } | null;
  } | undefined;
  const protection = routeSpec?.profitProtection;
  if (side === "short" && protection) {
    const floor = entry * (1 - protection.floorPct / 100);
    if (state.armedAt && state.armedAt !== candle.candleTime && candle.high >= floor) {
      return { exitPrice: Math.max(candle.open, floor), exitReason: "profit_protection" };
    }
  }

  if (routeSpec?.sessionExitTime && candle.candleTime >= routeSpec.sessionExitTime) {
    return { exitPrice: candle.close, exitReason: "session_exit_close_proxy" };
  }

  const maxHoldingMinutes = routeSpec?.maxHoldingMinutes;
  if (maxHoldingMinutes !== null && maxHoldingMinutes !== undefined) {
    const elapsed = timeToMinutes(candle.candleTime) - timeToMinutes(trade.entryCandleTime);
    if (routeSpec?.timeExitPriceMode === "next_bar_open" && elapsed > maxHoldingMinutes) {
      return { exitPrice: candle.open, exitReason: "max_holding_next_bar_open" };
    }
    if (routeSpec?.timeExitPriceMode === "boundary_close" && elapsed >= maxHoldingMinutes) {
      return { exitPrice: candle.close, exitReason: "max_holding_boundary_close" };
    }
  }
  return null;
}

export async function processSignalQualityVirtualTradesForEvent(input: {
  sourceEventId: string;
  candle: RtCandle1Min;
  candidate: RtSignalCandidate | null;
}): Promise<{ opened: number; updated: number; closed: number }> {
  const openTrades = (await getOpenRtSignalCandidateTrades(CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION))
    .filter(trade => trade.symbol === input.candle.symbol);
  let updated = 0;
  let closed = 0;

  for (const trade of openTrades) {
    if (trade.entrySourceEventId === input.sourceEventId) continue;
    const state = parseState(trade);
    const entry = Number(trade.entryPrice);
    state.mfePct = Math.max(state.mfePct, favorablePct(trade.side, entry, input.candle.high, input.candle.low));
    state.maePct = Math.max(state.maePct, adversePct(trade.side, entry, input.candle.high, input.candle.low));
    const routeSpec = (trade.stateJson as any)?.routeSpec as {
      profitProtection?: { triggerPct: number; floorPct: number } | null;
    } | undefined;
    if (!state.armedAt && trade.side === "short" && routeSpec?.profitProtection) {
      const trigger = entry * (1 - routeSpec.profitProtection.triggerPct / 100);
      if (input.candle.low <= trigger) state.armedAt = input.candle.candleTime;
    }
    const exit = evaluateExit({ trade, candle: input.candle, state });
    await upsertRtSignalCandidateTrade({
      virtualEngineVersion: trade.virtualEngineVersion,
      candidateId: trade.candidateId,
      entrySourceEventId: trade.entrySourceEventId,
      tradeDate: trade.tradeDate,
      symbol: trade.symbol,
      routeId: trade.routeId,
      side: trade.side,
      entryCandleTime: trade.entryCandleTime,
      entryPrice: trade.entryPrice,
      shares: trade.shares,
      slPct: trade.slPct,
      tpPct: trade.tpPct,
      maxHoldingMinutes: trade.maxHoldingMinutes,
      stateJson: { ...(trade.stateJson as object), ...state },
      exitSourceEventId: exit ? input.sourceEventId : trade.exitSourceEventId,
      exitTradeDate: exit ? input.candle.tradeDate : trade.exitTradeDate,
      exitCandleTime: exit ? input.candle.candleTime : trade.exitCandleTime,
      exitPrice: exit ? String(exit.exitPrice) : trade.exitPrice,
      exitReason: exit ? exit.exitReason : trade.exitReason,
      pnl: exit ? pricePnl(trade.side, entry, exit.exitPrice, trade.shares) : trade.pnl,
      realizedR: exit
        ? String((pricePnl(trade.side, entry, exit.exitPrice, trade.shares) / (entry * trade.shares)) * 100 / Number(trade.slPct))
        : trade.realizedR,
      mfePct: String(state.mfePct),
      maePct: String(state.maePct),
      completed: Boolean(exit) || trade.completed,
    });
    updated += 1;
    if (exit) closed += 1;
  }

  let opened = 0;
  if (input.candidate) {
    const routeSpec = (input.candidate.inputJson as any)?.routeSpec ?? null;
    await upsertRtSignalCandidateTrade({
      virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
      candidateId: input.candidate.id,
      entrySourceEventId: input.candidate.sourceEventId,
      tradeDate: input.candidate.tradeDate,
      symbol: input.candidate.symbol,
      routeId: input.candidate.routeId,
      side: input.candidate.side,
      entryCandleTime: input.candidate.candleTime,
      entryPrice: input.candidate.theoreticalEntryPrice,
      shares: 100,
      slPct: input.candidate.slPct,
      tpPct: input.candidate.tpPct,
      maxHoldingMinutes: input.candidate.maxHoldingMinutes,
      stateJson: { routeSpec, armedAt: null, mfePct: 0, maePct: 0 },
      exitSourceEventId: null,
      exitTradeDate: null,
      exitCandleTime: null,
      exitPrice: null,
      exitReason: null,
      pnl: null,
      realizedR: null,
      mfePct: "0",
      maePct: "0",
      completed: false,
    });
    opened = 1;
  }

  return { opened, updated, closed };
}
