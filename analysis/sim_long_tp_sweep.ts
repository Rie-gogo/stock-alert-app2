import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// LONGの最適TP幅シミュレーション: 0.5%, 0.6%, 0.8%, 1.0%, 1.2%, 1.5%で比較
// 同一銘柄制限あり（本番同等）で10営業日

const IS_BULLISH_MA_PERIOD = 8;
const IS_BULLISH_SLOPE_THRESHOLD = 0;
const ATR_FILTER_THRESHOLD = 0.12;
const SL_MAP: Record<string, number> = { "8035":0.5,"6857":0.6,"6976":0.6,"6526":0.9,"5803":0.5,"6981":0.4,"285A":0.8,"6146":0.8,"6594":0.5,"8316":0.5 };
const LOTS: Record<string, number> = { "8035":100,"6857":100,"285A":100,"6146":100,"6976":200,"6981":300,"8316":400,"5803":400,"6526":1400,"6594":1000 };
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];
const TP_LEVELS = [0.5, 0.6, 0.8, 1.0, 1.2, 1.5];

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
        const hour = parseInt(time.split(":")[0]);
        const min = parseInt(time.split(":")[1]);
        const timeMin = hour * 60 + min;
        
        // 前場強制決済 11:27
        if (position && timeMin >= 687 && timeMin < 750) {
          const pnl = (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "前場決済", pnl: Math.round(pnl) });
          position = null; continue;
        }
        // 大引け 15:25
        if (position && timeMin >= 925) {
          const pnl = (c.close - position.price) * position.lots;
          allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "大引け", pnl: Math.round(pnl) });
          position = null; continue;
        }
        
        // SL/TP判定
        if (position) {
          const slPct = SL_MAP[sym] || 0.5;
          const slPrice = position.price * (1 - slPct/100);
          const tpPrice = position.price * (1 + tpPct/100);
          if (c.low <= slPrice) { allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "SL", pnl: Math.round((slPrice - position.price) * position.lots) }); slAfterTime = time; position = null; continue; }
          if (c.high >= tpPrice) { allTrades.push({ date, sym, ...position, exitTime: time, exitReason: "TP", pnl: Math.round((tpPrice - position.price) * position.lots) }); position = null; continue; }
          continue;
        }
        
        // エントリー条件
        if (timeMin < 570 || timeMin >= 905) continue;
        if (timeMin >= 750 && timeMin < 770) continue;
        if (position) continue;
        
        if (slAfterTime) {
          const slH = parseInt(slAfterTime.split(":")[0]), slM = parseInt(slAfterTime.split(":")[1]);
          if (timeMin - (slH*60+slM) < 30) continue;
          slAfterTime = null;
        }
        
        // isBullish（MA8）
        if (buffer.length < IS_BULLISH_MA_PERIOD + 1) continue;
        const ma = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD;
        const prevMa = buffer.slice(-IS_BULLISH_MA_PERIOD-1,-1).reduce((s:number,b:any)=>s+b.close,0)/IS_BULLISH_MA_PERIOD;
        const isBullish = ((ma-prevMa)/prevMa*100) > IS_BULLISH_SLOPE_THRESHOLD;
        if (!isBullish) continue;
        
        // ATRフィルター
        if (buffer.length >= 20) {
          const atrBuf = buffer.slice(-20);
          const atr = atrBuf.reduce((s:number,b:any)=>s+(b.high-b.low),0)/20;
          if (atr/c.close*100 < ATR_FILTER_THRESHOLD) continue;
        }
        
        // ダウ理論LONG（直近高値更新）+ 静かな上昇バイパス
        if (buffer.length >= 21) {
          const recent20 = buffer.slice(-21, -1);
          const maxHigh = Math.max(...recent20.map((b:any)=>b.high));
          if (c.close > maxHigh) {
            const maDeviation = Math.abs((c.close - ma) / ma * 100);
            const barBody = Math.abs((c.close - c.open) / c.open * 100);
            const recentBars = buffer.slice(-10);
            const bearBars = recentBars.filter((b:any)=>b.close<b.open).length;
            if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) {
              position = { side: "long", price: c.close, lots: LOTS[sym] || 100, time, signal: "バイパスLONG" };
            }
          }
        }
      }
      
      if (position) {
        const lastC = dayCandles[dayCandles.length-1];
        allTrades.push({ date, sym, ...position, exitTime: "15:30", exitReason: "EOD", pnl: Math.round((lastC.close - position.price) * position.lots) });
        position = null;
      }
      buffer = dayCandles.slice(-100);
    }
  }
  return allTrades;
}

async function main() {
  console.log(`=== LONGの最適TP幅シミュレーション（10営業日、同一銘柄1ポジ制限あり） ===\n`);
  console.log(`TP幅    | 件数 | 勝敗      | 勝率   | 損益        | PF    | TP到達 | SL到達 | 前場決済 | 大引け`);
  console.log(`--------|------|-----------|--------|-------------|-------|--------|--------|----------|------`);
  
  for (const tp of TP_LEVELS) {
    const trades = await runSim(tp);
    const wins = trades.filter(t=>t.pnl>0);
    const losses = trades.filter(t=>t.pnl<=0);
    const totalPnl = trades.reduce((s,t)=>s+t.pnl,0);
    const grossWin = wins.reduce((s,t)=>s+t.pnl,0);
    const grossLoss = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
    const pf = grossLoss > 0 ? (grossWin/grossLoss).toFixed(2) : "∞";
    const tpCount = trades.filter(t=>t.exitReason==="TP").length;
    const slCount = trades.filter(t=>t.exitReason==="SL").length;
    const amClose = trades.filter(t=>t.exitReason==="前場決済").length;
    const eod = trades.filter(t=>t.exitReason==="大引け"||t.exitReason==="EOD").length;
    
    console.log(`${tp.toFixed(1)}%    | ${trades.length.toString().padStart(4)} | ${wins.length}勝${losses.length}敗 | ${(wins.length/trades.length*100).toFixed(1)}% | ${totalPnl.toLocaleString().padStart(11)}円 | ${pf.padStart(5)} | ${tpCount.toString().padStart(6)} | ${slCount.toString().padStart(6)} | ${amClose.toString().padStart(8)} | ${eod.toString().padStart(6)}`);
  }
  
  // 前場/後場別でも分析
  console.log(`\n\n=== 前場/後場別 TP幅比較 ===\n`);
  console.log(`TP幅    | 前場件数 | 前場損益      | 後場件数 | 後場損益`);
  console.log(`--------|----------|---------------|----------|--------`);
  for (const tp of TP_LEVELS) {
    const trades = await runSim(tp);
    const am = trades.filter(t => { const h = parseInt(t.time.split(":")[0]); return h < 12; });
    const pm = trades.filter(t => { const h = parseInt(t.time.split(":")[0]); return h >= 12; });
    console.log(`${tp.toFixed(1)}%    | ${am.length.toString().padStart(8)} | ${am.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString().padStart(13)}円 | ${pm.length.toString().padStart(8)} | ${pm.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString().padStart(11)}円`);
  }
  
  process.exit(0);
}
main();
