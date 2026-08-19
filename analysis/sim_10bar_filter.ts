import mysql from "mysql2/promise";
async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  
  // スコア0ブロックされたSHORT全件を取得
  const [blocks] = await conn.query(`
    SELECT trade_date as tradeDate, candle_time as candleTime, symbol, entry_price as entryPrice, signal_reason as reason
    FROM rt_score0_blocks
    WHERE side = 'SHORT'
    ORDER BY trade_date, candle_time
  `) as any[];
  
  console.log("=== スコア0ブロックSHORT: 10本変化率フィルター検証 ===\n");
  console.log("対象: " + (blocks as any[]).length + "件\n");
  
  let passCount = 0, blockCount = 0;
  let passPnl = 0, blockPnl = 0;
  let passWin = 0, passLose = 0, blockWin = 0, blockLose = 0;
  const details: string[] = [];
  
  for (const b of blocks as any[]) {
    const dateStr = typeof b.tradeDate === 'string' ? b.tradeDate : new Date(b.tradeDate).toISOString().slice(0, 10);
    const price = Number(b.entryPrice);
    const symbol = b.symbol;
    const time = b.candleTime;
    
    // 直前10本の変化率を計算
    const [prevCandles] = await conn.query(`
      SELECT close as c FROM rt_candles 
      WHERE tradeDate = ? AND symbol = ? AND candleTime <= ? 
      ORDER BY candleTime DESC LIMIT 11
    `, [dateStr, symbol, time]) as any[];
    
    const candles = (prevCandles as any[]).reverse();
    let changeRate = 0;
    if (candles.length >= 2) {
      const first = Number(candles[0].c);
      const last = Number(candles[candles.length - 1].c);
      changeRate = ((last - first) / first) * 100;
    }
    
    // エントリー後の損益を計算（SHORT）
    const slPctMap: Record<string, number> = {"8035":0.8,"6857":0.6,"6976":0.8,"6526":1.0,"5803":0.6,"6981":0.9,"285A":0.6,"6146":0.8,"6594":0.5,"8316":0.5};
    const slPct = slPctMap[symbol] || 0.6;
    const slPrice = price * (1 + slPct / 100);
    const tpPrice = price * (1 - 1.5 / 100);
    const shares = Math.floor(3000000 / price / 100) * 100 || 100;
    
    const [afterCandles] = await conn.query(`
      SELECT candleTime as t, high as h, low as l, close as c FROM rt_candles
      WHERE tradeDate = ? AND symbol = ? AND candleTime > ?
      ORDER BY candleTime LIMIT 300
    `, [dateStr, symbol, time]) as any[];
    
    let result = "EOD"; let pnl = 0;
    for (const r of afterCandles as any[]) {
      if (Number(r.h) >= slPrice) { result = "SL"; pnl = Math.round((price - slPrice) * shares); break; }
      if (Number(r.l) <= tpPrice) { result = "TP"; pnl = Math.round((price - tpPrice) * shares); break; }
    }
    if (result === "EOD") {
      const last = (afterCandles as any[])[(afterCandles as any[]).length - 1];
      pnl = last ? Math.round((price - Number(last.c)) * shares) : 0;
    }
    
    const passFilter = changeRate > -1.0;
    if (passFilter) {
      passCount++; passPnl += pnl;
      if (pnl > 0) passWin++; else passLose++;
    } else {
      blockCount++; blockPnl += pnl;
      if (pnl > 0) blockWin++; else blockLose++;
    }
    details.push(`${dateStr} ${time} ${symbol} @${price} 変化率:${changeRate.toFixed(2)}% → ${passFilter?"PASS":"BLOCK"} ${result} ${pnl>=0?"+":""}${pnl}`);
  }
  
  console.log("--- 10本変化率 > -1.0% フィルター結果 ---\n");
  console.log("通過(エントリー許可): " + passCount + "件 " + passWin + "勝" + passLose + "敗 " + (passPnl>=0?"+":"") + passPnl.toLocaleString() + "円");
  console.log("ブロック: " + blockCount + "件 " + blockWin + "勝" + blockLose + "敗 " + (blockPnl>=0?"+":"") + blockPnl.toLocaleString() + "円");
  console.log("\n全件(フィルターなし): " + (passCount+blockCount) + "件 " + (passWin+blockWin) + "勝" + (passLose+blockLose) + "敗 " + ((passPnl+blockPnl)>=0?"+":"") + (passPnl+blockPnl).toLocaleString() + "円");
  console.log("\nフィルター効果: ブロックされた" + blockCount + "件の損益 = " + (blockPnl>=0?"+":"") + blockPnl.toLocaleString() + "円");
  console.log(blockPnl < 0 ? "→ フィルターが正しく損失を防いでいる" : "→ フィルターがプラス取引をブロックしている（過剰ブロック）");
  
  console.log("\n--- 全件詳細 ---\n");
  for (const d of details) console.log(d);
  
  await conn.end();
}
main();
