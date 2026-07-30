import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // 1. 過去5日間の銘柄別受信数を確認
  console.log("=== 過去5日間の銘柄別ローソク足受信数 ===\n");
  const [rows1] = await db.execute(sql`
    SELECT tradeDate, symbol, COUNT(*) as cnt
    FROM rt_candles
    WHERE tradeDate >= '2026-07-23'
    GROUP BY tradeDate, symbol
    ORDER BY tradeDate, symbol
  `);
  
  // 日付ごとにまとめる
  const byDate: Record<string, Record<string, number>> = {};
  for (const row of rows1 as any[]) {
    const d = row.tradeDate;
    if (!byDate[d]) byDate[d] = {};
    byDate[d][row.symbol] = Number(row.cnt);
  }
  
  const allSymbols = new Set<string>();
  for (const d of Object.keys(byDate)) {
    for (const s of Object.keys(byDate[d])) {
      allSymbols.add(s);
    }
  }
  const sortedSymbols = [...allSymbols].sort();
  const dates = Object.keys(byDate).sort();
  
  // ヘッダー
  console.log(`${"銘柄".padEnd(8)}${dates.map(d => d.slice(5).padStart(8)).join("")}`);
  console.log("-".repeat(8 + dates.length * 8));
  
  for (const sym of sortedSymbols) {
    let line = sym.padEnd(8);
    for (const d of dates) {
      const cnt = byDate[d]?.[sym] || 0;
      line += (cnt === 0 ? "  ❌  " : String(cnt).padStart(6) + "  ");
    }
    console.log(line);
  }

  // 2. 7/29の未受信銘柄を特定
  console.log("\n\n=== 7/29 未受信銘柄の詳細分析 ===\n");
  const missing0729 = ["285A", "6526", "6976", "3436", "3778", "5016"];
  
  // 過去にこれらの銘柄が欠落した日があるか
  console.log("未受信6銘柄の過去受信履歴:");
  for (const sym of missing0729) {
    const [history] = await db.execute(sql`
      SELECT tradeDate, COUNT(*) as cnt
      FROM rt_candles
      WHERE symbol = ${sym}
      GROUP BY tradeDate
      ORDER BY tradeDate
    `);
    const dates = (history as any[]).map(r => `${r.tradeDate}(${r.cnt}本)`).join(", ");
    console.log(`  ${sym}: ${dates || "受信履歴なし"}`);
  }

  // 3. 7/29の受信銘柄の最初と最後のcandleTimeを確認
  console.log("\n\n=== 7/29 受信銘柄の受信時間帯 ===\n");
  const [rows3] = await db.execute(sql`
    SELECT symbol, 
           MIN(candleTime) as firstCandle, 
           MAX(candleTime) as lastCandle, 
           COUNT(*) as cnt
    FROM rt_candles
    WHERE tradeDate = '2026-07-29'
    GROUP BY symbol
    ORDER BY symbol
  `);
  
  console.log(`${"銘柄".padEnd(8)} ${"最初".padEnd(8)} ${"最後".padEnd(8)} ${"本数".padStart(6)}`);
  for (const row of rows3 as any[]) {
    console.log(`${String(row.symbol).padEnd(8)} ${String(row.firstCandle).padEnd(8)} ${String(row.lastCandle).padEnd(8)} ${String(row.cnt).padStart(6)}`);
  }

  // 4. 7/28（正常日）の受信銘柄の最初と最後のcandleTimeを確認
  console.log("\n\n=== 7/28 受信銘柄の受信時間帯（正常日） ===\n");
  const [rows4] = await db.execute(sql`
    SELECT symbol, 
           MIN(candleTime) as firstCandle, 
           MAX(candleTime) as lastCandle, 
           COUNT(*) as cnt
    FROM rt_candles
    WHERE tradeDate = '2026-07-28'
    GROUP BY symbol
    ORDER BY symbol
  `);
  
  console.log(`${"銘柄".padEnd(8)} ${"最初".padEnd(8)} ${"最後".padEnd(8)} ${"本数".padStart(6)}`);
  for (const row of rows4 as any[]) {
    console.log(`${String(row.symbol).padEnd(8)} ${String(row.firstCandle).padEnd(8)} ${String(row.lastCandle).padEnd(8)} ${String(row.cnt).padStart(6)}`);
  }

  // 5. 7/29の受信開始時刻を確認（最初のデータが来た時刻）
  console.log("\n\n=== 7/29 最初のデータ受信時刻（銘柄別） ===\n");
  const [rows5] = await db.execute(sql`
    SELECT symbol, candleTime
    FROM rt_candles
    WHERE tradeDate = '2026-07-29'
    AND candleTime = (
      SELECT MIN(c2.candleTime) FROM rt_candles c2 
      WHERE c2.tradeDate = '2026-07-29' AND c2.symbol = rt_candles.symbol
    )
    ORDER BY candleTime, symbol
  `);
  
  for (const row of rows5 as any[]) {
    console.log(`  ${row.candleTime} - ${row.symbol}`);
  }

  // 6. rt_daily_summariesで7/28と7/29を比較
  console.log("\n\n=== rt_daily_summaries 比較 ===\n");
  const [rows6] = await db.execute(sql`
    SELECT tradeDate, candlesReceived, tradesCount, winCount, lossCount
    FROM rt_daily_summaries
    WHERE tradeDate >= '2026-07-23'
    ORDER BY tradeDate
  `);
  
  console.log(`${"日付".padEnd(12)} ${"ローソク足".padStart(10)} ${"取引数".padStart(8)} ${"勝".padStart(4)} ${"負".padStart(4)}`);
  for (const row of rows6 as any[]) {
    console.log(`${String(row.tradeDate).padEnd(12)} ${String(row.candlesReceived).padStart(10)} ${String(row.tradesCount).padStart(8)} ${String(row.winCount).padStart(4)} ${String(row.lossCount).padStart(4)}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
