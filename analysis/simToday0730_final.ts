import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // 本日のrt_tradesを取得
  const [rows] = await db.execute(sql`
    SELECT id, symbol, action, price, shares, pnl, reason, tradeTime, side
    FROM rt_trades 
    WHERE tradeDate = '2026-07-30'
    ORDER BY tradeTime ASC, id ASC
  `);
  
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
  
  console.log("=== 7/30 CONFIRM_BARS=5(実績) vs CONFIRM_BARS=4(シミュレーション) ===\n");
  console.log(`エントリー: ${entries.length}件 / 決済: ${exits.length}件\n`);
  
  // 大台確認エントリーを特定
  const roundEntries = entries.filter((e: any) => e.reason.includes('大台確認'));
  const otherEntries = entries.filter((e: any) => !e.reason.includes('大台確認'));
  
  console.log(`大台確認エントリー: ${roundEntries.length}件（CONFIRM_BARS変更の影響あり）`);
  console.log(`その他エントリー: ${otherEntries.length}件（影響なし）\n`);
  
  let totalCurrentPnl = 0;
  let totalNewPnl = 0;
  
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("【大台確認エントリー詳細】");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  for (const e of roundEntries) {
    // 対応する決済を探す
    const exitIdx = exits.findIndex((x: any) => x.symbol === e.symbol && x.tradeTime >= e.tradeTime);
    const exit = exitIdx >= 0 ? exits[exitIdx] : null;
    
    const isStrongTrend = e.reason.includes('押し目なし・強トレンド');
    const isPullback = e.reason.includes('押し目確認後');
    const entryType = isStrongTrend ? '強トレンド' : isPullback ? '押し目確認後' : '不明';
    
    console.log(`■ ${e.tradeTime} | ${e.symbol} | ${e.action.toUpperCase()} @ ¥${e.price} | ${entryType}`);
    
    if (exit) {
      const exitPrice = parseFloat(exit.price);
      const currentPnl = exit.pnl || 0;
      totalCurrentPnl += currentPnl;
      console.log(`  決済: ${exit.tradeTime} @ ¥${exitPrice} | ${currentPnl >= 0 ? '+' : ''}${currentPnl}円 | ${exit.reason.substring(0, 50)}`);
    }
    
    // 1分前のローソク足を取得（4本確認なら1分早くエントリー）
    const [candles] = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume
      FROM rt_candles
      WHERE symbol = ${e.symbol} AND tradeDate = '2026-07-30'
      AND candleTime <= ${e.tradeTime}
      ORDER BY candleTime DESC
      LIMIT 6
    `);
    
    const cArr = candles as any[];
    if (cArr.length >= 2) {
      // 直近5本の足を表示
      console.log(`  直近足（↓古い→新しい↑）:`);
      for (let i = Math.min(4, cArr.length - 1); i >= 0; i--) {
        const c = cArr[i];
        const marker = i === 0 ? ' ← 現行エントリー足' : i === 1 ? ' ← 4本確認エントリー足' : '';
        console.log(`    ${c.candleTime} O:${parseFloat(c.open)} H:${parseFloat(c.high)} L:${parseFloat(c.low)} C:${parseFloat(c.close)}${marker}`);
      }
      
      const prevCandle = cArr[1]; // 1分前の足
      const newEntryPrice = parseFloat(prevCandle.close);
      const priceDiff = e.price - newEntryPrice;
      
      console.log(`\n  ★4本確認の場合:`);
      console.log(`    エントリー時刻: ${prevCandle.candleTime}（1分前倒し）`);
      console.log(`    エントリー価格: ¥${newEntryPrice}（${priceDiff > 0 ? `${Math.round(priceDiff)}円安く買える` : `${Math.abs(Math.round(priceDiff))}円高く買う`}）`);
      
      if (exit) {
        const exitPrice = parseFloat(exit.price);
        let newPnl: number;
        if (e.action === 'buy') {
          newPnl = Math.round((exitPrice - newEntryPrice) * e.shares);
        } else {
          newPnl = Math.round((newEntryPrice - exitPrice) * e.shares);
        }
        totalNewPnl += newPnl;
        
        const currentPnl = exit.pnl || 0;
        const diff = newPnl - currentPnl;
        console.log(`    現行PnL: ${currentPnl >= 0 ? '+' : ''}${currentPnl}円`);
        console.log(`    新PnL:   ${newPnl >= 0 ? '+' : ''}${newPnl}円（${diff >= 0 ? '+' : ''}${diff}円）`);
        
        // 損切りラインの比較
        const slPct = 0.005; // 0.5%
        if (e.action === 'buy') {
          const currentSL = Math.round(e.price * (1 - slPct));
          const newSL = Math.round(newEntryPrice * (1 - slPct));
          console.log(`    損切りライン: 現行 ¥${currentSL} → 新 ¥${newSL}`);
          
          // 新しい損切りラインで損切り回避できたか確認
          if (exit.reason.includes('損切り')) {
            // エントリー後の足を取得して、新SLに到達するか確認
            const [postCandles] = await db.execute(sql`
              SELECT candleTime, low, high, close
              FROM rt_candles
              WHERE symbol = ${e.symbol} AND tradeDate = '2026-07-30'
              AND candleTime > ${prevCandle.candleTime} AND candleTime <= ${exit.tradeTime}
              ORDER BY candleTime ASC
            `);
            
            const postArr = postCandles as any[];
            let hitNewSL = false;
            for (const c of postArr) {
              if (parseFloat(c.low) <= newSL) {
                hitNewSL = true;
                console.log(`    → 新SLでも ${c.candleTime} に損切り発動（安値 ¥${parseFloat(c.low)}）`);
                break;
              }
            }
            if (!hitNewSL) {
              console.log(`    → ★新SLなら損切り回避！その後の値動き:`);
              // エントリー後30分の値動きを確認
              const [futureCandles] = await db.execute(sql`
                SELECT candleTime, high, low, close
                FROM rt_candles
                WHERE symbol = ${e.symbol} AND tradeDate = '2026-07-30'
                AND candleTime > ${prevCandle.candleTime}
                ORDER BY candleTime ASC
                LIMIT 30
              `);
              const fArr = futureCandles as any[];
              let maxHigh = newEntryPrice;
              let maxHighTime = prevCandle.candleTime;
              for (const c of fArr) {
                if (parseFloat(c.high) > maxHigh) {
                  maxHigh = parseFloat(c.high);
                  maxHighTime = c.candleTime;
                }
              }
              const potentialPnl = Math.round((maxHigh - newEntryPrice) * e.shares);
              console.log(`      30分内最高値: ¥${maxHigh}（${maxHighTime}）→ 最大利益 +${potentialPnl}円`);
            }
          }
        }
      }
    } else {
      if (exit) {
        totalNewPnl += (exit.pnl || 0); // 足データなければ変更なし
      }
    }
    console.log("");
  }
  
  // その他エントリー（影響なし）
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("【その他エントリー（CONFIRM_BARS変更の影響なし）】");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  let otherPnl = 0;
  for (const e of otherEntries) {
    const exit = exits.find((x: any) => x.symbol === e.symbol && x.tradeTime >= e.tradeTime);
    if (exit) {
      const pnl = exit.pnl || 0;
      otherPnl += pnl;
      console.log(`  ${e.tradeTime} | ${e.symbol} | ${e.action.toUpperCase()} @ ¥${e.price} → ${exit.tradeTime} | ${pnl >= 0 ? '+' : ''}${pnl}円 | ${e.reason.substring(0, 50)}`);
    }
  }
  
  // 総合サマリー
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("【総合サマリー】");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  const grandCurrentPnl = totalCurrentPnl + otherPnl;
  const grandNewPnl = totalNewPnl + otherPnl;
  
  console.log(`  現行(5本確認):`);
  console.log(`    大台確認分: ${totalCurrentPnl >= 0 ? '+' : ''}${totalCurrentPnl}円`);
  console.log(`    その他分:   ${otherPnl >= 0 ? '+' : ''}${otherPnl}円`);
  console.log(`    合計:       ${grandCurrentPnl >= 0 ? '+' : ''}${grandCurrentPnl}円`);
  console.log(`\n  新(4本確認):`);
  console.log(`    大台確認分: ${totalNewPnl >= 0 ? '+' : ''}${totalNewPnl}円`);
  console.log(`    その他分:   ${otherPnl >= 0 ? '+' : ''}${otherPnl}円`);
  console.log(`    合計:       ${grandNewPnl >= 0 ? '+' : ''}${grandNewPnl}円`);
  console.log(`\n  差分: ${grandNewPnl - grandCurrentPnl >= 0 ? '+' : ''}${grandNewPnl - grandCurrentPnl}円`);
  
  process.exit(0);
}
main().catch(console.error);
