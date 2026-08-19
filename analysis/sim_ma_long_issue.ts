import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// ① MA期間がLONGの誤発火に与える影響を検証
// 「下落中の一時反発でisBullish=trueになりLONGが発火する」問題
// MA8, MA12, MA15, MA20で後場LONGの成績を比較
//
// ② 大台超えLONGの精度分析（なぜ成績が悪かったのか）

const SL_MAP: Record<string, number> = { "8035":0.5,"6857":0.6,"6976":0.6,"6526":0.9,"5803":0.5,"6981":0.4,"285A":0.8,"6146":0.8,"6594":0.5,"8316":0.5 };
const LOTS: Record<string, number> = { "8035":100,"6857":100,"285A":100,"6146":100,"6976":200,"6981":300,"8316":400,"5803":400,"6526":1400,"6594":1000 };
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];
const TP_LONG = 0.5;
const TP_SHORT = 1.5;

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 21`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1); // 20営業日
  
  // 全銘柄のデータをロード
  const allData: Record<string, Record<string, any[]>> = {};
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`SELECT tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol=${sym} AND tradeDate>=${tradeDates[0]} ORDER BY tradeDate, candleTime`);
    allData[sym] = {};
    for (const r of rows as any[]) {
      if (!allData[sym][r.tradeDate]) allData[sym][r.tradeDate] = [];
      allData[sym][r.tradeDate].push({...r, open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume:+r.volume});
    }
  }
  
  // ===== ① MA期間別のLONG成績比較 =====
  console.log(`=== ① MA期間別のバイパスLONG成績（20営業日） ===\n`);
  console.log(`MA期間 | 全体件数 | 勝率   | 損益        | 前場損益    | 後場損益    | 後場「下落中反発」誤発火`);
  console.log(`-------|----------|--------|-------------|-------------|-------------|--------`);
  
  for (const maPeriod of [8, 10, 12, 15, 20]) {
    let trades: any[] = [];
    
    for (const sym of SYMBOLS) {
      let buffer: any[] = allData[sym][tradeDates[0]] || [];
      
      for (const date of simDates) {
        const dayCandles = allData[sym][date] || [];
        if (dayCandles.length < 10) continue;
        let position: any = null;
        
        for (let i = 0; i < dayCandles.length; i++) {
          const c = dayCandles[i];
          buffer.push(c);
          if (buffer.length > 300) buffer = buffer.slice(-300);
          const [h, m] = c.candleTime.split(":").map(Number);
          const timeMin = h*60+m;
          
          // 決済
          if (position) {
            if (timeMin >= 687 && timeMin < 750) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots), exit:"前場"}); position=null; continue; }
            if (timeMin >= 925) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots), exit:"大引け"}); position=null; continue; }
            const slPrice = position.price * (1 - (SL_MAP[sym]||0.5)/100);
            const tpPrice = position.price * (1 + TP_LONG/100);
            if (c.low <= slPrice) { trades.push({...position, pnl: Math.round((slPrice-position.price)*position.lots), exit:"SL"}); position=null; continue; }
            if (c.high >= tpPrice) { trades.push({...position, pnl: Math.round((tpPrice-position.price)*position.lots), exit:"TP"}); position=null; continue; }
            continue;
          }
          
          if (timeMin < 570 || timeMin >= 905 || position) continue;
          if (timeMin >= 750 && timeMin < 770) continue;
          
          // isBullish
          if (buffer.length < maPeriod + 1) continue;
          const ma = buffer.slice(-maPeriod).reduce((s:number,b:any)=>s+b.close,0)/maPeriod;
          const prevMa = buffer.slice(-maPeriod-1,-1).reduce((s:number,b:any)=>s+b.close,0)/maPeriod;
          const isBullish = ((ma-prevMa)/prevMa*100) > 0;
          if (!isBullish) continue;
          
          // 静かな上昇バイパスLONG
          if (buffer.length >= 21) {
            const recent20 = buffer.slice(-21, -1);
            const maxHigh = Math.max(...recent20.map((b:any)=>b.high));
            if (c.close > maxHigh) {
              const maDeviation = Math.abs((c.close - ma) / ma * 100);
              const barBody = Math.abs((c.close - c.open) / c.open * 100);
              const recentBars = buffer.slice(-10);
              const bearBars = recentBars.filter((b:any)=>b.close<b.open).length;
              if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) {
                position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100, timeSlot: timeMin < 690 ? "前場" : "後場" };
              }
            }
          }
        }
        if (position) { const last = dayCandles[dayCandles.length-1]; trades.push({...position, pnl: Math.round((last.close-position.price)*position.lots), exit:"EOD"}); position=null; }
        buffer = dayCandles.slice(-100);
      }
    }
    
    const wins = trades.filter(t=>t.pnl>0);
    const am = trades.filter(t=>t.timeSlot==="前場");
    const pm = trades.filter(t=>t.timeSlot==="後場");
    const pmLosses = pm.filter(t=>t.pnl<0);
    console.log(`MA${maPeriod.toString().padStart(2)}   | ${trades.length.toString().padStart(8)} | ${(wins.length/trades.length*100).toFixed(1)}% | ${trades.reduce((s,t)=>s+t.pnl,0).toLocaleString().padStart(11)}円 | ${am.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString().padStart(11)}円 | ${pm.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString().padStart(11)}円 | ${pmLosses.length}件`);
  }
  
  // ===== ② 大台超えLONGの精度分析 =====
  console.log(`\n\n=== ② 大台超えLONGの精度分析（20営業日） ===`);
  console.log(`大台超えLONG停止前の成績を再検証: なぜ成績が悪かったのか\n`);
  
  let roundLongTrades: any[] = [];
  
  for (const sym of SYMBOLS) {
    let buffer: any[] = allData[sym][tradeDates[0]] || [];
    
    for (const date of simDates) {
      const dayCandles = allData[sym][date] || [];
      if (dayCandles.length < 10) continue;
      let position: any = null;
      
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i];
        buffer.push(c);
        if (buffer.length > 300) buffer = buffer.slice(-300);
        const [h, m] = c.candleTime.split(":").map(Number);
        const timeMin = h*60+m;
        
        // 決済
        if (position) {
          if (timeMin >= 687 && timeMin < 750) { roundLongTrades.push({...position, pnl: Math.round((c.close-position.price)*position.lots), exit:"前場"}); position=null; continue; }
          if (timeMin >= 925) { roundLongTrades.push({...position, pnl: Math.round((c.close-position.price)*position.lots), exit:"大引け"}); position=null; continue; }
          const slPrice = position.price * (1 - (SL_MAP[sym]||0.5)/100);
          const tpPrice = position.price * (1 + TP_LONG/100);
          if (c.low <= slPrice) { roundLongTrades.push({...position, pnl: Math.round((slPrice-position.price)*position.lots), exit:"SL"}); position=null; continue; }
          if (c.high >= tpPrice) { roundLongTrades.push({...position, pnl: Math.round((tpPrice-position.price)*position.lots), exit:"TP"}); position=null; continue; }
          continue;
        }
        
        if (timeMin < 570 || timeMin >= 905 || position) continue;
        if (timeMin >= 750 && timeMin < 770) continue;
        
        // 大台超えLONG検出
        if (i > 0 && buffer.length >= 2) {
          const prev = buffer[buffer.length - 2];
          const roundLevels = [100, 500, 1000, 5000, 10000];
          for (const rl of roundLevels) {
            const nearestAbove = Math.ceil(c.close / rl) * rl;
            // 前足がキリ番以下、今足がキリ番以上 → 大台超え
            if (prev.close < nearestAbove && c.close >= nearestAbove && (c.close - nearestAbove) / nearestAbove < 0.008) {
              // 板情報なしでLONGエントリー（大台超えLONGの純粋な成績）
              const [hh, mm] = c.candleTime.split(":").map(Number);
              position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100, level: nearestAbove, timeSlot: (hh*60+mm) < 690 ? "前場" : "後場" };
              break;
            }
          }
        }
      }
      if (position) { const last = dayCandles[dayCandles.length-1]; roundLongTrades.push({...position, pnl: Math.round((last.close-position.price)*position.lots), exit:"EOD"}); position=null; }
      buffer = dayCandles.slice(-100);
    }
  }
  
  const rlWins = roundLongTrades.filter(t=>t.pnl>0);
  const rlLosses = roundLongTrades.filter(t=>t.pnl<=0);
  console.log(`全体: ${roundLongTrades.length}件 ${rlWins.length}勝${rlLosses.length}敗 勝率${(rlWins.length/roundLongTrades.length*100).toFixed(1)}% ${roundLongTrades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  // TP=0.5%での成績
  console.log(`（TP=0.5%, 銘柄別SL使用）`);
  
  // 時間帯別
  const rlAm = roundLongTrades.filter(t=>t.timeSlot==="前場");
  const rlPm = roundLongTrades.filter(t=>t.timeSlot==="後場");
  console.log(`  前場: ${rlAm.length}件 ${rlAm.filter(t=>t.pnl>0).length}勝 ${rlAm.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  console.log(`  後場: ${rlPm.length}件 ${rlPm.filter(t=>t.pnl>0).length}勝 ${rlPm.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  // 銘柄別
  console.log(`\n  銘柄別:`);
  for (const s of SYMBOLS) {
    const st = roundLongTrades.filter(t=>t.sym===s);
    if (st.length === 0) continue;
    console.log(`    ${s}: ${st.length}件 ${st.filter(t=>t.pnl>0).length}勝${st.filter(t=>t.pnl<=0).length}敗 ${st.reduce((s2,t)=>s2+t.pnl,0).toLocaleString()}円`);
  }
  
  // 決済理由別
  console.log(`\n  決済理由別:`);
  for (const r of ["TP","SL","前場","大引け","EOD"]) {
    const rt = roundLongTrades.filter(t=>t.exit===r);
    if (rt.length) console.log(`    ${r}: ${rt.length}件 ${rt.filter(t=>t.pnl>0).length}勝 ${rt.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  }
  
  // 板情報（buy_pressure時）のフィルター効果
  console.log(`\n  ★ もし前場のみ + TP0.5%なら:`);
  console.log(`    ${rlAm.length}件 ${rlAm.filter(t=>t.pnl>0).length}勝 ${rlAm.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  
  process.exit(0);
}
main();
