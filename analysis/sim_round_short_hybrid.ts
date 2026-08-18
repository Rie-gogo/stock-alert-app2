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

function simulate(candles: C[], entryIdx: number, sl: number): { result: string; pnl: number; holdBars: number } {
  const ep = candles[entryIdx].c;
  const shares = Math.floor(3000000 / ep / 100) * 100 || 100;
  const slPrice = ep * (1 + sl / 100);
  const tpPrice = ep * (1 - TP_PCT / 100);
  for (let j = entryIdx + 1; j < candles.length; j++) {
    if (candles[j].h >= slPrice) return { result: "SL", pnl: Math.round((ep - slPrice) * shares), holdBars: j - entryIdx };
    if (candles[j].l <= tpPrice) return { result: "TP", pnl: Math.round((ep - tpPrice) * shares), holdBars: j - entryIdx };
  }
  const lastC = candles[candles.length - 1].c;
  return { result: "EOD", pnl: Math.round((ep - lastC) * shares), holdBars: candles.length - 1 - entryIdx };
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

  // 3パターン比較
  const results: Record<string, { trades: number; wins: number; pnl: number }> = {
    "現行(CB=2,MW=1)": { trades: 0, wins: 0, pnl: 0 },
    "案6_即(sell_p+vol)": { trades: 0, wins: 0, pnl: 0 },
    "案6_通常(CB=2,MW=1)": { trades: 0, wins: 0, pnl: 0 },
    "案6_合計": { trades: 0, wins: 0, pnl: 0 },
  };

  let fastEntries = 0;
  let normalEntries = 0;

  for (const [date, symbols] of Object.entries(days)) {
    for (const [sym, candles] of Object.entries(symbols)) {
      if (!SL_MAP[sym]) continue;
      const sl = SL_MAP[sym].short;
      const avgVol20 = candles.length >= 20 ? candles.slice(0, 20).reduce((s, c) => s + c.v, 0) / 20 : 0;

      for (let i = 1; i < candles.length - 5; i++) {
        const c = candles[i]; const prev = candles[i - 1];
        if (c.t < "09:30" || c.t >= "15:20") continue;

        // 大台割れ検出
        const price = c.c;
        const step = price >= 50000 ? 1000 : price >= 10000 ? 500 : price >= 5000 ? 200 : 100;
        const roundBelow = Math.floor(prev.c / step) * step;
        if (!(prev.c > roundBelow && c.c < roundBelow && roundBelow > 0)) continue;

        // 出来高の移動平均（直近20本）
        const recentVols = candles.slice(Math.max(0, i - 20), i);
        const avgVolRecent = recentVols.length > 0 ? recentVols.reduce((s, cc) => s + cc.v, 0) / recentVols.length : 1;
        const volRatio = avgVolRecent > 0 ? c.v / avgVolRecent : 0;

        // sell_pressure簡易判定: 直近3本で2本以上陰線 + 出来高増加
        const recent3 = candles.slice(Math.max(0, i - 2), i + 1);
        const bearCount = recent3.filter(cc => cc.c < cc.o).length;
        const isSellPressure = bearCount >= 2;

        // 出来高急増判定: 現在足の出来高が直近20本平均の1.5倍以上
        const isVolSpike = volRatio >= 1.5;

        // --- 現行(CB=2, MW=1): シグナル発生+3本後にエントリー ---
        const currentEntryIdx = i + 3;
        if (currentEntryIdx < candles.length) {
          // 確認バー2本維持チェック
          let confirmed = true;
          for (let k = i + 1; k <= i + 2 && k < candles.length; k++) {
            if (candles[k].c > roundBelow) { confirmed = false; break; }
          }
          if (confirmed) {
            const r = simulate(candles, currentEntryIdx, sl);
            results["現行(CB=2,MW=1)"].trades++;
            results["現行(CB=2,MW=1)"].pnl += r.pnl;
            if (r.pnl > 0) results["現行(CB=2,MW=1)"].wins++;
          }
        }

        // --- 案6: 条件合致時は即エントリー(+1本)、それ以外はCB=2,MW=1 ---
        if (isSellPressure && isVolSpike) {
          // 即エントリー（次の足）
          const fastIdx = i + 1;
          if (fastIdx < candles.length) {
            const r = simulate(candles, fastIdx, sl);
            results["案6_即(sell_p+vol)"].trades++;
            results["案6_即(sell_p+vol)"].pnl += r.pnl;
            if (r.pnl > 0) results["案6_即(sell_p+vol)"].wins++;
            results["案6_合計"].trades++;
            results["案6_合計"].pnl += r.pnl;
            if (r.pnl > 0) results["案6_合計"].wins++;
            fastEntries++;
          }
        } else {
          // 通常（CB=2, MW=1）
          const normalIdx = i + 3;
          if (normalIdx < candles.length) {
            let confirmed = true;
            for (let k = i + 1; k <= i + 2 && k < candles.length; k++) {
              if (candles[k].c > roundBelow) { confirmed = false; break; }
            }
            if (confirmed) {
              const r = simulate(candles, normalIdx, sl);
              results["案6_通常(CB=2,MW=1)"].trades++;
              results["案6_通常(CB=2,MW=1)"].pnl += r.pnl;
              if (r.pnl > 0) results["案6_通常(CB=2,MW=1)"].wins++;
              results["案6_合計"].trades++;
              results["案6_合計"].pnl += r.pnl;
              if (r.pnl > 0) results["案6_合計"].wins++;
              normalEntries++;
            }
          }
        }
      }
    }
  }

  console.log(`\n=== 案6（条件付き即エントリー）シミュレーション結果 ===\n`);
  console.log(`| パターン | 取引数 | 勝敗 | 勝率 | 総損益 | 1件平均 |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const [name, r] of Object.entries(results)) {
    const wr = r.trades > 0 ? (r.wins / r.trades * 100).toFixed(1) : "0";
    const avg = r.trades > 0 ? Math.round(r.pnl / r.trades).toLocaleString() : "0";
    console.log(`| ${name} | ${r.trades}件 | ${r.wins}勝${r.trades - r.wins}敗 | ${wr}% | ${r.pnl >= 0 ? "+" : ""}${r.pnl.toLocaleString()}円 | ${avg}円 |`);
  }
  console.log(`\n即エントリー: ${fastEntries}件, 通常エントリー: ${normalEntries}件`);
  console.log(`即エントリー比率: ${(fastEntries / (fastEntries + normalEntries) * 100).toFixed(1)}%`);

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
