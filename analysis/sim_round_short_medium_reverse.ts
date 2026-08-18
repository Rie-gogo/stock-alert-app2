import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, { long: number; short: number }> = {
  "8035": { long: 0.5, short: 0.8 }, "6857": { long: 0.6, short: 0.6 },
  "6976": { long: 0.6, short: 0.8 }, "6526": { long: 0.9, short: 1.0 },
  "5803": { long: 0.5, short: 0.6 }, "6981": { long: 0.4, short: 0.9 },
  "285A": { long: 0.8, short: 0.6 }, "6146": { long: 0.8, short: 0.8 },
  "6594": { long: 0.5, short: 0.5 }, "8316": { long: 0.5, short: 0.5 },
  "6920": { long: 0.8, short: 0.8 }, "5016": { long: 0.5, short: 0.5 },
  "9984": { long: 0.5, short: 0.5 },
};
interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  // 大台割れSHORT mediumのエントリー情報を取得
  const [entries] = await conn.query(`
    SELECT e.tradeDate, e.symbol, e.tradeTime as entryTime, CAST(e.price AS DECIMAL(12,2)) as entryPrice, x.pnl as shortPnl
    FROM rt_trades e
    JOIN rt_trades x ON e.tradeDate = x.tradeDate AND e.symbol = x.symbol AND x.action = 'cover' AND x.tradeTime > e.tradeTime
    WHERE e.tradeDate >= '2026-07-01' AND e.action = 'short' AND e.reason LIKE '%大台%' AND e.reason LIKE '%信頼度：中%'
    AND NOT EXISTS (SELECT 1 FROM rt_trades e2 WHERE e2.tradeDate = e.tradeDate AND e2.symbol = e.symbol AND e2.action = 'short' AND e2.tradeTime > e.tradeTime AND e2.tradeTime < x.tradeTime)
    ORDER BY e.tradeDate, e.tradeTime
  `) as any[];

  let shortWins = 0, shortLosses = 0, shortPnl = 0;
  let longWins = 0, longLosses = 0, longPnl = 0;

  console.log("| 日付 | 銘柄 | エントリー | SHORT結果 | SHORT損益 | LONG結果 | LONG損益 |");
  console.log("|---|---|---|---|---|---|---|");

  for (const e of entries as any[]) {
    const ep = Number(e.entryPrice);
    const sym = e.symbol;
    const sp = Number(e.shortPnl);
    const sl = SL_MAP[sym] || { long: 0.5, short: 0.8 };
    const shares = Math.floor(3000000 / ep / 100) * 100 || 100;

    // SHORT結果
    shortPnl += sp;
    if (sp > 0) shortWins++; else shortLosses++;

    // LONG結果: 同じエントリー価格でLONGした場合
    // rt_candlesからエントリー以降の値動きを取得
    const [candles] = await conn.query(`
      SELECT candleTime, open, high, low, close FROM rt_candles
      WHERE tradeDate = ? AND symbol = ? AND candleTime >= ?
      ORDER BY candleTime
    `, [e.tradeDate, sym, e.entryTime]) as any[];

    let longResult = "EOD";
    let lPnl = 0;
    const longSL = ep * (1 - sl.long / 100);
    const longTP = ep * (1 + TP_PCT / 100);

    for (const c of candles as any[]) {
      if (Number(c.low) <= longSL) { longResult = "SL"; lPnl = Math.round((longSL - ep) * shares); break; }
      if (Number(c.high) >= longTP) { longResult = "TP"; lPnl = Math.round((longTP - ep) * shares); break; }
    }
    if (longResult === "EOD" && candles.length > 0) {
      const lastC = Number((candles as any[])[candles.length - 1].close);
      lPnl = Math.round((lastC - ep) * shares);
    }

    longPnl += lPnl;
    if (lPnl > 0) longWins++; else longLosses++;

    const shortStr = sp >= 0 ? `+${sp.toLocaleString()}` : sp.toLocaleString();
    const longStr = lPnl >= 0 ? `+${lPnl.toLocaleString()}` : lPnl.toLocaleString();
    console.log(`| ${e.tradeDate} | ${sym} | @${ep.toLocaleString()} | ${sp > 0 ? "勝ち" : "負け"} | ${shortStr}円 | ${lPnl > 0 ? "勝ち" : "負け"} | ${longStr}円 |`);
  }

  console.log("\n=== 集計 ===");
  console.log(`SHORT: ${entries.length}件 ${shortWins}勝${shortLosses}敗 勝率${(shortWins/entries.length*100).toFixed(1)}% 総損益${shortPnl>=0?"+":""}${shortPnl.toLocaleString()}円`);
  console.log(`LONG:  ${entries.length}件 ${longWins}勝${longLosses}敗 勝率${(longWins/entries.length*100).toFixed(1)}% 総損益${longPnl>=0?"+":""}${longPnl.toLocaleString()}円`);

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
