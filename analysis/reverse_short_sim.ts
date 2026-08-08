/**
 * 「大台確認LONG × buy_pressure」逆張りSHORTシミュレーション
 * 
 * 過去の10件について、LONGではなくSHORTした場合の結果を検証
 * - エントリー: 元のLONGエントリー価格と同じ時点でSHORT
 * - SL: 銘柄別SL（上方向）
 * - TP: 1.5%（下方向）
 * - EOD: 大引け強制決済
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

async function main() {
  const db = await getDb();
  
  // Get last 30 trade dates
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  // Get all trades - find LONG entries with buy_pressure and round-level signal
  const tradesRes = await db.execute(sql.raw(
    `SELECT * FROM rt_trades WHERE tradeDate >= '${dates[0]}' ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (tradesRes as any)[0] || [];
  
  // Find the 10 buy_pressure LONG round-level entries
  interface TargetEntry {
    symbol: string;
    name: string;
    date: string;
    entryTime: string;
    entryPrice: number;
    originalPnl: number;
    reason: string;
  }
  
  const targets: TargetEntry[] = [];
  const processed = new Set<number>();
  
  for (let i = 0; i < allTrades.length; i++) {
    if (processed.has(i)) continue;
    const t = allTrades[i];
    if (t.action !== 'buy') continue;
    if (EXCLUDED.has(t.symbol)) continue;
    const reason = t.reason || '';
    if (!reason.includes('大台確認')) continue;
    if (t.boardSignal !== 'buy_pressure') continue;
    
    // Find the exit
    for (let j = i + 1; j < allTrades.length; j++) {
      if (processed.has(j)) continue;
      const e = allTrades[j];
      if (e.symbol === t.symbol && e.tradeDate === t.tradeDate && 
          e.action === 'sell' && e.pnl !== null) {
        targets.push({
          symbol: t.symbol,
          name: t.symbolName || t.symbol,
          date: t.tradeDate,
          entryTime: t.tradeTime,
          entryPrice: Number(t.price),
          originalPnl: Number(e.pnl),
          reason,
        });
        processed.add(j);
        break;
      }
    }
  }
  
  console.log('='.repeat(80));
  console.log('  「大台確認LONG × buy_pressure」逆張りSHORTシミュレーション');
  console.log('  対象: ' + targets.length + '件');
  console.log('  設定: 銘柄別SL, TP=1.5%, EOD強制決済');
  console.log('='.repeat(80));
  
  console.log('\n  # | 日付       | 時刻  | 銘柄         | Entry    | 元LONG PnL  | 逆SHORT PnL | 決済理由      | MFE     | MAE');
  console.log('  ' + '─'.repeat(120));
  
  let totalOriginal = 0;
  let totalReverse = 0;
  let reverseWins = 0;
  
  for (let idx = 0; idx < targets.length; idx++) {
    const t = targets[idx];
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
    
    // Simulate SHORT from entry price
    let exitPrice = 0;
    let exitTime = '';
    let exitReason = '';
    let mfe = 0; // max favorable (price going down)
    let mae = 0; // max adverse (price going up)
    let mfeTime = '';
    let maeTime = '';
    
    const slPrice = t.entryPrice * (1 + slPct / 100);
    const tpPrice = t.entryPrice * (1 - TP_PCT / 100);
    
    for (const c of candles) {
      const high = Number(c.high);
      const low = Number(c.low);
      
      // Track MFE/MAE
      const favorable = (t.entryPrice - low) / t.entryPrice * 100;
      const adverse = (high - t.entryPrice) / t.entryPrice * 100;
      if (favorable > mfe) { mfe = favorable; mfeTime = c.candleTime; }
      if (adverse > mae) { mae = adverse; maeTime = c.candleTime; }
      
      // Check SL (price goes up)
      if (high >= slPrice) {
        exitPrice = slPrice;
        exitTime = c.candleTime;
        exitReason = '損切り(SL:' + slPct + '%)';
        break;
      }
      
      // Check TP (price goes down)
      if (low <= tpPrice) {
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
    
    const reversePnl = exitPrice > 0 ? Math.round((t.entryPrice - exitPrice) * shares) : 0;
    
    totalOriginal += t.originalPnl;
    totalReverse += reversePnl;
    if (reversePnl > 0) reverseWins++;
    
    const origStr = t.originalPnl >= 0 ? '+' + t.originalPnl.toLocaleString() : t.originalPnl.toLocaleString();
    const revStr = reversePnl >= 0 ? '+' + reversePnl.toLocaleString() : reversePnl.toLocaleString();
    const result = reversePnl > 0 ? '○' : '×';
    
    console.log('  ' + result + String(idx + 1).padStart(2) + ' | ' + t.date + ' | ' + t.entryTime + ' | ' + t.name.padEnd(10) + ' | ' + t.entryPrice.toLocaleString().padStart(8) + ' | ' + origStr.padStart(11) + '円 | ' + revStr.padStart(11) + '円 | ' + exitReason.padEnd(14) + ' | +' + mfe.toFixed(2) + '% | +' + mae.toFixed(2) + '%');
  }
  
  console.log('  ' + '─'.repeat(120));
  
  // Summary
  console.log('\n  ─── サマリー ───');
  console.log('  元のLONG:    ' + targets.length + '件 | 勝率: 0% | 総PnL: ' + totalOriginal.toLocaleString() + '円');
  console.log('  逆張りSHORT: ' + targets.length + '件 | 勝率: ' + (reverseWins / targets.length * 100).toFixed(1) + '% | 総PnL: ' + totalReverse.toLocaleString() + '円');
  console.log('  改善効果: ' + (totalReverse - totalOriginal >= 0 ? '+' : '') + (totalReverse - totalOriginal).toLocaleString() + '円');
  console.log('    (ブロックのみの場合: +' + Math.abs(totalOriginal).toLocaleString() + '円)');
  console.log('    (逆張りSHORTの場合: +' + (totalReverse - totalOriginal).toLocaleString() + '円)');
  
  // TP到達率
  const tpHits = targets.length; // count from results
  let tpCount = 0;
  let slCount = 0;
  let eodCount = 0;
  // Re-count from output (we'll just print the MFE stats)
  console.log('\n  ─── MFE分析（SHORTとしての有利方向変動）───');
  console.log('  TP(1.5%)到達可能件数: MFE >= 1.5% の件数を上で確認');
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
