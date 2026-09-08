import type { RtSignalCandidate, RtSignalCandidateTrade } from "../drizzle/schema";
import {
  getOpenRtSignalCandidateTrades,
  upsertRtSignalCandidateTrade,
} from "./db";
import { CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION } from "./currentSignalCandidateRegistry";
import type { RtCandle1Min } from "./realtimeSimEngine";
import type { CurrentBoardExitSignal, CurrentRawSignal } from "./currentVirtualMarketContext";

const CURRENT_BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05;

export type VirtualState = {
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

export function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function pricePnl(side: "long" | "short", entry: number, exit: number, shares: number): number {
  return Math.round((side === "long" ? exit - entry : entry - exit) * shares);
}

export function favorablePct(side: "long" | "short", entry: number, high: number, low: number): number {
  return side === "long" ? ((high - entry) / entry) * 100 : ((entry - low) / entry) * 100;
}

export function adversePct(side: "long" | "short", entry: number, high: number, low: number): number {
  return side === "long" ? ((entry - low) / entry) * 100 : ((high - entry) / entry) * 100;
}

type VirtualExit = {
  exitPrice: number;
  reasonCode: string;
  reasonDetail: string | null;
};

export function splitVirtualExitReason(input: string | null | undefined): {
  reasonCode: string | null;
  reasonDetail: string | null;
} {
  if (!input) return { reasonCode: null, reasonDetail: null };
  const separator = input.indexOf(":");
  if (separator < 0) return { reasonCode: input.slice(0, 64), reasonDetail: null };
  return {
    reasonCode: input.slice(0, separator).slice(0, 64),
    reasonDetail: input.slice(separator + 1) || null,
  };
}

export function evaluateSignalQualityExit(input: {
  trade: RtSignalCandidateTrade;
  candle: RtCandle1Min;
  state: VirtualState;
  rawSignal: CurrentRawSignal;
  boardSignal: CurrentBoardExitSignal;
}): VirtualExit | null {
  const { trade, candle, state, rawSignal, boardSignal } = input;
  const entry = Number(trade.entryPrice);
  const slPct = Number(trade.slPct);
  const tpPct = Number(trade.tpPct);
  const side = trade.side;

  if (candle.tradeDate !== trade.tradeDate) {
    return { exitPrice: candle.open, reasonCode: "next_session_first_open_exit", reasonDetail: null };
  }

  if (side === "long") {
    const sl = entry * (1 - slPct / 100);
    if (candle.low <= sl) return { exitPrice: Math.min(candle.open, sl), reasonCode: "stop_loss", reasonDetail: null };
    const tp = entry * (1 + tpPct / 100);
    if (candle.high >= tp) return { exitPrice: Math.max(candle.open, tp), reasonCode: "take_profit", reasonDetail: null };
  } else {
    const sl = entry * (1 + slPct / 100);
    if (candle.high >= sl) return { exitPrice: Math.max(candle.open, sl), reasonCode: "stop_loss", reasonDetail: null };
    const tp = entry * (1 - tpPct / 100);
    if (candle.low <= tp) return { exitPrice: Math.min(candle.open, tp), reasonCode: "take_profit", reasonDetail: null };
  }

  const routeSpec = (trade.stateJson as any)?.routeSpec as {
    sessionExitTime?: string | null;
    maxHoldingMinutes?: number | null;
    timeExitPriceMode?: "next_bar_open" | "boundary_close" | null;
    profitProtection?: { triggerPct: number; floorPct: number } | null;
    usesSignalReversalExit?: boolean;
    usesBoardEarlyExit?: boolean;
  } | undefined;
  const protection = routeSpec?.profitProtection;
  if (side === "short" && protection) {
    const floor = entry * (1 - protection.floorPct / 100);
    if (state.armedAt && state.armedAt !== candle.candleTime && candle.high >= floor) {
      return { exitPrice: Math.max(candle.open, floor), reasonCode: "profit_protection", reasonDetail: null };
    }
  }

  if (routeSpec?.usesSignalReversalExit && rawSignal) {
    if (side === "long" && rawSignal.type === "sell") {
      return { exitPrice: candle.close, reasonCode: "signal_reversal", reasonDetail: rawSignal.reason };
    }
    if (side === "short" && rawSignal.type === "buy") {
      return { exitPrice: candle.close, reasonCode: "signal_reversal", reasonDetail: rawSignal.reason };
    }
  }

  if (routeSpec?.usesBoardEarlyExit) {
    const pnlPct = side === "long"
      ? ((candle.close - entry) / entry) * 100
      : ((entry - candle.close) / entry) * 100;
    const oppositeBoard = side === "long"
      ? boardSignal === "sell_pressure" || boardSignal === "large_sell_wall"
      : boardSignal === "buy_pressure" || boardSignal === "large_buy_wall";
    if (pnlPct >= CURRENT_BOARD_EARLY_EXIT_MIN_PROFIT_PCT && oppositeBoard) {
      return { exitPrice: candle.close, reasonCode: "board_early_exit", reasonDetail: boardSignal };
    }
  }

  if (routeSpec?.sessionExitTime && candle.candleTime >= routeSpec.sessionExitTime) {
    return { exitPrice: candle.close, reasonCode: "session_exit_close_proxy", reasonDetail: null };
  }

  const maxHoldingMinutes = routeSpec?.maxHoldingMinutes;
  if (maxHoldingMinutes !== null && maxHoldingMinutes !== undefined) {
    const elapsed = timeToMinutes(candle.candleTime) - timeToMinutes(trade.entryCandleTime);
    if (routeSpec?.timeExitPriceMode === "next_bar_open" && elapsed > maxHoldingMinutes) {
      return { exitPrice: candle.open, reasonCode: "max_holding_next_bar_open", reasonDetail: null };
    }
    if (routeSpec?.timeExitPriceMode === "boundary_close" && elapsed >= maxHoldingMinutes) {
      return { exitPrice: candle.close, reasonCode: "max_holding_boundary_close", reasonDetail: null };
    }
  }
  return null;
}

export async function processSignalQualityVirtualTradesForEvent(input: {
  sourceEventId: string;
  candle: RtCandle1Min;
  candidate: RtSignalCandidate | null;
  rawSignal?: CurrentRawSignal;
  boardSignal?: CurrentBoardExitSignal;
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
    const rawSignal = input.rawSignal ?? null;
    const boardSignal = input.boardSignal ?? "neutral";
    const exit = evaluateSignalQualityExit({ trade, candle: input.candle, state, rawSignal, boardSignal });
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
      stateJson: {
        ...(trade.stateJson as object),
        ...state,
        lastMarketContext: {
          sourceEventId: input.sourceEventId,
          rawSignal,
          boardSignal,
        },
      },
      exitSourceEventId: exit ? input.sourceEventId : trade.exitSourceEventId,
      exitTradeDate: exit ? input.candle.tradeDate : trade.exitTradeDate,
      exitCandleTime: exit ? input.candle.candleTime : trade.exitCandleTime,
      exitPrice: exit ? String(exit.exitPrice) : trade.exitPrice,
      exitReason: exit ? exit.reasonCode : trade.exitReason,
      exitReasonCode: exit ? exit.reasonCode : trade.exitReasonCode ?? splitVirtualExitReason(trade.exitReason).reasonCode,
      exitReasonDetail: exit ? exit.reasonDetail : trade.exitReasonDetail ?? splitVirtualExitReason(trade.exitReason).reasonDetail,
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
      exitReasonCode: null,
      exitReasonDetail: null,
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
