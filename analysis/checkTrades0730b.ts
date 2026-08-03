import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const [rows] = await db.execute(sql`
    SELECT id, symbol, action, price, shares, pnl, reason, tradeTime, side
    FROM rt_trades 
    WHERE tradeDate = '2026-07-30'
    ORDER BY tradeTime ASC, id ASC
  `);
  
  console.log("=== 7/30 全トレード（12件） ===\n");
  
  const entries: any[] = [];
  const exits: any[] = [];
  
  for (const r of rows as any[]) {
    const t = { ...r, price: parseFloat(r.price) };
    if (t.action === 'buy' || t.action === 'short') {
      entries.push(t);
    } else {
      exits.push(t);
    }
  }
  
  console.log("--- エントリー ---");
  for (const e of entries) {
    const isRound = e.reason.includes('大台確認');
    console.log(`  ${e.tradeTime} | ${e.symbol} | ${e.action.toUpperCase()} | ¥${e.price} | ${e.shares}株 | ${isRound ? '★大台' : '他'} | ${e.reason.substring(0, 80)}`);
  }
  
  console.log("\n--- 決済 ---");
  for (const x of exits) {
    const pnlStr = x.pnl !== null ? (x.pnl >= 0 ? `+${x.pnl}` : `${x.pnl}`) : 'N/A';
    console.log(`  ${x.tradeTime} | ${x.symbol} | ${x.action} | ¥${parseFloat(x.price)} | ${pnlStr}円 | ${x.reason.substring(0, 60)}`);
  }
  
  // 大台確認エントリーを特定
  const roundEntries = entries.filter((e: any) => e.reason.includes('大台確認'));
  console.log(`\n\n=== 大台確認エントリー: ${roundEntries.length}件 ===`);
  
  for (const e of roundEntries) {
    // 対応する決済
    const exit = exits.find((x: any) => x.symbol === e.symbol && x.tradeTime >= e.tradeTime);
    console.log(`\n  ${e.tradeTime} ${e.symbol} ${e.action.toUpperCase()} @ ¥${e.price}`);
    console.log(`  理由: ${e.reason}`);
    if (exit) {
      const pnlStr = exit.pnl !== null ? (exit.pnl >= 0 ? `+${exit.pnl}` : `${exit.pnl}`) : 'N/A';
      console.log(`  決済: ${exit.tradeTime} @ ¥${parseFloat(exit.price)} | ${pnlStr}円 | ${exit.reason.substring(0, 60)}`);
    }
    
    // 1分前のローソク足を取得
    const [candles] = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume
      FROM rt_candles_1min
      WHERE symbol = ${e.symbol} AND tradeDate = '2026-07-30'
      AND candleTime <= ${e.tradeTime}
      ORDER BY candleTime DESC
      LIMIT 6
    `);
    
    const cArr = candles as any[];
    if (cArr.length >= 2) {
      console.log(`  直近足:`);
      for (let i = Math.min(4, cArr.length - 1); i >= 0; i--) {
        const c = cArr[i];
        const marker = i === 0 ? ' ← エントリー足' : '';
        console.log(`    ${c.candleTime} O:${parseFloat(c.open)} H:${parseFloat(c.high)} L:${parseFloat(c.low)} C:${parseFloat(c.close)} V:${c.volume}${marker}`);
      }
      
      // 4本確認の場合: 1分前のclose付近でエントリー
      const prevCandle = cArr[1];
      const newEntryPrice = parseFloat(prevCandle.close);
      const priceDiff = e.price - newEntryPrice;
      console.log(`\n  ★4本確認の場合:`);
      console.log(`    エントリー: ~${prevCandle.candleTime} @ ¥${newEntryPrice} (現行比 ${priceDiff > 0 ? '-' : '+'}${Math.abs(Math.round(priceDiff))}円)`);
      
      if (exit) {
        const exitPrice = parseFloat(exit.price);
        let currentPnl = exit.pnl || 0;
        let newPnl: number;
        if (e.action === 'buy') {
          newPnl = Math.round((exitPrice - newEntryPrice) * e.shares);
        } else {
          newPnl = Math.round((newEntryPrice - exitPrice) * e.shares);
        }
        console.log(`    現行PnL: ${currentPnl >= 0 ? '+' : ''}${currentPnl}円`);
        console.log(`    新PnL:   ${newPnl >= 0 ? '+' : ''}${newPnl}円 (差: ${newPnl - currentPnl >= 0 ? '+' : ''}${newPnl - currentPnl}円)`);
        
        // 損切りライン比較
        const slPct = 0.5 / 100;
        if (e.action === 'buy') {
          const currentSL = e.price * (1 - slPct);
          const newSL = newEntryPrice * (1 - slPct);
          console.log(`    損切りライン: 現行 ¥${Math.round(currentSL)} → 新 ¥${Math.round(newSL)}`);
        } else {
          const currentSL = e.price * (1 + slPct);
          const newSL = newEntryPrice * (1 + slPct);
          console.log(`    損切りライン: 現行 ¥${Math.round(currentSL)} → 新 ¥${Math.round(newSL)}`);
        }
      }
    }
  }
  
  // 総合
  console.log("\n\n=== 総合損益 ===");
  let totalPnl = 0;
  for (const x of exits) {
    if (x.pnl !== null) totalPnl += x.pnl;
  }
  console.log(`現行(5本確認) 総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl}円`);
  
  process.exit(0);
}
main().catch(console.error);
