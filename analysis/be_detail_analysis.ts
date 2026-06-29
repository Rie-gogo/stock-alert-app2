/**
 * BE発動23件の詳細分析
 * 
 * BEトリガー(+0.5%)発動後の動きを追跡:
 * ① BE後にTP(+1.5%)到達したか
 * ② BE後にSL(-0.5%)相当まで逆行したか（BEなしなら損失だった）
 * ③ BE後に大引けまで持ったか
 * ④ BE発動後の最大含み益（エントリー価格基準）
 * ⑤ BE発動後の最大逆行（エントリー価格基準、マイナス=逆行）
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

interface Trade {
  id: number;
  symbol: string;
  symbolName: string;
  tradeDate: string;
  tradeTime: string;
  price: number;
  shares: number;
  pnl: number | null;
  side: string;
}

async function main() {
  const db = await getDb();
  
  const tradeResult = await db.execute(
    sql`SELECT id, symbol, symbolName, tradeDate, tradeTime, action, price, shares, pnl, reason, side
        FROM rt_trades ORDER BY tradeDate, tradeTime`
  ) as any;
  const allTrades: Trade[] = (tradeResult[0] ?? tradeResult).map((t: any) => ({
    ...t,
    price: Number(t.price),
    shares: Number(t.shares),
    pnl: t.pnl !== null ? Number(t.pnl) : null,
  }));
  
  const entries = allTrades.filter(t => t.pnl === null);
  
  interface BEDetail {
    symbol: string;
    symbolName: string;
    date: string;
    entryTime: string;
    side: string;
    entryPrice: number;
    shares: number;
    beTriggerTime: string;      // BEトリガー発動時刻
    beTriggerCandle: number;    // エントリーから何本目でBE発動
    beExitTime: string;         // BE決済時刻（建値戻り時刻）
    beExitCandle: number;       // BEトリガーから何本目で建値戻り
    maxProfitAfterBE: number;   // BE発動後の最大含み益（%）
    maxDrawdownAfterBE: number; // BE発動後の最大逆行（%、マイナス）
    maxProfitBeforeBE: number;  // BE発動前の最大含み益（%）
    wouldHaveBeenTP: boolean;   // BEなしならTP到達していたか
    wouldHaveBeenSL: boolean;   // BEなしならSL到達していたか
    actualExitPnl: number;      // 実際のexit pnl（BEなしの場合）
    exitReason: string;         // 実際のexit reason
    afterBEMaxProfitYen: number;  // BE後最大含み益（円）
    afterBEMaxDrawdownYen: number; // BE後最大逆行（円）
  }
  
  const beDetails: BEDetail[] = [];
  
  for (const entry of entries) {
    const exit = allTrades.find(t => 
      t.symbol === entry.symbol && 
      t.tradeDate === entry.tradeDate &&
      t.tradeTime > entry.tradeTime && 
      t.pnl !== null
    );
    if (!exit) continue;
    
    // Get all holding candles with time
    const holdingResult = await db.execute(
      sql`SELECT candleTime, open, high, low, close
          FROM rt_candles 
          WHERE symbol = ${entry.symbol} AND tradeDate = ${entry.tradeDate}
          AND candleTime > ${entry.tradeTime}
          ORDER BY candleTime`
    ) as any;
    const holding = (holdingResult[0] ?? holdingResult).map((c: any) => ({
      time: c.candleTime as string,
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }));
    
    const slPct = 0.005;
    const tpPct = 0.015;
    const beTriggerPct = 0.005;
    
    // Simulate to find BE trigger point
    let beTriggered = false;
    let beTriggerTime = '';
    let beTriggerCandle = 0;
    let beExitTime = '';
    let beExitCandle = 0;
    let maxProfitAfterBE = 0;
    let maxDrawdownAfterBE = 0;
    let maxProfitBeforeBE = 0;
    let isBEExit = false;
    
    for (let i = 0; i < holding.length; i++) {
      const c = holding[i];
      let unrealizedHigh: number, unrealizedLow: number;
      
      if (entry.side === 'short') {
        unrealizedHigh = (entry.price - c.low) / entry.price;
        unrealizedLow = (entry.price - c.high) / entry.price;
      } else {
        unrealizedHigh = (c.high - entry.price) / entry.price;
        unrealizedLow = (c.low - entry.price) / entry.price;
      }
      
      if (!beTriggered) {
        maxProfitBeforeBE = Math.max(maxProfitBeforeBE, unrealizedHigh);
        if (unrealizedHigh >= beTriggerPct) {
          beTriggered = true;
          beTriggerTime = c.time;
          beTriggerCandle = i + 1;
        }
        // Check if SL or TP hit before BE
        if (unrealizedLow <= -slPct || unrealizedHigh >= tpPct) break;
      }
      
      if (beTriggered) {
        maxProfitAfterBE = Math.max(maxProfitAfterBE, unrealizedHigh);
        maxDrawdownAfterBE = Math.min(maxDrawdownAfterBE, unrealizedLow);
        
        if (unrealizedLow <= 0 && !isBEExit) {
          isBEExit = true;
          beExitTime = c.time;
          beExitCandle = i + 1 - beTriggerCandle;
          break; // BE exit
        }
        if (unrealizedHigh >= tpPct) {
          break; // TP exit (not BE)
        }
      }
    }
    
    if (!isBEExit) continue; // Only interested in BE exits
    
    // Check what would have happened WITHOUT BE (continue tracking after BE exit)
    let wouldHaveBeenTP = false;
    let wouldHaveBeenSL = false;
    let noBeMaxProfit = 0;
    
    for (const c of holding) {
      let unrealizedHigh: number, unrealizedLow: number;
      if (entry.side === 'short') {
        unrealizedHigh = (entry.price - c.low) / entry.price;
        unrealizedLow = (entry.price - c.high) / entry.price;
      } else {
        unrealizedHigh = (c.high - entry.price) / entry.price;
        unrealizedLow = (c.low - entry.price) / entry.price;
      }
      
      noBeMaxProfit = Math.max(noBeMaxProfit, unrealizedHigh);
      
      if (unrealizedLow <= -slPct) { wouldHaveBeenSL = true; break; }
      if (unrealizedHigh >= tpPct) { wouldHaveBeenTP = true; break; }
    }
    
    beDetails.push({
      symbol: entry.symbol,
      symbolName: entry.symbolName,
      date: entry.tradeDate,
      entryTime: entry.tradeTime,
      side: entry.side,
      entryPrice: entry.price,
      shares: entry.shares,
      beTriggerTime,
      beTriggerCandle,
      beExitTime,
      beExitCandle,
      maxProfitAfterBE: maxProfitAfterBE * 100,
      maxDrawdownAfterBE: maxDrawdownAfterBE * 100,
      maxProfitBeforeBE: maxProfitBeforeBE * 100,
      wouldHaveBeenTP,
      wouldHaveBeenSL,
      actualExitPnl: exit.pnl!,
      exitReason: (exit as any).reason || '',
      afterBEMaxProfitYen: maxProfitAfterBE * entry.price * entry.shares,
      afterBEMaxDrawdownYen: maxDrawdownAfterBE * entry.price * entry.shares,
    });
  }
  
  console.log(`=== BE発動→建値決済 ${beDetails.length}件 詳細分析 ===\n`);
  
  // Summary stats
  const tpAfter = beDetails.filter(d => d.wouldHaveBeenTP);
  const slAfter = beDetails.filter(d => d.wouldHaveBeenSL);
  const closeAfter = beDetails.filter(d => !d.wouldHaveBeenTP && !d.wouldHaveBeenSL);
  
  console.log('【BE後の行方（BEなしで持ち続けた場合）】');
  console.log(`  ① BE後にTP(+1.5%)到達: ${tpAfter.length}件`);
  console.log(`  ② BE後にSL(-0.5%)到達: ${slAfter.length}件`);
  console.log(`  ③ BE後に大引けまで: ${closeAfter.length}件`);
  console.log('');
  
  // If we didn't have BE, what would the PnL be?
  const beExitPnl = 0; // All BE exits = 0
  const noBeTPPnl = tpAfter.length * 0.015; // rough
  const noBeSLPnl = slAfter.length * -0.005;
  
  console.log('【BEの価値評価】');
  const savedFromSL = slAfter.length;
  const missedTP = tpAfter.length;
  const savedAmount = slAfter.reduce((s, d) => s + 0.005 * d.entryPrice * d.shares, 0);
  const missedAmount = tpAfter.reduce((s, d) => s + 0.015 * d.entryPrice * d.shares, 0);
  console.log(`  BEで救われた（SL回避）: ${savedFromSL}件 → 回避した損失: +${Math.round(savedAmount).toLocaleString()}円`);
  console.log(`  BEで逃した（TP到達可能だった）: ${missedTP}件 → 逃した利益: -${Math.round(missedAmount).toLocaleString()}円`);
  console.log(`  ネット: ${savedAmount > missedAmount ? '+' : ''}${Math.round(savedAmount - missedAmount).toLocaleString()}円`);
  
  // Detail table
  console.log('\n' + '='.repeat(100));
  console.log('【個別詳細】');
  console.log('  # | 日付       | 時刻  | 銘柄         | 方向  | BE発動 | BE決済 | ④最大益% | ⑤最大逆行% | BEなし結果');
  console.log('  ' + '-'.repeat(95));
  
  for (let i = 0; i < beDetails.length; i++) {
    const d = beDetails[i];
    const noBe = d.wouldHaveBeenTP ? 'TP(+1.5%)' : d.wouldHaveBeenSL ? 'SL(-0.5%)' : '大引け';
    console.log(`  ${(i+1).toString().padStart(2)} | ${d.date} | ${d.entryTime} | ${d.symbolName.padEnd(10)} | ${d.side.padEnd(5)} | ${d.beTriggerTime}(${d.beTriggerCandle}本) | ${d.beExitTime}(${d.beExitCandle}本後) | +${d.maxProfitAfterBE.toFixed(2)}% | ${d.maxDrawdownAfterBE.toFixed(2)}% | ${noBe}`);
  }
  
  // Categorized analysis
  console.log('\n' + '='.repeat(100));
  console.log('【カテゴリ別分析】');
  
  console.log('\n--- ① BE後TP到達（BEで逃した利益）---');
  if (tpAfter.length > 0) {
    console.log('  # | 日付       | 銘柄         | 方向  | BE後最大益 | 逃した利益');
    for (const d of tpAfter) {
      const missed = 0.015 * d.entryPrice * d.shares;
      console.log(`    | ${d.date} | ${d.symbolName.padEnd(10)} | ${d.side.padEnd(5)} | +${d.maxProfitAfterBE.toFixed(2)}% (+${Math.round(d.afterBEMaxProfitYen).toLocaleString()}円) | -${Math.round(missed).toLocaleString()}円`);
    }
    console.log(`  合計逃した利益: -${Math.round(missedAmount).toLocaleString()}円`);
  } else {
    console.log('  なし');
  }
  
  console.log('\n--- ② BE後SL到達（BEで救われた）---');
  if (slAfter.length > 0) {
    console.log('  # | 日付       | 銘柄         | 方向  | BE後最大逆行 | 回避した損失');
    for (const d of slAfter) {
      const saved = 0.005 * d.entryPrice * d.shares;
      console.log(`    | ${d.date} | ${d.symbolName.padEnd(10)} | ${d.side.padEnd(5)} | ${d.maxDrawdownAfterBE.toFixed(2)}% (${Math.round(d.afterBEMaxDrawdownYen).toLocaleString()}円) | +${Math.round(saved).toLocaleString()}円`);
    }
    console.log(`  合計回避した損失: +${Math.round(savedAmount).toLocaleString()}円`);
  } else {
    console.log('  なし');
  }
  
  console.log('\n--- ③ BE後大引け（TPもSLも未到達）---');
  if (closeAfter.length > 0) {
    console.log('  # | 日付       | 銘柄         | 方向  | BE後最大益 | BE後最大逆行 | 大引けPnL');
    for (const d of closeAfter) {
      console.log(`    | ${d.date} | ${d.symbolName.padEnd(10)} | ${d.side.padEnd(5)} | +${d.maxProfitAfterBE.toFixed(2)}% (+${Math.round(d.afterBEMaxProfitYen).toLocaleString()}円) | ${d.maxDrawdownAfterBE.toFixed(2)}% (${Math.round(d.afterBEMaxDrawdownYen).toLocaleString()}円) | ${d.actualExitPnl >= 0 ? '+' : ''}${Math.round(d.actualExitPnl).toLocaleString()}円`);
    }
    const closeTotal = closeAfter.reduce((s, d) => s + d.actualExitPnl, 0);
    console.log(`  大引けPnL合計: ${closeTotal >= 0 ? '+' : ''}${Math.round(closeTotal).toLocaleString()}円 (BEで0円にした vs 持ち続けた場合)`);
  } else {
    console.log('  なし');
  }
  
  // Statistics
  console.log('\n' + '='.repeat(100));
  console.log('【統計サマリー】');
  const maxProfits = beDetails.map(d => d.maxProfitAfterBE);
  const maxDrawdowns = beDetails.map(d => d.maxDrawdownAfterBE);
  const triggerCandles = beDetails.map(d => d.beTriggerCandle);
  const exitCandles = beDetails.map(d => d.beExitCandle);
  
  maxProfits.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);
  triggerCandles.sort((a, b) => a - b);
  exitCandles.sort((a, b) => a - b);
  
  console.log(`  ④ BE後最大含み益:`);
  console.log(`    平均: +${(maxProfits.reduce((a, b) => a + b, 0) / maxProfits.length).toFixed(3)}%`);
  console.log(`    中央値: +${maxProfits[Math.floor(maxProfits.length / 2)].toFixed(3)}%`);
  console.log(`    最大: +${maxProfits[maxProfits.length - 1].toFixed(3)}%`);
  
  console.log(`  ⑤ BE後最大逆行:`);
  console.log(`    平均: ${(maxDrawdowns.reduce((a, b) => a + b, 0) / maxDrawdowns.length).toFixed(3)}%`);
  console.log(`    中央値: ${maxDrawdowns[Math.floor(maxDrawdowns.length / 2)].toFixed(3)}%`);
  console.log(`    最大逆行: ${maxDrawdowns[0].toFixed(3)}%`);
  
  console.log(`  BE発動までの時間:`);
  console.log(`    平均: ${(triggerCandles.reduce((a, b) => a + b, 0) / triggerCandles.length).toFixed(1)}分`);
  console.log(`    中央値: ${triggerCandles[Math.floor(triggerCandles.length / 2)]}分`);
  
  console.log(`  BE発動→建値戻りまでの時間:`);
  console.log(`    平均: ${(exitCandles.reduce((a, b) => a + b, 0) / exitCandles.length).toFixed(1)}分`);
  console.log(`    中央値: ${exitCandles[Math.floor(exitCandles.length / 2)]}分`);
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
