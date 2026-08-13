/**
 * スコア0ブロック全件を仮想エントリーし、
 * ①信頼度強のみ解除した場合 ②シグナル別の結果を集計する。
 * rt_score0_blocks + rt_candles（KABU受信足）のみ使用。
 */
import mysql from "mysql2/promise";

const SYMBOL_SL: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};
const TP_PCT = 1.5;

interface Block {
  trade_date: string; symbol: string; candle_time: string;
  side: string; signal_reason: string; entry_price: string;
  board_score: number; confidence: string;
}
interface SimResult {
  block: Block; result: "TP" | "SL" | "EOD"; pnl: number;
  exitTime: string; shares: number; signalType: string;
}

function classifySignal(reason: string): string {
  if (reason.includes("ダウ理論")) return "ダウ理論";
  if (reason.includes("大台超え") || reason.includes("大台割れ")) return "大台確認";
  if (reason.includes("デッドクロス") || reason.includes("ゴールデンクロス")) return "GC/DC";
  if (reason.includes("VWAP")) return "VWAPクロス";
  if (reason.includes("逆三尊") || reason.includes("ヘッドアンドショルダー")) return "逆三尊/H&S";
  return "その他";
}

function calcShares(entryPrice: number): number {
  const lot = 3_000_000;
  const unit = 100;
  return Math.max(unit, Math.floor(lot / entryPrice / unit) * unit);
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  const [blocks] = await conn.query<Block[]>(
    "SELECT trade_date, symbol, candle_time, side, signal_reason, entry_price, board_score, confidence FROM rt_score0_blocks ORDER BY trade_date, candle_time"
  );
  const results: SimResult[] = [];
  const candleCache = new Map<string, Array<{ candleTime: string; high: string; low: string; close: string }>>();

  for (const b of blocks) {
    const key = `${b.trade_date}_${b.symbol}`;
    if (!candleCache.has(key)) {
      const [candles] = await conn.query<any[]>(
        "SELECT candleTime, high, low, close FROM rt_candles WHERE tradeDate=? AND symbol=? ORDER BY candleTime",
        [b.trade_date, b.symbol]
      );
      candleCache.set(key, candles);
    }
    const candles = candleCache.get(key)!;
    const entryPrice = Number(b.entry_price);
    const sl = SYMBOL_SL[b.symbol] ?? 0.5;
    const shares = calcShares(entryPrice);
    const isLong = b.side === "BUY";
    const slPrice = isLong ? entryPrice * (1 - sl / 100) : entryPrice * (1 + sl / 100);
    const tpPrice = isLong ? entryPrice * (1 + TP_PCT / 100) : entryPrice * (1 - TP_PCT / 100);
    const startIdx = candles.findIndex(c => c.candleTime > b.candle_time);
    const after = startIdx >= 0 ? candles.slice(startIdx) : [];
    let result: "TP" | "SL" | "EOD" = "EOD";
    let exitTime = candles.length ? candles[candles.length - 1].candleTime : b.candle_time;
    let pnl = 0;
    for (const c of after) {
      const high = Number(c.high), low = Number(c.low);
      if ((isLong && low <= slPrice) || (!isLong && high >= slPrice)) {
        result = "SL"; exitTime = c.candleTime;
        pnl = -entryPrice * sl / 100 * shares;
        break;
      }
      if ((isLong && high >= tpPrice) || (!isLong && low <= tpPrice)) {
        result = "TP"; exitTime = c.candleTime;
        pnl = entryPrice * TP_PCT / 100 * shares;
        break;
      }
    }
    if (result === "EOD") {
      const eodClose = candles.length ? Number(candles[candles.length - 1].close) : entryPrice;
      pnl = (isLong ? eodClose - entryPrice : entryPrice - eodClose) * shares;
    }
    results.push({ block: b, result, pnl, exitTime, shares, signalType: classifySignal(b.signal_reason) });
  }
  await conn.end();

  // ① 全件（現行: 全てブロック）
  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  const wins = results.filter(r => r.pnl > 0);
  const losses = results.filter(r => r.pnl <= 0);
  console.log("=== ① 信頼度強のスコア0ブロックを全解除した場合 ===");
  console.log(`期間: ${blocks[0]?.trade_date} 〜 ${blocks[blocks.length - 1]?.trade_date} (${new Set(blocks.map(b => b.trade_date)).size}営業日)`);
  console.log(`対象: ${results.length}件（全てスコア0+信頼度強でブロックされた取引）`);
  console.log(`仮想損益合計: ${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}円`);
  console.log(`勝率: ${results.length ? (wins.length / results.length * 100).toFixed(1) : 0}% (${wins.length}勝${losses.length}敗)`);
  console.log(`TP: ${results.filter(r => r.result === "TP").length}件, SL: ${results.filter(r => r.result === "SL").length}件, EOD: ${results.filter(r => r.result === "EOD").length}件`);
  const grossWin = wins.reduce((s, r) => s + r.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));
  console.log(`PF: ${grossLoss ? (grossWin / grossLoss).toFixed(2) : 'N/A'}`);
  console.log(`平均勝ち: +${wins.length ? Math.round(grossWin / wins.length).toLocaleString() : 0}円, 平均負け: -${losses.length ? Math.round(grossLoss / losses.length).toLocaleString() : 0}円`);

  // ② シグナル別
  console.log("\n=== ② シグナル別成績 ===");
  const signalTypes = [...new Set(results.map(r => r.signalType))];
  console.log("シグナル | 件数 | 勝率 | 損益 | TP | SL | EOD | PF");
  console.log("-".repeat(90));
  for (const sig of signalTypes) {
    const sr = results.filter(r => r.signalType === sig);
    const sw = sr.filter(r => r.pnl > 0);
    const sl2 = sr.filter(r => r.pnl <= 0);
    const spnl = sr.reduce((s, r) => s + r.pnl, 0);
    const sgw = sw.reduce((s, r) => s + r.pnl, 0);
    const sgl = Math.abs(sl2.reduce((s, r) => s + r.pnl, 0));
    console.log(
      `${sig.padEnd(10)} | ${String(sr.length).padStart(3)} | ${(sw.length / sr.length * 100).toFixed(0).padStart(4)}% | ${(spnl >= 0 ? '+' : '') + Math.round(spnl).toLocaleString().padStart(10)} | ${sr.filter(r => r.result === "TP").length.toString().padStart(2)} | ${sr.filter(r => r.result === "SL").length.toString().padStart(2)} | ${sr.filter(r => r.result === "EOD").length.toString().padStart(2)} | ${sgl ? (sgw / sgl).toFixed(2) : 'N/A'}`
    );
  }

  // ③ 方向別
  console.log("\n=== ③ 方向別成績 ===");
  for (const side of ["BUY", "SHORT"]) {
    const sr = results.filter(r => r.block.side === side);
    const sw = sr.filter(r => r.pnl > 0);
    const spnl = sr.reduce((s, r) => s + r.pnl, 0);
    console.log(`${side}: ${sr.length}件, 勝率${sr.length ? (sw.length / sr.length * 100).toFixed(0) : 0}%, 損益${spnl >= 0 ? '+' : ''}${Math.round(spnl).toLocaleString()}円`);
  }

  // ④ 日別
  console.log("\n=== ④ 日別損益 ===");
  const dates = [...new Set(results.map(r => r.block.trade_date))].sort();
  for (const d of dates) {
    const dr = results.filter(r => r.block.trade_date === d);
    const dpnl = dr.reduce((s, r) => s + r.pnl, 0);
    const dw = dr.filter(r => r.pnl > 0).length;
    console.log(`${d}: ${dr.length}件, ${dw}勝${dr.length - dw}敗, ${dpnl >= 0 ? '+' : ''}${Math.round(dpnl).toLocaleString()}円`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
