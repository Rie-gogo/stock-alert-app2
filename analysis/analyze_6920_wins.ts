import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

/**
 * レーザーテック（6920）勝ちトレード4件の共通点分析
 * 
 * 勝ちトレード:
 * ○ 2026-06-18 10:00→10:09 | LONG @55,580 x100 | +83,370円 | 利確 | board:neutral
 * ○ 2026-06-23 10:17→10:54 | SHORT @56,130 x100 | +84,195円 | 利確 | board:sell_pressure
 * ○ 2026-06-26 13:16→13:35 | SHORT @50,420 x100 | +75,630円 | 利確 | board:sell_pressure
 * ○ 2026-06-26 15:05→15:30 | SHORT @50,080 x100 | +8,000円 | 大引け | board:sell_pressure
 */

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

async function main() {
  const db = await getDb();
  const symbol = '6920';
  
  // Get all entry trades for 6920
  const tradesRes = await db.execute(sql.raw(
    `SELECT * FROM rt_trades WHERE symbol = '${symbol}' ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (tradesRes as any)[0] || [];
  
  // Identify winning entry-exit pairs
  interface TradePair {
    entry: any;
    exit: any;
    pnl: number;
  }
  
  const pairs: TradePair[] = [];
  for (let i = 0; i < allTrades.length; i++) {
    const t = allTrades[i];
    if (t.action !== 'buy' && t.action !== 'short') continue;
    const exit = allTrades.find((e: any, idx: number) => 
      idx > i && e.symbol === symbol && e.tradeDate === t.tradeDate &&
      (e.action === 'sell' || e.action === 'cover')
    );
    if (exit && exit.pnl !== null) {
      pairs.push({ entry: t, exit, pnl: Number(exit.pnl) });
    }
  }
  
  const wins = pairs.filter(p => p.pnl > 0);
  const losses = pairs.filter(p => p.pnl <= 0);
  
  console.log(`${'='.repeat(80)}`);
  console.log(`  レーザーテック（6920）勝ちトレード共通点分析`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  勝ち: ${wins.length}件 / 負け: ${losses.length}件`);
  
  // ========== 勝ちトレード詳細 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  勝ちトレード詳細`);
  console.log(`${'─'.repeat(80)}`);
  
  for (const w of wins) {
    const t = w.entry;
    const e = w.exit;
    const date = t.tradeDate;
    const holdMin = timeToMinutes(e.tradeTime) - timeToMinutes(t.tradeTime);
    
    // Get candles before entry (context)
    const preCandles = await db.execute(sql.raw(
      `SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '${symbol}' AND candleTime <= '${t.tradeTime}' ORDER BY candleTime`
    ));
    const preCandleRows = (preCandles as any)[0] || [];
    
    // Get candles after entry
    const postCandles = await db.execute(sql.raw(
      `SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '${symbol}' AND candleTime > '${t.tradeTime}' ORDER BY candleTime`
    ));
    const postCandleRows = (postCandles as any)[0] || [];
    
    // Day context
    const allDayCandles = await db.execute(sql.raw(
      `SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '${symbol}' ORDER BY candleTime`
    ));
    const dayCandles = (allDayCandles as any)[0] || [];
    
    const dayOpen = dayCandles.length > 0 ? Number(dayCandles[0].open) : 0;
    const dayClose = dayCandles.length > 0 ? Number(dayCandles[dayCandles.length - 1].close) : 0;
    const dayHigh = dayCandles.length > 0 ? Math.max(...dayCandles.map((c: any) => Number(c.high))) : 0;
    const dayLow = dayCandles.length > 0 ? Math.min(...dayCandles.map((c: any) => Number(c.low))) : 0;
    const dayRange = ((dayHigh - dayLow) / dayOpen * 100).toFixed(2);
    const dayChange = ((dayClose - dayOpen) / dayOpen * 100).toFixed(2);
    
    // Pre-entry trend (last 10 candles before entry)
    const last10 = preCandleRows.slice(-10);
    let preTrend = 'N/A';
    if (last10.length >= 5) {
      const firstClose = Number(last10[0].close);
      const lastClose = Number(last10[last10.length - 1].close);
      const trendPct = ((lastClose - firstClose) / firstClose * 100).toFixed(2);
      preTrend = `${Number(trendPct) > 0 ? '+' : ''}${trendPct}%`;
    }
    
    // Volume analysis (pre-entry)
    const avgVol = last10.length > 0 ? last10.reduce((s: number, c: any) => s + Number(c.volume), 0) / last10.length : 0;
    const entryCandle = preCandleRows[preCandleRows.length - 1];
    const entryVol = entryCandle ? Number(entryCandle.volume) : 0;
    const volRatio = avgVol > 0 ? (entryVol / avgVol).toFixed(2) : 'N/A';
    
    // Price position relative to day's range at entry
    const entryPrice = Number(t.price);
    const pricePosition = dayHigh > dayLow ? ((entryPrice - dayLow) / (dayHigh - dayLow) * 100).toFixed(0) : 'N/A';
    
    // Time since open
    const minSinceOpen = timeToMinutes(t.tradeTime) - timeToMinutes('09:00');
    
    // How quickly did it reach TP?
    let tpReachTime = 'N/A';
    const tpLine = t.side === 'long' ? entryPrice * 1.015 : entryPrice * 0.985;
    for (const c of postCandleRows) {
      if (t.side === 'long' && Number(c.high) >= tpLine) {
        tpReachTime = c.candleTime;
        break;
      }
      if (t.side === 'short' && Number(c.low) <= tpLine) {
        tpReachTime = c.candleTime;
        break;
      }
    }
    
    // Was there a prior failed trade on the same day?
    const priorTrades = pairs.filter(p => p.entry.tradeDate === date && 
      timeToMinutes(p.entry.tradeTime) < timeToMinutes(t.tradeTime));
    
    // Confidence level
    const confMatch = t.reason.match(/信頼度：(強|中|弱)/);
    const confidence = confMatch ? confMatch[1] : 'unknown';
    
    console.log(`\n  ○ ${date} ${t.tradeTime}→${e.tradeTime} | ${t.side.toUpperCase()} @${entryPrice.toLocaleString()} | +${w.pnl.toLocaleString()}円`);
    console.log(`    シグナル: ${t.reason.substring(0, 80)}`);
    console.log(`    信頼度: ${confidence}`);
    console.log(`    板シグナル: ${t.boardSignal}`);
    console.log(`    保有時間: ${holdMin}分`);
    console.log(`    ---`);
    console.log(`    日足: 始値=${dayOpen.toLocaleString()} 終値=${dayClose.toLocaleString()} (${dayChange}%) レンジ=${dayRange}%`);
    console.log(`    エントリー前10本トレンド: ${preTrend}`);
    console.log(`    出来高比率（エントリー足/直前10本平均）: ${volRatio}x`);
    console.log(`    日中レンジ内位置: ${pricePosition}%（0%=安値、100%=高値）`);
    console.log(`    寄りからの経過: ${minSinceOpen}分`);
    console.log(`    TP到達時刻: ${tpReachTime} (エントリーから${tpReachTime !== 'N/A' ? timeToMinutes(tpReachTime) - timeToMinutes(t.tradeTime) : '?'}分)`);
    console.log(`    同日先行トレード: ${priorTrades.length}件 (${priorTrades.map(p => p.pnl > 0 ? '勝' : '負').join(',')})`);
    console.log(`    決済理由: ${e.reason}`);
  }
  
  // ========== 勝ちと負けの比較 ==========
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  勝ち vs 負け 特徴比較`);
  console.log(`${'─'.repeat(80)}`);
  
  // Confidence comparison
  const winConf: Record<string, number> = {};
  const lossConf: Record<string, number> = {};
  for (const w of wins) {
    const m = w.entry.reason.match(/信頼度：(強|中|弱)/);
    const c = m ? m[1] : 'unknown';
    winConf[c] = (winConf[c] || 0) + 1;
  }
  for (const l of losses) {
    const m = l.entry.reason.match(/信頼度：(強|中|弱)/);
    const c = m ? m[1] : 'unknown';
    lossConf[c] = (lossConf[c] || 0) + 1;
  }
  console.log(`\n  信頼度分布:`);
  console.log(`    勝ち: ${JSON.stringify(winConf)}`);
  console.log(`    負け: ${JSON.stringify(lossConf)}`);
  
  // Board signal comparison
  const winBoard: Record<string, number> = {};
  const lossBoard: Record<string, number> = {};
  for (const w of wins) {
    const b = w.entry.boardSignal || 'unknown';
    winBoard[b] = (winBoard[b] || 0) + 1;
  }
  for (const l of losses) {
    const b = l.entry.boardSignal || 'unknown';
    lossBoard[b] = (lossBoard[b] || 0) + 1;
  }
  console.log(`\n  板シグナル分布:`);
  console.log(`    勝ち: ${JSON.stringify(winBoard)}`);
  console.log(`    負け: ${JSON.stringify(lossBoard)}`);
  
  // Side comparison
  const winSide: Record<string, number> = {};
  const lossSide: Record<string, number> = {};
  for (const w of wins) { winSide[w.entry.side] = (winSide[w.entry.side] || 0) + 1; }
  for (const l of losses) { lossSide[l.entry.side] = (lossSide[l.entry.side] || 0) + 1; }
  console.log(`\n  方向分布:`);
  console.log(`    勝ち: ${JSON.stringify(winSide)}`);
  console.log(`    負け: ${JSON.stringify(lossSide)}`);
  
  // Signal type comparison
  const winSig: Record<string, number> = {};
  const lossSig: Record<string, number> = {};
  for (const w of wins) {
    let sig = 'その他';
    if (w.entry.reason.includes('大台確認') || w.entry.reason.includes('大台超え') || w.entry.reason.includes('大台割れ')) sig = '大台確認';
    else if (w.entry.reason.includes('逆三尊')) sig = '逆三尊';
    else if (w.entry.reason.includes('VWAP')) sig = 'VWAP';
    else if (w.entry.reason.includes('ダウ理論')) sig = 'ダウ理論';
    else if (w.entry.reason.includes('三尊') || w.entry.reason.includes('H&S')) sig = '三尊天井';
    winSig[sig] = (winSig[sig] || 0) + 1;
  }
  for (const l of losses) {
    let sig = 'その他';
    if (l.entry.reason.includes('大台確認') || l.entry.reason.includes('大台超え') || l.entry.reason.includes('大台割れ')) sig = '大台確認';
    else if (l.entry.reason.includes('逆三尊')) sig = '逆三尊';
    else if (l.entry.reason.includes('VWAP')) sig = 'VWAP';
    else if (l.entry.reason.includes('ダウ理論')) sig = 'ダウ理論';
    else if (l.entry.reason.includes('三尊') || l.entry.reason.includes('H&S')) sig = '三尊天井';
    lossSig[sig] = (lossSig[sig] || 0) + 1;
  }
  console.log(`\n  シグナル種別分布:`);
  console.log(`    勝ち: ${JSON.stringify(winSig)}`);
  console.log(`    負け: ${JSON.stringify(lossSig)}`);
  
  // Time comparison
  console.log(`\n  エントリー時刻:`);
  console.log(`    勝ち: ${wins.map(w => w.entry.tradeTime).join(', ')}`);
  console.log(`    負け: ${losses.map(l => l.entry.tradeTime).join(', ')}`);
  
  // Hold time comparison
  const winHold = wins.map(w => timeToMinutes(w.exit.tradeTime) - timeToMinutes(w.entry.tradeTime));
  const lossHold = losses.map(l => timeToMinutes(l.exit.tradeTime) - timeToMinutes(l.entry.tradeTime));
  console.log(`\n  保有時間:`);
  console.log(`    勝ち平均: ${(winHold.reduce((s, h) => s + h, 0) / winHold.length).toFixed(0)}分 (${winHold.join(', ')}分)`);
  console.log(`    負け平均: ${(lossHold.reduce((s, h) => s + h, 0) / lossHold.length).toFixed(0)}分 (${lossHold.join(', ')}分)`);
  
  // Day trend analysis for wins vs losses
  console.log(`\n  日足トレンド（始値→終値）:`);
  for (const w of wins) {
    const dayCandles = await db.execute(sql.raw(
      `SELECT open, close FROM rt_candles WHERE tradeDate = '${w.entry.tradeDate}' AND symbol = '${symbol}' ORDER BY candleTime LIMIT 1`
    ));
    const lastCandle = await db.execute(sql.raw(
      `SELECT close FROM rt_candles WHERE tradeDate = '${w.entry.tradeDate}' AND symbol = '${symbol}' ORDER BY candleTime DESC LIMIT 1`
    ));
    const dc = (dayCandles as any)[0][0];
    const lc = (lastCandle as any)[0][0];
    if (dc && lc) {
      const change = ((Number(lc.close) - Number(dc.open)) / Number(dc.open) * 100).toFixed(2);
      console.log(`    勝ち ${w.entry.tradeDate}: ${w.entry.side} on ${Number(change) > 0 ? '上昇' : '下落'}日 (${change}%)`);
    }
  }
  for (const l of losses.slice(0, 5)) {
    const dayCandles = await db.execute(sql.raw(
      `SELECT open FROM rt_candles WHERE tradeDate = '${l.entry.tradeDate}' AND symbol = '${symbol}' ORDER BY candleTime LIMIT 1`
    ));
    const lastCandle = await db.execute(sql.raw(
      `SELECT close FROM rt_candles WHERE tradeDate = '${l.entry.tradeDate}' AND symbol = '${symbol}' ORDER BY candleTime DESC LIMIT 1`
    ));
    const dc = (dayCandles as any)[0][0];
    const lc = (lastCandle as any)[0][0];
    if (dc && lc) {
      const change = ((Number(lc.close) - Number(dc.open)) / Number(dc.open) * 100).toFixed(2);
      console.log(`    負け ${l.entry.tradeDate}: ${l.entry.side} on ${Number(change) > 0 ? '上昇' : '下落'}日 (${change}%)`);
    }
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
