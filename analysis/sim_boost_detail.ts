import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 前場ブーストLONGの詳細分析: なぜマイナスか

const IS_BULLISH_MA_PERIOD = 8;
const TP_LONG = 0.5;
const AM_BOOST_MA_DEV_MAX = 1.0;
const AM_BOOST_BODY_MAX = 0.5;
const AM_BOOST_BEAR_MAX = 5;
const SL_MAP: Record<string, { long: number; short: number }> = {
  "8035": { long: 0.5, short: 0.8 }, "6857": { long: 0.6, short: 0.6 },
  "6976": { long: 0.6, short: 0.8 }, "6526": { long: 0.9, short: 1.0 },
  "5803": { long: 0.5, short: 0.6 }, "6981": { long: 0.4, short: 0.9 },
  "285A": { long: 0.8, short: 0.6 }, "6146": { long: 0.8, short: 0.8 },
  "6594": { long: 0.5, short: 0.5 }, "8316": { long: 0.5, short: 0.5 },
};
const LOTS: Record<string, number> = {
  "8035": 100, "6857": 100, "285A": 100, "6146": 100,
  "6976": 200, "6981": 300, "8316": 400, "5803": 400, "6526": 1400, "6594": 1000,
};
const SYMBOLS = ["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6146", "6594", "8316"];

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 31`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  
  // パターンA: 前場ブーストLONGのみ（SHORTなし、同一銘柄制限なし）
  const tradesA: any[] = [];
  // パターンB: 全ロジック内での前場ブーストLONG（SHORTあり、同一銘柄制限あり）
  const tradesB: any[] = [];
  
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`
      SELECT tradeDate, candleTime, open, high, low, close, volume
      FROM rt_candles WHERE symbol=${sym} AND tradeDate>=${tradeDates[0]} ORDER BY tradeDate, candleTime
    `);
    const candles = rows as any[];
    if (candles.length < 50) continue;
    const byDate: Record<string, any[]> = {};
    for (const c of candles) { if (!byDate[c.tradeDate]) byDate[c.tradeDate] = []; byDate[c.tradeDate].push({...c, open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+c.volume}); }
    
    // パターンA: LONGのみ
    let bufA: any[] = byDate[tradeDates[0]] || [];
    for (const date of simDates) {
      const dayCandles = byDate[date] || [];
      if (dayCandles.length < 10) continue;
      let pos: any = null;
      for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i]; bufA.push(c); if (bufA.length > 300) bufA = bufA.slice(-300);
        const [h, m] = c.candleTime.split(":").map(Number); const timeMin = h*60+m;
        const isAM = timeMin < 688;
        if (pos) {
          if (timeMin >= 687 && timeMin < 750) { tradesA.push({...pos, pnl: Math.round((c.close-pos.price)*pos.lots), exit:"前場"}); pos=null; continue; }
          if (timeMin >= 925) { tradesA.push({...pos, pnl: Math.round((c.close-pos.price)*pos.lots), exit:"大引け"}); pos=null; continue; }
          const slP = pos.price*(1-(SL_MAP[sym]?.long||0.5)/100);
          const tpP = pos.price*(1+TP_LONG/100);
          if (c.low<=slP) { tradesA.push({...pos, pnl: Math.round((slP-pos.price)*pos.lots), exit:"SL"}); pos=null; continue; }
          if (c.high>=tpP) { tradesA.push({...pos, pnl: Math.round((tpP-pos.price)*pos.lots), exit:"TP"}); pos=null; continue; }
          continue;
        }
        if (timeMin<570||timeMin>=905||!isAM) continue;
        if (bufA.length < 21) continue;
        const ma = bufA.slice(-8).reduce((s:number,b:any)=>s+b.close,0)/8;
        const prevMa = bufA.slice(-9,-1).reduce((s:number,b:any)=>s+b.close,0)/8;
        const isBullish = ((ma-prevMa)/prevMa*100) > 0;
        if (!isBullish) continue;
        const maxHigh = Math.max(...bufA.slice(-21,-1).map((b:any)=>b.high));
        if (c.close <= maxHigh) continue;
        const maDeviation = Math.abs((c.close - ma) / ma * 100);
        const barBody = Math.abs((c.close - c.open) / c.open * 100);
        const bearBars = bufA.slice(-10).filter((b:any)=>b.close<b.open).length;
        // 静かな上昇バイパスは除外（ブーストのみ）
        if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) continue; // バイパス条件に該当するものは除外
        if (maDeviation < AM_BOOST_MA_DEV_MAX && barBody < AM_BOOST_BODY_MAX && bearBars <= AM_BOOST_BEAR_MAX) {
          pos = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100, method: "前場ブースト" };
        }
      }
      if (pos) { const last=dayCandles[dayCandles.length-1]; tradesA.push({...pos, pnl: Math.round((last.close-pos.price)*pos.lots), exit:"EOD"}); pos=null; }
      bufA = dayCandles.slice(-100);
    }
  }
  
  const winsA = tradesA.filter(t=>t.pnl>0);
  const totalA = tradesA.reduce((s,t)=>s+t.pnl,0);
  const gpA = winsA.reduce((s,t)=>s+t.pnl,0);
  const glA = Math.abs(tradesA.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
  
  console.log("=== パターンA: 前場ブーストLONGのみ（SHORTなし、同一銘柄制限なし）===");
  console.log(`  ${tradesA.length}件 ${winsA.length}勝${tradesA.length-winsA.length}敗 勝率${(winsA.length/tradesA.length*100).toFixed(1)}% ${totalA.toLocaleString()}円 PF${glA>0?(gpA/glA).toFixed(2):"∞"}`);
  
  // 決済理由別
  for (const exit of ["TP","SL","前場","大引け","EOD"]) {
    const et = tradesA.filter(t=>t.exit===exit);
    if (et.length===0) continue;
    console.log(`  ${exit}: ${et.length}件 ${et.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  }
  
  // 日別
  console.log("\n  日別:");
  for (const d of simDates) {
    const dt = tradesA.filter(t=>t.date===d);
    if (dt.length===0) continue;
    console.log(`    ${d}: ${dt.length}件 ${dt.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円`);
  }
  
  // 銘柄別
  console.log("\n  銘柄別:");
  for (const s of SYMBOLS) {
    const st = tradesA.filter(t=>t.sym===s);
    if (st.length===0) continue;
    console.log(`    ${s}: ${st.length}件 ${st.filter(t=>t.pnl>0).length}勝${st.filter(t=>t.pnl<=0).length}敗 ${st.reduce((s2,t)=>s2+t.pnl,0).toLocaleString()}円`);
  }
  
  // maDeviation分布
  console.log("\n  MA乖離分布（勝ち vs 負け）:");
  // 勝ち取引のMA乖離を再計算するのは難しいので、件数だけ出す
  
  console.log("\n=== 30日全ロジックsim内の前場ブースト158件との比較 ===");
  console.log(`  パターンA（LONGのみ）: ${tradesA.length}件 ${totalA.toLocaleString()}円`);
  console.log(`  30日全ロジック内: 158件 -269,719円`);
  console.log(`  差: ${tradesA.length - 158}件の差 = SHORTとの競合で${tradesA.length - 158}件が失われた`);
  
  process.exit(0);
}
main();
