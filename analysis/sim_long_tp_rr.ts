import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// LONGの最適TP: リスクリワード比を考慮した詳細分析
// 各TP幅での平均利益/平均損失、実質期待値を計算

const IS_BULLISH_MA_PERIOD = 8;
const IS_BULLISH_SLOPE_THRESHOLD = 0;
const ATR_FILTER_THRESHOLD = 0.12;
const SL_MAP: Record<string, number> = { "8035":0.5,"6857":0.6,"6976":0.6,"6526":0.9,"5803":0.5,"6981":0.4,"285A":0.8,"6146":0.8,"6594":0.5,"8316":0.5 };
const LOTS: Record<string, number> = { "8035":100,"6857":100,"285A":100,"6146":100,"6976":200,"6981":300,"8316":400,"5803":400,"6526":1400,"6594":1000 };
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];
const TP_LEVELS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5];

async function runSim(tpPct: number) {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 11`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  
  const allTrades: any[] = [];
  
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
      let position: any = null;
      let slAfterTime: string | null = null;
      
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i];
        buffer.push(c);
        if (buffer.length > 300) buffer = buffer.slice(-300);
        const time = c.candleTime;
        const [h, m] = time.split(":").map(Number);
        const timeMin = h*60+m;
        
        // 前場強制決済
        if (position && timeMin >= 687 && timeMin < 750) {
          const pnl = (c.close - position.price) * position.lots;
          const pnlPct = (c.close - position.price) / position.price * 100;
          allTrades.push({ sym, pnl: Math.round(pnl), pnlPct, exitReason: "前場決済", slPct: SL_MAP[sym] });
          position = null; continue;
        }
        if (position && timeMin >= 925) {
          const pnl = (c.close - position.price) * position.lots;
          const pnlPct = (c.close - position.price) / position.price * 100;
          allTrades.push({ sym, pnl: Math.round(pnl), pnlPct, exitReason: "大引け", slPct: SL_MAP[sym] });
          position = null; continue;
        }
        
        if (position) {
          const slPct = SL_MAP[sym] || 0.5;
          const slPrice = position.price * (1 - slPct/100);
          const tpPrice = position.price * (1 + tpPct/100);
          if (c.low <= slPrice) { 
            allTrades.push({ sym, pnl: Math.round((slPrice - position.price) * position.lots), pnlPct: -slPct, exitReason: "SL", slPct }); 
            slAfterTime = time; position = null; continue; 
          }
          if (c.high >= tpPrice) { 
            allTrades.push({ sym, pnl: Math.round((tpPrice - position.price) * position.lots), pnlPct: tpPct, exitReason: "TP", slPct }); 
            position = null; continue; 
          }
          continue;
        }
        
        if (timeMin < 570 || timeMin >= 905) continue;
        if (timeMin >= 750 && timeMin < 770) continue;
        if (slAfterTime) { const [sh,sm] = slAfterTime.split(":").map(Number); if (timeMin-(sh*60+sm)<30) continue; slAfterTime=null; }
        
        if (buffer.length < IS_BULLISH_MA_PERIOD + 1) continue;
        const ma = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD;
        const prevMa = buffer.slice(-IS_BULLISH_MA_PERIOD-1,-1).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD;
        const isBullish = ((ma-prevMa)/prevMa*100) > IS_BULLISH_SLOPE_THRESHOLD;
        if (!isBullish) continue;
        
        if (buffer.length >= 20) { const atrBuf = buffer.slice(-20); const atr = atrBuf.reduce((s:number,b:any)=>s+(b.high-b.low),0)/20; if (atr/c.close*100 < ATR_FILTER_THRESHOLD) continue; }
        
        if (buffer.length >= 21) {
          const recent20 = buffer.slice(-21, -1);
          const maxHigh = Math.max(...recent20.map((b:any)=>b.high));
          if (c.close > maxHigh) {
            const maDeviation = Math.abs((c.close - ma) / ma * 100);
            const barBody = Math.abs((c.close - c.open) / c.open * 100);
            const recentBars = buffer.slice(-10);
            const bearBars = recentBars.filter((b:any)=>b.close<b.open).length;
            if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) {
              position = { price: c.close, lots: LOTS[sym] || 100, time };
            }
          }
        }
      }
      
      if (position) {
        const lastC = dayCandles[dayCandles.length-1];
        const pnl = (lastC.close - position.price) * position.lots;
        const pnlPct = (lastC.close - position.price) / position.price * 100;
        allTrades.push({ sym, pnl: Math.round(pnl), pnlPct, exitReason: "EOD", slPct: SL_MAP[position.sym] || 0.5 });
        position = null;
      }
      buffer = dayCandles.slice(-100);
    }
  }
  return allTrades;
}

async function main() {
  console.log(`=== LONGの最適TP幅: リスクリワード比分析（10営業日、同一銘柄1ポジ制限あり） ===`);
  console.log(`\n各銘柄のSL幅: 8035:0.5%, 6857:0.6%, 6976:0.6%, 6526:0.9%, 5803:0.5%, 6981:0.4%, 285A:0.8%, 6146:0.8%, 6594:0.5%, 8316:0.5%`);
  console.log(`平均SL幅: 約0.6%\n`);
  
  console.log(`TP幅  | 件数 | 勝率   | 損益        | PF   | 平均利益   | 平均損失   | RR比  | 期待値/件  | TP到達 | SL到達 | 時間決済`);
  console.log(`------|------|--------|-------------|------|------------|------------|-------|------------|--------|--------|--------`);
  
  for (const tp of TP_LEVELS) {
    const trades = await runSim(tp);
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
    const avgWin = wins.length > 0 ? Math.round(grossWin / wins.length) : 0;
    const avgLoss = losses.length > 0 ? Math.round(grossLoss / losses.length) : 0;
    const rr = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : "∞";
    const ev = Math.round(totalPnl / trades.length);
    const tpCount = trades.filter(t => t.exitReason === "TP").length;
    const slCount = trades.filter(t => t.exitReason === "SL").length;
    const timeCount = trades.filter(t => t.exitReason === "前場決済" || t.exitReason === "大引け" || t.exitReason === "EOD").length;
    
    console.log(`${tp.toFixed(1)}%  | ${trades.length.toString().padStart(4)} | ${(wins.length/trades.length*100).toFixed(1)}% | ${totalPnl.toLocaleString().padStart(11)}円 | ${pf.padStart(4)} | ${("+"+avgWin.toLocaleString()).padStart(10)}円 | ${("-"+avgLoss.toLocaleString()).padStart(10)}円 | ${rr.padStart(5)} | ${(ev>=0?"+":"")+ev.toLocaleString()}円 | ${tpCount.toString().padStart(6)} | ${slCount.toString().padStart(6)} | ${timeCount.toString().padStart(6)}`);
  }
  
  // 補足: 勝率×平均利益 - 敗率×平均損失 の期待値計算
  console.log(`\n\n=== 期待値の内訳（勝率×平均利益 vs 敗率×平均損失） ===`);
  console.log(`TP幅  | 勝率   | 平均利益(円) | 勝ち貢献   | 敗率   | 平均損失(円) | 負け貢献   | 純期待値`);
  console.log(`------|--------|-------------|------------|--------|-------------|------------|--------`);
  for (const tp of TP_LEVELS) {
    const trades = await runSim(tp);
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const winRate = wins.length / trades.length;
    const lossRate = losses.length / trades.length;
    const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const winContrib = Math.round(winRate * avgWin);
    const lossContrib = Math.round(lossRate * avgLoss);
    const netEV = winContrib - lossContrib;
    console.log(`${tp.toFixed(1)}%  | ${(winRate*100).toFixed(1)}% | ${Math.round(avgWin).toLocaleString().padStart(11)} | +${winContrib.toLocaleString().padStart(9)}円 | ${(lossRate*100).toFixed(1)}% | ${Math.round(avgLoss).toLocaleString().padStart(11)} | -${lossContrib.toLocaleString().padStart(9)}円 | ${(netEV>=0?"+":"")+netEV.toLocaleString()}円`);
  }
  
  // SL幅別の最適TP
  console.log(`\n\n=== SL幅別の最適TP（SLに対するTP倍率） ===`);
  console.log(`SL幅0.4%の銘柄（6981）: TP何%が最適か`);
  console.log(`SL幅0.5%の銘柄（8035,5803,6594,8316）: TP何%が最適か`);
  console.log(`SL幅0.6%の銘柄（6857,6976）: TP何%が最適か`);
  console.log(`SL幅0.8%の銘柄（285A,6146）: TP何%が最適か`);
  console.log(`SL幅0.9%の銘柄（6526）: TP何%が最適か`);
  
  for (const tp of TP_LEVELS) {
    const trades = await runSim(tp);
    const slGroups: Record<string, any[]> = {};
    for (const t of trades) {
      const sl = (SL_MAP[t.sym] || 0.5).toFixed(1);
      if (!slGroups[sl]) slGroups[sl] = [];
      slGroups[sl].push(t);
    }
    if (tp === TP_LEVELS[0]) {
      console.log(`\nTP幅  | SL0.4%      | SL0.5%      | SL0.6%      | SL0.8%      | SL0.9%`);
      console.log(`------|-------------|-------------|-------------|-------------|--------`);
    }
    const parts: string[] = [];
    for (const sl of ["0.4","0.5","0.6","0.8","0.9"]) {
      const g = slGroups[sl] || [];
      if (g.length === 0) { parts.push("  -  "); continue; }
      const pnl = g.reduce((s:number,t:any)=>s+t.pnl,0);
      const wr = (g.filter((t:any)=>t.pnl>0).length/g.length*100).toFixed(0);
      parts.push(`${wr}% ${pnl>=0?"+":""}${Math.round(pnl/1000)}k`);
    }
    console.log(`${tp.toFixed(1)}%  | ${parts.join(" | ")}`);
  }
  
  process.exit(0);
}
main();
