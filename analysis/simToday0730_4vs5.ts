/**
 * 7/30 本日のエントリー・決済比較: CONFIRM_BARS=5(現行) vs CONFIRM_BARS=4(新)
 * 
 * 実際のrt_tradesテーブルから本日のトレードを取得し、
 * 4本確認だった場合にエントリータイミングがどう変わるかをシミュレーション
 */
import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // 本日のrt_tradesを取得（エントリーと決済の両方）
  const trades = await db.execute(sql`
    SELECT id, symbol, side, action, price, shares, pnl, reason, 
           tradeTime as candle_time, tradeDate as trade_date, boardSignal as board_signal
    FROM rt_trades 
    WHERE tradeDate = '2026-07-30'
    ORDER BY tradeTime ASC, id ASC
  `);
  
  console.log("=== 7/30 本日の全トレード（現行 CONFIRM_BARS=5） ===\n");
  console.log(`トレード数: ${(trades as any[]).length}件\n`);
  
  // エントリーと決済をペアリング
  const entries: any[] = [];
  const exits: any[] = [];
  
  for (const t of trades as any[]) {
    if (t.action === 'buy' || t.action === 'short') {
      entries.push(t);
    } else {
      exits.push(t);
    }
  }
  
  console.log("--- エントリー一覧 ---");
  for (const e of entries) {
    console.log(`  ${e.candle_time} | ${e.symbol} | ${e.action.toUpperCase()} | ¥${e.price} | ${e.shares}株 | ${e.reason}`);
  }
  
  console.log("\n--- 決済一覧 ---");
  for (const x of exits) {
    const pnlStr = x.pnl >= 0 ? `+${x.pnl}` : `${x.pnl}`;
    console.log(`  ${x.candle_time} | ${x.symbol} | ${x.action} | ¥${x.price} | ${pnlStr}円 | ${x.reason}`);
  }
  
  // 大台確認エントリーのみ抽出（reason に「大台確認」を含む）
  const roundEntries = entries.filter((e: any) => e.reason && e.reason.includes('大台確認'));
  const nonRoundEntries = entries.filter((e: any) => !e.reason || !e.reason.includes('大台確認'));
  
  console.log(`\n\n=== 大台確認エントリー: ${roundEntries.length}件 ===`);
  console.log(`（これらが CONFIRM_BARS 変更の影響を受ける）\n`);
  
  if (roundEntries.length === 0) {
    console.log("大台確認エントリーなし — 他のシグナルのみ");
  }
  
  for (const e of roundEntries) {
    // 対応する決済を探す
    const exit = exits.find((x: any) => x.symbol === e.symbol && x.candle_time >= e.candle_time);
    const pnlStr = exit ? (exit.pnl >= 0 ? `+${exit.pnl}` : `${exit.pnl}`) : '未決済';
    console.log(`  ${e.candle_time} | ${e.symbol} | ${e.action.toUpperCase()} | ¥${e.price} | ${e.reason}`);
    if (exit) {
      console.log(`    → 決済: ${exit.candle_time} | ${exit.action} | ¥${exit.price} | ${pnlStr}円 | ${exit.reason}`);
    }
  }
  
  console.log(`\n=== 大台確認以外のエントリー: ${nonRoundEntries.length}件 ===`);
  console.log(`（これらは CONFIRM_BARS 変更の影響を受けない）\n`);
  
  for (const e of nonRoundEntries) {
    const exit = exits.find((x: any) => x.symbol === e.symbol && x.candle_time >= e.candle_time);
    const pnlStr = exit ? (exit.pnl >= 0 ? `+${exit.pnl}` : `${exit.pnl}`) : '未決済';
    console.log(`  ${e.candle_time} | ${e.symbol} | ${e.action.toUpperCase()} | ¥${e.price} | ${e.reason}`);
    if (exit) {
      console.log(`    → 決済: ${exit.candle_time} | ${exit.action} | ¥${exit.price} | ${pnlStr}円 | ${exit.reason}`);
    }
  }
  
  // 4本確認の場合のシミュレーション
  // 大台確認エントリーは1分早くなる（5本→4本 = 1分短縮）
  // 1分前の価格でエントリーした場合の損益を計算
  console.log("\n\n=== CONFIRM_BARS=4 の場合の変化予測 ===\n");
  
  if (roundEntries.length > 0) {
    console.log("大台確認エントリーは確認完了が1分早くなるため:");
    console.log("- エントリー時刻が約1分前倒し");
    console.log("- エントリー価格が1分前の水準（通常はやや低い）");
    console.log("- 損切りラインまでの余裕が増える可能性\n");
    
    // 各大台確認エントリーについて、1分前のローソク足を取得
    for (const e of roundEntries) {
      const candles = await db.execute(sql`
        SELECT candleTime as candle_time, open, high, low, close, volume
        FROM rt_candles_1min
        WHERE symbol = ${e.symbol} AND tradeDate = '2026-07-30'
        AND candleTime <= ${e.candle_time}
        ORDER BY candleTime DESC
        LIMIT 5
      `);
      
      const candleArr = candles[0] as any[];
      if (candleArr.length >= 2) {
        const entryCandle = candleArr[0]; // エントリー時の足
        const prevCandle = candleArr[1];  // 1分前の足
        
        const newEntryPrice = prevCandle.close; // 4本確認なら1分前のclose付近でエントリー
        const priceDiff = e.price - newEntryPrice;
        const priceDiffPct = (priceDiff / e.price * 100).toFixed(3);
        
        // 対応する決済を探す
        const exit = exits.find((x: any) => x.symbol === e.symbol && x.candle_time >= e.candle_time);
        
        console.log(`  ${e.symbol} (${e.action.toUpperCase()}):`);
        console.log(`    現行(5本): エントリー ${e.candle_time} @ ¥${e.price}`);
        console.log(`    新(4本):   エントリー ~${prevCandle.candle_time} @ ¥${newEntryPrice} (${priceDiff > 0 ? '-' : '+'}${Math.abs(priceDiff)}円, ${priceDiffPct}%有利)`);
        
        if (exit) {
          const currentPnl = exit.pnl;
          // 新しいPnLを計算
          let newPnl: number;
          if (e.action === 'buy') {
            newPnl = (exit.price - newEntryPrice) * e.shares;
          } else { // short
            newPnl = (newEntryPrice - exit.price) * e.shares;
          }
          const pnlChange = newPnl - currentPnl;
          console.log(`    現行PnL: ${currentPnl >= 0 ? '+' : ''}${currentPnl}円`);
          console.log(`    新PnL:   ${newPnl >= 0 ? '+' : ''}${Math.round(newPnl)}円 (${pnlChange >= 0 ? '+' : ''}${Math.round(pnlChange)}円)`);
          
          // 損切りラインの確認
          const slPct = 0.5 / 100;
          const currentSL = e.action === 'buy' ? e.price * (1 - slPct) : e.price * (1 + slPct);
          const newSL = e.action === 'buy' ? newEntryPrice * (1 - slPct) : newEntryPrice * (1 + slPct);
          console.log(`    損切りライン: 現行 ¥${Math.round(currentSL)} → 新 ¥${Math.round(newSL)}`);
          
          // 損切りに引っかかったか確認
          if (exit.reason && exit.reason.includes('損切り')) {
            // 新しいエントリー価格で損切りを回避できたか
            const postCandles = await db.execute(sql`
              SELECT candleTime as candle_time, low, high
              FROM rt_candles_1min
              WHERE symbol = ${e.symbol} AND tradeDate = '2026-07-30'
              AND candleTime > ${prevCandle.candle_time} AND candleTime <= ${exit.candle_time}
              ORDER BY candleTime ASC
            `);
            
            const postArr = postCandles[0] as any[];
            let wouldHitNewSL = false;
            let newSLHitTime = '';
            for (const c of postArr) {
              if (e.action === 'buy' && c.low <= newSL) {
                wouldHitNewSL = true;
                newSLHitTime = c.candle_time;
                break;
              }
              if (e.action === 'short' && c.high >= newSL) {
                wouldHitNewSL = true;
                newSLHitTime = c.candle_time;
                break;
              }
            }
            
            if (wouldHitNewSL) {
              console.log(`    → 新SLでも損切り発動（${newSLHitTime}）`);
            } else {
              console.log(`    → ★新SLなら損切り回避の可能性あり！`);
            }
          }
        }
        console.log("");
      }
    }
  }
  
  // 総合サマリー
  console.log("\n=== 総合サマリー ===\n");
  
  let totalCurrentPnl = 0;
  let totalNewPnl = 0;
  
  for (const x of exits) {
    totalCurrentPnl += x.pnl || 0;
  }
  
  console.log(`現行(5本確認) 総損益: ${totalCurrentPnl >= 0 ? '+' : ''}${totalCurrentPnl}円`);
  console.log(`（4本確認の正確な総損益は上記個別分析を参照）`);
  
  process.exit(0);
}

main().catch(console.error);
