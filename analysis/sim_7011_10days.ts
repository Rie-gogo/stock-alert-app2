/**
 * 三菱重工業（7011）直近10日間シミュレーション
 * 
 * 除外理由: 「7/1以降0勝2敗、-26,670円」
 * 
 * 現在の設定でシミュレーション:
 * - SL: デフォルト0.5%（SYMBOL_SL_MAPに7011は未登録）
 * - TP: 1.5%
 * - 大台確認4本維持
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const TP_PERCENT = 1.5;
const SL_PERCENT = 0.5; // 7011のデフォルトSL

async function main() {
  const db = await getDb();
  
  // まず7011の除外経緯を確認: 全トレード履歴
  console.log(`${'='.repeat(80)}`);
  console.log(`  三菱重工業（7011）分析`);
  console.log(`${'='.repeat(80)}`);
  
  // 全トレード取得
  const allTradesRes = await db.execute(sql.raw(
    `SELECT * FROM rt_trades WHERE symbol = '7011' ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (allTradesRes as any)[0] || [];
  
  // ペアリング
  interface TradePair {
    date: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    shares: number;
    pnl: number;
    entryTime: string;
    exitTime: string;
    reason: string;
    exitReason: string;
    boardSignal: string;
  }
  
  const pairs: TradePair[] = [];
  const processed = new Set<number>();
  
  for (let i = 0; i < allTrades.length; i++) {
    if (processed.has(i)) continue;
    const t = allTrades[i];
    if (t.action !== 'buy' && t.action !== 'short') continue;
    
    for (let j = i + 1; j < allTrades.length; j++) {
      if (processed.has(j)) continue;
      const e = allTrades[j];
      if (e.symbol === t.symbol && e.tradeDate === t.tradeDate && 
          (e.action === 'sell' || e.action === 'cover') && e.pnl !== null) {
        pairs.push({
          date: t.tradeDate,
          side: t.side,
          entryPrice: Number(t.price),
          exitPrice: Number(e.price),
          shares: Number(t.shares),
          pnl: Number(e.pnl),
          entryTime: t.tradeTime,
          exitTime: e.tradeTime,
          reason: t.reason || '',
          exitReason: e.reason || '',
          boardSignal: t.boardSignal || 'unknown',
        });
        processed.add(j);
        break;
      }
    }
  }
  
  console.log(`\n  全トレード履歴（${pairs.length}件）:`);
  console.log(`  日付       | 時刻        | 方向  | エントリー | 決済     | PnL       | 決済理由`);
  console.log(`  ${'─'.repeat(85)}`);
  
  let totalPnl = 0;
  for (const p of pairs) {
    totalPnl += p.pnl;
    const pnlStr = p.pnl >= 0 ? `+${p.pnl.toLocaleString()}` : p.pnl.toLocaleString();
    console.log(`  ${p.date} | ${p.entryTime}→${p.exitTime} | ${p.side.padEnd(5)} | ${p.entryPrice.toLocaleString().padStart(8)} | ${p.exitPrice.toLocaleString().padStart(8)} | ${pnlStr.padStart(9)}円 | ${p.exitReason.substring(0, 30)}`);
  }
  console.log(`  ${'─'.repeat(85)}`);
  console.log(`  合計: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円 | 勝率: ${(pairs.filter(p => p.pnl > 0).length / pairs.length * 100).toFixed(1)}%`);
  
  // ========== 直近10日間のシミュレーション ==========
  console.log(`\n\n${'='.repeat(80)}`);
  console.log(`  直近10日間シミュレーション（7011を現在の設定で取引した場合）`);
  console.log(`${'='.repeat(80)}`);
  
  // Get last 10 trade dates with 7011 candle data
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '7011' ORDER BY tradeDate DESC LIMIT 10`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  console.log(`\n  対象期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日)`);
  
  // 7011の実際のトレードを直近10日で抽出
  const recentPairs = pairs.filter(p => dates.includes(p.date));
  
  if (recentPairs.length > 0) {
    console.log(`\n  実際に記録されたトレード（${recentPairs.length}件）:`);
    for (const p of recentPairs) {
      const pnlStr = p.pnl >= 0 ? `+${p.pnl.toLocaleString()}` : p.pnl.toLocaleString();
      console.log(`    ${p.date} ${p.entryTime}→${p.exitTime} | ${p.side} | ${pnlStr}円 | ${p.exitReason}`);
    }
  } else {
    console.log(`\n  直近10日間に7011のトレード記録なし（除外中のため）`);
  }
  
  // シミュレーション: 7011のキャンドルデータからシグナルを検出してシミュレート
  // 実際のrt_tradesに記録がないので、他の銘柄と同じロジックでシグナルが出たかを推定
  // → 大台確認シグナルが出たかどうかをキャンドルデータから検証
  
  console.log(`\n  ── 仮想シミュレーション（大台シグナル検出） ──`);
  
  // 7011の直近10日のキャンドルデータを使って大台シグナルを検出
  let simTotalPnl = 0;
  let simTradeCount = 0;
  let simWins = 0;
  
  interface SimTrade {
    date: string;
    entryTime: string;
    exitTime: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    shares: number;
    pnl: number;
    reason: string;
  }
  const simTrades: SimTrade[] = [];
  
  for (const date of dates) {
    // Get all candles for this day
    const candlesRes = await db.execute(sql.raw(
      `SELECT candleTime, open, high, low, close, volume FROM rt_candles 
       WHERE tradeDate = '${date}' AND symbol = '7011' 
       ORDER BY candleTime`
    ));
    const candles = (candlesRes as any)[0] || [];
    if (candles.length < 30) continue; // Need warmup
    
    // Detect round level signals (simplified version of the engine logic)
    // 7011 price range: ~2800-3500 → round levels every 100 yen
    const getRoundLevel = (price: number): number => {
      if (price >= 10000) return Math.round(price / 1000) * 1000;
      if (price >= 3000) return Math.round(price / 500) * 500;
      return Math.round(price / 100) * 100;
    };
    
    let dayTraded = false;
    let confirmCount = 0;
    let pendingDirection: 'buy' | 'sell' | null = null;
    let pendingLevel = 0;
    
    for (let i = 30; i < candles.length; i++) {
      if (dayTraded) break; // 1日1トレードまで（簡略化）
      
      const c = candles[i];
      const time = c.candleTime;
      const close = Number(c.close);
      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      
      // Time filters
      if (time < '09:30' || time >= '15:05') continue;
      if (time >= '11:00' && time < '11:30') continue;
      if (time >= '12:30' && time < '13:00') continue;
      
      // Detect round level break
      const roundLevel = getRoundLevel(close);
      const prevClose = Number(candles[i-1].close);
      const prevRound = getRoundLevel(prevClose);
      
      if (pendingDirection === null) {
        // Check for new round level break
        if (close > roundLevel && prevClose <= roundLevel && roundLevel > prevRound) {
          // Broke above a round level
          pendingDirection = 'buy';
          pendingLevel = roundLevel;
          confirmCount = 1;
        } else if (close < roundLevel && prevClose >= roundLevel && roundLevel < prevRound) {
          // Broke below a round level
          pendingDirection = 'sell';
          pendingLevel = roundLevel;
          confirmCount = 1;
        }
      } else {
        // Confirming
        if (pendingDirection === 'buy' && close > pendingLevel) {
          confirmCount++;
        } else if (pendingDirection === 'sell' && close < pendingLevel) {
          confirmCount++;
        } else {
          // Failed confirmation
          pendingDirection = null;
          confirmCount = 0;
          continue;
        }
        
        if (confirmCount >= 4) {
          // Entry!
          const entryPrice = close;
          const shares = Math.floor(3000000 * 0.9 / entryPrice / 100) * 100;
          if (shares < 100) { pendingDirection = null; confirmCount = 0; continue; }
          
          const slPrice = pendingDirection === 'buy' 
            ? entryPrice * (1 - SL_PERCENT / 100)
            : entryPrice * (1 + SL_PERCENT / 100);
          const tpPrice = pendingDirection === 'buy'
            ? entryPrice * (1 + TP_PERCENT / 100)
            : entryPrice * (1 - TP_PERCENT / 100);
          
          // Simulate forward
          let exitPrice = entryPrice;
          let exitTime = time;
          let exitReason = '大引け強制決済';
          
          for (let j = i + 1; j < candles.length; j++) {
            const fc = candles[j];
            const fh = Number(fc.high);
            const fl = Number(fc.low);
            
            if (pendingDirection === 'buy') {
              if (fl <= slPrice) { exitPrice = slPrice; exitTime = fc.candleTime; exitReason = `損切り(SL:${SL_PERCENT}%)`; break; }
              if (fh >= tpPrice) { exitPrice = tpPrice; exitTime = fc.candleTime; exitReason = `利確(TP:${TP_PERCENT}%)`; break; }
            } else {
              if (fh >= slPrice) { exitPrice = slPrice; exitTime = fc.candleTime; exitReason = `損切り(SL:${SL_PERCENT}%)`; break; }
              if (fl <= tpPrice) { exitPrice = tpPrice; exitTime = fc.candleTime; exitReason = `利確(TP:${TP_PERCENT}%)`; break; }
            }
            exitPrice = Number(fc.close);
            exitTime = fc.candleTime;
          }
          
          const pnl = pendingDirection === 'buy'
            ? (exitPrice - entryPrice) * shares
            : (entryPrice - exitPrice) * shares;
          
          simTrades.push({
            date, entryTime: time, exitTime, side: pendingDirection === 'buy' ? 'long' : 'short',
            entryPrice, exitPrice, shares, pnl, reason: exitReason,
          });
          
          simTotalPnl += pnl;
          simTradeCount++;
          if (pnl > 0) simWins++;
          dayTraded = true;
          pendingDirection = null;
          confirmCount = 0;
        }
      }
    }
  }
  
  console.log(`\n  日付       | 時刻        | 方向  | エントリー | 決済     | 株数 | PnL       | 理由`);
  console.log(`  ${'─'.repeat(95)}`);
  
  for (const t of simTrades) {
    const pnlStr = t.pnl >= 0 ? `+${t.pnl.toFixed(0)}` : t.pnl.toFixed(0);
    console.log(`  ${t.date} | ${t.entryTime}→${t.exitTime} | ${t.side.padEnd(5)} | ${t.entryPrice.toFixed(0).padStart(8)} | ${t.exitPrice.toFixed(0).padStart(8)} | ${String(t.shares).padStart(4)} | ${pnlStr.padStart(9)}円 | ${t.reason}`);
  }
  
  console.log(`  ${'─'.repeat(95)}`);
  console.log(`  合計: ${simTradeCount}件 | 勝率: ${simTradeCount > 0 ? (simWins / simTradeCount * 100).toFixed(1) : 0}% | 総PnL: ${simTotalPnl >= 0 ? '+' : ''}${simTotalPnl.toFixed(0)}円`);
  
  // MFE/MAE分析
  if (simTrades.length > 0) {
    console.log(`\n  ── MFE/MAE分析 ──`);
    for (const t of simTrades) {
      // Get candles during hold period
      const holdCandles = await db.execute(sql.raw(
        `SELECT candleTime, high, low FROM rt_candles 
         WHERE tradeDate = '${t.date}' AND symbol = '7011' 
         AND candleTime > '${t.entryTime}' AND candleTime <= '${t.exitTime}'
         ORDER BY candleTime`
      ));
      const hc = (holdCandles as any)[0] || [];
      
      let mfe = 0, mae = 0;
      for (const c of hc) {
        if (t.side === 'long') {
          const profit = (Number(c.high) - t.entryPrice) / t.entryPrice * 100;
          const loss = (t.entryPrice - Number(c.low)) / t.entryPrice * 100;
          mfe = Math.max(mfe, profit);
          mae = Math.max(mae, loss);
        } else {
          const profit = (t.entryPrice - Number(c.low)) / t.entryPrice * 100;
          const loss = (Number(c.high) - t.entryPrice) / t.entryPrice * 100;
          mfe = Math.max(mfe, profit);
          mae = Math.max(mae, loss);
        }
      }
      
      const pnlStr = t.pnl >= 0 ? `+${t.pnl.toFixed(0)}` : t.pnl.toFixed(0);
      console.log(`    ${t.date} ${t.side.padEnd(5)} | MFE: +${mfe.toFixed(2)}% | MAE: -${mae.toFixed(2)}% | PnL: ${pnlStr}円`);
    }
  }
  
  // 日中ボラティリティ分析
  console.log(`\n  ── 日中ボラティリティ（直近10日） ──`);
  for (const date of dates) {
    const dayCandles = await db.execute(sql.raw(
      `SELECT MIN(low) as dayLow, MAX(high) as dayHigh,
       (SELECT open FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '7011' ORDER BY candleTime LIMIT 1) as dayOpen,
       (SELECT close FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '7011' ORDER BY candleTime DESC LIMIT 1) as dayClose,
       COUNT(*) as bars
       FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '7011'`
    ));
    const d = (dayCandles as any)[0][0];
    if (!d || !d.dayOpen) continue;
    const range = ((Number(d.dayHigh) - Number(d.dayLow)) / Number(d.dayOpen) * 100).toFixed(2);
    const change = ((Number(d.dayClose) - Number(d.dayOpen)) / Number(d.dayOpen) * 100).toFixed(2);
    console.log(`    ${date}: レンジ${range}% | 変動${Number(change) >= 0 ? '+' : ''}${change}% | ${d.bars}本`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
