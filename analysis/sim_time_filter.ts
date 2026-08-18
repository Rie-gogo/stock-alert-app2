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

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [rows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime, open, high, low, close, volume
    FROM rt_candles WHERE tradeDate >= '2026-07-14' AND symbol IN (${ACTIVE.map(s=>`'${s}'`).join(",")})
    ORDER BY tradeDate, symbol, candleTime
  `) as any[];

  // グループ化
  const days: Record<string, Record<string, C[]>> = {};
  for (const r of rows as any[]) {
    const d = r.tradeDate; const s = r.symbol;
    if (!days[d]) days[d] = {};
    if (!days[d][s]) days[d][s] = [];
    days[d][s].push({ t: r.candleTime, o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume) });
  }

  // 禁止時間帯にキリ番割れ/超えが発生したか検出
  let blockedTrades: { date: string; symbol: string; time: string; side: string; price: number; result: string; pnl: number }[] = [];

  for (const [date, symbols] of Object.entries(days)) {
    for (const [sym, candles] of Object.entries(symbols)) {
      const sl = SL_MAP[sym] || { long: 0.8, short: 0.8 };
      for (let i = 1; i < candles.length; i++) {
        const c = candles[i]; const prev = candles[i-1];
        // 禁止時間帯のみチェック
        if (!((c.t >= "11:00" && c.t < "11:30") || (c.t >= "12:30" && c.t < "13:00"))) continue;

        // 大台割れ検出（簡易: 前足close > キリ番 && 今足close < キリ番）
        const price = c.c;
        const step = price >= 50000 ? 1000 : price >= 10000 ? 500 : price >= 5000 ? 200 : 100;
        const roundBelow = Math.floor(prev.c / step) * step;
        if (prev.c > roundBelow && c.c < roundBelow && roundBelow > 0) {
          // 大台割れSHORT
          const ep = c.c;
          const shares = Math.floor(3000000 / ep / 100) * 100 || 100;
          const slPrice = ep * (1 + sl.short / 100);
          const tpPrice = ep * (1 - TP_PCT / 100);
          let result = "EOD"; let pnl = 0;
          for (let j = i + 3; j < candles.length; j++) { // CB=2 + MW=1 = 3本後からエントリー
            if (candles[j].h >= slPrice) { result = "SL"; pnl = Math.round((ep - slPrice) * shares); break; }
            if (candles[j].l <= tpPrice) { result = "TP"; pnl = Math.round((ep - tpPrice) * shares); break; }
          }
          if (result === "EOD" && candles.length > i+3) { pnl = Math.round((ep - candles[candles.length-1].c) * shares); }
          blockedTrades.push({ date, symbol: sym, time: c.t, side: "SHORT", price: ep, result, pnl });
        }
        // 大台超え検出
        const roundAbove = Math.ceil(prev.c / step) * step;
        if (prev.c < roundAbove && c.c > roundAbove && roundAbove > 0 && roundAbove !== roundBelow) {
          // 大台超え → 現在は停止中なのでスキップ
        }
      }
    }
  }

  console.log(`\n=== 禁止時間帯(11:00-11:30, 12:30-13:00)で発生した大台割れSHORTシグナル ===\n`);
  console.log(`| 日付 | 銘柄 | 時刻 | エントリー | 結果 | 損益 |`);
  console.log(`|---|---|---|---|---|---|`);
  let totalPnl = 0; let wins = 0; let losses = 0;
  for (const t of blockedTrades) {
    totalPnl += t.pnl;
    if (t.pnl > 0) wins++; else losses++;
    console.log(`| ${t.date} | ${t.symbol} | ${t.time} | @${t.price.toLocaleString()} | ${t.result} | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 |`);
  }
  console.log(`\n集計: ${blockedTrades.length}件 ${wins}勝${losses}敗 総損益${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`1件平均: ${blockedTrades.length > 0 ? Math.round(totalPnl / blockedTrades.length).toLocaleString() : 0}円`);

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
