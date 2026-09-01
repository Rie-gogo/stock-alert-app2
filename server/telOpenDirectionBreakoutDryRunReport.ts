import { TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX } from "./telOpenDirectionBreakout";

export type TelOpenDirectionBreakoutReportTrade = {
  symbol: string;
  action: string;
  tradeTime: string;
  price: number | string;
  shares: number;
  pnl: number | null;
  reason: string;
};

export type TelOpenDirectionBreakoutReportSignal = {
  time: string;
  symbol: string;
  action: string;
  price: number;
  reason: string;
};

export type TelOpenDirectionBreakoutPersistedEvent = {
  candleTime: string;
  eventType: "engine_rejected";
  side: "long" | "short";
  detail: string | null;
  referencePrice: number | string;
};

export type TelOpenDirectionBreakoutDryRunSummary = {
  entries: number;
  exits: number;
  realizedPnl: number;
  marginBlocks: number;
  otherEngineBlocks: number;
};

export function formatTelOpenDirectionBreakoutDryRunReport(
  trades: TelOpenDirectionBreakoutReportTrade[],
  signalHistory: TelOpenDirectionBreakoutReportSignal[],
  persistedEvents: TelOpenDirectionBreakoutPersistedEvent[] = [],
): { summary: TelOpenDirectionBreakoutDryRunSummary; section: string } {
  const orderedTrades = [...trades].sort((a, b) => a.tradeTime.localeCompare(b.tradeTime));
  const entries: TelOpenDirectionBreakoutReportTrade[] = [];
  const exits: TelOpenDirectionBreakoutReportTrade[] = [];
  let targetPositionOpen = false;
  for (const trade of orderedTrades.filter(item => item.symbol === "8035")) {
    if (trade.action === "buy" || trade.action === "short") {
      targetPositionOpen = trade.reason.startsWith(TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX);
      if (targetPositionOpen) entries.push(trade);
      continue;
    }
    if (trade.action === "sell" || trade.action === "cover") {
      if (targetPositionOpen) exits.push(trade);
      targetPositionOpen = false;
    }
  }

  const volatileBlocks = signalHistory.filter(signal =>
    signal.symbol === "8035" &&
    (
      signal.action === "tel_open_direction_breakout_block" ||
      (signal.action === "margin_block" && signal.reason.includes(TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX))
    ),
  );
  const persistedBlocks: TelOpenDirectionBreakoutReportSignal[] = persistedEvents.map(event => ({
    time: event.candleTime,
    symbol: "8035",
    action: event.detail === "margin_block" ? "margin_block" : "tel_open_direction_breakout_block",
    price: Number(event.referencePrice),
    reason: `${TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX}${event.side === "long" ? "LONG" : "SHORT"}拒否・後続再探索: ${event.detail ?? "unknown_engine_gate"}`,
  }));
  const blockByIdentity = new Map<string, TelOpenDirectionBreakoutReportSignal>();
  for (const signal of [...volatileBlocks, ...persistedBlocks]) {
    blockByIdentity.set(`${signal.time}|${signal.action}`, signal);
  }
  const relatedBlocks = Array.from(blockByIdentity.values());
  const marginBlocks = relatedBlocks.filter(signal => signal.action === "margin_block");
  const otherEngineBlocks = relatedBlocks.filter(signal => signal.action === "tel_open_direction_breakout_block");
  const realizedPnl = exits.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);

  const eventLines = [
    ...relatedBlocks.map(signal => `  [${signal.time}] 拒否・再探索継続 @${signal.price.toLocaleString()}円: ${signal.reason}`),
    ...entries.map(trade => `  [${trade.tradeTime}] ${trade.action === "buy" ? "LONG" : "SHORT"} @${Number(trade.price).toLocaleString()}円 ×${trade.shares}株: ${trade.reason}`),
    ...exits.map(trade => {
      const pnl = trade.pnl === null ? "-" : `${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toLocaleString()}円`;
      return `  [${trade.tradeTime}] ${trade.action.toUpperCase()} @${Number(trade.price).toLocaleString()}円 理論損益:${pnl}: ${trade.reason}`;
    }),
  ].sort((a, b) => a.slice(3, 8).localeCompare(b.slice(3, 8)));

  const summary = {
    entries: entries.length,
    exits: exits.length,
    realizedPnl,
    marginBlocks: marginBlocks.length,
    otherEngineBlocks: otherEngineBlocks.length,
  };
  const pnlText = `${realizedPnl >= 0 ? "+" : ""}${realizedPnl.toLocaleString()}円`;
  const section = `
【8035始値方向付き短期ブレイク DRY_RUN乖離監視】
  理論エントリー: ${summary.entries}件 / 決済: ${summary.exits}件 / 確定理論損益: ${pnlText}
  共通ゲート拒否・再探索: ${summary.marginBlocks + summary.otherEngineBlocks}件（証拠金:${summary.marginBlocks} / ATR等:${summary.otherEngineBlocks}）
${eventLines.length > 0 ? eventLines.join("\n") : "  （候補・拒否なし）"}
  注: DRY_RUNの確定足価格であり、LIVE約定価格ではありません。
`;
  return { summary, section };
}
