import { SOFTBANK_BREAKOUT_LONG_REASON_PREFIX } from "./softbankBreakoutLong";

export type SoftbankBreakoutLongReportTrade = {
  symbol: string;
  action: string;
  tradeTime: string;
  price: number | string;
  shares: number;
  pnl: number | null;
  reason: string;
};

export type SoftbankBreakoutLongReportSignal = {
  time: string;
  symbol: string;
  action: string;
  price: number;
  reason: string;
};

export type SoftbankBreakoutLongPersistedEvent = {
  candleTime: string;
  eventType: "engine_rejected";
  side: "long";
  detail: string | null;
  referencePrice: number | string;
};

export type SoftbankBreakoutLongDryRunSummary = {
  entries: number;
  exits: number;
  realizedPnl: number;
  marginBlocks: number;
  otherEngineBlocks: number;
};

export function formatSoftbankBreakoutLongDryRunReport(
  trades: SoftbankBreakoutLongReportTrade[],
  signalHistory: SoftbankBreakoutLongReportSignal[],
  persistedEvents: SoftbankBreakoutLongPersistedEvent[] = [],
): { summary: SoftbankBreakoutLongDryRunSummary; section: string } {
  const orderedTrades = [...trades].sort((a, b) => a.tradeTime.localeCompare(b.tradeTime));
  const entries = orderedTrades.filter(trade =>
    trade.symbol === "9984" &&
    trade.action === "buy" &&
    trade.reason.startsWith(SOFTBANK_BREAKOUT_LONG_REASON_PREFIX),
  );
  const firstEntryTime = entries[0]?.tradeTime;
  const exits = firstEntryTime
    ? orderedTrades.filter(trade =>
      trade.symbol === "9984" &&
      trade.action === "sell" &&
      trade.tradeTime >= firstEntryTime,
    )
    : [];

  const volatileBlocks = signalHistory.filter(signal =>
    signal.symbol === "9984" &&
    (
      signal.action === "softbank_breakout_long_block" ||
      (signal.action === "margin_block" && signal.reason.includes(SOFTBANK_BREAKOUT_LONG_REASON_PREFIX))
    ),
  );
  const persistedBlocks: SoftbankBreakoutLongReportSignal[] = persistedEvents.map(event => ({
    time: event.candleTime,
    symbol: "9984",
    action: event.detail === "margin_block" ? "margin_block" : "softbank_breakout_long_block",
    price: Number(event.referencePrice),
    reason: `${SOFTBANK_BREAKOUT_LONG_REASON_PREFIX}拒否・後続再探索: ${event.detail ?? "unknown_engine_gate"}`,
  }));
  const blockByIdentity = new Map<string, SoftbankBreakoutLongReportSignal>();
  for (const signal of [...volatileBlocks, ...persistedBlocks]) {
    blockByIdentity.set(`${signal.time}|${signal.action}`, signal);
  }
  const relatedBlocks = Array.from(blockByIdentity.values());
  const marginBlocks = relatedBlocks.filter(signal => signal.action === "margin_block");
  const otherEngineBlocks = relatedBlocks.filter(signal => signal.action === "softbank_breakout_long_block");
  const realizedPnl = exits.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);

  const eventLines = [
    ...relatedBlocks.map(signal => `  [${signal.time}] 拒否・再探索継続 @${signal.price.toLocaleString()}円: ${signal.reason}`),
    ...entries.map(trade => `  [${trade.tradeTime}] LONG @${Number(trade.price).toLocaleString()}円 ×${trade.shares}株: ${trade.reason}`),
    ...exits.map(trade => {
      const pnl = trade.pnl === null ? "-" : `${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toLocaleString()}円`;
      return `  [${trade.tradeTime}] SELL @${Number(trade.price).toLocaleString()}円 理論損益:${pnl}: ${trade.reason}`;
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
【9984 10本高値更新LONG DRY_RUN乖離監視】
  理論エントリー: ${summary.entries}件 / 決済: ${summary.exits}件 / 確定理論損益: ${pnlText}
  共通ゲート拒否・再探索: ${summary.marginBlocks + summary.otherEngineBlocks}件（証拠金:${summary.marginBlocks} / ATR等:${summary.otherEngineBlocks}）
${eventLines.length > 0 ? eventLines.join("\n") : "  （候補・拒否なし）"}
  注: DRY_RUNの確定足価格であり、LIVE約定価格ではありません。
`;
  return { summary, section };
}
