import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// バイパスLONG 86件の詳細分析: なぜ勝率が低いのか
const IS_BULLISH_MA_PERIOD = 8;
const SL_MAP: Record<string, number> = { "8035":0.5,"6857":0.6,"6976":0.6,"6526":0.9,"5803":0.5,"6981":0.4,"285A":0.8,"6146":0.8,"6594":0.5,"8316":0.5 };
const LOTS: Record<string, number> = { "8035":100,"6857":100,"285A":100,"6146":100,"6976":200,"6981":300,"8316":400,"5803":400,"6526":1400,"6594":1000 };
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 11`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  
  const trades: any[] = [];
  
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`SELECT tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol=${sym} AND tradeDate>=${tradeDates[0]} ORDER BY tradeDate, candleTime`);
    const candles = rows as any[];
    if (candles.length < 50) continue;
    
    const byDate: Record<string, any[]> = {};
    for (const c of candles) { if (!byDate[c.tradeDate]) byDate[c.tradeDate] = []; byDate[c.tradeDate].push({...c, open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+c.volume}); }
    
    let buffer: any[] = byDate[tradeDates[0]] || [];
    
    for (const date of simDates) {
      const dayCandles = byDate[date] || [];
      if (dayCandles.length < 10) continue;
      let enteredToday = false;
      
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i];
        buffer.push(c);
        if (buffer.length > 300) buffer = buffer.slice(-300);
        
        const time = c.candleTime;
        const hour = parseInt(time.split(":")[0]);
        const min = parseInt(time.split(":")[1]);
        const timeMin = hour * 60 + min;
        if (timeMin < 570 || timeMin >= 905) continue;
        if (timeMin >= 750 && timeMin < 770) continue;
        
        // isBullish（MA8）
        const maPeriod = IS_BULLISH_MA_PERIOD;
        if (buffer.length < maPeriod + 1) continue;
        const ma = buffer.slice(-maPeriod).reduce((s:number,b:any)=>s+b.close,0)/maPeriod;
        const prevMa = buffer.slice(-maPeriod-1,-1).reduce((s:number,b:any)=>s+b.close,0)/maPeriod;
        const isBullish = ((ma-prevMa)/prevMa*100) > 0;
        if (!isBullish) continue;
        
        // ダウ理論LONG（直近高値更新）
        if (buffer.length < 21) continue;
        const recent20 = buffer.slice(-21, -1);
        const maxHigh = Math.max(...recent20.map((b:any)=>b.high));
        if (c.close <= maxHigh) continue;
        
        // 静かな上昇バイパス条件（緩和A）
        const maDeviation = Math.abs((c.close - ma) / ma * 100);
        const barBody = Math.abs((c.close - c.open) / c.open * 100);
        const recentBars = buffer.slice(-10);
        const bearBars = recentBars.filter((b:any)=>b.close<b.open).length;
        if (maDeviation >= 0.5 || barBody >= 0.2 || bearBars > 4) continue;
        
        // エントリー
        const slPct = SL_MAP[sym] || 0.5;
        const slPrice = c.close * (1 - slPct/100);
        const tpPrice = c.close * (1 + 1.5/100);
        const lots = LOTS[sym] || 100;
        
        // 結果計算
        let pnl = 0, exitReason = "EOD", exitTime = "15:25", holdMin = 0;
        let maxUp = 0, maxDown = 0;
        for (let j = i+1; j < dayCandles.length; j++) {
          holdMin++;
          const nc = dayCandles[j];
          const ncTime = nc.candleTime;
          const ncMin = parseInt(ncTime.split(":")[0])*60 + parseInt(ncTime.split(":")[1]);
          
          maxUp = Math.max(maxUp, (nc.high - c.close)/c.close*100);
          maxDown = Math.min(maxDown, (nc.low - c.close)/c.close*100);
          
          // 前場強制決済
          if (ncMin >= 687 && ncMin < 750) { pnl = (nc.close - c.close)*lots; exitReason = "前場決済"; exitTime = ncTime; break; }
          if (ncMin >= 925) { pnl = (nc.close - c.close)*lots; exitReason = "大引け"; exitTime = ncTime; break; }
          if (nc.low <= slPrice) { pnl = (slPrice - c.close)*lots; exitReason = "SL"; exitTime = ncTime; break; }
          if (nc.high >= tpPrice) { pnl = (tpPrice - c.close)*lots; exitReason = "TP"; exitTime = ncTime; break; }
        }
        if (exitReason === "EOD") { const last = dayCandles[dayCandles.length-1]; pnl = (last.close - c.close)*lots; }
        
        trades.push({ date, sym, time, price: c.close, pnl: Math.round(pnl), exitReason, holdMin, maxUp: maxUp.toFixed(3), maxDown: maxDown.toFixed(3), maDeviation: maDeviation.toFixed(3), barBody: barBody.toFixed(3), bearBars, timeSlot: timeMin < 690 ? "前場" : "後場" });
      }
      buffer = dayCandles.slice(-100);
    }
  }
  
  const wins = trades.filter(t=>t.pnl>0);
  const losses = trades.filter(t=>t.pnl<=0);
  console.log(`=== バイパスLONG詳細分析 ===`);
  console.log(`全体: ${trades.length}件 ${wins.length}勝${losses.length}敗 ${trades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  console.log(`\n--- 勝ち取引 ---`);
  for (const t of wins.slice(0,15)) console.log(`  ${t.date} ${t.time} ${t.sym} @${t.price} ${t.exitReason} +${t.pnl.toLocaleString()}円 ${t.holdMin}分 maxUp:${t.maxUp}% maxDown:${t.maxDown}% MA乖離:${t.maDeviation}% 実体:${t.barBody}% 陰線:${t.bearBars}`);
  
  console.log(`\n--- 負け取引（先頭15件） ---`);
  for (const t of losses.slice(0,15)) console.log(`  ${t.date} ${t.time} ${t.sym} @${t.price} ${t.exitReason} ${t.pnl.toLocaleString()}円 ${t.holdMin}分 maxUp:${t.maxUp}% maxDown:${t.maxDown}% MA乖離:${t.maDeviation}% 実体:${t.barBody}% 陰線:${t.bearBars}`);
  
  console.log(`\n--- 決済理由別 ---`);
  for (const r of ["TP","SL","前場決済","大引け","EOD"]) { const rt = trades.filter(t=>t.exitReason===r); if(rt.length) console.log(`  ${r}: ${rt.length}件 ${rt.filter(t=>t.pnl>0).length}勝 ${rt.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`); }
  
  console.log(`\n--- 時間帯別 ---`);
  const am = trades.filter(t=>t.timeSlot==="前場"), pm = trades.filter(t=>t.timeSlot==="後場");
  console.log(`  前場: ${am.length}件 ${am.filter(t=>t.pnl>0).length}勝 ${am.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`  後場: ${pm.length}件 ${pm.filter(t=>t.pnl>0).length}勝 ${pm.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  console.log(`\n--- 銘柄別 ---`);
  for (const s of SYMBOLS) { const st = trades.filter(t=>t.sym===s); if(st.length) console.log(`  ${s}: ${st.length}件 ${st.filter(t=>t.pnl>0).length}勝${st.filter(t=>t.pnl<=0).length}敗 ${st.reduce((s2,t)=>s2+t.pnl,0).toLocaleString()}円`); }
  
  console.log(`\n--- SL到達率 ---`);
  const slTrades = trades.filter(t=>t.exitReason==="SL");
  console.log(`  SL到達: ${slTrades.length}/${trades.length}件 (${(slTrades.length/trades.length*100).toFixed(1)}%)`);
  console.log(`  SL平均保有時間: ${Math.round(slTrades.reduce((s,t)=>s+t.holdMin,0)/slTrades.length)}分`);
  const tpTrades = trades.filter(t=>t.exitReason==="TP");
  console.log(`  TP到達: ${tpTrades.length}/${trades.length}件 (${(tpTrades.length/trades.length*100).toFixed(1)}%)`);
  
  // maxUp分析: TP(1.5%)に到達しなかったが、どこまで上がったか
  const nonTP = trades.filter(t=>t.exitReason!=="TP");
  const upBuckets = [0.3, 0.5, 0.8, 1.0, 1.2, 1.5];
  console.log(`\n--- TP未到達取引のmaxUp分布 ---`);
  for (const b of upBuckets) { const cnt = nonTP.filter(t=>parseFloat(t.maxUp)>=b).length; console.log(`  maxUp >= ${b}%: ${cnt}件/${nonTP.length}件`); }
  
  process.exit(0);
}
main();
