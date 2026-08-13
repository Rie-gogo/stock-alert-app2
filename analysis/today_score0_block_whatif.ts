/** 本日のスコア0ブロックを、既存の本番日次レポートと同じ仮想SL/TPロジックで検証する。 */
import { getRtCandlesAllForDate, getScore0BlocksForDate } from "../server/db";
import { formatScore0Report, runScore0DailySimulation } from "../server/cbV2Simulation";

async function main() {
  const tradeDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const [candles, blocks] = await Promise.all([
    getRtCandlesAllForDate(tradeDate),
    getScore0BlocksForDate(tradeDate),
  ]);
  const result = runScore0DailySimulation(
    tradeDate,
    candles,
    blocks.map(block => ({
      symbol: block.symbol,
      candleTime: block.candleTime,
      side: block.side as "BUY" | "SHORT",
      signalReason: block.signalReason,
      entryPrice: block.entryPrice,
    })),
  );
  console.log(formatScore0Report(result));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
