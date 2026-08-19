import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// 本日の理想エントリーの共通点:
// LONG(前場): 寄り付き直後の急上昇。MA乖離>0.5%、実体>0.2%でバイパス不可。
//   → 共通: isBullish=true + 直近高値更新 + 出来高あり + 寄り付き30分以内
// SHORT(前場後半〜後場): 上昇後の反転下落。isBullishが2-3分で解除される。
//   → 共通: 大台割れ or 直近安値更新 + isBullish解除直後
//
// 改善案:
// 案A: 寄り付きブースト（09:30〜10:00限定で、バイパス条件を緩和）
//   - MA乖離<1.0%、実体<0.5%、陰線≤5本に緩和（寄り付き30分のみ）
// 案B: 出来高ブレイクアウトLONG（出来高1.5倍以上 + 直近高値更新でLONG即エントリー）
//   - SHORTの即エントリーと同じ発想をLONGに適用
// 案C: 大台超えLONGの条件付き復活（isBullish=true + 出来高1.5倍以上 + 前場のみ）

const SL_MAP: Record<string, number> = { "8035":0.5,"6857":0.6,"6976":0.6,"6526":0.9,"5803":0.5,"6981":0.4,"285A":0.8,"6146":0.8,"6594":0.5,"8316":0.5 };
const LOTS: Record<string, number> = { "8035":100,"6857":100,"285A":100,"6146":100,"6976":200,"6981":300,"8316":400,"5803":400,"6526":1400,"6594":1000 };
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];
const TP_LONG = 0.5;

async function main() {
  const db = await getDb();
  const [dates] = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='8035' ORDER BY tradeDate DESC LIMIT 21`);
  const tradeDates = (dates as any[]).map(d => d.tradeDate).reverse();
  const simDates = tradeDates.slice(1);
  console.log(`対象: ${simDates[0]}〜${simDates[simDates.length-1]}（${simDates.length}営業日）\n`);
  
  const allData: Record<string, Record<string, any[]>> = {};
  for (const sym of SYMBOLS) {
    const [rows] = await db.execute(sql`SELECT tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol=${sym} AND tradeDate>=${tradeDates[0]} ORDER BY tradeDate, candleTime`);
    allData[sym] = {};
    for (const r of rows as any[]) {
      if (!allData[sym][r.tradeDate]) allData[sym][r.tradeDate] = [];
      allData[sym][r.tradeDate].push({...r, open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume:+r.volume});
    }
  }
  
  // 各案をシミュレーション
  const proposals = [
    { name: "現行（静かな上昇バイパスのみ）", maDevMax: 0.5, bodyMax: 0.2, bearMax: 4, timeLimit: 0, volMin: 0, roundOk: false },
    { name: "案A: 寄り付きブースト（09:30-10:00のみ緩和）", maDevMax: 1.0, bodyMax: 0.5, bearMax: 5, timeLimit: 600, volMin: 0, roundOk: false },
    { name: "案B: 出来高ブレイクLONG（vol≥1.5x + 高値更新）", maDevMax: 999, bodyMax: 999, bearMax: 999, timeLimit: 0, volMin: 1.5, roundOk: false },
    { name: "案C: 大台超えLONG復活（isBullish + vol≥1.5x + 前場のみ）", maDevMax: 999, bodyMax: 999, bearMax: 999, timeLimit: 690, volMin: 1.5, roundOk: true },
    { name: "案D: 案A+B統合（寄り付き緩和 or 出来高ブレイク）", maDevMax: 1.0, bodyMax: 0.5, bearMax: 5, timeLimit: 600, volMin: 1.5, roundOk: false },
  ];
  
  for (const p of proposals) {
    let trades: any[] = [];
    
    for (const sym of SYMBOLS) {
      let buffer: any[] = allData[sym][tradeDates[0]] || [];
      
      for (const date of simDates) {
        const dayCandles = allData[sym][date] || [];
        if (dayCandles.length < 10) continue;
        let position: any = null;
        let slAfterTime: number | null = null;
        
        for (let i = 0; i < dayCandles.length; i++) {
          const c = dayCandles[i]; buffer.push(c); if (buffer.length > 300) buffer = buffer.slice(-300);
          const [h, m] = c.candleTime.split(":").map(Number); const timeMin = h*60+m;
          
          // 決済
          if (position) {
            if (timeMin >= 687 && timeMin < 750) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots), exit:"前場"}); position=null; continue; }
            if (timeMin >= 925) { trades.push({...position, pnl: Math.round((c.close-position.price)*position.lots), exit:"大引け"}); position=null; continue; }
            const slP = position.price*(1-(SL_MAP[sym]||0.5)/100); const tpP = position.price*(1+TP_LONG/100);
            if (c.low<=slP) { trades.push({...position, pnl: Math.round((slP-position.price)*position.lots), exit:"SL"}); slAfterTime=timeMin; position=null; continue; }
            if (c.high>=tpP) { trades.push({...position, pnl: Math.round((tpP-position.price)*position.lots), exit:"TP"}); position=null; continue; }
            continue;
          }
          
          if (timeMin<570||timeMin>=905||position) continue;
          if (timeMin>=750&&timeMin<770) continue;
          if (slAfterTime && timeMin-slAfterTime<30) continue;
          
          // isBullish
          if (buffer.length < 9) continue;
          const ma = buffer.slice(-8).reduce((s:number,b:any)=>s+b.close,0)/8;
          const prevMa = buffer.slice(-9,-1).reduce((s:number,b:any)=>s+b.close,0)/8;
          const isBullish = ((ma-prevMa)/prevMa*100) > 0;
          if (!isBullish) continue;
          
          // 直近高値更新
          if (buffer.length < 21) continue;
          const recent20 = buffer.slice(-21, -1);
          const maxHigh = Math.max(...recent20.map((b:any)=>b.high));
          if (c.close <= maxHigh) continue;
          
          // 出来高
          const vol20 = buffer.length >= 21 ? buffer.slice(-21,-1).reduce((s:number,b:any)=>s+b.volume,0)/20 : 0;
          const volRatio = vol20 > 0 ? c.volume / vol20 : 0;
          
          // 大台超えチェック
          let isRoundBreak = false;
          if (i > 0) {
            const prev = buffer[buffer.length - 2];
            for (const rl of [100,500,1000,5000,10000]) {
              const near = Math.ceil(c.close/rl)*rl;
              if (prev.close < near && c.close >= near) { isRoundBreak = true; break; }
            }
          }
          
          // バイパス条件
          const maDeviation = Math.abs((c.close - ma) / ma * 100);
          const barBody = Math.abs((c.close - c.open) / c.open * 100);
          const bearBars = buffer.slice(-10).filter((b:any)=>b.close<b.open).length;
          
          let canEntry = false;
          
          if (p.name.includes("案D")) {
            // 案D: 寄り付き緩和 OR 出来高ブレイク
            const inMorning = timeMin <= 600; // 09:30-10:00
            if (inMorning && maDeviation < p.maDevMax && barBody < p.bodyMax && bearBars <= p.bearMax) canEntry = true;
            if (volRatio >= p.volMin && !isRoundBreak) canEntry = true; // 出来高ブレイク（大台超え以外）
            // 現行バイパスも維持
            if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) canEntry = true;
          } else if (p.name.includes("案C")) {
            // 案C: 大台超えLONG復活（条件付き）
            if (isRoundBreak && volRatio >= p.volMin && (p.timeLimit === 0 || timeMin <= p.timeLimit)) canEntry = true;
            // 現行バイパスも維持
            if (!isRoundBreak && maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) canEntry = true;
          } else if (p.name.includes("案B")) {
            // 案B: 出来高ブレイクLONG
            if (volRatio >= p.volMin && !isRoundBreak) canEntry = true;
            // 現行バイパスも維持
            if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) canEntry = true;
          } else if (p.name.includes("案A")) {
            // 案A: 寄り付き緩和
            const inMorning = timeMin <= p.timeLimit; // 09:30-10:00
            if (inMorning && maDeviation < p.maDevMax && barBody < p.bodyMax && bearBars <= p.bearMax) canEntry = true;
            // 通常時間は現行バイパス
            if (!inMorning && maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) canEntry = true;
          } else {
            // 現行
            if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) canEntry = true;
          }
          
          // 大台超えLONG停止（案C以外）
          if (isRoundBreak && !p.roundOk) canEntry = false;
          
          if (canEntry) {
            position = { sym, date, time: c.candleTime, price: c.close, lots: LOTS[sym]||100, timeSlot: timeMin<690?"前場":"後場", method: isRoundBreak?"大台超え":"高値更新" };
          }
        }
        if (position) { const last=dayCandles[dayCandles.length-1]; trades.push({...position, pnl: Math.round((last.close-position.price)*position.lots), exit:"EOD"}); position=null; }
        buffer = dayCandles.slice(-100);
      }
    }
    
    const wins = trades.filter(t=>t.pnl>0);
    const am = trades.filter(t=>t.timeSlot==="前場");
    const pm = trades.filter(t=>t.timeSlot==="後場");
    const totalPnl = trades.reduce((s,t)=>s+t.pnl,0);
    const grossWin = wins.reduce((s,t)=>s+t.pnl,0);
    const grossLoss = Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
    const pf = grossLoss > 0 ? (grossWin/grossLoss).toFixed(2) : "∞";
    
    console.log(`\n=== ${p.name} ===`);
    console.log(`  全体: ${trades.length}件 ${wins.length}勝${trades.length-wins.length}敗 勝率${(wins.length/trades.length*100).toFixed(1)}% ${totalPnl.toLocaleString()}円 PF${pf}`);
    console.log(`  前場: ${am.length}件 ${am.filter(t=>t.pnl>0).length}勝 ${am.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString()}円`);
    console.log(`  後場: ${pm.length}件 ${pm.filter(t=>t.pnl>0).length}勝 ${pm.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString()}円`);
    console.log(`  1日平均: ${Math.round(totalPnl/simDates.length).toLocaleString()}円/日`);
    
    // 本日8/19の結果
    const today = trades.filter(t=>t.date==="2026-08-19");
    if (today.length > 0) {
      console.log(`  ★本日8/19: ${today.length}件 ${today.filter(t=>t.pnl>0).length}勝 ${today.reduce((s:number,t:any)=>s+t.pnl,0).toLocaleString()}円`);
      for (const t of today) console.log(`    ${t.time} ${t.sym} @${t.price} ${t.method} → ${t.exit} ${t.pnl>0?"+":""}${t.pnl.toLocaleString()}円`);
    }
  }
  
  process.exit(0);
}
main();
