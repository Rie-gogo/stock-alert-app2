import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

/**
 * 現在のアルゴリズム設定で7/30・7/31をシミュレーション
 * 
 * 主な変更点（7/30当時 → 現在）:
 * 1. 大台確認バー: 5本 → 4本
 * 2. 銘柄別SL: 一律0.5% → 銘柄別（0.5-0.9%）
 * 3. medium信頼度: 大台シグナルはステートマシン経由で通過可能（変更なし）
 * 
 * 注: 大台シグナルはmediumでもステートマシン（確認バー→押し目待ち）を経由してエントリーするため
 *     「medium直接エントリー禁止」には該当しない
 */

const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.8,
  "6857": 0.6,
  "6976": 0.5,
  "6526": 0.9,
  "5803": 0.5,
  "6981": 0.9,
  "285A": 0.8,
  "6920": 0.9,
  "6758": 0.5,
  "8316": 0.5,
};

const DEFAULT_SL = 0.5;
const TP_PERCENT = 1.5;
const ROUND_LEVEL_CONFIRM_BARS = 4; // 現在は4本

interface Trade {
  date: string;
  time: string;
  symbol: string;
  name: string;
  side: 'long' | 'short';
  entryPrice: number;
  shares: number;
  slPercent: number;
  exitPrice?: number;
  pnl?: number;
  exitReason?: string;
  exitTime?: string;
}

async function main() {
  const db = await getDb();
  
  for (const date of ['2026-07-30', '2026-07-31']) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${date} シミュレーション（現在の設定）`);
    console.log(`${'='.repeat(60)}`);
    
    // Get all candles for this date
    const candlesRes = await db.execute(sql.raw(
      `SELECT symbol, candleTime, open, high, low, close, volume FROM rt_candles WHERE tradeDate = '${date}' ORDER BY candleTime, symbol`
    ));
    const allCandles = (candlesRes as any)[0] || [];
    
    // Get original trades for comparison
    const origTradesRes = await db.execute(sql.raw(
      `SELECT * FROM rt_trades WHERE tradeDate = '${date}' ORDER BY tradeTime`
    ));
    const origTrades = (origTradesRes as any)[0] || [];
    
    console.log(`\n受信足数: ${allCandles.length}`);
    console.log(`\n--- 元の取引結果 ---`);
    
    const origEntries = origTrades.filter((t: any) => t.action === 'buy' || t.action === 'short');
    for (const t of origTrades) {
      if (t.pnl !== null) {
        console.log(`  ${t.tradeTime} ${t.symbol} ${t.symbolName} | ${t.action} @${t.price} x${t.shares} | PnL=${Number(t.pnl).toLocaleString()}円 | ${t.reason.substring(0, 40)}`);
      }
    }
    const origTotal = origTrades.filter((t: any) => t.pnl !== null).reduce((s: number, t: any) => s + Number(t.pnl), 0);
    console.log(`  合計: ${origTotal.toLocaleString()}円`);
    
    // Now simulate with current settings
    // For each original entry, recalculate SL/TP with new settings
    console.log(`\n--- 現在の設定でのシミュレーション ---`);
    
    let newTotal = 0;
    const simResults: any[] = [];
    
    for (let i = 0; i < origTrades.length; i++) {
      const t = origTrades[i];
      if (t.action !== 'buy' && t.action !== 'short') continue;
      
      const symbol = t.symbol;
      const entryPrice = Number(t.price);
      const shares = Number(t.shares);
      const side = t.side as 'long' | 'short';
      const entryTime = t.tradeTime;
      const slPct = SYMBOL_SL_MAP[symbol] ?? DEFAULT_SL;
      
      // Calculate new SL and TP lines
      let slLine: number, tpLine: number;
      if (side === 'long') {
        slLine = entryPrice * (1 - slPct / 100);
        tpLine = entryPrice * (1 + TP_PERCENT / 100);
      } else {
        slLine = entryPrice * (1 + slPct / 100);
        tpLine = entryPrice * (1 - TP_PERCENT / 100);
      }
      
      // Find candles after entry to determine exit
      const postEntryCandles = allCandles.filter((c: any) => 
        c.symbol === symbol && c.candleTime > entryTime
      );
      
      let exitPrice: number | null = null;
      let exitReason = '';
      let exitTime = '';
      
      for (const c of postEntryCandles) {
        if (side === 'long') {
          // Check SL first (low hits SL)
          if (Number(c.low) <= slLine) {
            exitPrice = slLine;
            exitReason = `損切り (SL:${slPct}% → ${slLine.toFixed(0)}円)`;
            exitTime = c.candleTime;
            break;
          }
          // Check TP (high hits TP)
          if (Number(c.high) >= tpLine) {
            exitPrice = tpLine;
            exitReason = `利確 (TP:${TP_PERCENT}% → ${tpLine.toFixed(0)}円)`;
            exitTime = c.candleTime;
            break;
          }
        } else {
          // Short: SL is above entry
          if (Number(c.high) >= slLine) {
            exitPrice = slLine;
            exitReason = `損切り (SL:${slPct}% → ${slLine.toFixed(0)}円)`;
            exitTime = c.candleTime;
            break;
          }
          // Short: TP is below entry
          if (Number(c.low) <= tpLine) {
            exitPrice = tpLine;
            exitReason = `利確 (TP:${TP_PERCENT}% → ${tpLine.toFixed(0)}円)`;
            exitTime = c.candleTime;
            break;
          }
        }
        // Check forced close at 15:25
        if (c.candleTime >= '15:25') {
          exitPrice = Number(c.close);
          exitReason = `大引け強制決済 @${c.candleTime}`;
          exitTime = c.candleTime;
          break;
        }
      }
      
      if (exitPrice === null) {
        // Use last candle close
        const lastCandle = allCandles.filter((c: any) => c.symbol === symbol).pop();
        if (lastCandle) {
          exitPrice = Number(lastCandle.close);
          exitReason = '大引け強制決済(最終足)';
          exitTime = lastCandle.candleTime;
        } else {
          exitPrice = entryPrice;
          exitReason = 'データなし';
          exitTime = '15:30';
        }
      }
      
      let pnl: number;
      if (side === 'long') {
        pnl = Math.round((exitPrice - entryPrice) * shares);
      } else {
        pnl = Math.round((entryPrice - exitPrice) * shares);
      }
      
      // Find original PnL for comparison
      const origExit = origTrades.find((ot: any) => 
        ot.symbol === symbol && 
        (ot.action === 'sell' || ot.action === 'cover') &&
        ot.tradeTime >= entryTime &&
        origTrades.indexOf(ot) > i
      );
      const origPnl = origExit ? Number(origExit.pnl) : null;
      const origSlPct = 0.5; // 当時は一律0.5%
      
      const diff = origPnl !== null ? pnl - origPnl : 0;
      
      simResults.push({
        entryTime, symbol, name: t.symbolName, side, entryPrice, shares,
        oldSl: origSlPct, newSl: slPct,
        exitTime, exitPrice, exitReason, pnl,
        origPnl, diff
      });
      
      newTotal += pnl;
      
      console.log(`  ${entryTime} ${symbol} ${t.symbolName} | ${side} @${entryPrice.toLocaleString()} x${shares}`);
      console.log(`    旧SL:${origSlPct}% → 新SL:${slPct}% | 決済:${exitTime} @${exitPrice.toFixed(0)} | ${exitReason}`);
      console.log(`    新PnL: ${pnl.toLocaleString()}円 | 旧PnL: ${origPnl !== null ? origPnl.toLocaleString() : '?'}円 | 差分: ${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円`);
    }
    
    console.log(`\n--- ${date} サマリー ---`);
    console.log(`  旧設定合計: ${origTotal.toLocaleString()}円`);
    console.log(`  新設定合計: ${newTotal.toLocaleString()}円`);
    console.log(`  差分: ${(newTotal - origTotal) >= 0 ? '+' : ''}${(newTotal - origTotal).toLocaleString()}円`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
