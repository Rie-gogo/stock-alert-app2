/**
 * 太陽誘電(6976) SL幅スイープ: 0.5%〜1.0%（0.1%刻み）
 * rt_tradesの実エントリーを固定し、rt_candlesで各SL幅の結果を比較する。
 * 30日間（rt_candlesに存在する全期間）
 */
import mysql from "mysql2/promise";

const SYMBOL = "6976";
const TP_PCT = 1.5;
const SL_VALUES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

interface Entry { tradeDate: string; tradeTime: string; side: string; price: string; shares: string; }
interface Candle { candleTime: string; high: string; low: string; close: string; }
interface SimResult { sl: number; result: "TP" | "SL" | "EOD"; pnl: number; exitTime: string; }

function simulate(entry: Entry, candles: Candle[], sl: number): SimResult {
  const ep = Number(entry.price);
  const shares = Number(entry.shares);
  const isLong = entry.side === "long";
  const slPrice = isLong ? ep * (1 - sl / 100) : ep * (1 + sl / 100);
  const tpPrice = isLong ? ep * (1 + TP_PCT / 100) : ep * (1 - TP_PCT / 100);
  const startIdx = candles.findIndex(c => c.candleTime > entry.tradeTime);
  const after = startIdx >= 0 ? candles.slice(startIdx) : [];

  for (const c of after) {
    const h = Number(c.high), l = Number(c.low);
    // SL先判定（本番エンジンと同じ）
    if ((isLong && l <= slPrice) || (!isLong && h >= slPrice)) {
      return { sl, result: "SL", exitTime: c.candleTime, pnl: -ep * sl / 100 * shares };
    }
    if ((isLong && h >= tpPrice) || (!isLong && l <= tpPrice)) {
      return { sl, result: "TP", exitTime: c.candleTime, pnl: ep * TP_PCT / 100 * shares };
    }
  }
  const eodClose = candles.length ? Number(candles[candles.length - 1].close) : ep;
  const eodPnl = (isLong ? eodClose - ep : ep - eodClose) * shares;
  return { sl, result: "EOD", exitTime: candles.length ? candles[candles.length - 1].candleTime : "", pnl: eodPnl };
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);

  // 全エントリーを取得
  const [trades] = await conn.query(
    "SELECT tradeDate, tradeTime, side, price, shares FROM rt_trades WHERE symbol=? AND action IN ('buy','short') ORDER BY tradeDate, tradeTime",
    [SYMBOL]
  ) as any[];

  console.log(`太陽誘電(6976) SL幅スイープ: ${trades.length}件のエントリー\n`);

  // 日別キャンドルキャッシュ
  const cache = new Map<string, Candle[]>();
  const allResults = new Map<number, SimResult[]>();
  for (const sl of SL_VALUES) allResults.set(sl, []);

  for (const entry of trades) {
    if (!cache.has(entry.tradeDate)) {
      const [candles] = await conn.query(
        "SELECT candleTime, high, low, close FROM rt_candles WHERE tradeDate=? AND symbol=? ORDER BY candleTime",
        [entry.tradeDate, SYMBOL]
      ) as any[];
      cache.set(entry.tradeDate, candles);
    }
    const candles = cache.get(entry.tradeDate) as Candle[];
    for (const sl of SL_VALUES) {
      allResults.get(sl)!.push(simulate(entry, candles, sl));
    }
  }
  await conn.end();

  // === 総合比較 ===
  console.log("=== SL幅別 総合比較 ===");
  console.log("SL%  | 件数 | 勝率  | 総損益       | TP  | SL  | EOD | PF   | 平均勝ち    | 平均負け");
  console.log("-".repeat(100));
  for (const sl of SL_VALUES) {
    const r = allResults.get(sl)!;
    const wins = r.filter(x => x.pnl > 0);
    const losses = r.filter(x => x.pnl <= 0);
    const total = r.reduce((s, x) => s + x.pnl, 0);
    const gw = wins.reduce((s, x) => s + x.pnl, 0);
    const gl = Math.abs(losses.reduce((s, x) => s + x.pnl, 0));
    const pf = gl ? (gw / gl).toFixed(2) : (gw > 0 ? "Inf" : "0.00");
    const avgW = wins.length ? Math.round(gw / wins.length) : 0;
    const avgL = losses.length ? Math.round(gl / losses.length) : 0;
    console.log(
      `${sl.toFixed(1)}% | ${String(r.length).padStart(3)} | ${(wins.length / r.length * 100).toFixed(1).padStart(5)}% | ${(total >= 0 ? "+" : "") + Math.round(total).toLocaleString().padStart(11)} | ${r.filter(x => x.result === "TP").length.toString().padStart(3)} | ${r.filter(x => x.result === "SL").length.toString().padStart(3)} | ${r.filter(x => x.result === "EOD").length.toString().padStart(3)} | ${pf.padStart(4)} | +${avgW.toLocaleString().padStart(8)} | -${avgL.toLocaleString().padStart(8)}`
    );
  }

  // === 取引ごとの結果変化 ===
  console.log("\n=== 取引ごとの詳細（SL幅で結果が変わるもの） ===");
  console.log("日付       | 時刻  | 方向  | 価格     | 株数 | 0.5%結果 | 0.6%結果 | 0.7%結果 | 0.8%結果 | 0.9%結果 | 1.0%結果");
  console.log("-".repeat(130));
  for (let i = 0; i < trades.length; i++) {
    const entry = trades[i];
    const r05 = allResults.get(0.5)![i];
    const r10 = allResults.get(1.0)![i];
    // 結果が変わるもののみ表示
    if (r05.result === r10.result && Math.abs(r05.pnl - r10.pnl) < 100) continue;
    const cols = SL_VALUES.map(sl => {
      const r = allResults.get(sl)![i];
      const sign = r.pnl >= 0 ? "+" : "";
      return `${r.result}${sign}${Math.round(r.pnl / 1000)}k`.padStart(8);
    });
    console.log(
      `${entry.tradeDate} | ${entry.tradeTime} | ${entry.side.padEnd(5)} | ${Number(entry.price).toFixed(0).padStart(8)} | ${String(entry.shares).padStart(4)} | ${cols.join(" | ")}`
    );
  }

  // === 方向別 ===
  console.log("\n=== 方向別比較 ===");
  for (const side of ["long", "short"]) {
    console.log(`\n--- ${side.toUpperCase()} ---`);
    console.log("SL%  | 件数 | 勝率  | 総損益       | PF");
    console.log("-".repeat(55));
    const indices = trades.map((t: any, i: number) => t.side === side ? i : -1).filter((i: number) => i >= 0);
    for (const sl of SL_VALUES) {
      const r = indices.map((i: number) => allResults.get(sl)![i]);
      const wins = r.filter(x => x.pnl > 0);
      const losses = r.filter(x => x.pnl <= 0);
      const total = r.reduce((s, x) => s + x.pnl, 0);
      const gw = wins.reduce((s, x) => s + x.pnl, 0);
      const gl = Math.abs(losses.reduce((s, x) => s + x.pnl, 0));
      const pf = gl ? (gw / gl).toFixed(2) : (gw > 0 ? "Inf" : "0.00");
      console.log(
        `${sl.toFixed(1)}% | ${String(r.length).padStart(3)} | ${(wins.length / r.length * 100).toFixed(1).padStart(5)}% | ${(total >= 0 ? "+" : "") + Math.round(total).toLocaleString().padStart(11)} | ${pf.padStart(4)}`
      );
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
