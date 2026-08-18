import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, { long: number; short: number }> = {
  "8035": { long: 0.5, short: 0.8 }, "6857": { long: 0.6, short: 0.6 },
  "6976": { long: 0.6, short: 0.8 }, "6526": { long: 0.9, short: 1.0 },
  "5803": { long: 0.5, short: 0.6 }, "6981": { long: 0.4, short: 0.9 },
  "285A": { long: 0.8, short: 0.6 }, "6146": { long: 0.8, short: 0.8 },
  "6594": { long: 0.5, short: 0.5 }, "8316": { long: 0.5, short: 0.5 },
};
const ACTIVE = Object.keys(SL_MAP);
interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

function simulate(candles: C[], entryIdx: number, sl: number): { pnl: number } {
  const ep = candles[entryIdx].c;
  const shares = Math.floor(3000000 / ep / 100) * 100 || 100;
  const slPrice = ep * (1 + sl / 100);
  const tpPrice = ep * (1 - TP_PCT / 100);
  for (let j = entryIdx + 1; j < candles.length; j++) {
    if (candles[j].h >= slPrice) return { pnl: Math.round((ep - slPrice) * shares) };
    if (candles[j].l <= tpPrice) return { pnl: Math.round((ep - tpPrice) * shares) };
  }
  return { pnl: Math.round((ep - candles[candles.length - 1].c) * shares) };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [rows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime, open, high, low, close, volume
    FROM rt_candles WHERE tradeDate >= '2026-06-30' AND symbol IN (${ACTIVE.map(s=>`'${s}'`).join(",")})
    ORDER BY tradeDate, symbol, candleTime
  `) as any[];

  const days: Record<string, Record<string, C[]>> = {};
  for (const r of rows as any[]) {
    const d = r.tradeDate; const s = r.symbol;
    if (!days[d]) days[d] = {};
    if (!days[d][s]) days[d][s] = [];
    days[d][s].push({ t: r.candleTime, o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume) });
  }

  const thresholds = [1.0, 1.2, 1.5, 2.0, 2.5, 3.0];
  
  console.log(`\n=== 出来高倍率閾値スイープ（即エントリー部分のみ） ===\n`);
  console.log(`| 閾値 | 即エントリー件数 | 勝敗 | 勝率 | 総損益 | 1件平均 |`);
  console.log(`|---|---|---|---|---|---|`);

  for (const threshold of thresholds) {
    let trades = 0, wins = 0, pnl = 0;

    for (const [date, symbols] of Object.entries(days)) {
      for (const [sym, candles] of Object.entries(symbols)) {
        if (!SL_MAP[sym]) continue;
        const sl = SL_MAP[sym].short;

        for (let i = 1; i < candles.length - 5; i++) {
          const c = candles[i]; const prev = candles[i - 1];
          if (c.t < "09:30" || c.t >= "15:20") continue;

          const price = c.c;
          const step = price >= 50000 ? 1000 : price >= 10000 ? 500 : price >= 5000 ? 200 : 100;
          const roundBelow = Math.floor(prev.c / step) * step;
          if (!(prev.c > roundBelow && c.c < roundBelow && roundBelow > 0)) continue;

          // sell_pressure: 直近3本中2本以上陰線
          const recent3 = candles.slice(Math.max(0, i - 2), i + 1);
          const bearCount = recent3.filter(cc => cc.c < cc.o).length;
          if (bearCount < 2) continue;

          // 出来高判定
          const recentVols = candles.slice(Math.max(0, i - 20), i);
          const avgVol = recentVols.length > 0 ? recentVols.reduce((s, cc) => s + cc.v, 0) / recentVols.length : 1;
          const volRatio = avgVol > 0 ? c.v / avgVol : 0;
          if (volRatio < threshold) continue;

          // 即エントリー
          const r = simulate(candles, i + 1, sl);
          trades++;
          pnl += r.pnl;
          if (r.pnl > 0) wins++;
        }
      }
    }

    const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : "0";
    const avg = trades > 0 ? Math.round(pnl / trades).toLocaleString() : "0";
    console.log(`| ${threshold}倍 | ${trades}件 | ${wins}勝${trades - wins}敗 | ${wr}% | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円 | ${avg}円 |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
