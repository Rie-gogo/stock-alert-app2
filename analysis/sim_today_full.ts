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
const ACTIVE = new Set(Object.keys(SL_MAP));
const MA = 20;
const TARGET_DATE = "2026-08-17";
interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

function calcMA(c: C[], i: number) { if (i < MA - 1) return 0; let s = 0; for (let k = i - MA + 1; k <= i; k++) s += c[k].c; return s / MA; }
function isBullishFn(c: C[], i: number): boolean { if (i < MA + 1) return false; const cur = calcMA(c, i), prev = calcMA(c, i - 1); return prev > 0 && (cur - prev) / prev * 100 > 0; }
function board(c: C[], i: number): string { if (i < 5) return "neutral"; let u = 0, d = 0; for (let k = i - 4; k <= i; k++) { if (c[k].c > c[k].o) u++; else if (c[k].c < c[k].o) d++; } return u >= 4 ? "buy_pressure" : d >= 4 ? "sell_pressure" : "neutral"; }

function quietRiseBypass(c: C[], i: number): boolean {
  if (i < MA + 10) return false;
  if (!isBullishFn(c, i)) return false;
  const ma20 = calcMA(c, i);
  if (ma20 <= 0 || c[i].c <= ma20) return false;
  const maDiv = (c[i].c - ma20) / ma20 * 100;
  if (maDiv >= 0.3) return false;
  const barBody = Math.abs(c[i].c - c[i].o) / c[i].o * 100;
  if (barBody >= 0.1) return false;
  let bearBars = 0;
  for (let k = i - 9; k <= i; k++) if (c[k].c < c[k].o) bearBars++;
  return bearBars <= 3;
}

function getRoundLevel(price: number): number {
  if (price >= 50000) return 1000; if (price >= 10000) return 500;
  if (price >= 5000) return 100; if (price >= 1000) return 50; return 10;
}

function sim(c: C[], ei: number, sl: number, dir: "long" | "short") {
  const ep = c[ei].c;
  const sh = Math.floor(3000000 / ep / 100) * 100 || 100;
  for (let j = ei + 1; j < c.length; j++) {
    if (dir === "long") {
      if (c[j].l <= ep * (1 - sl / 100)) return { pnl: Math.round((ep * (1 - sl / 100) - ep) * sh), r: "SL", t: c[j].t, sh };
      if (c[j].h >= ep * (1 + TP_PCT / 100)) return { pnl: Math.round((ep * (1 + TP_PCT / 100) - ep) * sh), r: "TP", t: c[j].t, sh };
    } else {
      if (c[j].h >= ep * (1 + sl / 100)) return { pnl: Math.round((ep - ep * (1 + sl / 100)) * sh), r: "SL", t: c[j].t, sh };
      if (c[j].l <= ep * (1 - TP_PCT / 100)) return { pnl: Math.round((ep - ep * (1 - TP_PCT / 100)) * sh), r: "TP", t: c[j].t, sh };
    }
  }
  const lastC = c[c.length - 1].c;
  const pnl = dir === "long" ? Math.round((lastC - ep) * sh) : Math.round((ep - lastC) * sh);
  return { pnl, r: "EOD", t: c[c.length - 1].t, sh };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [rows] = await conn.query(`SELECT symbol,candleTime,open,high,low,close,volume FROM rt_candles WHERE tradeDate=? ORDER BY symbol,candleTime`, [TARGET_DATE]) as any[];
  await conn.end();

  const bySymbol: Record<string, C[]> = {};
  for (const r of rows) { if (!ACTIVE.has(r.symbol)) continue; if (!bySymbol[r.symbol]) bySymbol[r.symbol] = []; bySymbol[r.symbol].push({ t: r.candleTime, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 }); }

  type Trade = { sym: string; dir: string; time: string; entry: number; pnl: number; result: string; signal: string; bypass: string; };
  const trades: Trade[] = [];

  for (const [sym, candles] of Object.entries(bySymbol)) {
    if (candles.length < 35) continue;
    const step = getRoundLevel(candles[0].c);
    const usedRound = new Set<number>();
    const usedHigh = new Set<string>();

    for (let i = MA + 2; i < candles.length - 5; i++) {
      if (candles[i].t < "09:05" || candles[i].t > "14:30") continue;
      const isBull = isBullishFn(candles, i);
      const brd = board(candles, i);

      // --- 大台割れSHORT (CB=2) ---
      const prevC = candles[i - 1].c, curC = candles[i].c;
      const roundBelow = Math.floor(prevC / step) * step;
      if (prevC >= roundBelow && curC < roundBelow && !usedRound.has(-roundBelow)) {
        // 確認2本
        let ok = true;
        for (let cb = 1; cb <= 2; cb++) { const idx = i + cb; if (idx >= candles.length || candles[idx].c >= roundBelow) { ok = false; break; } }
        if (ok) {
          const ei = i + 3;
          if (ei < candles.length - 5) {
            // isBullish check (SHORT禁止)
            if (!isBullishFn(candles, ei)) {
              if (brd !== "buy_pressure") {
                usedRound.add(-roundBelow);
                const t = sim(candles, ei, SL_MAP[sym].short, "short");
                trades.push({ sym, dir: "SHORT", time: candles[ei].t, entry: candles[ei].c, pnl: t.pnl, result: t.r, signal: `大台割れ(${roundBelow}円)`, bypass: "" });
              }
            }
          }
        }
      }

      // --- ダウ理論LONG (直近高値更新) ---
      let pH = 0; for (let k = Math.max(0, i - 20); k < i; k++) pH = Math.max(pH, candles[k].h);
      if (candles[i].h > pH && candles[i - 1].h <= pH) {
        const hk = `${sym}-${Math.floor(i / 8)}`;
        if (!usedHigh.has(hk)) {
          usedHigh.add(hk);
          // sell_pressure禁止
          if (brd === "sell_pressure") continue;
          // buy_pressure → ブロック対象（板読みスコアが高いが過熱）
          // 板読みスコア判定: neutralならスコア0 → 静かな上昇バイパスチェック
          const isQuiet = quietRiseBypass(candles, i);
          const scoreHigh = brd === "buy_pressure"; // buy_pressureならスコア高い
          if (!scoreHigh && !isQuiet) continue; // スコア0 + バイパス条件不満たし → ブロック
          if (scoreHigh && brd === "buy_pressure") continue; // buy_pressure時LONGは全敗なのでブロック
          // isBullish条件（LONGには現在適用されていないが、バイパス条件にisBullishが含まれる）
          if (isQuiet) {
            const t = sim(candles, i + 1, SL_MAP[sym].long, "long");
            trades.push({ sym, dir: "LONG", time: candles[i + 1].t, entry: candles[i + 1].c, pnl: t.pnl, result: t.r, signal: "ダウ理論LONG", bypass: "静かな上昇バイパス" });
          }
        }
      }
    }
  }

  // 結果表示
  trades.sort((a, b) => a.time.localeCompare(b.time));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;

  console.log(`=== 本日(${TARGET_DATE}) 現行ロジック全体シミュレーション ===`);
  console.log(`取引数: ${trades.length}件 | ${wins}勝${losses}敗 | 勝率: ${trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0}%`);
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円\n`);

  console.log("| 時刻 | 銘柄 | 方向 | シグナル | エントリー | 結果 | 損益 | 備考 |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const t of trades) {
    console.log(`| ${t.time} | ${t.sym} | ${t.dir} | ${t.signal} | @${t.entry.toLocaleString()}円 | ${t.result} | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 | ${t.bypass} |`);
  }

  // 方向別
  const longs = trades.filter(t => t.dir === "LONG");
  const shorts = trades.filter(t => t.dir === "SHORT");
  console.log(`\nLONG: ${longs.length}件 ${longs.filter(t=>t.pnl>0).length}勝${longs.filter(t=>t.pnl<=0).length}敗 ${longs.reduce((s,t)=>s+t.pnl,0)>=0?"+":""}${longs.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`SHORT: ${shorts.length}件 ${shorts.filter(t=>t.pnl>0).length}勝${shorts.filter(t=>t.pnl<=0).length}敗 ${shorts.reduce((s,t)=>s+t.pnl,0)>=0?"+":""}${shorts.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);

  // 本番実績との比較
  console.log(`\n--- 本番実績: 1件 0勝1敗 -51,592円（6146 SHORT @64,490 → SL） ---`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
