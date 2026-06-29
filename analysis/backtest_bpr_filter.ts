/**
 * BPRフィルター改善案シミュレーション
 * 条件:
 *   ① 後場限定（13:00以降のエントリー）
 *   ② SHORT限定
 *   ③ BPR >= 0.60 でブロック
 * 
 * rt_tradesのshortエントリーと、同時刻のrt_candlesのboardSnapshotからBPRを取得
 */
import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

interface ShortTrade {
  id: number;
  symbol: string;
  symbolName: string;
  tradeDate: string;
  entryTime: string;
  entryPrice: number;
  shares: number;
  reason: string;
  boardSignal: string | null;
  // 決済情報（coverレコードから）
  exitTime?: string;
  exitPrice?: number;
  pnl?: number;
  exitReason?: string;
  // BPR（rt_candlesから）
  bpr?: number;
}

async function main() {
  const db = await getDb();

  // 全SHORTエントリーを取得
  const [shortEntries] = await db.execute(sql`
    SELECT id, symbol, symbolName, tradeDate, tradeTime, price, shares, reason, boardSignal
    FROM rt_trades
    WHERE action = 'short'
    ORDER BY tradeDate, tradeTime
  `);

  // 全COVER（決済）を取得
  const [coverEntries] = await db.execute(sql`
    SELECT id, symbol, tradeDate, tradeTime, price, pnl, reason
    FROM rt_trades
    WHERE action = 'cover'
    ORDER BY tradeDate, tradeTime
  `);

  // SHORTとCOVERをペアリング（同日・同銘柄で、SHORTの後の最初のCOVER）
  const trades: ShortTrade[] = [];
  const usedCovers = new Set<number>();

  for (const entry of shortEntries as any[]) {
    const trade: ShortTrade = {
      id: entry.id,
      symbol: entry.symbol,
      symbolName: entry.symbolName,
      tradeDate: entry.tradeDate,
      entryTime: entry.tradeTime,
      entryPrice: Number(entry.price),
      shares: entry.shares,
      reason: entry.reason,
      boardSignal: entry.boardSignal,
    };

    // 対応するcoverを探す
    for (const cover of coverEntries as any[]) {
      if (usedCovers.has(cover.id)) continue;
      if (cover.symbol === entry.symbol && cover.tradeDate === entry.tradeDate && cover.tradeTime >= entry.tradeTime) {
        trade.exitTime = cover.tradeTime;
        trade.exitPrice = Number(cover.price);
        trade.pnl = cover.pnl != null ? Number(cover.pnl) : null;
        trade.exitReason = cover.reason;
        usedCovers.add(cover.id);
        break;
      }
    }

    // BPRを取得（エントリー時刻のrt_candlesから）
    const [candles] = await db.execute(sql`
      SELECT boardSnapshot FROM rt_candles
      WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate} AND candleTime = ${entry.tradeTime}
      LIMIT 1
    `);
    if (candles.length > 0 && (candles[0] as any).boardSnapshot) {
      const snap = (candles[0] as any).boardSnapshot;
      const bsObj = typeof snap === 'string' ? JSON.parse(snap) : snap;
      trade.bpr = bsObj.buyPressureRatio;
    }

    trades.push(trade);
  }

  console.log(`=== BPRフィルター改善案シミュレーション ===`);
  console.log(`条件: ① 後場(13:00以降) ② SHORT限定 ③ BPR>=0.60でブロック`);
  console.log(`全SHORT取引数: ${trades.length}`);
  console.log(`期間: ${trades[0]?.tradeDate} 〜 ${trades[trades.length-1]?.tradeDate}`);
  console.log("");

  // 後場SHORTを抽出
  const pmShorts = trades.filter(t => {
    const hour = parseInt(t.entryTime.split(":")[0]);
    return hour >= 13;
  });
  console.log(`後場SHORT取引数: ${pmShorts.length}`);

  // BPRデータがある取引
  const withBpr = pmShorts.filter(t => t.bpr !== undefined);
  const noBpr = pmShorts.filter(t => t.bpr === undefined);
  console.log(`  BPRデータあり: ${withBpr.length}件`);
  console.log(`  BPRデータなし: ${noBpr.length}件`);
  console.log("");

  // BPR>=0.60の取引を特定
  const blocked = withBpr.filter(t => t.bpr! >= 0.60);
  const passed = withBpr.filter(t => t.bpr! < 0.60);

  console.log(`=== ブロック対象（BPR>=0.60）: ${blocked.length}件 ===`);
  let totalBlockedPnl = 0;
  let blockedWins = 0;
  let blockedLosses = 0;

  blocked.forEach((t, i) => {
    const pnl = t.pnl ?? 0;
    const result = pnl >= 0 ? "✓勝" : "✗負";
    if (pnl >= 0) blockedWins++;
    else blockedLosses++;
    totalBlockedPnl += pnl;
    console.log(`  ${i+1}. ${t.tradeDate} ${t.entryTime} ${t.symbol}(${t.symbolName}) BPR=${t.bpr?.toFixed(3)} PnL=${pnl.toLocaleString()}円 ${result}`);
    console.log(`     理由: ${t.reason?.substring(0, 60)}`);
    console.log(`     決済: ${t.exitTime} ${t.exitReason?.substring(0, 40) ?? "未決済"}`);
  });

  console.log("");
  console.log(`--- ブロック対象サマリー ---`);
  console.log(`  勝ち: ${blockedWins}件 / 負け: ${blockedLosses}件`);
  console.log(`  ブロック対象の合計PnL: ${totalBlockedPnl.toLocaleString()}円`);
  console.log(`  → ブロックによる改善額: ${(-totalBlockedPnl).toLocaleString()}円`);
  console.log("");

  // 通過する取引のサマリー
  const passedPnl = passed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const passedWins = passed.filter(t => (t.pnl ?? 0) >= 0).length;
  console.log(`--- 通過する取引（BPR<0.60）: ${passed.length}件 ---`);
  passed.forEach((t, i) => {
    const pnl = t.pnl ?? 0;
    const result = pnl >= 0 ? "✓勝" : "✗負";
    console.log(`  ${i+1}. ${t.tradeDate} ${t.entryTime} ${t.symbol}(${t.symbolName}) BPR=${t.bpr?.toFixed(3)} PnL=${pnl.toLocaleString()}円 ${result}`);
  });
  console.log(`  合計PnL: ${passedPnl.toLocaleString()}円 (勝ち${passedWins}件)`);
  console.log("");

  // 全体への影響
  const allPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const allWins = trades.filter(t => (t.pnl ?? 0) >= 0).length;
  const newPnl = allPnl - totalBlockedPnl;
  const newTotal = trades.length - blocked.length;
  const newWins = allWins - blockedWins;

  console.log(`=== 全体への影響（全SHORT取引ベース）===`);
  console.log(`  ベースライン: ${trades.length}取引 / PnL ${allPnl.toLocaleString()}円 / 勝率${(allWins/trades.length*100).toFixed(1)}%`);
  console.log(`  フィルター後: ${newTotal}取引 / PnL ${newPnl.toLocaleString()}円 / 勝率${(newWins/newTotal*100).toFixed(1)}%`);
  console.log(`  改善額: ${(newPnl - allPnl).toLocaleString()}円`);
  console.log("");

  // BPR閾値の感度分析（後場SHORT限定）
  console.log(`=== BPR閾値の感度分析（後場SHORT限定）===`);
  const thresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75];
  for (const th of thresholds) {
    const bl = withBpr.filter(t => t.bpr! >= th);
    const blPnl = bl.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const blWins = bl.filter(t => (t.pnl ?? 0) >= 0).length;
    const blLosses = bl.filter(t => (t.pnl ?? 0) < 0).length;
    console.log(`  BPR>=${th.toFixed(2)}: ${bl.length}件ブロック (勝${blWins}/負${blLosses}) → 改善${(-blPnl).toLocaleString()}円`);
  }
  console.log("");

  // 日別の影響
  console.log(`=== 日別の影響 ===`);
  const dates = [...new Set(trades.map(t => t.tradeDate))].sort();
  for (const date of dates) {
    const dayBlocked = blocked.filter(t => t.tradeDate === date);
    if (dayBlocked.length === 0) continue;
    const dayBlockedPnl = dayBlocked.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    console.log(`  ${date}: ${dayBlocked.length}件ブロック → 改善${(-dayBlockedPnl).toLocaleString()}円`);
    dayBlocked.forEach(t => {
      console.log(`    ${t.entryTime} ${t.symbol} BPR=${t.bpr?.toFixed(3)} PnL=${(t.pnl ?? 0).toLocaleString()}円`);
    });
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
