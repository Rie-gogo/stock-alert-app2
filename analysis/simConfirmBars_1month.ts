/**
 * CONFIRM_BARS=4 vs 5: 過去1ヶ月間の全トレードシミュレーション
 * 
 * 方法: 大台確認エントリーについて、1分前のclose価格でエントリーした場合の
 * 損益を再計算する。決済価格は同じ（損切りライン変更による回避は別途分析）。
 */
import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

interface Trade {
  id: number;
  symbol: string;
  action: string;
  price: number;
  shares: number;
  pnl: number | null;
  reason: string;
  tradeTime: string;
  tradeDate: string;
  side: string;
}

async function main() {
  const db = await getDb();
  
  // 過去1ヶ月のトレードを取得
  const [rows] = await db.execute(sql`
    SELECT id, symbol, action, price, shares, pnl, reason, tradeTime, tradeDate, side
    FROM rt_trades 
    WHERE tradeDate >= '2026-06-30'
    ORDER BY tradeDate ASC, tradeTime ASC, id ASC
  `);
  
  const allTrades = (rows as any[]).map(r => ({
    ...r,
    price: parseFloat(r.price),
    pnl: r.pnl !== null ? Number(r.pnl) : null
  })) as Trade[];
  
  console.log(`=== CONFIRM_BARS=4 vs 5: 過去1ヶ月シミュレーション ===`);
  console.log(`期間: 2026-06-30 〜 2026-07-30`);
  console.log(`全トレード数: ${allTrades.length}件\n`);
  
  // エントリーと決済をペアリング（日付+銘柄で対応付け）
  const pairs: { entry: Trade; exit: Trade }[] = [];
  const usedExitIds = new Set<number>();
  
  for (const t of allTrades) {
    if (t.action === 'buy' || t.action === 'short') {
      // 対応する決済を探す
      const exit = allTrades.find(x => 
        !usedExitIds.has(x.id) &&
        x.symbol === t.symbol && 
        x.tradeDate === t.tradeDate &&
        (x.action === 'sell' || x.action === 'cover') &&
        x.tradeTime >= t.tradeTime &&
        x.id > t.id
      );
      if (exit) {
        pairs.push({ entry: t, exit });
        usedExitIds.add(exit.id);
      }
    }
  }
  
  console.log(`ペアリング成功: ${pairs.length}件\n`);
  
  // 大台確認エントリーを特定
  const roundPairs = pairs.filter(p => p.entry.reason.includes('大台確認'));
  const otherPairs = pairs.filter(p => !p.entry.reason.includes('大台確認'));
  
  console.log(`大台確認エントリー: ${roundPairs.length}件（CONFIRM_BARS影響あり）`);
  console.log(`その他エントリー: ${otherPairs.length}件（影響なし）\n`);
  
  // 各大台確認エントリーについて、1分前の価格を取得してシミュレーション
  let totalCurrentPnl = 0;
  let totalNewPnl = 0;
  let improvedCount = 0;
  let worsenedCount = 0;
  let unchangedCount = 0;
  let slAvoidedCount = 0;
  
  // 日別集計
  const dailyResults: Map<string, { currentPnl: number; newPnl: number; count: number }> = new Map();
  // 銘柄別集計
  const symbolResults: Map<string, { currentPnl: number; newPnl: number; count: number }> = new Map();
  // 種別別集計
  const typeResults: Map<string, { currentPnl: number; newPnl: number; count: number; wins: number; newWins: number }> = new Map();
  // BUY/SHORT別集計
  const sideResults: Map<string, { currentPnl: number; newPnl: number; count: number; wins: number; newWins: number }> = new Map();
  
  const tradeDetails: any[] = [];
  
  for (const pair of roundPairs) {
    const { entry, exit } = pair;
    const currentPnl = exit.pnl || 0;
    totalCurrentPnl += currentPnl;
    
    // 1分前のローソク足を取得
    const [candles] = await db.execute(sql`
      SELECT candleTime, close
      FROM rt_candles
      WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
      AND candleTime < ${entry.tradeTime}
      ORDER BY candleTime DESC
      LIMIT 1
    `);
    
    const cArr = candles as any[];
    let newPnl = currentPnl; // デフォルトは変更なし
    let newEntryPrice = entry.price;
    
    if (cArr.length > 0) {
      newEntryPrice = parseFloat(cArr[0].close);
      
      // 新しいPnLを計算（決済価格は同じと仮定）
      const exitPrice = exit.price;
      if (entry.action === 'buy') {
        newPnl = Math.round((exitPrice - newEntryPrice) * entry.shares);
      } else { // short
        newPnl = Math.round((newEntryPrice - exitPrice) * entry.shares);
      }
      
      // 損切り回避の確認
      if (exit.reason.includes('損切り') && newPnl > currentPnl) {
        // 新しい損切りラインで回避できたか確認
        const slPct = 0.005;
        let newSL: number;
        if (entry.action === 'buy') {
          newSL = newEntryPrice * (1 - slPct);
          // エントリー後の安値を確認
          const [postCandles] = await db.execute(sql`
            SELECT MIN(low) as minLow
            FROM rt_candles
            WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
            AND candleTime >= ${cArr[0].candleTime} AND candleTime <= ${exit.tradeTime}
          `);
          const minLow = parseFloat((postCandles as any[])[0]?.minLow || '0');
          if (minLow > newSL) {
            slAvoidedCount++;
          }
        } else {
          newSL = newEntryPrice * (1 + slPct);
          const [postCandles] = await db.execute(sql`
            SELECT MAX(high) as maxHigh
            FROM rt_candles
            WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
            AND candleTime >= ${cArr[0].candleTime} AND candleTime <= ${exit.tradeTime}
          `);
          const maxHigh = parseFloat((postCandles as any[])[0]?.maxHigh || '999999');
          if (maxHigh < newSL) {
            slAvoidedCount++;
          }
        }
      }
    }
    
    totalNewPnl += newPnl;
    
    if (newPnl > currentPnl) improvedCount++;
    else if (newPnl < currentPnl) worsenedCount++;
    else unchangedCount++;
    
    // 日別集計
    const dateKey = entry.tradeDate;
    const daily = dailyResults.get(dateKey) || { currentPnl: 0, newPnl: 0, count: 0 };
    daily.currentPnl += currentPnl;
    daily.newPnl += newPnl;
    daily.count++;
    dailyResults.set(dateKey, daily);
    
    // 銘柄別集計
    const symKey = entry.symbol;
    const sym = symbolResults.get(symKey) || { currentPnl: 0, newPnl: 0, count: 0 };
    sym.currentPnl += currentPnl;
    sym.newPnl += newPnl;
    sym.count++;
    symbolResults.set(symKey, sym);
    
    // 種別別集計（強トレンド vs 押し目確認後）
    const isStrongTrend = entry.reason.includes('押し目なし・強トレンド');
    const typeKey = isStrongTrend ? '強トレンド' : '押し目確認後';
    const type = typeResults.get(typeKey) || { currentPnl: 0, newPnl: 0, count: 0, wins: 0, newWins: 0 };
    type.currentPnl += currentPnl;
    type.newPnl += newPnl;
    type.count++;
    if (currentPnl > 0) type.wins++;
    if (newPnl > 0) type.newWins++;
    typeResults.set(typeKey, type);
    
    // BUY/SHORT別
    const sideKey = entry.action === 'buy' ? 'BUY' : 'SHORT';
    const side = sideResults.get(sideKey) || { currentPnl: 0, newPnl: 0, count: 0, wins: 0, newWins: 0 };
    side.currentPnl += currentPnl;
    side.newPnl += newPnl;
    side.count++;
    if (currentPnl > 0) side.wins++;
    if (newPnl > 0) side.newWins++;
    sideResults.set(sideKey, side);
    
    tradeDetails.push({
      date: entry.tradeDate,
      time: entry.tradeTime,
      symbol: entry.symbol,
      action: entry.action,
      type: typeKey,
      currentEntry: entry.price,
      newEntry: newEntryPrice,
      exitPrice: exit.price,
      currentPnl,
      newPnl,
      diff: newPnl - currentPnl,
      exitReason: exit.reason.substring(0, 30)
    });
  }
  
  // その他エントリーの合計
  let otherTotalPnl = 0;
  for (const pair of otherPairs) {
    otherTotalPnl += pair.exit.pnl || 0;
  }
  
  // ===== 結果出力 =====
  
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("【総合結果】");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  const grandCurrentPnl = totalCurrentPnl + otherTotalPnl;
  const grandNewPnl = totalNewPnl + otherTotalPnl;
  
  console.log(`  大台確認（${roundPairs.length}件）:`);
  console.log(`    現行(5本): ${totalCurrentPnl >= 0 ? '+' : ''}${totalCurrentPnl.toLocaleString()}円`);
  console.log(`    新(4本):   ${totalNewPnl >= 0 ? '+' : ''}${totalNewPnl.toLocaleString()}円`);
  console.log(`    差分:      ${(totalNewPnl - totalCurrentPnl) >= 0 ? '+' : ''}${(totalNewPnl - totalCurrentPnl).toLocaleString()}円`);
  console.log(`\n  その他シグナル（${otherPairs.length}件）: ${otherTotalPnl >= 0 ? '+' : ''}${otherTotalPnl.toLocaleString()}円（変更なし）`);
  console.log(`\n  全体合計:`);
  console.log(`    現行(5本): ${grandCurrentPnl >= 0 ? '+' : ''}${grandCurrentPnl.toLocaleString()}円`);
  console.log(`    新(4本):   ${grandNewPnl >= 0 ? '+' : ''}${grandNewPnl.toLocaleString()}円`);
  console.log(`    差分:      ${(grandNewPnl - grandCurrentPnl) >= 0 ? '+' : ''}${(grandNewPnl - grandCurrentPnl).toLocaleString()}円`);
  
  console.log(`\n  改善/悪化: 改善${improvedCount}件 / 悪化${worsenedCount}件 / 変化なし${unchangedCount}件`);
  console.log(`  損切り回避: ${slAvoidedCount}件`);
  
  // BUY/SHORT別
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("【BUY / SHORT 別】");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  for (const [side, data] of sideResults) {
    const winRate = data.count > 0 ? (data.wins / data.count * 100).toFixed(1) : '0';
    const newWinRate = data.count > 0 ? (data.newWins / data.count * 100).toFixed(1) : '0';
    console.log(`  ${side}（${data.count}件）:`);
    console.log(`    現行: ${data.currentPnl >= 0 ? '+' : ''}${data.currentPnl.toLocaleString()}円 (勝率${winRate}%)`);
    console.log(`    新:   ${data.newPnl >= 0 ? '+' : ''}${data.newPnl.toLocaleString()}円 (勝率${newWinRate}%)`);
    console.log(`    差分: ${(data.newPnl - data.currentPnl) >= 0 ? '+' : ''}${(data.newPnl - data.currentPnl).toLocaleString()}円\n`);
  }
  
  // 種別別
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("【強トレンド / 押し目確認後 別】");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  for (const [type, data] of typeResults) {
    const winRate = data.count > 0 ? (data.wins / data.count * 100).toFixed(1) : '0';
    const newWinRate = data.count > 0 ? (data.newWins / data.count * 100).toFixed(1) : '0';
    console.log(`  ${type}（${data.count}件）:`);
    console.log(`    現行: ${data.currentPnl >= 0 ? '+' : ''}${data.currentPnl.toLocaleString()}円 (勝率${winRate}%)`);
    console.log(`    新:   ${data.newPnl >= 0 ? '+' : ''}${data.newPnl.toLocaleString()}円 (勝率${newWinRate}%)`);
    console.log(`    差分: ${(data.newPnl - data.currentPnl) >= 0 ? '+' : ''}${(data.newPnl - data.currentPnl).toLocaleString()}円\n`);
  }
  
  // 銘柄別
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("【銘柄別】");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  const sortedSymbols = [...symbolResults.entries()].sort((a, b) => (b[1].newPnl - b[1].currentPnl) - (a[1].newPnl - a[1].currentPnl));
  console.log(`  ${'銘柄'.padEnd(6)} | ${'件数'.padStart(4)} | ${'現行PnL'.padStart(12)} | ${'新PnL'.padStart(12)} | ${'差分'.padStart(12)}`);
  console.log(`  ${'-'.repeat(6)} | ${'-'.repeat(4)} | ${'-'.repeat(12)} | ${'-'.repeat(12)} | ${'-'.repeat(12)}`);
  for (const [sym, data] of sortedSymbols) {
    const diff = data.newPnl - data.currentPnl;
    console.log(`  ${sym.padEnd(6)} | ${String(data.count).padStart(4)} | ${(data.currentPnl >= 0 ? '+' : '') + data.currentPnl.toLocaleString().padStart(11)} | ${(data.newPnl >= 0 ? '+' : '') + data.newPnl.toLocaleString().padStart(11)} | ${(diff >= 0 ? '+' : '') + diff.toLocaleString().padStart(11)}`);
  }
  
  // 日別
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("【日別】");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  console.log(`  ${'日付'.padEnd(10)} | ${'件数'.padStart(4)} | ${'現行PnL'.padStart(12)} | ${'新PnL'.padStart(12)} | ${'差分'.padStart(12)}`);
  console.log(`  ${'-'.repeat(10)} | ${'-'.repeat(4)} | ${'-'.repeat(12)} | ${'-'.repeat(12)} | ${'-'.repeat(12)}`);
  
  const sortedDates = [...dailyResults.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [date, data] of sortedDates) {
    const diff = data.newPnl - data.currentPnl;
    console.log(`  ${date} | ${String(data.count).padStart(4)} | ${(data.currentPnl >= 0 ? '+' : '') + data.currentPnl.toLocaleString().padStart(11)} | ${(data.newPnl >= 0 ? '+' : '') + data.newPnl.toLocaleString().padStart(11)} | ${(diff >= 0 ? '+' : '') + diff.toLocaleString().padStart(11)}`);
  }
  
  // 大きな差分のトレード TOP10
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("【差分TOP10（改善）】");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  const sortedByDiff = [...tradeDetails].sort((a, b) => b.diff - a.diff);
  for (let i = 0; i < Math.min(10, sortedByDiff.length); i++) {
    const t = sortedByDiff[i];
    console.log(`  ${t.date} ${t.time} | ${t.symbol} ${t.action.toUpperCase()} | ${t.type} | 現行:${t.currentPnl >= 0 ? '+' : ''}${t.currentPnl}→新:${t.newPnl >= 0 ? '+' : ''}${t.newPnl} | 差分:+${t.diff}`);
  }
  
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("【差分WORST10（悪化）】");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  const sortedByDiffAsc = [...tradeDetails].sort((a, b) => a.diff - b.diff);
  for (let i = 0; i < Math.min(10, sortedByDiffAsc.length); i++) {
    const t = sortedByDiffAsc[i];
    if (t.diff >= 0) break;
    console.log(`  ${t.date} ${t.time} | ${t.symbol} ${t.action.toUpperCase()} | ${t.type} | 現行:${t.currentPnl >= 0 ? '+' : ''}${t.currentPnl}→新:${t.newPnl >= 0 ? '+' : ''}${t.newPnl} | 差分:${t.diff}`);
  }
  
  process.exit(0);
}
main().catch(console.error);
