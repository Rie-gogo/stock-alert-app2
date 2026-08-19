import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const [blocks] = await db.execute(sql`
    SELECT trade_date, candle_time, symbol, signal_reason, entry_price 
    FROM rt_score0_blocks WHERE side = 'SHORT' ORDER BY trade_date, candle_time
  `);
  
  const results: any[] = [];
  for (const block of blocks as any[]) {
    const { trade_date, candle_time, symbol, signal_reason, entry_price } = block;
    const price = parseFloat(entry_price);
    const slMap: Record<string,number> = {'8035':0.8,'6857':0.6,'6976':0.8,'6526':1.0,'5803':0.6,'6981':0.9,'285A':0.6,'6146':0.8,'6594':0.5,'8316':0.5,'6920':0.8};
    const slPct = slMap[symbol] || 0.8;
    const slPrice = price * (1 + slPct/100);
    const tpPrice = price * (1 - 1.5/100);
    
    const [candles] = await db.execute(sql`
      SELECT candleTime, high, low, close FROM rt_candles 
      WHERE symbol = ${symbol} AND tradeDate = ${trade_date} AND candleTime > ${candle_time}
      ORDER BY candleTime LIMIT 120
    `);
    
    let pnl = 0, exitReason = "EOD", exitTime = "15:25", holdMin = 0;
    for (const c of candles as any[]) {
      holdMin++;
      if (parseFloat(c.high) >= slPrice) { pnl = -(slPrice - price); exitReason = "SL"; exitTime = c.candleTime; break; }
      if (parseFloat(c.low) <= tpPrice) { pnl = price - tpPrice; exitReason = "TP"; exitTime = c.candleTime; break; }
    }
    if (exitReason === "EOD" && (candles as any[]).length > 0) {
      pnl = price - parseFloat((candles as any[])[(candles as any[]).length-1].close);
    }
    
    const lotsMap: Record<string,number> = {'8035':100,'6857':100,'285A':100,'6146':100,'6976':200,'6981':300,'8316':400,'5803':400,'6526':1400,'6594':1000,'6920':100};
    const lots = lotsMap[symbol] || 100;
    const totalPnl = Math.round(pnl * lots);
    const hour = parseInt(candle_time.split(":")[0]);
    const timeSlot = hour < 12 ? "前場" : "後場";
    const sigType = signal_reason.includes("大台割れ") ? "大台割れ" : signal_reason.includes("三尊") ? "三尊" : signal_reason.includes("VWAP") ? "VWAP" : "ダウ理論";
    const isRepeat = results.some(r => r.symbol === symbol && r.trade_date === trade_date);
    
    results.push({ trade_date, candle_time, symbol, sigType, timeSlot, price, totalPnl, exitReason, holdMin, isRepeat, win: totalPnl > 0 });
  }
  
  const wins = results.filter(r => r.win);
  const losses = results.filter(r => r.win === false);
  console.log("=== SHORTスコア0ブロック 25件分析 ===");
  console.log("全体:", wins.length + "勝" + losses.length + "敗", results.reduce((s,r)=>s+r.totalPnl,0).toLocaleString() + "円");
  
  console.log("\n--- プラス取引 ---");
  for (const r of wins) console.log(" ", r.trade_date, r.candle_time, r.symbol, r.sigType, r.timeSlot, r.exitReason, "+"+r.totalPnl.toLocaleString()+"円", r.isRepeat?"連続":"初回", r.holdMin+"分");
  console.log("\n--- マイナス取引 ---");
  for (const r of losses) console.log(" ", r.trade_date, r.candle_time, r.symbol, r.sigType, r.timeSlot, r.exitReason, r.totalPnl.toLocaleString()+"円", r.isRepeat?"連続":"初回", r.holdMin+"分");
  
  console.log("\n=== 共通点分析 ===");
  console.log("【時間帯】");
  const am = results.filter(r=>r.timeSlot==="前場"), pm = results.filter(r=>r.timeSlot==="後場");
  console.log("  前場:", am.filter(r=>r.win).length+"勝"+am.filter(r=>r.win===false).length+"敗", am.reduce((s,r)=>s+r.totalPnl,0).toLocaleString()+"円");
  console.log("  後場:", pm.filter(r=>r.win).length+"勝"+pm.filter(r=>r.win===false).length+"敗", pm.reduce((s,r)=>s+r.totalPnl,0).toLocaleString()+"円");
  
  console.log("【シグナル種別】");
  for (const st of [...new Set(results.map(r=>r.sigType))]) {
    const s = results.filter(r=>r.sigType===st);
    console.log(" ", st+":", s.filter(r=>r.win).length+"勝"+s.filter(r=>r.win===false).length+"敗", s.reduce((s2,r)=>s2+r.totalPnl,0).toLocaleString()+"円");
  }
  
  console.log("【初回/連続（同一銘柄・同日2回目以降）】");
  const first = results.filter(r=>r.isRepeat===false), repeat = results.filter(r=>r.isRepeat);
  console.log("  初回:", first.filter(r=>r.win).length+"勝"+first.filter(r=>r.win===false).length+"敗", first.reduce((s,r)=>s+r.totalPnl,0).toLocaleString()+"円");
  console.log("  連続:", repeat.filter(r=>r.win).length+"勝"+repeat.filter(r=>r.win===false).length+"敗", repeat.reduce((s,r)=>s+r.totalPnl,0).toLocaleString()+"円");
  
  console.log("【銘柄別】");
  for (const sym of [...new Set(results.map(r=>r.symbol))]) {
    const s = results.filter(r=>r.symbol===sym);
    console.log(" ", sym+":", s.filter(r=>r.win).length+"勝"+s.filter(r=>r.win===false).length+"敗", s.reduce((s2,r)=>s2+r.totalPnl,0).toLocaleString()+"円");
  }
  
  console.log("【決済理由】");
  for (const er of [...new Set(results.map(r=>r.exitReason))]) {
    const s = results.filter(r=>r.exitReason===er);
    console.log(" ", er+":", s.filter(r=>r.win).length+"勝"+s.filter(r=>r.win===false).length+"敗", s.reduce((s2,r)=>s2+r.totalPnl,0).toLocaleString()+"円");
  }
  
  process.exit(0);
}
main();
