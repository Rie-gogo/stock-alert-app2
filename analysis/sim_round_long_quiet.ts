import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, { long: number; short: number }> = {
  "8035": { long: 0.5, short: 0.8 },
  "6857": { long: 0.6, short: 0.6 },
  "6976": { long: 0.6, short: 0.8 },
  "6526": { long: 0.9, short: 1.0 },
  "5803": { long: 0.5, short: 0.6 },
  "6981": { long: 0.4, short: 0.9 },
  "285A": { long: 0.8, short: 0.6 },
  "6146": { long: 0.8, short: 0.8 },
  "6594": { long: 0.5, short: 0.5 },
  "8316": { long: 0.5, short: 0.5 },
};
const ACTIVE = new Set(Object.keys(SL_MAP));
const MA = 20;
interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

function calcMA(c: C[], i: number) { if (i < MA - 1) return 0; let s = 0; for (let k = i - MA + 1; k <= i; k++) s += c[k].c; return s / MA; }

function isBullish(c: C[], i: number): boolean {
  if (i < MA + 1) return false;
  const cur = calcMA(c, i), prev = calcMA(c, i - 1);
  return prev > 0 && (cur - prev) / prev * 100 > 0;
}

function quietRiseCondition(c: C[], i: number): boolean {
  if (i < MA + 10) return false;
  // isBullish
  if (!isBullish(c, i)) return false;
  // MA乖離 < 0.3%
  const ma20 = calcMA(c, i);
  if (ma20 <= 0) return false;
  const maDiv = (c[i].c - ma20) / ma20 * 100;
  if (maDiv >= 0.3) return false;
  // close > MA20
  if (c[i].c <= ma20) return false;
  // エントリー足実体 < 0.1%
  const barBody = Math.abs(c[i].c - c[i].o) / c[i].o * 100;
  if (barBody >= 0.1) return false;
  // 直近10本で陰線3本以下
  let bearBars = 0;
  for (let k = i - 9; k <= i; k++) if (c[k].c < c[k].o) bearBars++;
  if (bearBars > 3) return false;
  return true;
}

function board(c: C[], i: number): string {
  if (i < 5) return "neutral";
  let u = 0, d = 0;
  for (let k = i - 4; k <= i; k++) { if (c[k].c > c[k].o) u++; else if (c[k].c < c[k].o) d++; }
  return u >= 4 ? "buy_pressure" : d >= 4 ? "sell_pressure" : "neutral";
}

function simLong(c: C[], ei: number, sl: number) {
  const ep = c[ei].c;
  const sh = Math.floor(3000000 / ep / 100) * 100 || 100;
  const slL = ep * (1 - sl / 100), tpL = ep * (1 + TP_PCT / 100);
  for (let j = ei + 1; j < c.length; j++) {
    if (c[j].l <= slL) return { pnl: Math.round((slL - ep) * sh), r: "SL", t: c[j].t };
    if (c[j].h >= tpL) return { pnl: Math.round((tpL - ep) * sh), r: "TP", t: c[j].t };
  }
  return { pnl: Math.round((c[c.length - 1].c - ep) * sh), r: "EOD", t: c[c.length - 1].t };
}

// キリ番判定
function getRoundLevel(price: number): number {
  if (price >= 50000) return 1000;
  if (price >= 10000) return 500;
  if (price >= 5000) return 100;
  if (price >= 1000) return 50;
  return 10;
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [rows] = await conn.query(`SELECT symbol,tradeDate,candleTime,open,high,low,close,volume FROM rt_candles WHERE tradeDate>='2026-07-01' ORDER BY symbol,tradeDate,candleTime`) as any[];
  const byDS: Record<string, Record<string, C[]>> = {};
  for (const r of rows) {
    if (!ACTIVE.has(r.symbol)) continue;
    const d = r.tradeDate;
    if (!byDS[d]) byDS[d] = {};
    if (!byDS[d][r.symbol]) byDS[d][r.symbol] = [];
    byDS[d][r.symbol].push({ t: r.candleTime, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 });
  }
  await conn.end();

  // 結果格納
  type Trade = { date: string; sym: string; entry: number; time: string; pnl: number; result: string; quiet: boolean; bp: boolean; };
  const allTrades: Trade[] = [];
  const quietTrades: Trade[] = [];
  const noQuietTrades: Trade[] = [];

  for (const [date, syms] of Object.entries(byDS)) {
    for (const [sym, candles] of Object.entries(syms)) {
      if (candles.length < 35) continue;
      const sl = SL_MAP[sym].long;
      const step = getRoundLevel(candles[0].c);
      const used = new Set<number>();

      for (let i = MA + 2; i < candles.length - 10; i++) {
        if (candles[i].t < "09:05" || candles[i].t > "14:30") continue;
        // 大台超え検出: 前足close <= キリ番 && 今足close > キリ番
        const prevClose = candles[i - 1].c;
        const curClose = candles[i].c;
        const roundAbove = Math.ceil(prevClose / step) * step;
        if (!(prevClose <= roundAbove && curClose > roundAbove)) continue;
        // 重複防止
        const key = Math.floor(roundAbove);
        if (used.has(key)) continue;
        used.add(key);

        // 確認バー4本（CB=4）
        const confirmStart = i + 1;
        let confirmed = true;
        for (let cb = 0; cb < 4; cb++) {
          const idx = confirmStart + cb;
          if (idx >= candles.length) { confirmed = false; break; }
          if (candles[idx].c <= roundAbove) { confirmed = false; break; }
        }
        if (!confirmed) continue;

        const ei = confirmStart + 4; // 確認完了後の次の足
        if (ei >= candles.length - 5) continue;

        const isBp = board(candles, ei) === "buy_pressure";
        const isQuiet = quietRiseCondition(candles, ei);

        // LONGエントリーシミュレーション
        const t = simLong(candles, ei, sl);
        const trade: Trade = { date, sym, entry: candles[ei].c, time: candles[ei].t, pnl: t.pnl, result: t.r, quiet: isQuiet, bp: isBp };
        allTrades.push(trade);
        if (isQuiet) quietTrades.push(trade);
        else noQuietTrades.push(trade);
      }
    }
  }

  // 集計
  const summarize = (trades: Trade[], label: string) => {
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0).length;
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const wr = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : "0";
    console.log(`| ${label} | ${trades.length}件 ${wins}勝${losses}敗 | ${wr}% | ${total >= 0 ? "+" : ""}${total.toLocaleString()}円 |`);
  };

  console.log("=== 大台超えLONG: 静かな上昇バイパス条件シミュレーション ===");
  console.log("期間: 7/1〜8/17 | CB=4（大台超えLONG用）\n");
  console.log("| 条件 | 取引数 | 勝率 | 総損益 |");
  console.log("|---|---|---|---|");
  summarize(allTrades, "全大台超えLONG（フィルターなし）");
  summarize(quietTrades, "★静かな上昇バイパス条件を満たすもの");
  summarize(noQuietTrades, "条件を満たさないもの（ブロック対象）");
  summarize(allTrades.filter(t => t.bp), "buy_pressure時（現在は逆張りSHORT）");
  summarize(allTrades.filter(t => !t.bp && t.quiet), "★not buy_pressure + 静かな上昇");
  summarize(allTrades.filter(t => !t.bp && !t.quiet), "not buy_pressure + 条件不足（ブロック）");

  // 詳細
  console.log("\n--- 静かな上昇バイパス条件を満たす取引の詳細 ---");
  for (const t of quietTrades) {
    console.log(`  ${t.date} ${t.sym} ${t.time} @${t.entry} → ${t.result} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 ${t.bp ? "[buy_pressure]" : ""}`);
  }

  console.log("\n--- not buy_pressure + 静かな上昇の詳細 ---");
  const target = allTrades.filter(t => !t.bp && t.quiet);
  for (const t of target) {
    console.log(`  ${t.date} ${t.sym} ${t.time} @${t.entry} → ${t.result} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
