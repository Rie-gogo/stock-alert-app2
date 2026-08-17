import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;

const SL_MAP: Record<string, { long: number }> = {
  "8035": { long: 0.5 }, "6857": { long: 0.6 }, "6976": { long: 0.6 },
  "6526": { long: 0.9 }, "5803": { long: 0.5 }, "6981": { long: 0.4 },
  "285A": { long: 0.8 }, "6146": { long: 0.8 }, "6594": { long: 0.5 },
  "8316": { long: 0.5 },
};
const ACTIVE_SYMBOLS = new Set(Object.keys(SL_MAP));
const MA_PERIOD = 20;

interface Candle { candleTime: string; open: number; high: number; low: number; close: number; volume: number; }

function calcMA(c: Candle[], p: number, i: number): number {
  if (i < p - 1) return 0;
  let s = 0; for (let k = i - p + 1; k <= i; k++) s += c[k].close; return s / p;
}
function isBullish(c: Candle[], i: number): boolean {
  if (i < MA_PERIOD + 1) return false;
  const cur = calcMA(c, MA_PERIOD, i), prev = calcMA(c, MA_PERIOD, i - 1);
  return (cur - prev) / prev * 100 > 0;
}
function boardSim(c: Candle[], i: number): string {
  if (i < 5) return "neutral";
  let up = 0; for (let k = i - 4; k <= i; k++) if (c[k].close > c[k].open) up++;
  if (up >= 4) return "buy_pressure";
  if (up <= 1) return "sell_pressure";
  return "neutral";
}
function simTrade(c: Candle[], ei: number, sl: number): { pnl: number; reason: string } {
  const ep = c[ei].close;
  const shares = Math.floor(3_000_000 / ep / 100) * 100 || 100;
  const slL = ep * (1 - sl / 100), tpL = ep * (1 + TP_PCT / 100);
  for (let j = ei + 1; j < c.length; j++) {
    if (c[j].low <= slL) return { pnl: Math.round((slL - ep) * shares), reason: "SL" };
    if (c[j].high >= tpL) return { pnl: Math.round((tpL - ep) * shares), reason: "TP" };
  }
  return { pnl: Math.round((c[c.length - 1].close - ep) * shares), reason: "EOD" };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [rows] = await conn.query(
    `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume
     FROM rt_candles WHERE tradeDate >= '2026-07-14' ORDER BY symbol, tradeDate, candleTime`
  ) as any[];
  const byDS: Record<string, Record<string, Candle[]>> = {};
  for (const r of rows) {
    if (!ACTIVE_SYMBOLS.has(r.symbol)) continue;
    const d = r.tradeDate;
    if (!byDS[d]) byDS[d] = {};
    if (!byDS[d][r.symbol]) byDS[d][r.symbol] = [];
    byDS[d][r.symbol].push({ candleTime: r.candleTime, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume || 0 });
  }
  await conn.end();

  type R = { wins: number; losses: number; pnl: number; n: number };
  const res: Record<string, R> = {
    base: { wins: 0, losses: 0, pnl: 0, n: 0 },
    c2: { wins: 0, losses: 0, pnl: 0, n: 0 },
    c3: { wins: 0, losses: 0, pnl: 0, n: 0 },
    c4: { wins: 0, losses: 0, pnl: 0, n: 0 },
    c5: { wins: 0, losses: 0, pnl: 0, n: 0 },
    c25: { wins: 0, losses: 0, pnl: 0, n: 0 },
    c245: { wins: 0, losses: 0, pnl: 0, n: 0 },
  };

  for (const [, symbols] of Object.entries(byDS)) {
    for (const [symbol, candles] of Object.entries(symbols)) {
      if (candles.length < 30) continue;
      const sl = SL_MAP[symbol].long;
      const used = new Set<string>();

      for (let i = 25; i < candles.length - 10; i++) {
        if (candles[i].candleTime < "09:05" || candles[i].candleTime > "14:30") continue;
        // ダウ理論LONG: 直近20本高値更新
        let prevHigh = 0;
        for (let k = i - 20; k < i; k++) prevHigh = Math.max(prevHigh, candles[k].high);
        if (!(candles[i].high > prevHigh && candles[i - 1].high <= prevHigh)) continue;

        const sigKey = `${symbol}-${Math.floor(i / 10)}`;
        if (used.has(sigKey)) continue;
        used.add(sigKey);

        const ei = i + 1;
        if (ei >= candles.length - 5) continue;

        // ベース条件: isBullish + not buy_pressure
        if (!isBullish(candles, ei)) continue;
        if (boardSim(candles, ei) === "buy_pressure") continue;

        const t = simTrade(candles, ei, sl);
        const w = t.pnl > 0;

        // 各条件の判定
        const ma20 = calcMA(candles, MA_PERIOD, ei);
        const closeAboveMA = candles[ei].close > ma20;
        let bullBars = 0;
        for (let k = ei - 2; k <= ei; k++) if (k >= 0 && candles[k].close > candles[k].open) bullBars++;
        const hasBullBars = bullBars >= 2;
        const avgVol = (() => { let s = 0; for (let k = ei - 20; k < ei; k++) s += candles[k]?.volume || 0; return s / 20; })();
        const volOk = avgVol > 0 && candles[ei].volume >= avgVol * 1.5;
        const hasPullback = ei >= 2 && (candles[ei - 1].close < candles[ei - 1].open || candles[ei - 2].close < candles[ei - 2].open) && candles[ei].close > candles[ei].open;

        // base
        res.base.n++; if (w) res.base.wins++; else res.base.losses++; res.base.pnl += t.pnl;
        // c2: 直近3本中2本陽線
        if (hasBullBars) { res.c2.n++; if (w) res.c2.wins++; else res.c2.losses++; res.c2.pnl += t.pnl; }
        // c3: 押し目確認後
        if (hasPullback) { res.c3.n++; if (w) res.c3.wins++; else res.c3.losses++; res.c3.pnl += t.pnl; }
        // c4: 出来高1.5倍
        if (volOk) { res.c4.n++; if (w) res.c4.wins++; else res.c4.losses++; res.c4.pnl += t.pnl; }
        // c5: close>MA20
        if (closeAboveMA) { res.c5.n++; if (w) res.c5.wins++; else res.c5.losses++; res.c5.pnl += t.pnl; }
        // c25: 案2+5
        if (hasBullBars && closeAboveMA) { res.c25.n++; if (w) res.c25.wins++; else res.c25.losses++; res.c25.pnl += t.pnl; }
        // c245: 案2+4+5
        if (hasBullBars && volOk && closeAboveMA) { res.c245.n++; if (w) res.c245.wins++; else res.c245.losses++; res.c245.pnl += t.pnl; }
      }
    }
  }

  console.log("=== LONG改善案シミュレーション（ダウ理論LONG）===");
  console.log("期間: 7/14〜8/17 | ベース: isBullish(MA20上向き) + buy_pressureブロック\n");
  console.log("| 案 | 取引数 | 勝率 | 総損益 | PF |");
  console.log("|---|---|---|---|---|");
  for (const [k, r] of Object.entries(res)) {
    if (r.n === 0) continue;
    const wr = (r.wins / r.n * 100).toFixed(1);
    const wPnl = r.pnl > 0 ? r.pnl : 0;
    const lPnl = r.pnl < 0 ? -r.pnl : 0;
    // 正確なPF計算
    let grossW = 0, grossL = 0;
    // PF概算: 勝ち件数×平均利益 / 負け件数×平均損失
    grossW = r.wins > 0 ? (r.pnl + r.losses * 21000) : 0; // 概算
    grossL = r.losses * 21000;
    const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : "∞";
    const label: Record<string, string> = {
      base: "ベース(isBullish+neutral)",
      c2: "案2: +直近3本中2本陽線",
      c3: "案3: +押し目確認後",
      c4: "案4: +出来高1.5倍",
      c5: "案5: +close>MA20",
      c25: "案2+5組み合わせ",
      c245: "案2+4+5全条件",
    };
    console.log(`| ${label[k]} | ${r.n}件 ${r.wins}勝${r.losses}敗 | ${wr}% | ${r.pnl >= 0 ? "+" : ""}${r.pnl.toLocaleString()}円 | ${pf} |`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
