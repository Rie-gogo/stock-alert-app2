/**
 * SHORT成績の悪いシグナルを分析し、逆張りLONGの候補を探す
 * 
 * 先ほどの「大台確認LONG × buy_pressure → 逆張りSHORT」の逆パターン:
 * 「大台確認SHORT × sell_pressure → 逆張りLONG」が有効か検証
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const EXCLUDED = new Set(['6920', '6758', '9984', '7011', '9107', '8306', '4568', '5016', '7203', '3778', '3436', '6723']);

const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};
const DEFAULT_SL = 0.5;
const TP_PCT = 1.5;

interface Pair {
  symbol: string;
  name: string;
  date: string;
  side: string;
  entryPrice: number;
  pnl: number;
  entryTime: string;
  signalType: string;
  exitReason: string;
  confidence: string;
  boardSignal: string;
  reason: string;
}

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
  
  // Pair entries with exits - SHORT only
  const pairs: Pair[] = [];
  const processed = new Set<number>();
  
  for (let i = 0; i < allTrades.length; i++) {
    if (processed.has(i)) continue;
    const t = allTrades[i];
    if (t.action !== 'short') continue;
    if (EXCLUDED.has(t.symbol)) continue;
    
    for (let j = i + 1; j < allTrades.length; j++) {
      if (processed.has(j)) continue;
      const e = allTrades[j];
      if (e.symbol === t.symbol && e.tradeDate === t.tradeDate && 
          e.action === 'cover' && e.pnl !== null) {
        
        const reason = t.reason || '';
        let signalType = 'その他';
        if (reason.includes('大台確認')) signalType = '大台確認(4本維持)';
        else if (reason.includes('デッドクロス')) signalType = 'デッドクロス';
        else if (reason.includes('ゴールデンクロス')) signalType = 'ゴールデンクロス';
        else if (reason.includes('VWAPクロス')) signalType = 'VWAPクロス';
        else if (reason.includes('三尊') || reason.includes('H&S')) signalType = '三尊/逆三尊';
        else if (reason.includes('ダウ理論') || reason.includes('高値更新') || reason.includes('安値更新')) signalType = 'ダウ理論';
        
        let confidence = '不明';
        if (reason.includes('信頼度：強')) confidence = '強';
        else if (reason.includes('信頼度：中')) confidence = '中';
        else if (reason.includes('信頼度：弱')) confidence = '弱';
        
        pairs.push({
          symbol: t.symbol, name: t.symbolName || t.symbol,
          date: t.tradeDate, side: 'short',
          entryPrice: Number(t.price), pnl: Number(e.pnl),
          entryTime: t.tradeTime, signalType,
          exitReason: e.reason || '', confidence,
          boardSignal: t.boardSignal || '', reason,
        });
        processed.add(j);
        break;
      }
    }
  }
  
  console.log('='.repeat(80));
  console.log('  SHORT取引の詳細分析 — 逆張りLONG候補の探索');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1]);
  console.log('  SHORT取引数: ' + pairs.length + '件');
  console.log('='.repeat(80));
  
  // Overall SHORT stats
  const totalWins = pairs.filter(p => p.pnl > 0).length;
  const totalPnl = pairs.reduce((s, p) => s + p.pnl, 0);
  console.log('\n  【SHORT全体】');
  console.log('  件数: ' + pairs.length + ' | 勝率: ' + (totalWins / pairs.length * 100).toFixed(1) + '% | 総PnL: ' + totalPnl.toLocaleString() + '円');
  
  // By signal type × board signal combination
  console.log('\n  ─── シグナル × 板シグナル 組み合わせ別 ───');
  console.log('  シグナル            | 板         | 件数 | 勝率   | 総PnL        | 平均PnL     | 全敗？');
  console.log('  ' + '─'.repeat(95));
  
  const combos = new Map<string, Pair[]>();
  for (const p of pairs) {
    const key = p.signalType + ' × ' + (p.boardSignal || 'unknown');
    const arr = combos.get(key) || [];
    arr.push(p);
    combos.set(key, arr);
  }
  
  // Sort by PnL ascending (worst first)
  const sortedCombos = [...combos.entries()].sort((a, b) => {
    return a[1].reduce((s, t) => s + t.pnl, 0) - b[1].reduce((s, t) => s + t.pnl, 0);
  });
  
  for (const [key, trades] of sortedCombos) {
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = Math.round(pnl / trades.length);
    const allLoss = wins === 0 ? '★全敗' : '';
    const [sig, board] = key.split(' × ');
    console.log('  ' + sig.padEnd(18) + ' | ' + board.padEnd(14) + ' | ' + String(trades.length).padStart(4) + ' | ' + (wins / trades.length * 100).toFixed(1).padStart(5) + '% | ' + pnl.toLocaleString().padStart(12) + '円 | ' + avgPnl.toLocaleString().padStart(10) + '円 | ' + allLoss);
  }
  
  // Find the worst performing combination with enough samples
  console.log('\n\n  ─── 逆張りLONG候補（SHORT勝率30%以下 & 3件以上）───');
  console.log('  ' + '─'.repeat(95));
  
  const candidates: { key: string; trades: Pair[] }[] = [];
  for (const [key, trades] of sortedCombos) {
    const wins = trades.filter(t => t.pnl > 0).length;
    const winRate = wins / trades.length;
    if (winRate <= 0.30 && trades.length >= 3) {
      candidates.push({ key, trades });
    }
  }
  
  for (const { key, trades } of candidates) {
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    console.log('\n  【' + key + '】 ' + trades.length + '件 | 勝率: ' + (wins / trades.length * 100).toFixed(1) + '% | 総PnL: ' + pnl.toLocaleString() + '円');
    console.log('  詳細:');
    for (const t of trades) {
      const pnlStr = t.pnl >= 0 ? '+' + t.pnl.toLocaleString() : t.pnl.toLocaleString();
      console.log('    ' + t.date + ' ' + t.entryTime + ' ' + t.name + '(' + t.symbol + ') @ ' + t.entryPrice.toLocaleString() + ' → ' + pnlStr + '円 [' + t.confidence + ']');
    }
  }
  
  // Now simulate reverse LONG for the best candidate
  console.log('\n\n' + '='.repeat(80));
  console.log('  逆張りLONGシミュレーション');
  console.log('='.repeat(80));
  
  // For each candidate, simulate LONG entry
  for (const { key, trades } of candidates) {
    if (trades.length < 3) continue;
    
    let totalOriginalPnl = 0;
    let totalReversePnl = 0;
    let reverseWins = 0;
    
    console.log('\n  【' + key + '】 → 逆張りLONG');
    console.log('  # | 日付       | 時刻  | 銘柄         | Entry    | 元SHORT PnL | 逆LONG PnL  | 決済理由      | MFE     | MAE');
    console.log('  ' + '─'.repeat(120));
    
    for (let idx = 0; idx < trades.length; idx++) {
      const t = trades[idx];
      const slPct = SYMBOL_SL_MAP[t.symbol] ?? DEFAULT_SL;
      const shares = Math.floor(2000000 / t.entryPrice);
      
      // Get candles after entry
      const candlesRes = await db.execute(sql.raw(
        `SELECT candleTime, open, high, low, close FROM rt_candles 
         WHERE tradeDate = '${t.date}' AND symbol = '${t.symbol}' 
         AND candleTime > '${t.entryTime}'
         ORDER BY candleTime`
      ));
      const candles = (candlesRes as any)[0] || [];
      
      // Simulate LONG from entry price
      let exitPrice = 0;
      let exitTime = '';
      let exitReason = '';
      let mfe = 0; // max favorable (price going up)
      let mae = 0; // max adverse (price going down)
      
      const slPrice = t.entryPrice * (1 - slPct / 100);
      const tpPrice = t.entryPrice * (1 + TP_PCT / 100);
      
      for (const c of candles) {
        const high = Number(c.high);
        const low = Number(c.low);
        
        // Track MFE/MAE for LONG
        const favorable = (high - t.entryPrice) / t.entryPrice * 100;
        const adverse = (t.entryPrice - low) / t.entryPrice * 100;
        if (favorable > mfe) mfe = favorable;
        if (adverse > mae) mae = adverse;
        
        // Check SL (price goes down)
        if (low <= slPrice) {
          exitPrice = slPrice;
          exitTime = c.candleTime;
          exitReason = '損切り(SL:' + slPct + '%)';
          break;
        }
        
        // Check TP (price goes up)
        if (high >= tpPrice) {
          exitPrice = tpPrice;
          exitTime = c.candleTime;
          exitReason = '利確(TP:1.5%)';
          break;
        }
      }
      
      // EOD if no exit
      if (!exitTime && candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        exitPrice = Number(lastCandle.close);
        exitTime = lastCandle.candleTime;
        exitReason = '大引け強制決済';
      }
      
      const reversePnl = exitPrice > 0 ? Math.round((exitPrice - t.entryPrice) * shares) : 0;
      
      totalOriginalPnl += t.pnl;
      totalReversePnl += reversePnl;
      if (reversePnl > 0) reverseWins++;
      
      const origStr = t.pnl >= 0 ? '+' + t.pnl.toLocaleString() : t.pnl.toLocaleString();
      const revStr = reversePnl >= 0 ? '+' + reversePnl.toLocaleString() : reversePnl.toLocaleString();
      const result = reversePnl > 0 ? '○' : '×';
      
      console.log('  ' + result + String(idx + 1).padStart(2) + ' | ' + t.date + ' | ' + t.entryTime + ' | ' + t.name.padEnd(10) + ' | ' + t.entryPrice.toLocaleString().padStart(8) + ' | ' + origStr.padStart(11) + '円 | ' + revStr.padStart(11) + '円 | ' + exitReason.padEnd(14) + ' | +' + mfe.toFixed(2) + '% | +' + mae.toFixed(2) + '%');
    }
    
    console.log('  ' + '─'.repeat(120));
    console.log('  元のSHORT:   ' + trades.length + '件 | 勝率: ' + (trades.filter(t => t.pnl > 0).length / trades.length * 100).toFixed(1) + '% | 総PnL: ' + totalOriginalPnl.toLocaleString() + '円');
    console.log('  逆張りLONG:  ' + trades.length + '件 | 勝率: ' + (reverseWins / trades.length * 100).toFixed(1) + '% | 総PnL: ' + totalReversePnl.toLocaleString() + '円');
    console.log('  改善効果: ' + (totalReversePnl - totalOriginalPnl >= 0 ? '+' : '') + (totalReversePnl - totalOriginalPnl).toLocaleString() + '円');
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
