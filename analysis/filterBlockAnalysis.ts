/**
 * フィルター別ブロック分析
 * 7/1以降の日別取引数と、各フィルターのブロック件数を集計
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL || "", connectionLimit: 3 });
  const db = drizzle(pool);

  // 1. 日別取引数
  console.log("=== 日別取引数（7/1以降） ===");
  console.log("| 日付 | 取引数 | 勝 | 敗 | 勝率 | 損益 |");
  console.log("|------|--------|---|---|------|------|");
  
  const [tradeRows] = await db.execute(
    sql`SELECT tradeDate, COUNT(*) as trades, 
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins, 
        SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses, 
        ROUND(SUM(pnl), 0) as totalPnl 
        FROM rt_trades WHERE tradeDate >= '2026-07-01' 
        GROUP BY tradeDate ORDER BY tradeDate ASC`
  );
  
  let preFilterTotal = 0;
  let postFilterTotal = 0;
  for (const r of tradeRows as any[]) {
    const winRate = r.trades > 0 ? (Number(r.wins) / Number(r.trades) * 100).toFixed(1) : "0";
    const marker = r.tradeDate >= "2026-07-16" ? " ★" : "";
    console.log(`| ${r.tradeDate}${marker} | ${r.trades} | ${r.wins} | ${r.losses} | ${winRate}% | ${Number(r.totalPnl).toLocaleString()}円 |`);
    if (r.tradeDate < "2026-07-16") preFilterTotal += Number(r.trades);
    else postFilterTotal += Number(r.trades);
  }
  
  const preDays = (tradeRows as any[]).filter((r: any) => r.tradeDate < "2026-07-16").length;
  const postDays = (tradeRows as any[]).filter((r: any) => r.tradeDate >= "2026-07-16").length;
  console.log("");
  console.log(`7/16以前: ${preDays}日間で${preFilterTotal}取引 (平均${(preFilterTotal/preDays).toFixed(1)}件/日)`);
  console.log(`7/16以降: ${postDays}日間で${postFilterTotal}取引 (平均${(postFilterTotal/postDays).toFixed(1)}件/日)`);
  console.log("");

  // 2. score0_blocks (板読みスコア0ブロック) 日別
  console.log("=== 板読みスコア0ブロック（rt_score0_blocks）日別 ===");
  console.log("| 日付 | ブロック件数 |");
  console.log("|------|------------|");
  
  const [scoreRows] = await db.execute(
    sql`SELECT trade_date as tradeDate, COUNT(*) as blocks FROM rt_score0_blocks WHERE trade_date >= '2026-07-01' GROUP BY trade_date ORDER BY trade_date ASC`
  );
  for (const r of scoreRows as any[]) {
    const marker = r.tradeDate >= "2026-07-16" ? " ★" : "";
    console.log(`| ${r.tradeDate}${marker} | ${r.blocks} |`);
  }
  console.log("");

  // 3. Check rt_trades for exitReason breakdown
  console.log("=== サイド別（7/16以前 vs 以降） ===");
  const [reasonPre] = await db.execute(
    sql`SELECT side, COUNT(*) as cnt, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins FROM rt_trades WHERE tradeDate >= '2026-07-01' AND tradeDate < '2026-07-16' GROUP BY side ORDER BY cnt DESC`
  );
  const [reasonPost] = await db.execute(
    sql`SELECT side, COUNT(*) as cnt, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins FROM rt_trades WHERE tradeDate >= '2026-07-16' GROUP BY side ORDER BY cnt DESC`
  );
  console.log("7/16以前:");
  for (const r of reasonPre as any[]) console.log(`  ${r.side}: ${r.cnt}件 (勝${r.wins})`);
  console.log("7/16以降:");
  for (const r of reasonPost as any[]) console.log(`  ${r.side}: ${r.cnt}件 (勝${r.wins})`);
  console.log("");

  // 4. Check trade entry reasons to understand what signals are generating trades
  console.log("=== エントリー理由別（7/16以前 vs 以降） ===");
  const [entryPre] = await db.execute(
    sql`SELECT SUBSTRING_INDEX(reason, ':', 1) as reasonType, COUNT(*) as cnt FROM rt_trades WHERE tradeDate >= '2026-07-01' AND tradeDate < '2026-07-16' GROUP BY reasonType ORDER BY cnt DESC LIMIT 15`
  );
  const [entryPost] = await db.execute(
    sql`SELECT SUBSTRING_INDEX(reason, ':', 1) as reasonType, COUNT(*) as cnt FROM rt_trades WHERE tradeDate >= '2026-07-16' GROUP BY reasonType ORDER BY cnt DESC LIMIT 15`
  );
  console.log("7/16以前:");
  for (const r of entryPre as any[]) console.log(`  ${r.reasonType}: ${r.cnt}件`);
  console.log("\n7/16以降:");
  for (const r of entryPost as any[]) console.log(`  ${r.reasonType}: ${r.cnt}件`);
  console.log("");

  // 5. Score0 blocks by context (what filter blocked them)
  console.log("=== score0_blocks コンテキスト別（7/16以降） ===");
  const [contextRows] = await db.execute(
    sql`SELECT context, side, COUNT(*) as cnt FROM rt_score0_blocks WHERE trade_date >= '2026-07-16' GROUP BY context, side ORDER BY cnt DESC`
  );
  for (const r of contextRows as any[]) console.log(`  ${r.context} (${r.side}): ${r.cnt}件`);
  console.log("");

  // 6. Check if there are any other block records (like signalHistory with round_distance_block)
  // Since signalHistory is in-memory only, let's check production logs
  // Instead, let's analyze the candle data to understand signal generation
  console.log("=== 1分足データ量（日別） ===");
  const [candleRows] = await db.execute(
    sql`SELECT tradeDate, COUNT(*) as candles, COUNT(DISTINCT symbol) as symbols 
        FROM rt_candles WHERE tradeDate >= '2026-07-01' 
        GROUP BY tradeDate ORDER BY tradeDate ASC`
  );
  console.log("| 日付 | 足数 | 銘柄数 |");
  console.log("|------|------|--------|");
  for (const r of candleRows as any[]) {
    const marker = r.tradeDate >= "2026-07-16" ? " ★" : "";
    console.log(`| ${r.tradeDate}${marker} | ${r.candles} | ${r.symbols} |`);
  }
  console.log("");

  // 7. Per-symbol trade count comparison
  console.log("=== 銘柄別取引数（7/16以前 vs 以降） ===");
  console.log("| 銘柄 | 7/1-7/15 | 7/16以降 | 差 |");
  console.log("|------|----------|----------|---|");
  const [symPre] = await db.execute(
    sql`SELECT symbol, COUNT(*) as cnt FROM rt_trades WHERE tradeDate >= '2026-07-01' AND tradeDate < '2026-07-16' GROUP BY symbol ORDER BY symbol`
  );
  const [symPost] = await db.execute(
    sql`SELECT symbol, COUNT(*) as cnt FROM rt_trades WHERE tradeDate >= '2026-07-16' GROUP BY symbol ORDER BY symbol`
  );
  const preMap = new Map((symPre as any[]).map(r => [r.symbol, Number(r.cnt)]));
  const postMap = new Map((symPost as any[]).map(r => [r.symbol, Number(r.cnt)]));
  const allSymbols = new Set([...preMap.keys(), ...postMap.keys()]);
  for (const sym of [...allSymbols].sort()) {
    const pre = preMap.get(sym) || 0;
    const post = postMap.get(sym) || 0;
    const diff = post - pre;
    console.log(`| ${sym} | ${pre} | ${post} | ${diff >= 0 ? "+" : ""}${diff} |`);
  }

  await pool.end();
}

main().catch(console.error);
