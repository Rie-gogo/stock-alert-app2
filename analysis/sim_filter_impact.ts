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
interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

function calcMA(c: C[], i: number) { if (i < MA - 1) return 0; let s = 0; for (let k = i - MA + 1; k <= i; k++) s += c[k].c; return s / MA; }
function isBullishFn(c: C[], i: number): boolean { if (i < MA + 1) return false; const cur = calcMA(c, i), prev = calcMA(c, i - 1); return prev > 0 && (cur - prev) / prev * 100 > 0; }
function board(c: C[], i: number): string { if (i < 5) return "neutral"; let u = 0, d = 0; for (let k = i - 4; k <= i; k++) { if (c[k].c > c[k].o) u++; else if (c[k].c < c[k].o) d++; } return u >= 4 ? "buy_pressure" : d >= 4 ? "sell_pressure" : "neutral"; }
function quietRiseBypass(c: C[], i: number): boolean {
  if (i < MA + 10) return false;
  if (!isBullishFn(c, i)) return false;
  const ma20 = calcMA(c, i);
  if (ma20 <= 0 || c[i].c <= ma20) return false;
  if ((c[i].c - ma20) / ma20 * 100 >= 0.3) return false;
  if (Math.abs(c[i].c - c[i].o) / c[i].o * 100 >= 0.1) return false;
  let bearBars = 0; for (let k = i - 9; k <= i; k++) if (c[k].c < c[k].o) bearBars++;
  return bearBars <= 3;
}
function sim(c: C[], ei: number, sl: number, dir: "long" | "short") {
  const ep = c[ei].c; const sh = Math.floor(3000000 / ep / 100) * 100 || 100;
  for (let j = ei + 1; j < c.length; j++) {
    if (dir === "long") { if (c[j].l <= ep * (1 - sl / 100)) return { pnl: Math.round((ep * (1 - sl / 100) - ep) * sh), r: "SL" }; if (c[j].h >= ep * (1 + TP_PCT / 100)) return { pnl: Math.round((ep * (1 + TP_PCT / 100) - ep) * sh), r: "TP" }; }
    else { if (c[j].h >= ep * (1 + sl / 100)) return { pnl: Math.round((ep - ep * (1 + sl / 100)) * sh), r: "SL" }; if (c[j].l <= ep * (1 - TP_PCT / 100)) return { pnl: Math.round((ep - ep * (1 - TP_PCT / 100)) * sh), r: "TP" }; }
  }
  const lastC = c[c.length - 1].c; const pnl = dir === "long" ? Math.round((lastC - ep) * sh) : Math.round((ep - lastC) * sh);
  return { pnl, r: "EOD" };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  // 30日間のデータで検証
  const [rows] = await conn.query(`SELECT symbol,tradeDate,candleTime,open,high,low,close,volume FROM rt_candles WHERE tradeDate>='2026-07-14' ORDER BY symbol,tradeDate,candleTime`) as any[];
  await conn.end();

  const byDS: Record<string, Record<string, C[]>> = {};
  for (const r of rows) { if (!ACTIVE.has(r.symbol)) continue; const d = r.tradeDate; if (!byDS[d]) byDS[d] = {}; if (!byDS[d][r.symbol]) byDS[d][r.symbol] = []; byDS[d][r.symbol].push({ t: r.candleTime, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 }); }

  // フィルター別の影響を集計
  type Stats = { total: number; wins: number; pnl: number; };
  const results: Record<string, Stats> = {
    "全取引（フィルターなし）": { total: 0, wins: 0, pnl: 0 },
    "同一銘柄制限適用後": { total: 0, wins: 0, pnl: 0 },
    "信頼度フィルター（出来高1.3倍以上のみ）": { total: 0, wins: 0, pnl: 0 },
    "信頼度フィルター除外分": { total: 0, wins: 0, pnl: 0 },
    "3分足HTFフィルター適用後": { total: 0, wins: 0, pnl: 0 },
    "HTFフィルター除外分": { total: 0, wins: 0, pnl: 0 },
    "日次損失上限(-10万)適用後": { total: 0, wins: 0, pnl: 0 },
    "日次損失上限で停止された分": { total: 0, wins: 0, pnl: 0 },
  };

  for (const [date, syms] of Object.entries(byDS)) {
    type Trade = { sym: string; dir: "long"|"short"; time: string; pnl: number; vol: number; htf: string; quiet: boolean; };
    const dayTrades: Trade[] = [];

    for (const [sym, candles] of Object.entries(syms)) {
      if (candles.length < 35) continue;
      const usedHigh = new Set<string>();

      for (let i = MA + 2; i < candles.length - 5; i++) {
        if (candles[i].t < "09:05" || candles[i].t > "14:30") continue;
        // ダウ理論LONG検出
        let pH = 0; for (let k = Math.max(0, i - 20); k < i; k++) pH = Math.max(pH, candles[k].h);
        if (candles[i].h > pH && candles[i - 1].h <= pH) {
          const hk = `${sym}-${Math.floor(i / 8)}`;
          if (usedHigh.has(hk)) continue; usedHigh.add(hk);
          const brd = board(candles, i);
          if (brd === "sell_pressure" || brd === "buy_pressure") continue;
          const isQuiet = quietRiseBypass(candles, i);
          if (!isQuiet) continue;
          const ei = i + 1; if (ei >= candles.length - 5) continue;
          const t = sim(candles, ei, SL_MAP[sym].long, "long");
          // 出来高比率
          const avgVol = candles.slice(Math.max(0, i - 20), i).reduce((s, c) => s + c.v, 0) / 20;
          const volRatio = avgVol > 0 ? candles[i].v / avgVol : 1;
          // 3分足HTF
          let htf = "neutral";
          if (i >= 3) {
            const h3 = Math.max(candles[i].h, candles[i-1].h, candles[i-2].h);
            const l3 = Math.min(candles[i].l, candles[i-1].l, candles[i-2].l);
            const c3 = candles[i].c; const o3 = candles[i-2].o;
            htf = c3 > o3 ? "up" : c3 < o3 ? "down" : "neutral";
          }
          dayTrades.push({ sym, dir: "long", time: candles[ei].t, pnl: t.pnl, vol: volRatio, htf, quiet: true });
        }
      }
    }

    dayTrades.sort((a, b) => a.time.localeCompare(b.time));

    // フィルターなし
    for (const t of dayTrades) { results["全取引（フィルターなし）"].total++; if (t.pnl > 0) results["全取引（フィルターなし）"].wins++; results["全取引（フィルターなし）"].pnl += t.pnl; }

    // 同一銘柄制限
    const usedSym = new Set<string>();
    const afterSymLimit: Trade[] = [];
    for (const t of dayTrades) {
      if (!usedSym.has(t.sym)) { usedSym.add(t.sym); afterSymLimit.push(t); results["同一銘柄制限適用後"].total++; if (t.pnl > 0) results["同一銘柄制限適用後"].wins++; results["同一銘柄制限適用後"].pnl += t.pnl; }
    }

    // 信頼度フィルター（出来高1.3倍以上）
    for (const t of afterSymLimit) {
      if (t.vol >= 1.3) { results["信頼度フィルター（出来高1.3倍以上のみ）"].total++; if (t.pnl > 0) results["信頼度フィルター（出来高1.3倍以上のみ）"].wins++; results["信頼度フィルター（出来高1.3倍以上のみ）"].pnl += t.pnl; }
      else { results["信頼度フィルター除外分"].total++; if (t.pnl > 0) results["信頼度フィルター除外分"].wins++; results["信頼度フィルター除外分"].pnl += t.pnl; }
    }

    // HTFフィルター
    for (const t of afterSymLimit) {
      if (t.htf !== "down") { results["3分足HTFフィルター適用後"].total++; if (t.pnl > 0) results["3分足HTFフィルター適用後"].wins++; results["3分足HTFフィルター適用後"].pnl += t.pnl; }
      else { results["HTFフィルター除外分"].total++; if (t.pnl > 0) results["HTFフィルター除外分"].wins++; results["HTFフィルター除外分"].pnl += t.pnl; }
    }

    // 日次損失上限
    let dailyPnl = 0;
    for (const t of afterSymLimit) {
      if (dailyPnl <= -100000) { results["日次損失上限で停止された分"].total++; if (t.pnl > 0) results["日次損失上限で停止された分"].wins++; results["日次損失上限で停止された分"].pnl += t.pnl; }
      else { results["日次損失上限(-10万)適用後"].total++; if (t.pnl > 0) results["日次損失上限(-10万)適用後"].wins++; results["日次損失上限(-10万)適用後"].pnl += t.pnl; dailyPnl += t.pnl; }
    }
  }

  console.log("=== フィルター別影響分析（静かな上昇バイパスLONGのみ）===");
  console.log("期間: 7/14〜8/17\n");
  console.log("| フィルター | 取引数 | 勝率 | 総損益 | 1件平均 |");
  console.log("|---|---|---|---|---|");
  for (const [label, s] of Object.entries(results)) {
    if (s.total === 0) { console.log(`| ${label} | 0件 | - | - | - |`); continue; }
    const wr = (s.wins / s.total * 100).toFixed(1);
    const avg = Math.round(s.pnl / s.total);
    console.log(`| ${label} | ${s.total}件 ${s.wins}勝${s.total - s.wins}敗 | ${wr}% | ${s.pnl >= 0 ? "+" : ""}${s.pnl.toLocaleString()}円 | ${avg >= 0 ? "+" : ""}${avg.toLocaleString()}円 |`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
