import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  // 25件のブロック記録を取得
  const db = await getDb(); const blocks = await db.execute(sql`
    SELECT trade_date, candle_time, symbol, signal_reason, entry_price 
    FROM rt_score0_blocks WHERE side = 'SHORT' ORDER BY trade_date, candle_time
  `);
  
  // 各ブロックについてrt_candlesからエントリー時点の状態を取得し、仮想損益を計算
  const results: any[] = [];
  
  for (const block of blocks.rows as any[]) {
    const { trade_date, candle_time, symbol, signal_reason, entry_price } = block;
    const price = parseFloat(entry_price);
    
    // SL幅を取得（銘柄別）
    const slMap: Record<string, number> = {
      '8035': 0.8, '6857': 0.6, '6976': 0.8, '6526': 1.0,
      '5803': 0.6, '6981': 0.9, '285A': 0.6, '6146': 0.8,
      '6594': 0.5, '8316': 0.5
    };
    const slPct = slMap[symbol] || 0.8;
    const slPrice = price * (1 + slPct / 100);
    const tpPrice = price * (1 - 1.5 / 100);
    
    // エントリー後の足を取得
    const candles = await db.execute(sql`
      SELECT tradeTime, high, low, close FROM rt_candles 
      WHERE symbol = ${symbol} AND tradeDate = ${trade_date} AND tradeTime > ${candle_time}
      ORDER BY tradeTime LIMIT 120
    `);
    
    let pnl = 0;
    let exitReason = "EOD";
    let exitTime = "15:25";
    let holdMinutes = 0;
    
    for (const c of candles.rows as any[]) {
      holdMinutes++;
      const high = parseFloat(c.high);
      const low = parseFloat(c.low);
      const close = parseFloat(c.close);
      
      if (high >= slPrice) {
        pnl = -(slPrice - price);
        exitReason = "SL";
        exitTime = c.tradeTime;
        break;
      }
      if (low <= tpPrice) {
        pnl = price - tpPrice;
        exitReason = "TP";
        exitTime = c.tradeTime;
        break;
      }
    }
    
    if (exitReason === "EOD") {
      const lastCandle = candles.rows[candles.rows.length - 1] as any;
      if (lastCandle) {
        pnl = price - parseFloat(lastCandle.close);
      }
    }
    
    // ロット計算
    const lots = symbol === '8035' || symbol === '6857' || symbol === '285A' || symbol === '6146' ? 100 :
                 symbol === '6976' ? 200 : symbol === '6981' ? 300 : symbol === '8316' ? 400 :
                 symbol === '5803' ? 400 : symbol === '6526' ? 1400 : symbol === '6594' ? 1000 : 100;
    const totalPnl = Math.round(pnl * lots);
    
    // エントリー時刻の分類
    const hour = parseInt(candle_time.split(':')[0]);
    const minute = parseInt(candle_time.split(':')[1]);
    const timeSlot = hour < 11 || (hour === 11 && minute <= 30) ? "前場" : "後場";
    
    // シグナル種別
    const sigType = signal_reason.includes("大台割れ") ? "大台割れ" :
                    signal_reason.includes("三尊") ? "三尊" :
                    signal_reason.includes("VWAP") ? "VWAP" : "ダウ理論";
    
    // 同一銘柄の連続シグナルかどうか
    const prevSameSymbol = results.filter(r => r.symbol === symbol && r.trade_date === trade_date);
    const isRepeat = prevSameSymbol.length > 0;
    
    results.push({
      trade_date, candle_time, symbol, sigType, timeSlot,
      price, totalPnl, exitReason, exitTime, holdMinutes, isRepeat,
      win: totalPnl > 0
    });
  }
  
  // 分析
  const wins = results.filter(r => r.win);
  const losses = results.filter(r => !r.win);
  
  console.log(`\n=== SHORTスコア0ブロック 25件分析 ===`);
  console.log(`全体: ${wins.length}勝${losses.length}敗 ${results.reduce((s,r) => s + r.totalPnl, 0).toLocaleString()}円`);
  
  console.log(`\n--- プラス取引 ${wins.length}件 ---`);
  for (const r of wins) {
    console.log(`  ${r.trade_date} ${r.candle_time} ${r.symbol} ${r.sigType} ${r.timeSlot} ${r.exitReason} +${r.totalPnl.toLocaleString()}円 ${r.isRepeat ? '★連続' : '初回'} 保有${r.holdMinutes}分`);
  }
  
  console.log(`\n--- マイナス取引 ${losses.length}件 ---`);
  for (const r of losses) {
    console.log(`  ${r.trade_date} ${r.candle_time} ${r.symbol} ${r.sigType} ${r.timeSlot} ${r.exitReason} ${r.totalPnl.toLocaleString()}円 ${r.isRepeat ? '★連続' : '初回'} 保有${r.holdMinutes}分`);
  }
  
  // 共通点分析
  console.log(`\n=== 共通点分析 ===`);
  
  // 時間帯
  console.log(`\n【時間帯】`);
  const amWins = wins.filter(r => r.timeSlot === "前場");
  const amLosses = losses.filter(r => r.timeSlot === "前場");
  const pmWins = wins.filter(r => r.timeSlot === "後場");
  const pmLosses = losses.filter(r => r.timeSlot === "後場");
  console.log(`  前場: ${amWins.length}勝${amLosses.length}敗 ${[...amWins,...amLosses].reduce((s,r)=>s+r.totalPnl,0).toLocaleString()}円`);
  console.log(`  後場: ${pmWins.length}勝${pmLosses.length}敗 ${[...pmWins,...pmLosses].reduce((s,r)=>s+r.totalPnl,0).toLocaleString()}円`);
  
  // シグナル種別
  console.log(`\n【シグナル種別】`);
  const sigTypes = [...new Set(results.map(r => r.sigType))];
  for (const st of sigTypes) {
    const stResults = results.filter(r => r.sigType === st);
    const stWins = stResults.filter(r => r.win);
    console.log(`  ${st}: ${stWins.length}勝${stResults.length - stWins.length}敗 ${stResults.reduce((s,r)=>s+r.totalPnl,0).toLocaleString()}円`);
  }
  
  // 連続シグナル
  console.log(`\n【連続シグナル（同一銘柄・同日2回目以降）】`);
  const repeatResults = results.filter(r => r.isRepeat);
  const firstResults = results.filter(r => !r.isRepeat);
  const repeatWins = repeatResults.filter(r => r.win);
  const firstWins = firstResults.filter(r => r.win);
  console.log(`  初回: ${firstWins.length}勝${firstResults.length - firstWins.length}敗 ${firstResults.reduce((s,r)=>s+r.totalPnl,0).toLocaleString()}円`);
  console.log(`  連続: ${repeatWins.length}勝${repeatResults.length - repeatWins.length}敗 ${repeatResults.reduce((s,r)=>s+r.totalPnl,0).toLocaleString()}円`);
  
  // 銘柄別
  console.log(`\n【銘柄別】`);
  const symbols = [...new Set(results.map(r => r.symbol))];
  for (const sym of symbols) {
    const symResults = results.filter(r => r.symbol === sym);
    const symWins = symResults.filter(r => r.win);
    console.log(`  ${sym}: ${symWins.length}勝${symResults.length - symWins.length}敗 ${symResults.reduce((s,r)=>s+r.totalPnl,0).toLocaleString()}円`);
  }
  
  // 決済理由
  console.log(`\n【決済理由】`);
  const exitReasons = [...new Set(results.map(r => r.exitReason))];
  for (const er of exitReasons) {
    const erResults = results.filter(r => r.exitReason === er);
    const erWins = erResults.filter(r => r.win);
    console.log(`  ${er}: ${erWins.length}勝${erResults.length - erWins.length}敗 ${erResults.reduce((s,r)=>s+r.totalPnl,0).toLocaleString()}円`);
  }
  
  process.exit(0);
}
main();
