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
function board(c: C[], i: number) { if (i < 5) return "neutral"; let u = 0; for (let k = i - 4; k <= i; k++) if (c[k].c > c[k].o) u++; return u >= 4 ? "buy_pressure" : u <= 1 ? "sell_pressure" : "neutral"; }
function sim(c: C[], ei: number, sl: number) { const ep = c[ei].c; const sh = Math.floor(3000000 / ep / 100) * 100 || 100; const slL = ep * (1 - sl / 100), tpL = ep * (1 + TP_PCT / 100); for (let j = ei + 1; j < c.length; j++) { if (c[j].l <= slL) return { pnl: Math.round((slL - ep) * sh), r: "SL", holdBars: j - ei }; if (c[j].h >= tpL) return { pnl: Math.round((tpL - ep) * sh), r: "TP", holdBars: j - ei }; } return { pnl: Math.round((c[c.length - 1].c - ep) * sh), r: "EOD", holdBars: c.length - 1 - ei }; }

interface Feature {
  result: "WIN" | "LOSS";
  pnl: number;
  symbol: string;
  volRatio: number;       // エントリー足の出来高 / 直近20本平均
  maDeviation: number;    // close vs MA20 乖離率(%)
  momentum3: number;      // 直近3本の値動き幅(%)
  momentum5: number;      // 直近5本の値動き幅(%)
  consUpBars: number;     // エントリー前の連続陽線数
  highDist: number;       // 直近20本高値からの距離(%)
  barSize: number;        // エントリー足の実体サイズ(%)
  prevBarDir: number;     // 直前足の方向（1=陽線, -1=陰線, 0=同値）
  volTrend: number;       // 直近5本の出来高トレンド（最新/5本前）
  holdBars: number;       // 保有本数
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [rows] = await conn.query(`SELECT symbol,tradeDate,candleTime,open,high,low,close,volume FROM rt_candles WHERE tradeDate>='2026-07-14' ORDER BY symbol,tradeDate,candleTime`) as any[];
  const byDS: Record<string, Record<string, C[]>> = {};
  for (const r of rows) { if (!ACTIVE.has(r.symbol)) continue; const d = r.tradeDate; if (!byDS[d]) byDS[d] = {}; if (!byDS[d][r.symbol]) byDS[d][r.symbol] = []; byDS[d][r.symbol].push({ t: r.candleTime, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 }); }
  await conn.end();

  const features: Feature[] = [];

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
        if (candles[ei].c <= ma20) continue; // 案5条件

        const t = sim(candles, ei, sl);
        const result = t.pnl > 0 ? "WIN" : "LOSS" as "WIN" | "LOSS";

        // 特徴量計算
        const avgVol = (() => { let s = 0; for (let k = ei - 20; k < ei; k++) s += candles[k]?.v || 0; return s / 20; })();
        const volRatio = avgVol > 0 ? candles[ei].v / avgVol : 1;
        const maDeviation = (candles[ei].c - ma20) / ma20 * 100;
        const momentum3 = (candles[ei].c - candles[ei - 3].c) / candles[ei - 3].c * 100;
        const momentum5 = (candles[ei].c - candles[ei - 5].c) / candles[ei - 5].c * 100;
        let consUp = 0; for (let k = ei; k >= Math.max(0, ei - 10); k--) { if (candles[k].c > candles[k].o) consUp++; else break; }
        const highDist = (pH - candles[ei].c) / candles[ei].c * 100; // 負=高値超え
        const barSize = Math.abs(candles[ei].c - candles[ei].o) / candles[ei].o * 100;
        const prevBarDir = candles[ei - 1].c > candles[ei - 1].o ? 1 : candles[ei - 1].c < candles[ei - 1].o ? -1 : 0;
        const volTrend = candles[ei - 5]?.v > 0 ? candles[ei].v / candles[ei - 5].v : 1;

        features.push({ result, pnl: t.pnl, symbol: sym, volRatio, maDeviation, momentum3, momentum5, consUpBars: consUp, highDist, barSize, prevBarDir, volTrend, holdBars: t.holdBars });
      }
    }
  }

  const wins = features.filter(f => f.result === "WIN");
  const losses = features.filter(f => f.result === "LOSS");

  console.log("=== 案5ベース LONG 勝ち/負け特徴分析 ===");
  console.log(`期間: 7/14〜8/17 | 全${features.length}件 (${wins.length}勝${losses.length}敗)\n`);

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const med = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s.length > 0 ? s[Math.floor(s.length / 2)] : 0; };

  console.log("| 特徴量 | 勝ち平均 | 負け平均 | 勝ち中央値 | 負け中央値 | 差の方向 |");
  console.log("|---|---|---|---|---|---|");

  const metrics: { name: string; key: keyof Feature }[] = [
    { name: "出来高比率(vs20本平均)", key: "volRatio" },
    { name: "MA20乖離率(%)", key: "maDeviation" },
    { name: "直近3本モメンタム(%)", key: "momentum3" },
    { name: "直近5本モメンタム(%)", key: "momentum5" },
    { name: "連続陽線数", key: "consUpBars" },
    { name: "20本高値からの距離(%)", key: "highDist" },
    { name: "エントリー足実体(%)", key: "barSize" },
    { name: "直前足方向(1=陽,-1=陰)", key: "prevBarDir" },
    { name: "出来高トレンド(最新/5本前)", key: "volTrend" },
    { name: "保有本数", key: "holdBars" },
  ];

  for (const m of metrics) {
    const wVals = wins.map(f => f[m.key] as number);
    const lVals = losses.map(f => f[m.key] as number);
    const wAvg = avg(wVals).toFixed(3);
    const lAvg = avg(lVals).toFixed(3);
    const wMed = med(wVals).toFixed(3);
    const lMed = med(lVals).toFixed(3);
    const dir = +wAvg > +lAvg ? "勝ち>負け" : +wAvg < +lAvg ? "勝ち<負け" : "同じ";
    console.log(`| ${m.name} | ${wAvg} | ${lAvg} | ${wMed} | ${lMed} | ${dir} |`);
  }

  // 条件別の勝率
  console.log("\n=== 条件別フィルターの勝率 ===\n");
  const filters: { name: string; fn: (f: Feature) => boolean }[] = [
    { name: "出来高比率 >= 1.5", fn: f => f.volRatio >= 1.5 },
    { name: "出来高比率 >= 2.0", fn: f => f.volRatio >= 2.0 },
    { name: "出来高比率 < 1.0", fn: f => f.volRatio < 1.0 },
    { name: "MA乖離率 < 0.3%", fn: f => f.maDeviation < 0.3 },
    { name: "MA乖離率 0.1〜0.5%", fn: f => f.maDeviation >= 0.1 && f.maDeviation <= 0.5 },
    { name: "MA乖離率 > 0.5%", fn: f => f.maDeviation > 0.5 },
    { name: "直近3本モメンタム < 0.3%", fn: f => f.momentum3 < 0.3 },
    { name: "直近3本モメンタム 0.1〜0.4%", fn: f => f.momentum3 >= 0.1 && f.momentum3 <= 0.4 },
    { name: "直近3本モメンタム > 0.5%", fn: f => f.momentum3 > 0.5 },
    { name: "連続陽線 1本のみ", fn: f => f.consUpBars === 1 },
    { name: "連続陽線 2本", fn: f => f.consUpBars === 2 },
    { name: "連続陽線 3本以上", fn: f => f.consUpBars >= 3 },
    { name: "直前足が陰線", fn: f => f.prevBarDir === -1 },
    { name: "直前足が陽線", fn: f => f.prevBarDir === 1 },
    { name: "エントリー足実体 > 0.2%", fn: f => f.barSize > 0.2 },
    { name: "エントリー足実体 < 0.1%", fn: f => f.barSize < 0.1 },
    { name: "出来高トレンド > 1.5", fn: f => f.volTrend > 1.5 },
    { name: "出来高トレンド < 0.7", fn: f => f.volTrend < 0.7 },
    { name: "MA乖離<0.3% + 直前陰線", fn: f => f.maDeviation < 0.3 && f.prevBarDir === -1 },
    { name: "モメンタム0.1-0.4% + 出来高>=1.5", fn: f => f.momentum3 >= 0.1 && f.momentum3 <= 0.4 && f.volRatio >= 1.5 },
    { name: "連続陽線1本 + MA乖離<0.3%", fn: f => f.consUpBars === 1 && f.maDeviation < 0.3 },
    { name: "直前陰線 + 出来高>=1.5", fn: f => f.prevBarDir === -1 && f.volRatio >= 1.5 },
  ];

  console.log("| 条件 | 取引数 | 勝率 | 総損益 | 1件平均 |");
  console.log("|---|---|---|---|---|");
  for (const fl of filters) {
    const matched = features.filter(fl.fn);
    if (matched.length < 10) continue; // サンプル少なすぎは除外
    const w = matched.filter(f => f.result === "WIN").length;
    const pnl = matched.reduce((s, f) => s + f.pnl, 0);
    console.log(`| ${fl.name} | ${matched.length}件 ${w}勝${matched.length - w}敗 | ${(w / matched.length * 100).toFixed(1)}% | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円 | ${Math.round(pnl / matched.length) >= 0 ? "+" : ""}${Math.round(pnl / matched.length).toLocaleString()}円 |`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
