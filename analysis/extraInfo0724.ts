import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const today = "2026-07-24";

  // Check candle count
  const r1 = await db.execute(sql`
    SELECT COUNT(*) as cnt, COUNT(DISTINCT symbol) as symbols,
           MIN(candleTime) as firstCandle, MAX(candleTime) as lastCandle
    FROM rt_candles WHERE tradeDate = ${today}
  `);
  console.log("■ データ受信状況");
  const info = (r1 as any)[0][0];
  console.log(`  受信ローソク足: ${info.cnt}本 (${info.symbols}銘柄)`);
  console.log(`  時間範囲: ${info.firstCandle} ～ ${info.lastCandle}`);

  // Check score0 blocks for today
  try {
    const r2 = await db.execute(sql`
      SELECT symbol, candleTime, side, SUBSTRING(signalReason, 1, 100) as reason
      FROM rt_score0_blocks WHERE tradeDate = ${today}
      ORDER BY candleTime
    `);
    const blocks = (r2 as any)[0];
    if (blocks.length > 0) {
      console.log(`\n■ 板読みスコア0ブロック (${blocks.length}件)`);
      for (const b of blocks) {
        console.log(`  ${b.candleTime} ${b.symbol} ${b.side}: ${b.reason}`);
      }
    } else {
      console.log(`\n■ 板読みスコア0ブロック: 0件`);
    }
  } catch (e) {
    console.log(`\n■ 板読みスコア0ブロック: テーブルエラー`);
  }

  // Check 3peak signals for today
  try {
    const r3 = await db.execute(sql`
      SELECT symbol, detectedAt, direction, peakPrices, necklinePrice, entryPrice, status, virtualPnl
      FROM rt_3peak_signals WHERE tradeDate = ${today}
      ORDER BY detectedAt
    `);
    const peaks = (r3 as any)[0];
    if (peaks.length > 0) {
      console.log(`\n■ 3山/3谷シグナル (${peaks.length}件)`);
      for (const p of peaks) {
        console.log(`  ${p.detectedAt} ${p.symbol} ${p.direction} status=${p.status} pnl=${p.virtualPnl}`);
      }
    } else {
      console.log(`\n■ 3山/3谷シグナル: 0件`);
    }
  } catch (e) {
    console.log(`\n■ 3山/3谷シグナル: テーブルエラー`);
  }

  // Weekly summary
  const r4 = await db.execute(sql`
    SELECT SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END) as weekPnl,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses
    FROM rt_trades WHERE tradeDate >= '2026-07-21' AND tradeDate <= '2026-07-24'
  `);
  const week = (r4 as any)[0][0];
  console.log(`\n■ 今週の累計 (7/21-7/24)`);
  console.log(`  損益: ${Number(week.weekPnl).toLocaleString()}円`);
  console.log(`  成績: ${week.wins}勝${week.losses}敗`);

  // Check production logs for blocked signals
  console.log(`\n■ 本日のフィルターブロック状況 (本番ログから推定)`);
  console.log(`  ※ 本番ログは午後分のみ保持のため、午前のブロック状況は不明`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
