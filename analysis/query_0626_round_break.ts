import { getDb } from '../server/db';

async function main() {
  const db = await getDb();
  
  // Get all 6/26 round-break trades
  const [trades] = await db.execute(
    `SELECT id, symbol, symbolName, action, price, shares, pnl, reason, tradeTime, side, boardSignal 
     FROM rt_trades 
     WHERE tradeDate = '2026-06-26' AND reason LIKE '%大台%' 
     ORDER BY tradeTime`
  ) as any;
  
  console.log(`=== 6/26 大台割れ取引: ${trades.length}件 ===`);
  
  // Group entry/exit pairs
  const entries: any[] = [];
  const exits: any[] = [];
  
  for (const t of trades) {
    if (t.action === 'entry') entries.push(t);
    else exits.push(t);
  }
  
  console.log(`\nエントリー: ${entries.length}件, 決済: ${exits.length}件\n`);
  
  // For each entry, find corresponding exit and get board data from rt_candles
  for (const entry of entries) {
    const exit = exits.find((e: any) => e.symbol === entry.symbol && e.tradeTime > entry.tradeTime);
    const pnl = exit ? exit.pnl : 0;
    const exitReason = exit ? exit.reason : '未決済';
    
    // Get the candle at entry time to check board snapshot
    const entryMinute = entry.tradeTime.substring(0, 5); // HH:MM
    const [candles] = await db.execute(
      `SELECT boardSnapshot FROM rt_candles 
       WHERE tradeDate = '2026-06-26' AND symbol = ? AND candleTime = ?`,
      [entry.symbol, entryMinute]
    ) as any;
    
    let boardData: any = null;
    if (candles.length > 0 && candles[0].boardSnapshot) {
      try {
        boardData = JSON.parse(candles[0].boardSnapshot);
      } catch {}
    }
    
    const bpr = boardData?.buyPressureRatio ?? 'N/A';
    const boardSignal = boardData?.signal ?? entry.boardSignal ?? 'N/A';
    const boardScore = entry.boardSignal ? '(logged)' : 'N/A';
    
    // Parse hour
    const hour = parseInt(entry.tradeTime.substring(0, 2));
    const minute = parseInt(entry.tradeTime.substring(3, 5));
    const timeDecimal = hour + minute / 60;
    
    const result = pnl > 0 ? '勝ち' : pnl < 0 ? '負け' : '引分';
    
    console.log(`${entry.tradeTime} ${entry.symbolName}(${entry.symbol}) ${entry.side} @${entry.price}`);
    console.log(`  結果: ${result} P&L=${pnl}円 決済理由: ${exitReason}`);
    console.log(`  板信号: ${boardSignal} BPR: ${bpr} 時間帯: ${timeDecimal < 13 ? '午前' : '午後'}`);
    console.log(`  Ver4条件チェック:`);
    
    // Ver4: ① 板スコア>=2, ② BPR<0.54, ③ 13時前
    const v4_time = timeDecimal < 13;
    const v4_bpr = typeof bpr === 'number' && bpr < 0.54;
    const v4_board = boardSignal === 'sell_pressure' || boardSignal === 'large_sell_wall';
    const v4_pass = v4_time && v4_bpr && v4_board;
    
    console.log(`    ① 13時前: ${v4_time ? 'PASS' : 'FAIL'}`);
    console.log(`    ② BPR<0.54: ${v4_bpr ? 'PASS' : 'FAIL'} (${bpr})`);
    console.log(`    ③ 売り板優勢: ${v4_board ? 'PASS' : 'FAIL'} (${boardSignal})`);
    console.log(`    → Ver4判定: ${v4_pass ? '通過' : 'ブロック'}`);
    console.log('');
  }
  
  // Summary
  console.log('\n=== サマリー ===');
  let currentPnl = 0;
  let v4Pnl = 0;
  let currentCount = entries.length;
  let v4Count = 0;
  let currentWins = 0;
  let v4Wins = 0;
  
  for (const entry of entries) {
    const exit = exits.find((e: any) => e.symbol === entry.symbol && e.tradeTime > entry.tradeTime);
    const pnl = exit ? Number(exit.pnl) : 0;
    currentPnl += pnl;
    if (pnl > 0) currentWins++;
    
    const entryMinute = entry.tradeTime.substring(0, 5);
    const [candles] = await db.execute(
      `SELECT boardSnapshot FROM rt_candles 
       WHERE tradeDate = '2026-06-26' AND symbol = ? AND candleTime = ?`,
      [entry.symbol, entryMinute]
    ) as any;
    
    let boardData: any = null;
    if (candles.length > 0 && candles[0].boardSnapshot) {
      try { boardData = JSON.parse(candles[0].boardSnapshot); } catch {}
    }
    
    const bpr = boardData?.buyPressureRatio;
    const boardSignal = boardData?.signal ?? entry.boardSignal;
    const hour = parseInt(entry.tradeTime.substring(0, 2));
    const minute = parseInt(entry.tradeTime.substring(3, 5));
    const timeDecimal = hour + minute / 60;
    
    const v4_time = timeDecimal < 13;
    const v4_bpr = typeof bpr === 'number' && bpr < 0.54;
    const v4_board = boardSignal === 'sell_pressure' || boardSignal === 'large_sell_wall';
    
    if (v4_time && v4_bpr && v4_board) {
      v4Count++;
      v4Pnl += pnl;
      if (pnl > 0) v4Wins++;
    }
  }
  
  console.log(`現行: ${currentCount}件, 勝率${(currentWins/currentCount*100).toFixed(1)}%, P&L=${currentPnl}円`);
  console.log(`Ver4: ${v4Count}件, 勝率${v4Count > 0 ? (v4Wins/v4Count*100).toFixed(1) : 0}%, P&L=${v4Pnl}円`);
  console.log(`差分: エントリー${v4Count - currentCount}件, P&L${v4Pnl - currentPnl > 0 ? '+' : ''}${v4Pnl - currentPnl}円`);
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
