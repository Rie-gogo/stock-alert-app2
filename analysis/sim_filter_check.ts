/**
 * ATRフィルターと3分足HTFフィルターの必要性検証
 * 本番エンジンのrt_tradesデータと、ブロックされたシグナルの仮想エントリーを比較
 * 
 * 方法: 20営業日のrt_candlesから大台割れSHORTとダウ理論LONGを検出し、
 * ATRフィルターとHTFフィルターの有無で結果がどう変わるかを比較
 */
import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, {long: number; short: number}> = {
  "8035": {long:0.5, short:0.8}, "6857": {long:0.6, short:0.6}, "6976": {long:0.6, short:0.8},
  "6526": {long:0.9, short:1.0}, "5803": {long:0.5, short:0.6}, "6981": {long:0.4, short:0.9},
  "285A": {long:0.8, short:0.6}, "6146": {long:0.8, short:0.8}, "6594": {long:0.5, short:0.5},
  "8316": {long:0.5, short:0.5},
};
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];
const ATR_PERIOD = 7;
const ATR_THRESHOLD = 0.0012;

function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  if (price >= 100000) { const b = Math.floor(price/1000)*1000; for(let i=-3;i<=3;i++) levels.push(b+i*1000); }
  else if (price >= 10000) { const b = Math.floor(price/500)*500; for(let i=-3;i<=3;i++) levels.push(b+i*500); }
  else if (price >= 5000) { const b = Math.floor(price/200)*200; for(let i=-3;i<=3;i++) levels.push(b+i*200); }
  else if (price >= 2000) { const b = Math.floor(price/100)*100; for(let i=-3;i<=3;i++) levels.push(b+i*100); }
  else { const b = Math.floor(price/50)*50; for(let i=-3;i<=3;i++) levels.push(b+i*50); }
  return levels.filter(l => l > 0);
}

function calcATR(highs: number[], lows: number[], closes: number[], period: number): number[] {
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    trs.push(tr);
  }
  const atrs: number[] = [];
  if (trs.length >= period) {
    let sum = trs.slice(0, period).reduce((s, v) => s + v, 0);
    atrs.push(sum / period);
    for (let i = period; i < trs.length; i++) {
      const atr = (atrs[atrs.length-1] * (period-1) + trs[i]) / period;
      atrs.push(atr);
    }
  }
  return atrs;
}

function get3mTrend(candles: {c: number}[], idx: number): "up"|"down"|"neutral" {
  if (idx < 3) return "neutral";
  const c0 = candles[idx].c;
  const c3 = candles[idx - 3].c;
  const pct = (c0 - c3) / c3 * 100;
  if (pct > 0.05) return "up";
  if (pct < -0.05) return "down";
  return "neutral";
}

interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 21
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const prevDate = allDates[0];
  const dates = allDates.slice(1);
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${allDates.map((d: string) => `'${d}'`).join(',')})
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY symbol, tradeDate, candleTime
  `) as any[];

  const rawBuffers: Record<string, {date: string; c: C}[]> = {};
  for (const r of allRows as any[]) {
    if (!rawBuffers[r.symbol]) rawBuffers[r.symbol] = [];
    rawBuffers[r.symbol].push({ date: String(r.tradeDate), c: { t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) } });
  }

  // 3パターンで比較: 全フィルターあり / ATRなし / HTFなし / 両方なし
  interface Trade { date: string; time: string; symbol: string; side: string; pnl: number; atrBlocked: boolean; htfBlocked: boolean; }
  const allTrades: Trade[] = [];

  for (const date of dates) {
    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const bufUpToDate = allBuf.filter(b => b.date <= date);
      const todayCandles = allBuf.filter(b => b.date === date).map(b => b.c);
      if (todayCandles.length < 25) continue;

      let inPosition = false;

      for (let i = 20; i < todayCandles.length; i++) {
        const candle = todayCandles[i];
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;
        if (inPosition) continue;

        const globalIdx = bufUpToDate.findIndex(b => b.date === date && b.c.t === candle.t);
        if (globalIdx < 21) continue;

        // isBullish
        const w = bufUpToDate.slice(globalIdx - 19, globalIdx + 1).map(b => b.c);
        const pw = bufUpToDate.slice(globalIdx - 20, globalIdx).map(b => b.c);
        const ma20 = w.reduce((s, c) => s + c.c, 0) / 20;
        const prevMa20 = pw.reduce((s, c) => s + c.c, 0) / 20;
        const isBullish = (ma20 - prevMa20) / prevMa20 * 100 > 0;

        // 大台割れSHORT検出
        const prevClose = todayCandles[i-1].c;
        const currClose = candle.c;
        const levels = getRoundLevels(prevClose);
        let shortSignal = false;
        for (const level of levels) {
          if (prevClose >= level && currClose < level && !isBullish) {
            shortSignal = true; break;
          }
        }

        if (!shortSignal) continue;

        // ATRフィルター判定
        let atrBlocked = false;
        if (globalIdx >= ATR_PERIOD + 1) {
          const slice = bufUpToDate.slice(globalIdx - ATR_PERIOD, globalIdx + 1).map(b => b.c);
          const highs = slice.map(c => c.h);
          const lows = slice.map(c => c.l);
          const closes = slice.map(c => c.c);
          const atrs = calcATR(highs, lows, closes, ATR_PERIOD);
          if (atrs.length > 0) {
            const atrRatio = atrs[atrs.length-1] / candle.c;
            if (atrRatio < ATR_THRESHOLD) atrBlocked = true;
          }
        }

        // HTFフィルター判定
        let htfBlocked = false;
        const trend3m = get3mTrend(todayCandles.map(c => ({c: c.c})), i);
        if (trend3m === "up") htfBlocked = true; // SHORT時にupならブロック

        // シミュレーション
        const sl = SL_MAP[symbol]?.short || 0.8;
        const price = candle.c;
        const shares = Math.floor(3000000 / price / 100) * 100 || 100;
        const slPrice = price * (1 + sl / 100);
        const tpPrice = price * (1 - TP_PCT / 100);
        let pnl = 0;
        for (let j = i + 1; j < todayCandles.length; j++) {
          if (todayCandles[j].t >= "11:27" && todayCandles[j].t < "11:30") { pnl = Math.round((price - todayCandles[j].c) * shares); break; }
          if (todayCandles[j].t >= "15:25") { pnl = Math.round((price - todayCandles[j].c) * shares); break; }
          if (todayCandles[j].h >= slPrice) { pnl = Math.round((price - slPrice) * shares); break; }
          if (todayCandles[j].l <= tpPrice) { pnl = Math.round((price - tpPrice) * shares); break; }
        }

        allTrades.push({ date, time: candle.t, symbol, side: "short", pnl, atrBlocked, htfBlocked });
        inPosition = true; // 同一銘柄1日1回制限
      }
    }
  }

  // 集計
  const withBoth = allTrades.filter(t => !t.atrBlocked && !t.htfBlocked);
  const withoutATR = allTrades.filter(t => !t.htfBlocked); // ATRフィルターなし
  const withoutHTF = allTrades.filter(t => !t.atrBlocked); // HTFフィルターなし
  const withoutBoth = allTrades; // 両方なし

  const atrOnly = allTrades.filter(t => t.atrBlocked && !t.htfBlocked); // ATRだけでブロック
  const htfOnly = allTrades.filter(t => t.htfBlocked && !t.atrBlocked); // HTFだけでブロック
  const bothBlocked = allTrades.filter(t => t.atrBlocked && t.htfBlocked);

  function summary(trades: Trade[], label: string) {
    const cnt = trades.length;
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const gp = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? (gp/gl).toFixed(2) : "∞";
    return `| ${label} | ${cnt}件 | ${cnt > 0 ? (wins/cnt*100).toFixed(1) : "-"}% (${wins}勝${cnt-wins}敗) | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円 | ${pf} |`;
  }

  console.log(`=== ATRフィルター・HTFフィルター必要性検証（大台割れSHORT）===\n`);
  console.log(`全シグナル: ${allTrades.length}件`);
  console.log(`  ATRブロック: ${allTrades.filter(t=>t.atrBlocked).length}件`);
  console.log(`  HTFブロック: ${allTrades.filter(t=>t.htfBlocked).length}件`);
  console.log(`  両方ブロック: ${bothBlocked.length}件`);
  console.log(`  どちらも通過: ${withBoth.length}件\n`);

  console.log(`| パターン | 件数 | 勝率 | 損益 | PF |`);
  console.log(`|----------|------|------|------|-----|`);
  console.log(summary(withBoth, "現行（両方あり）"));
  console.log(summary(withoutATR, "ATRフィルターなし"));
  console.log(summary(withoutHTF, "HTFフィルターなし"));
  console.log(summary(withoutBoth, "両方なし"));

  console.log(`\n--- ブロックされた取引の内訳 ---\n`);
  console.log(`| ブロック理由 | 件数 | 勝率 | 損益 | PF | 判定 |`);
  console.log(`|-------------|------|------|------|-----|------|`);
  console.log(summary(atrOnly, "ATRのみでブロック") + " " + (atrOnly.reduce((s,t)=>s+t.pnl,0) < 0 ? "ブロック正解" : "★過剰ブロック"));
  console.log(summary(htfOnly, "HTFのみでブロック") + " " + (htfOnly.reduce((s,t)=>s+t.pnl,0) < 0 ? "ブロック正解" : "★過剰ブロック"));
  console.log(summary(bothBlocked, "両方でブロック") + " " + (bothBlocked.reduce((s,t)=>s+t.pnl,0) < 0 ? "ブロック正解" : "★過剰ブロック"));

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
