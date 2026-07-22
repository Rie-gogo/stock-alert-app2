import { runScore0DailySimulation, formatScore0Report } from "../server/cbV2Simulation.ts";

// Test with empty blocks
const emptyResult = runScore0DailySimulation("2026-07-22", [], []);
console.log("=== Empty test ===");
console.log(formatScore0Report(emptyResult));

// Test with mock data
const mockCandles = [];
// Create mock candles for symbol 6981 from 13:40 to 15:30
for (let h = 13; h <= 15; h++) {
  for (let m = 0; m < 60; m++) {
    const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    if (time < "13:40" || time > "15:30") continue;
    // Simulate a downtrend from 7913 to 7800
    const progress = (h * 60 + m - 13 * 60 - 40) / 110;
    const price = 7913 - progress * 113;
    mockCandles.push({
      symbol: "6981",
      candleTime: time,
      open: String(price + 2),
      high: String(price + 5),
      low: String(price - 5),
      close: String(price),
      volume: 1000,
    });
  }
}

const mockBlocks = [
  {
    symbol: "6981",
    candleTime: "13:43",
    side: "SHORT",
    signalReason: "ダウ理論: 直近安値更新｜信頼度：強",
    entryPrice: "7900",
  },
];

const result = runScore0DailySimulation("2026-07-22", mockCandles, mockBlocks);
console.log("\n=== Mock test (SHORT downtrend) ===");
console.log(formatScore0Report(result));
console.log("Trades:", JSON.stringify(result.trades, null, 2));
