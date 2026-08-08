/**
 * 大台確認LONG 全トレード詳細分析
 * - なぜ勝率14.3%と悪いのか
 * - 利確した3件は何が良かったのか
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const EXCLUDED = new Set(['6920', '6758', '9984', '7011', '9107', '8306', '4568', '5016', '7203', '3778', '3436', '6723']);

async function main() {
  const db = await getDb();
  
  // Get last 30 trade dates
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  // Get all trades
  const tradesRes = await db.execute(sql.raw(
    `SELECT * FROM rt_trades WHERE tradeDate >= '${dates[0]}' ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (tradesRes as any)[0] || [];
  
  // Find round-level LONG entries
  interface Trade {
    symbol: string; name: string; date: string; side: string;
    entryPrice: number; exitPrice: number; pnl: number;
    entryTime: string; exitTime: string;
    reason: string; exitReason: string;
    confidence: string; boardSignal: string;
  }
  
  const roundLongs: Trade[] = [];
  const processed = new Set<number>();
  
  for (let i = 0; i < allTrades.length; i++) {
    if (processed.has(i)) continue;
    const t = allTrades[i];
    if (t.action !== 'buy') continue;
    if (EXCLUDED.has(t.symbol)) continue;
    const reason = t.reason || '';
    if (!reason.includes('大台確認')) continue;
    
    for (let j = i + 1; j < allTrades.length; j++) {
      if (processed.has(j)) continue;
      const e = allTrades[j];
      if (e.symbol === t.symbol && e.tradeDate === t.tradeDate && 
          e.action === 'sell' && e.pnl !== null) {
        
        let confidence = '不明';
        if (reason.includes('信頼度：強')) confidence = '強';
        else if (reason.includes('信頼度：中')) confidence = '中';
        
        roundLongs.push({
          symbol: t.symbol, name: t.symbolName || t.symbol,
          date: t.tradeDate, side: 'long',
          entryPrice: Number(t.price), exitPrice: Number(e.price),
          pnl: Number(e.pnl),
          entryTime: t.tradeTime, exitTime: e.tradeTime,
          reason, exitReason: e.reason || '',
          confidence, boardSignal: t.boardSignal || '',
        });
        processed.add(j);
        break;
      }
    }
  }
  
  console.log('='.repeat(80));
  console.log('  大台確認LONG 全トレード詳細分析');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1]);
  console.log('  件数: ' + roundLongs.length + '件（勝ち' + roundLongs.filter(t => t.pnl > 0).length + ' / 負け' + roundLongs.filter(t => t.pnl <= 0).length + '）');
  console.log('='.repeat(80));
  
  // Detailed analysis for each trade
  console.log('\n  ─── 全トレード一覧 ───');
  console.log('  # | 日付       | 時刻        | 銘柄         | Entry    | PnL        | 信頼度 | 板      | 決済理由');
  console.log('  ' + '─'.repeat(105));
  
  let idx = 0;
  for (const t of roundLongs) {
    idx++;
    const pnlStr = t.pnl >= 0 ? '+' + t.pnl.toLocaleString() : t.pnl.toLocaleString();
    const result = t.pnl > 0 ? '○' : '×';
    console.log('  ' + result + String(idx).padStart(2) + ' | ' + t.date + ' | ' + t.entryTime + '→' + t.exitTime + ' | ' + t.name.padEnd(10) + ' | ' + t.entryPrice.toLocaleString().padStart(8) + ' | ' + pnlStr.padStart(10) + '円 | ' + t.confidence.padEnd(2) + '   | ' + t.boardSignal.padEnd(14) + ' | ' + t.exitReason.substring(0, 30));
  }
  
  // Analyze each trade's context
  console.log('\n\n  ─── 各トレードの詳細分析 ───');
  
  for (const t of roundLongs) {
    // Get day's candle data
    const dayRes = await db.execute(sql.raw(
      `SELECT 
        (SELECT open FROM rt_candles WHERE tradeDate = '${t.date}' AND symbol = '${t.symbol}' ORDER BY candleTime LIMIT 1) as dayOpen,
        (SELECT close FROM rt_candles WHERE tradeDate = '${t.date}' AND symbol = '${t.symbol}' ORDER BY candleTime DESC LIMIT 1) as dayClose,
        MIN(low) as dayLow, MAX(high) as dayHigh
       FROM rt_candles WHERE tradeDate = '${t.date}' AND symbol = '${t.symbol}'`
    ));
    const day = (dayRes as any)[0][0];
    const dayOpen = Number(day.dayOpen);
    const dayClose = Number(day.dayClose);
    const dayHigh = Number(day.dayHigh);
    const dayLow = Number(day.dayLow);
    const dayChange = ((dayClose - dayOpen) / dayOpen * 100).toFixed(2);
    
    // Get candles after entry for MFE/MAE
    const candlesRes = await db.execute(sql.raw(
      `SELECT candleTime, high, low, close FROM rt_candles 
       WHERE tradeDate = '${t.date}' AND symbol = '${t.symbol}' 
       AND candleTime > '${t.entryTime}'
       ORDER BY candleTime`
    ));
    const candles = (candlesRes as any)[0] || [];
    
    let mfe = 0, mae = 0, mfeTime = '', maeTime = '';
    for (const c of candles) {
      const profit = (Number(c.high) - t.entryPrice) / t.entryPrice * 100;
      const loss = (t.entryPrice - Number(c.low)) / t.entryPrice * 100;
      if (profit > mfe) { mfe = profit; mfeTime = c.candleTime; }
      if (loss > mae) { mae = loss; maeTime = c.candleTime; }
    }
    
    // Get candles BEFORE entry to understand pre-entry move
    const preCandlesRes = await db.execute(sql.raw(
      `SELECT candleTime, open, high, low, close FROM rt_candles 
       WHERE tradeDate = '${t.date}' AND symbol = '${t.symbol}' 
       AND candleTime <= '${t.entryTime}'
       ORDER BY candleTime`
    ));
    const preCandles = (preCandlesRes as any)[0] || [];
    
    // Calculate how much the stock already moved before entry
    let preMovePct = 0;
    if (preCandles.length > 0) {
      const firstOpen = Number(preCandles[0].open);
      preMovePct = (t.entryPrice - firstOpen) / firstOpen * 100;
    }
    
    // Entry position in day's range
    const entryPos = dayHigh !== dayLow ? ((t.entryPrice - dayLow) / (dayHigh - dayLow) * 100).toFixed(0) : '50';
    
    const result = t.pnl > 0 ? '【勝ち】' : '【負け】';
    const pnlStr = t.pnl >= 0 ? '+' + t.pnl.toLocaleString() : t.pnl.toLocaleString();
    
    console.log('\n  ' + '─'.repeat(70));
    console.log('  ' + result + ' ' + t.date + ' ' + t.entryTime + ' ' + t.name + '(' + t.symbol + ') LONG @ ' + t.entryPrice.toLocaleString());
    console.log('  PnL: ' + pnlStr + '円 | 信頼度: ' + t.confidence + ' | 板: ' + t.boardSignal);
    console.log('  日足: ' + dayOpen.toLocaleString() + '→' + dayClose.toLocaleString() + ' (' + (Number(dayChange) >= 0 ? '+' : '') + dayChange + '%) | レンジ: ' + dayLow.toLocaleString() + '〜' + dayHigh.toLocaleString());
    console.log('  Entry前の動き: 始値から' + (preMovePct >= 0 ? '+' : '') + preMovePct.toFixed(2) + '% | Entry位置(日中): ' + entryPos + '%');
    console.log('  MFE: +' + mfe.toFixed(3) + '% (' + mfeTime + ') | MAE: -' + mae.toFixed(3) + '% (' + maeTime + ')');
    
    // Diagnosis
    if (t.pnl > 0) {
      console.log('  → 成功要因: MFE +' + mfe.toFixed(2) + '%でTP到達。日足' + (Number(dayChange) >= 0 ? '上昇' : '下落') + '日。');
    } else {
      if (mfe < 0.3) {
        console.log('  → 失敗要因: エントリー後ほぼ上昇せず(MFE +' + mfe.toFixed(2) + '%)。方向が完全に逆。');
      } else if (mfe >= 0.5 && mfe < 1.5) {
        console.log('  → 失敗要因: 方向は合っていた(MFE +' + mfe.toFixed(2) + '%)がTP 1.5%に届かず反転。');
      } else {
        console.log('  → 失敗要因: MFE +' + mfe.toFixed(2) + '%。MAE -' + mae.toFixed(2) + '%で先にSLに到達。');
      }
    }
  }
  
  // Summary: wins vs losses comparison
  console.log('\n\n' + '='.repeat(80));
  console.log('  勝ちトレード vs 負けトレード 比較');
  console.log('='.repeat(80));
  
  const wins = roundLongs.filter(t => t.pnl > 0);
  const losses = roundLongs.filter(t => t.pnl <= 0);
  
  // Collect stats for wins and losses
  const winStats = { buyPressure: 0, sellPressure: 0, neutral: 0, strong: 0, medium: 0, avgPreMove: 0 };
  const lossStats = { buyPressure: 0, sellPressure: 0, neutral: 0, strong: 0, medium: 0, avgPreMove: 0 };
  
  for (const t of wins) {
    if (t.boardSignal === 'buy_pressure') winStats.buyPressure++;
    else if (t.boardSignal === 'sell_pressure') winStats.sellPressure++;
    else winStats.neutral++;
    if (t.confidence === '強') winStats.strong++;
    else winStats.medium++;
  }
  
  for (const t of losses) {
    if (t.boardSignal === 'buy_pressure') lossStats.buyPressure++;
    else if (t.boardSignal === 'sell_pressure') lossStats.sellPressure++;
    else lossStats.neutral++;
    if (t.confidence === '強') lossStats.strong++;
    else lossStats.medium++;
  }
  
  console.log('\n  板シグナル:');
  console.log('    勝ち(' + wins.length + '件): buy_pressure=' + winStats.buyPressure + ', sell_pressure=' + winStats.sellPressure + ', neutral=' + winStats.neutral);
  console.log('    負け(' + losses.length + '件): buy_pressure=' + lossStats.buyPressure + ', sell_pressure=' + lossStats.sellPressure + ', neutral=' + lossStats.neutral);
  
  console.log('\n  信頼度:');
  console.log('    勝ち(' + wins.length + '件): 強=' + winStats.strong + ', 中=' + winStats.medium);
  console.log('    負け(' + losses.length + '件): 強=' + lossStats.strong + ', 中=' + lossStats.medium);
  
  // Time of day analysis
  console.log('\n  エントリー時間帯:');
  const winTimes = wins.map(t => parseInt(t.entryTime.split(':')[0]));
  const lossTimes = losses.map(t => parseInt(t.entryTime.split(':')[0]));
  console.log('    勝ち: ' + winTimes.join('時, ') + '時');
  console.log('    負け: ' + lossTimes.join('時, ') + '時');
  
  // Symbol breakdown
  console.log('\n  銘柄別:');
  const bySymbol = new Map<string, { wins: number, losses: number, pnl: number }>();
  for (const t of roundLongs) {
    const s = bySymbol.get(t.symbol) || { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl > 0) s.wins++;
    else s.losses++;
    s.pnl += t.pnl;
    bySymbol.set(t.symbol, s);
  }
  
  for (const [sym, stats] of [...bySymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    const name = roundLongs.find(t => t.symbol === sym)?.name || sym;
    console.log('    ' + name + '(' + sym + '): ' + stats.wins + '勝' + stats.losses + '敗 PnL:' + (stats.pnl >= 0 ? '+' : '') + stats.pnl.toLocaleString() + '円');
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
