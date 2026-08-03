/**
 * CONFIRM_BARS=4 vs 5 比較シミュレーション（銘柄別SL幅適用済み）
 * 
 * 方法: rt_tradesの全大台確認トレードについて、
 * - CONFIRM_BARS=4: 実績通り（現在のエントリー価格）
 * - CONFIRM_BARS=5: エントリーが1バー遅れた場合のシミュレーション
 * 
 * 両方とも銘柄別SL幅を適用して比較する
 */
import mysql from "mysql2/promise";

const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.7,
  "6857": 0.9,
  "6976": 1.0,
  "6526": 0.9,
  "5803": 0.7,
  "6981": 0.9,
  "285A": 1.5,
  "6920": 1.0,
  "6758": 0.5,
  "8316": 0.5,
};
const TP_PCT = 1.5;
const MARKET_CLOSE = "15:25";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);

  // 全期間のrt_tradesを取得
  const [allTrades] = await conn.execute(
    `SELECT id, tradeDate, symbol, side, action, price, shares, pnl, reason, tradeTime
     FROM rt_trades ORDER BY tradeDate, id`
  ) as any[];

  // エントリーと決済をペアリング
  const pairedTrades: any[] = [];
  const openPositions: Map<string, any> = new Map();
  for (const t of allTrades) {
    const key = `${t.tradeDate}_${t.symbol}`;
    if (t.action === 'buy' || t.action === 'short') {
      openPositions.set(key, t);
    } else if (t.action === 'sell' || t.action === 'cover') {
      const entry = openPositions.get(key);
      if (entry) {
        pairedTrades.push({
          tradeDate: t.tradeDate,
          symbol: t.symbol,
          side: entry.side,
          entryPrice: Number(entry.price),
          exitPrice: Number(t.price),
          entryTime: entry.tradeTime,
          exitTime: t.tradeTime,
          pnl: Number(t.pnl),
          reason: entry.reason,
          exitReason: t.reason,
          shares: Number(entry.shares),
        });
        openPositions.delete(key);
      }
    }
  }

  // 大台確認シグナルのみ抽出
  const roundLevelTrades = pairedTrades.filter(t => t.reason.includes("大台"));
  const nonRoundTrades = pairedTrades.filter(t => !t.reason.includes("大台"));

  console.log(`=== CONFIRM_BARS=4 vs 5 比較（銘柄別SL適用） ===`);
  console.log(`全トレード: ${pairedTrades.length}件`);
  console.log(`  大台確認シグナル: ${roundLevelTrades.length}件（CONFIRM_BARSに影響）`);
  console.log(`  その他シグナル: ${nonRoundTrades.length}件（影響なし）`);
  console.log("");

  // 各大台確認トレードについてCONFIRM_BARS=5をシミュレート
  let total4 = 0;
  let total5 = 0;
  let wins4 = 0;
  let wins5 = 0;
  const dailyResults: Map<string, { pnl4: number; pnl5: number; count: number }> = new Map();
  const symbolResults: Map<string, { pnl4: number; pnl5: number; count: number }> = new Map();

  console.log("=== 個別トレード比較 ===\n");

  for (const t of roundLevelTrades) {
    const { symbol, side, entryPrice, entryTime, pnl, shares, tradeDate } = t;
    const slPct = SYMBOL_SL_MAP[symbol] || 0.5;

    // CONFIRM_BARS=4の結果（銘柄別SLで再計算）
    // 実績のSLラインと新SLラインが異なる可能性があるため、バーデータから再シミュレート
    const [candles] = await conn.execute(
      `SELECT candleTime, open, high, low, close, volume
       FROM rt_candles
       WHERE symbol = ? AND tradeDate = ? AND candleTime >= ?
       ORDER BY candleTime LIMIT 120`, [symbol, tradeDate, entryTime]
    ) as any[];

    if (candles.length < 3) continue;

    // --- CONFIRM_BARS=4 シミュレーション（現在のエントリー価格から） ---
    const result4 = simulateExit(candles.slice(1), entryPrice, side, slPct, shares);

    // --- CONFIRM_BARS=5 シミュレーション（1バー遅れ） ---
    let result5: { pnl: number; reason: string; exitTime: string };
    if (candles.length >= 2) {
      const newEntryPrice = Number(candles[1].open); // 1バー後のopen
      const result5sim = simulateExit(candles.slice(2), newEntryPrice, side, slPct, shares);
      result5 = result5sim;
    } else {
      result5 = { pnl: pnl, reason: "データ不足", exitTime: "" };
    }

    total4 += result4.pnl;
    total5 += result5.pnl;
    if (result4.pnl > 0) wins4++;
    if (result5.pnl > 0) wins5++;

    // 日別集計
    const dayKey = tradeDate;
    const dayData = dailyResults.get(dayKey) || { pnl4: 0, pnl5: 0, count: 0 };
    dayData.pnl4 += result4.pnl;
    dayData.pnl5 += result5.pnl;
    dayData.count++;
    dailyResults.set(dayKey, dayData);

    // 銘柄別集計
    const symData = symbolResults.get(symbol) || { pnl4: 0, pnl5: 0, count: 0 };
    symData.pnl4 += result4.pnl;
    symData.pnl5 += result5.pnl;
    symData.count++;
    symbolResults.set(symbol, symData);

    const diff = result5.pnl - result4.pnl;
    if (Math.abs(diff) > 5000) {
      console.log(`${tradeDate} ${entryTime} ${symbol} ${side} @${entryPrice} (${shares}株) SL:${slPct}%`);
      console.log(`  BARS=4: ${result4.pnl > 0 ? "+" : ""}${result4.pnl}円 (${result4.reason})`);
      console.log(`  BARS=5: ${result5.pnl > 0 ? "+" : ""}${result5.pnl}円 (${result5.reason})`);
      console.log(`  差分: ${diff > 0 ? "+" : ""}${diff}円 ${diff > 0 ? "★5が有利" : "★4が有利"}`);
      console.log("");
    }
  }

  // その他シグナルの損益（変わらない）
  const nonRoundPnl = nonRoundTrades.reduce((sum, t) => sum + t.pnl, 0);

  console.log("\n=== 総合結果 ===\n");
  console.log("| 設定 | 大台確認損益 | その他損益 | 合計 | 大台勝率 |");
  console.log("|------|------------|-----------|------|---------|");
  console.log(`| CONFIRM_BARS=4 | ${total4 > 0 ? "+" : ""}${total4}円 | ${nonRoundPnl > 0 ? "+" : ""}${nonRoundPnl}円 | ${(total4 + nonRoundPnl) > 0 ? "+" : ""}${total4 + nonRoundPnl}円 | ${roundLevelTrades.length > 0 ? (wins4 / roundLevelTrades.length * 100).toFixed(1) : 0}% |`);
  console.log(`| CONFIRM_BARS=5 | ${total5 > 0 ? "+" : ""}${total5}円 | ${nonRoundPnl > 0 ? "+" : ""}${nonRoundPnl}円 | ${(total5 + nonRoundPnl) > 0 ? "+" : ""}${total5 + nonRoundPnl}円 | ${roundLevelTrades.length > 0 ? (wins5 / roundLevelTrades.length * 100).toFixed(1) : 0}% |`);
  console.log(`| 差分(5-4) | ${(total5 - total4) > 0 ? "+" : ""}${total5 - total4}円 | 0円 | ${(total5 - total4) > 0 ? "+" : ""}${total5 - total4}円 | ${((wins5 - wins4) / roundLevelTrades.length * 100).toFixed(1)}pt |`);

  // 銘柄別
  console.log("\n=== 銘柄別比較 ===\n");
  console.log("| 銘柄 | 件数 | BARS=4損益 | BARS=5損益 | 差分 | 有利 |");
  console.log("|------|------|-----------|-----------|------|------|");
  for (const [sym, data] of [...symbolResults.entries()].sort((a, b) => (b[1].pnl5 - b[1].pnl4) - (a[1].pnl5 - a[1].pnl4))) {
    const diff = data.pnl5 - data.pnl4;
    console.log(`| ${sym} | ${data.count}件 | ${data.pnl4 > 0 ? "+" : ""}${data.pnl4}円 | ${data.pnl5 > 0 ? "+" : ""}${data.pnl5}円 | ${diff > 0 ? "+" : ""}${diff}円 | ${diff > 0 ? "5" : diff < 0 ? "4" : "同"} |`);
  }

  // 日別
  console.log("\n=== 日別比較 ===\n");
  console.log("| 日付 | 件数 | BARS=4損益 | BARS=5損益 | 差分 |");
  console.log("|------|------|-----------|-----------|------|");
  for (const [date, data] of [...dailyResults.entries()].sort()) {
    const diff = data.pnl5 - data.pnl4;
    console.log(`| ${date} | ${data.count}件 | ${data.pnl4 > 0 ? "+" : ""}${data.pnl4}円 | ${data.pnl5 > 0 ? "+" : ""}${data.pnl5}円 | ${diff > 0 ? "+" : ""}${diff}円 |`);
  }

  await conn.end();
  process.exit(0);
}

function simulateExit(
  candles: any[],
  entryPrice: number,
  side: string,
  slPct: number,
  shares: number
): { pnl: number; reason: string; exitTime: string } {
  const slLine = side === "long"
    ? entryPrice * (1 - slPct / 100)
    : entryPrice * (1 + slPct / 100);
  const tpLine = side === "long"
    ? entryPrice * (1 + TP_PCT / 100)
    : entryPrice * (1 - TP_PCT / 100);

  for (const c of candles) {
    const high = Number(c.high);
    const low = Number(c.low);
    const time = c.candleTime as string;

    // 15:25以降はEOD決済
    if (time >= MARKET_CLOSE) {
      const closePrice = Number(c.close);
      const pnl = side === "long"
        ? Math.round((closePrice - entryPrice) * shares)
        : Math.round((entryPrice - closePrice) * shares);
      return { pnl, reason: "EOD決済", exitTime: time };
    }

    if (side === "long") {
      if (low <= slLine) {
        const pnl = Math.round((slLine - entryPrice) * shares);
        return { pnl, reason: `損切り(SL:${slLine.toFixed(0)})`, exitTime: time };
      }
      if (high >= tpLine) {
        const pnl = Math.round((tpLine - entryPrice) * shares);
        return { pnl, reason: `利確(TP:${tpLine.toFixed(0)})`, exitTime: time };
      }
    } else {
      if (high >= slLine) {
        const pnl = Math.round((entryPrice - slLine) * shares);
        return { pnl, reason: `損切り(SL:${slLine.toFixed(0)})`, exitTime: time };
      }
      if (low <= tpLine) {
        const pnl = Math.round((entryPrice - tpLine) * shares);
        return { pnl, reason: `利確(TP:${tpLine.toFixed(0)})`, exitTime: time };
      }
    }
  }

  // バーが尽きた場合は最後のcloseで決済
  if (candles.length > 0) {
    const lastClose = Number(candles[candles.length - 1].close);
    const pnl = side === "long"
      ? Math.round((lastClose - entryPrice) * shares)
      : Math.round((entryPrice - lastClose) * shares);
    return { pnl, reason: "EOD決済(データ末尾)", exitTime: candles[candles.length - 1].candleTime };
  }

  return { pnl: 0, reason: "データなし", exitTime: "" };
}

main().catch(e => { console.error(e); process.exit(1); });
