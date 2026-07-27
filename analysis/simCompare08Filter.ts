/**
 * 7/17以降のrt_candlesデータを使って、0.8%フィルターあり/なしの2パターンで
 * エンジンを再シミュレーションし比較する。
 * 
 * アプローチ: エンジンのprocessCandleを直接呼び出すが、DB書き込みをモック化し、
 * ROUND_DISTANCE_BLOCK_THRESHOLD_PCTを動的に変更する。
 * 
 * 実際にはエンジンはmodule-level stateを使うため、2回のシミュレーションは
 * 別プロセスで実行する必要がある。ここではforkで実行する。
 */
import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { execSync } from "child_process";
import * as fs from "fs";

async function main() {
  const db = await getDb();
  
  // 7/17-7/27の取引日を取得
  const datesResult = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE tradeDate >= '2026-07-17' AND tradeDate <= '2026-07-27'
    ORDER BY tradeDate
  `);
  const dates = (datesResult as any)[0].map((r: any) => r.tradeDate);
  console.log(`シミュレーション対象日: ${dates.join(", ")}`);

  // 各日のキャンドルデータをJSONファイルに書き出す
  for (const date of dates) {
    const candlesResult = await db.execute(sql`
      SELECT symbol, tradeDate, candleTime, 
             CAST(open AS DOUBLE) as \`open\`, 
             CAST(high AS DOUBLE) as high, 
             CAST(low AS DOUBLE) as low, 
             CAST(close AS DOUBLE) as \`close\`, 
             volume, boardSnapshot
      FROM rt_candles 
      WHERE tradeDate = ${date}
      ORDER BY candleTime, symbol
    `);
    const candles = (candlesResult as any)[0];
    fs.writeFileSync(`/tmp/candles_${date}.json`, JSON.stringify(candles));
    console.log(`  ${date}: ${candles.length} candles exported`);
  }

  // シミュレーションワーカースクリプトを生成
  const workerScript = `
import * as fs from "fs";

// --- Mock DB functions ---
const trades: any[] = [];
let mockInsertRtCandle = async (d: any) => {};
let mockInsertRtTrade = async (d: any) => { trades.push(d); };
let mockUpsertRtDailySummary = async (d: any) => {};
let mockGetRtTradesForDate = async (d: string) => trades.filter(t => t.tradeDate === d);
let mockGetRtCandlesAllForDate = async (d: string) => [];
let mockGetRtOpenPositionsFromDb = async () => [];
let mockInsertScore0Block = async (d: any) => {};

// Monkey-patch the db module before importing the engine
import Module from "module";
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function(request: string, parent: any, ...args: any[]) {
  if (request === "./db" || request === "../server/db") {
    return originalResolve.call(this, "./mockDb", parent, ...args);
  }
  return originalResolve.call(this, request, parent, ...args);
};
`;

  // Better approach: directly query candles and run a simplified simulation
  // that mirrors the engine's state machine logic
  console.log("\n--- Running simplified state machine simulation ---\n");
  
  // Write the actual simulation runner
  fs.writeFileSync("/tmp/sim_dates.json", JSON.stringify(dates));
  
  // Run simulation for each scenario
  const scenarios = [
    { name: "フィルターあり（現行0.8%）", threshold: 0.8 },
    { name: "フィルターなし（閾値999%）", threshold: 999 },
  ];

  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario.name} ===`);
    try {
      const result = execSync(
        `cd /home/ubuntu/stock-alert-app && ROUND_THRESHOLD=${scenario.threshold} npx tsx analysis/simWorker.ts 2>/dev/null`,
        { encoding: "utf-8", timeout: 120000 }
      );
      console.log(result);
    } catch (e: any) {
      console.error(`Error: ${e.message?.slice(0, 200)}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
