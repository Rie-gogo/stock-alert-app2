export type TaiyoCandidateBReportTrade = {
  symbol: string;
  action: string;
  tradeTime: string;
  price: number | string;
  shares: number;
  pnl: number | null;
  reason: string;
};

export type TaiyoCandidateBReportSignal = {
  time: string;
  symbol: string;
  action: string;
  price: number;
  reason: string;
};

export type TaiyoCandidateBPersistedEvent = {
  candleTime: string;
  eventType: "confirmation_rejected" | "engine_rejected";
  side: "long" | "short";
  triggerTime: string;
  rejectionCodes: string[] | null;
  detail: string | null;
  referencePrice: number | string;
};

export type TaiyoCandidateBDryRunSummary = {
  entries: number;
  exits: number;
  marginBlocks: number;
  otherEngineBlocks: number;
  confirmationRejects: number;
};

export function formatTaiyoCandidateBDryRunReport(
  trades: TaiyoCandidateBReportTrade[],
  signalHistory: TaiyoCandidateBReportSignal[],
  persistedEvents: TaiyoCandidateBPersistedEvent[] = [],
): { summary: TaiyoCandidateBDryRunSummary; section: string } {
  const orderedTrades = [...trades].sort((a, b) => a.tradeTime.localeCompare(b.tradeTime));
  const entries = orderedTrades.filter(trade =>
    trade.symbol === "6976" &&
    (trade.action === "buy" || trade.action === "short") &&
    trade.reason.startsWith("太陽誘電候補B"),
  );
  const firstEntryTime = entries[0]?.tradeTime;
  const exits = firstEntryTime
    ? orderedTrades.filter(trade =>
      trade.symbol === "6976" &&
      (trade.action === "sell" || trade.action === "cover") &&
      trade.tradeTime >= firstEntryTime,
    )
    : [];

  const volatileBlocks = signalHistory.filter(signal =>
    signal.symbol === "6976" &&
    (
      signal.action === "candidate_b_block" ||
      (signal.action === "margin_block" && signal.reason.includes("太陽誘電候補B"))
    ),
  );
  const persistedBlocks: TaiyoCandidateBReportSignal[] = persistedEvents.map(event => ({
    time: event.candleTime,
    symbol: "6976",
    action: event.eventType === "confirmation_rejected"
      ? "candidate_b_confirmation_rejected"
      : event.detail === "margin_block" ? "margin_block" : "candidate_b_block",
    price: Number(event.referencePrice),
    reason: event.eventType === "confirmation_rejected"
      ? `太陽誘電候補B確認失敗・後続再探索: ${(event.rejectionCodes ?? []).join(",") || "unknown"}`
      : `太陽誘電候補B拒否・後続再探索: ${event.detail ?? "unknown_engine_gate"}`,
  }));
  const blockByIdentity = new Map<string, TaiyoCandidateBReportSignal>();
  for (const signal of [...volatileBlocks, ...persistedBlocks]) {
    blockByIdentity.set(`${signal.time}|${signal.action}`, signal);
  }
  const relatedBlocks = Array.from(blockByIdentity.values());
  const marginBlocks = relatedBlocks.filter(signal => signal.action === "margin_block");
  const otherEngineBlocks = relatedBlocks.filter(signal => signal.action === "candidate_b_block");
  const confirmationRejects = relatedBlocks.filter(signal => signal.action === "candidate_b_confirmation_rejected");

  const eventLines = [
    ...relatedBlocks.map(signal => `  [${signal.time}] 拒否・再探索継続 @${signal.price.toLocaleString()}円: ${signal.reason}`),
    ...entries.map(trade => `  [${trade.tradeTime}] ${trade.action.toUpperCase()} @${Number(trade.price).toLocaleString()}円 ×${trade.shares}株: ${trade.reason}`),
    ...exits.map(trade => {
      const pnl = trade.pnl === null ? "-" : `${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toLocaleString()}円`;
      return `  [${trade.tradeTime}] ${trade.action.toUpperCase()} @${Number(trade.price).toLocaleString()}円 損益:${pnl}: ${trade.reason}`;
    }),
  ].sort((a, b) => a.slice(3, 8).localeCompare(b.slice(3, 8)));

  const summary = {
    entries: entries.length,
    exits: exits.length,
    marginBlocks: marginBlocks.length,
    otherEngineBlocks: otherEngineBlocks.length,
    confirmationRejects: confirmationRejects.length,
  };
  const section = `
【6976候補B30分 DRY_RUN乖離監視】
  理論エントリー: ${summary.entries}件 / 決済: ${summary.exits}件
  共通ゲート拒否: ${summary.marginBlocks + summary.otherEngineBlocks}件（証拠金:${summary.marginBlocks} / ATR等:${summary.otherEngineBlocks}）
  確認失敗・再探索: ${summary.confirmationRejects}件
${eventLines.length > 0 ? eventLines.join("\n") : "  （候補・拒否なし）"}
  注: DRY_RUNの確定足価格であり、LIVE約定価格ではありません。
`;
  return { summary, section };
}
