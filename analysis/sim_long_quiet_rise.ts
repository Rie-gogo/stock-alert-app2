import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, number> = {
  "8035": 0.5, "6857": 0.6, "6976": 0.6, "6526": 0.9, "5803": 0.5,
  "6981": 0.4, "285A": 0.8, "6146": 0.8, "6594": 0.5, "8316": 0.5,
};
const ACTIVE = new Set(Object.keys(SL_MAP));
const MA = 20;
interface C { t: string; o: number; h: number; l: number; c: number; v: number; }
function calcMA(c: C[], p: number, i: number) { if (i < p - 1) return 0; let s = 0; for (let k = i - p + 1; k <= i; k++) s += c[k].c; return s / p; }
function isBullish(c: C[], i: number) { if (i < MA + 1) return false; const cur = calcMA(c, MA, i), prev = calcMA(c, MA, i - 1); return (cur - prev) / prev * 100 > 0; }
function board(c: C[], i: number) { if (i < 5) return "neutral"; let u = 0, d = 0; for (let k = i - 4; k <= i; k++) { if (c[k].c > c[k].o) u++; else if (c[k].c < c[k].o) d++; } return u >= 4 ? "buy_pressure" : d >= 4 ? "sell_pressure" : "neutral"; }
function sim(c: C[], ei: number, sl: number) { const ep = c[ei].c; const sh = Math.floor(3000000 / ep / 100) * 100 || 100; const slL = ep * (1 - sl / 100), tpL = ep * (1 + TP_PCT / 100); for (let j = ei + 1; j < c.length; j++) { if (c[j].l <= slL) return { pnl: Math.round((slL - ep) * sh), r: "SL" }; if (c[j].h >= tpL) return { pnl: Math.round((tpL - ep) * sh), r: "TP" }; } return { pnl: Math.round((c[c.length - 1].c - ep) * sh), r: "EOD" }; }

// 売り圧力の不在を判定する関数
function noSellPressure(c: C[], i: number): boolean {
  if (i < 10) return false;
  // 直近10本で陰線が3本以下 = 売り圧力が弱い
  let downBars = 0;
  for (let k = i - 9; k <= i; k++) if (c[k].c < c[k].o) downBars++;
  return downBars <= 3;
}

// 売り板が薄い（出来高減少中 + 下ヒゲなし）= 売り手不在
function sellAbsent(c: C[], i: number): boolean {
  if (i < 5) return false;
  // 直近5本で下ヒゲ（安値がopen/closeより大きく離れている）が少ない
  let longLowerWick = 0;
  for (let k = i - 4; k <= i; k++) {
    const body = Math.abs(c[k].c - c[k].o);
    const lowerWick = Math.min(c[k].o, c[k].c) - c[k].l;
    if (lowerWick > body * 0.5) longLowerWick++;
  }
  // 下ヒゲが少ない = 売り手が攻めていない
  return longLowerWick <= 1;
}

// 出来高が減少している（売りも買いも枯れている = 静かな上昇）
function volumeDecreasing(c: C[], i: number): boolean {
  if (i < 10) return false;
  const recent5 = (c[i].v + c[i-1].v + c[i-2].v + c[i-3].v + c[i-4].v) / 5;
  const prev5 = (c[i-5].v + c[i-6].v + c[i-7].v + c[i-8].v + c[i-9].v) / 5;
  return prev5 > 0 && recent5 / prev5 < 0.8;
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [rows] = await conn.query(`SELECT symbol,tradeDate,candleTime,open,high,low,close,volume FROM rt_candles WHERE tradeDate>='2026-07-14' ORDER BY symbol,tradeDate,candleTime`) as any[];
  const byDS: Record<string, Record<string, C[]>> = {};
  for (const r of rows) { if (!ACTIVE.has(r.symbol)) continue; const d = r.tradeDate; if (!byDS[d]) byDS[d] = {}; if (!byDS[d][r.symbol]) byDS[d][r.symbol] = []; byDS[d][r.symbol].push({ t: r.candleTime, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 }); }
  await conn.end();

  type R = { w: number; l: number; pnl: number; n: number };
  const res: Record<string, R> = {
    base: { w: 0, l: 0, pnl: 0, n: 0 },
    quiet: { w: 0, l: 0, pnl: 0, n: 0 },         // ① MA乖離<0.3% + 実体<0.1%
    noSell: { w: 0, l: 0, pnl: 0, n: 0 },         // ② 売り圧力不在
    sellAbsent: { w: 0, l: 0, pnl: 0, n: 0 },     // ② 売り手不在（下ヒゲなし）
    volDown: { w: 0, l: 0, pnl: 0, n: 0 },        // ② 出来高減少
    noSell_quiet: { w: 0, l: 0, pnl: 0, n: 0 },   // ①+② 組み合わせ
    sellAbsent_quiet: { w: 0, l: 0, pnl: 0, n: 0 },
    volDown_quiet: { w: 0, l: 0, pnl: 0, n: 0 },
    allSellFilters: { w: 0, l: 0, pnl: 0, n: 0 }, // 全売り不在条件
  };

  for (const [, syms] of Object.entries(byDS)) {
    for (const [sym, candles] of Object.entries(syms)) {
      if (candles.length < 30) continue;
      const sl = SL_MAP[sym];
      const used = new Set<string>();
      for (let i = 25; i < candles.length - 10; i++) {
        if (candles[i].t < "09:05" || candles[i].t > "14:30") continue;
        let pH = 0; for (let k = i - 20; k < i; k++) pH = Math.max(pH, candles[k].h);
        if (!(candles[i].h > pH && candles[i - 1].h <= pH)) continue;
        const sk = `${sym}-${Math.floor(i / 10)}`; if (used.has(sk)) continue; used.add(sk);
        const ei = i + 1; if (ei >= candles.length - 5) continue;
        if (!isBullish(candles, ei)) continue;
        if (board(candles, ei) === "buy_pressure") continue;
        const ma20 = calcMA(candles, MA, ei);
        if (candles[ei].c <= ma20) continue;

        const t = sim(candles, ei, sl);
        const w = t.pnl > 0;
        const maDiv = (candles[ei].c - ma20) / ma20 * 100;
        const barSize = Math.abs(candles[ei].c - candles[ei].o) / candles[ei].o * 100;
        const isQuiet = maDiv < 0.3 && barSize < 0.1;
        const isNoSell = noSellPressure(candles, ei);
        const isSellAbsent = sellAbsent(candles, ei);
        const isVolDown = volumeDecreasing(candles, ei);

        // base
        res.base.n++; if (w) res.base.w++; else res.base.l++; res.base.pnl += t.pnl;
        // ① 静かな上昇
        if (isQuiet) { res.quiet.n++; if (w) res.quiet.w++; else res.quiet.l++; res.quiet.pnl += t.pnl; }
        // ② 売り圧力不在
        if (isNoSell) { res.noSell.n++; if (w) res.noSell.w++; else res.noSell.l++; res.noSell.pnl += t.pnl; }
        if (isSellAbsent) { res.sellAbsent.n++; if (w) res.sellAbsent.w++; else res.sellAbsent.l++; res.sellAbsent.pnl += t.pnl; }
        if (isVolDown) { res.volDown.n++; if (w) res.volDown.w++; else res.volDown.l++; res.volDown.pnl += t.pnl; }
        // ①+②
        if (isQuiet && isNoSell) { res.noSell_quiet.n++; if (w) res.noSell_quiet.w++; else res.noSell_quiet.l++; res.noSell_quiet.pnl += t.pnl; }
        if (isQuiet && isSellAbsent) { res.sellAbsent_quiet.n++; if (w) res.sellAbsent_quiet.w++; else res.sellAbsent_quiet.l++; res.sellAbsent_quiet.pnl += t.pnl; }
        if (isQuiet && isVolDown) { res.volDown_quiet.n++; if (w) res.volDown_quiet.w++; else res.volDown_quiet.l++; res.volDown_quiet.pnl += t.pnl; }
        if (isNoSell && isSellAbsent && !isVolDown) { res.allSellFilters.n++; if (w) res.allSellFilters.w++; else res.allSellFilters.l++; res.allSellFilters.pnl += t.pnl; }
      }
    }
  }

  console.log("=== LONG改善: 静かな上昇 + 売り圧力不在 ===");
  console.log("期間: 7/14〜8/17 | ベース: isBullish + close>MA20 + buy_pressureブロック\n");
  console.log("| 条件 | 取引数 | 勝率 | 総損益 | 1件平均 |");
  console.log("|---|---|---|---|---|");
  const labels: Record<string, string> = {
    base: "ベース(案5)",
    quiet: "① MA乖離<0.3% + 実体<0.1%",
    noSell: "② 売り圧力不在(直近10本で陰線3本以下)",
    sellAbsent: "② 売り手不在(下ヒゲ少ない)",
    volDown: "② 出来高減少(直近5本/前5本 < 0.8)",
    noSell_quiet: "①+② 静かな上昇 + 売り圧力不在",
    sellAbsent_quiet: "①+② 静かな上昇 + 売り手不在",
    volDown_quiet: "①+② 静かな上昇 + 出来高減少",
    allSellFilters: "② 売り圧力不在 + 売り手不在",
  };
  for (const [k, r] of Object.entries(res)) {
    if (r.n === 0) continue;
    const wr = (r.w / r.n * 100).toFixed(1);
    const avg = Math.round(r.pnl / r.n);
    console.log(`| ${labels[k]} | ${r.n}件 ${r.w}勝${r.l}敗 | ${wr}% | ${r.pnl >= 0 ? "+" : ""}${r.pnl.toLocaleString()}円 | ${avg >= 0 ? "+" : ""}${avg.toLocaleString()}円 |`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
