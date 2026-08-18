/**
 * SHORTシグナル別 + 静かな上昇バイパスのMA期間別最適値検証（20営業日）
 * 
 * SHORTの各シグナル: isBullish=true → ブロック。MA期間を変えてどのシグナルに最適か検証
 * 静かな上昇バイパス: isBullish=true が必須条件。MA期間を変えてバイパス発動率と損益を検証
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
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_VOL_LOOKBACK = 20;
const FAST_ENTRY_PREV_DIST_PCT = 0.05;

function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  if (price >= 100000) { const b = Math.floor(price/1000)*1000; for(let i=-3;i<=3;i++) levels.push(b+i*1000); }
  else if (price >= 10000) { const b = Math.floor(price/500)*500; for(let i=-3;i<=3;i++) levels.push(b+i*500); }
  else if (price >= 5000) { const b = Math.floor(price/200)*200; for(let i=-3;i<=3;i++) levels.push(b+i*200); }
  else if (price >= 2000) { const b = Math.floor(price/100)*100; for(let i=-3;i<=3;i++) levels.push(b+i*100); }
  else { const b = Math.floor(price/50)*50; for(let i=-3;i<=3;i++) levels.push(b+i*50); }
  return levels.filter(l => l > 0);
}

function calcIsBullish(closes: number[], maPeriod: number): boolean {
  if (closes.length < maPeriod + 1) return false;
  const cur = closes.slice(closes.length - maPeriod);
  const prev = closes.slice(closes.length - maPeriod - 1, closes.length - 1);
  const ma = cur.reduce((s, v) => s + v, 0) / maPeriod;
  const prevMa = prev.reduce((s, v) => s + v, 0) / maPeriod;
  return (ma - prevMa) / prevMa * 100 > 0;
}

interface Trade { pnl: number; signal: string; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 22
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const dates = allDates.slice(2); // 20営業日
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${allDates.map((d: string) => `'${d}'`).join(',')})
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY symbol, tradeDate, candleTime
  `) as any[];

  const rawBuffers: Record<string, any[]> = {};
  for (const r of allRows as any[]) {
    if (!rawBuffers[r.symbol]) rawBuffers[r.symbol] = [];
    rawBuffers[r.symbol].push({ date: String(r.tradeDate), c: { t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) } });
  }

  const periods = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30];

  // === SHORT シグナル別 ===
  console.log(`=== SHORT シグナル別 MA最適値 ===`);
  console.log(`(isBullish=true → SHORTブロック。MA期間が短い→反応早い→ブロック多い)\n`);

  for (const signalType of ["大台割れ(即vol)", "大台割れ(即4a)", "大台割れ(CB2)", "大台超え逆張り"]) {
    console.log(`--- ${signalType} ---`);
    console.log(`| MA期間 | 件数 | 勝率 | 損益 | PF |`);
    console.log(`|--------|------|------|------|-----|`);

    for (const maPeriod of periods) {
      const trades: Trade[] = [];
      for (const date of dates) {
        for (const symbol of SYMBOLS) {
          const allBuf = rawBuffers[symbol];
          if (!allBuf) continue;
          const todayCandles = allBuf.filter((b: any) => b.date === date).map((b: any) => b.c);
          if (todayCandles.length < 25) continue;
          const prevDayCloses = allBuf.filter((b: any) => b.date < date).map((b: any) => b.c.c);

          for (let i = 1; i < todayCandles.length; i++) {
            const candle = todayCandles[i];
            if (candle.t < "09:30" || candle.t >= "15:05") continue;
            if (candle.t >= "12:30" && candle.t < "12:50") continue;

            const allCloses = [...prevDayCloses, ...todayCandles.slice(0, i + 1).map((c: any) => c.c)];
            const isBullish = calcIsBullish(allCloses, maPeriod);
            if (isBullish) continue; // ブロック

            const prevCandle = todayCandles[i - 1];
            if (!prevCandle) continue;
            const levels = getRoundLevels(prevCandle.c);

            if (signalType.startsWith("大台割れ")) {
              for (const level of levels) {
                if (prevCandle.c >= level && candle.c < level) {
                  const volAvg = i >= FAST_ENTRY_VOL_LOOKBACK
                    ? todayCandles.slice(i - FAST_ENTRY_VOL_LOOKBACK, i).reduce((s: number, c: any) => s + c.v, 0) / FAST_ENTRY_VOL_LOOKBACK : 0;
                  const volRatio = volAvg > 0 ? candle.v / volAvg : 0;
                  const prevDistPct = (prevCandle.c - level) / level * 100;

                  let sig = "大台割れ(CB2)";
                  if (volRatio >= FAST_ENTRY_VOL_RATIO) sig = "大台割れ(即vol)";
                  else if (prevDistPct <= FAST_ENTRY_PREV_DIST_PCT) sig = "大台割れ(即4a)";

                  if (sig !== signalType) break;

                  // シミュレート: 後続の足でSL/TP判定
                  const sl = SL_MAP[symbol]?.short || 0.8;
                  const slPrice = candle.c * (1 + sl / 100);
                  const tpPrice = candle.c * (1 - TP_PCT / 100);
                  let pnl = 0;
                  for (let j = i + 1; j < todayCandles.length; j++) {
                    const fc = todayCandles[j];
                    if (fc.t >= "11:27" && fc.t < "11:30") { pnl = Math.round((candle.c - fc.c) * (Math.floor(3000000 / candle.c / 100) * 100 || 100)); break; }
                    if (fc.t >= "15:25") { pnl = Math.round((candle.c - fc.c) * (Math.floor(3000000 / candle.c / 100) * 100 || 100)); break; }
                    if (fc.h >= slPrice) { pnl = Math.round((candle.c - slPrice) * (Math.floor(3000000 / candle.c / 100) * 100 || 100)); break; }
                    if (fc.l <= tpPrice) { pnl = Math.round((candle.c - tpPrice) * (Math.floor(3000000 / candle.c / 100) * 100 || 100)); break; }
                    if (j === todayCandles.length - 1) { pnl = Math.round((candle.c - fc.c) * (Math.floor(3000000 / candle.c / 100) * 100 || 100)); }
                  }
                  trades.push({ pnl, signal: sig });
                  break;
                }
              }
            } else if (signalType === "大台超え逆張り") {
              const recentBars = todayCandles.slice(Math.max(0, i - 3), i);
              const bullBars = recentBars.filter((c: any) => c.c > c.o).length;
              if (bullBars >= 2) {
                for (const level of levels) {
                  if (prevCandle.c <= level && candle.c > level) {
                    const sl = SL_MAP[symbol]?.short || 0.8;
                    const slPrice = candle.c * (1 + sl / 100);
                    const tpPrice = candle.c * (1 - TP_PCT / 100);
                    let pnl = 0;
                    const shares = Math.floor(3000000 / candle.c / 100) * 100 || 100;
                    for (let j = i + 1; j < todayCandles.length; j++) {
                      const fc = todayCandles[j];
                      if (fc.t >= "11:27" && fc.t < "11:30") { pnl = Math.round((candle.c - fc.c) * shares); break; }
                      if (fc.t >= "15:25") { pnl = Math.round((candle.c - fc.c) * shares); break; }
                      if (fc.h >= slPrice) { pnl = Math.round((candle.c - slPrice) * shares); break; }
                      if (fc.l <= tpPrice) { pnl = Math.round((candle.c - tpPrice) * shares); break; }
                      if (j === todayCandles.length - 1) { pnl = Math.round((candle.c - fc.c) * shares); }
                    }
                    trades.push({ pnl, signal: "大台超え逆張り" });
                    break;
                  }
                }
              }
            }
          }
        }
      }
      const wins = trades.filter(t => t.pnl > 0).length;
      const pnl = trades.reduce((s, t) => s + t.pnl, 0);
      const gross = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const loss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
      const pf = loss > 0 ? (gross / loss).toFixed(2) : "∞";
      console.log(`| MA${maPeriod} | ${trades.length}件 | ${trades.length > 0 ? (wins/trades.length*100).toFixed(1) : 0}% | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円 | ${pf} |`);
    }
    console.log("");
  }

  // === 静かな上昇バイパス ===
  console.log(`\n=== 静かな上昇バイパス MA最適値 ===`);
  console.log(`(isBullish=true が必須条件。MA期間が短い→isBullish=trueになりやすい→バイパス発動しやすい)\n`);

  // スコア0ブロック記録を取得
  const [blockRows] = await conn.query(`
    SELECT trade_date, symbol, candle_time, entry_price FROM rt_score0_blocks
    WHERE side = 'BUY' ORDER BY trade_date, candle_time
  `) as any[];

  console.log(`| MA期間 | バイパス件数 | 勝率 | 損益 | PF |`);
  console.log(`|--------|------------|------|------|-----|`);

  for (const maPeriod of periods) {
    const trades: Trade[] = [];
    for (const block of blockRows as any[]) {
      const date = String(block.trade_date);
      const symbol = block.symbol;
      const time = block.candle_time;
      const entryPrice = Number(block.entry_price);

      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const todayCandles = allBuf.filter((b: any) => b.date === date).map((b: any) => b.c);
      const prevDayCloses = allBuf.filter((b: any) => b.date < date).map((b: any) => b.c.c);

      // エントリー足のインデックスを探す
      const entryIdx = todayCandles.findIndex((c: any) => c.t === time);
      if (entryIdx < 0) continue;
      const candle = todayCandles[entryIdx];

      // isBullish計算
      const allCloses = [...prevDayCloses, ...todayCandles.slice(0, entryIdx + 1).map((c: any) => c.c)];
      const isBullish = calcIsBullish(allCloses, maPeriod);
      if (!isBullish) continue; // バイパスにはisBullish=true必須

      // MA乖離計算（MA20固定 — バイパスのMA乖離計算は常にMA20）
      const ma20Period = 20;
      if (allCloses.length < ma20Period) continue;
      const ma20 = allCloses.slice(allCloses.length - ma20Period).reduce((s, v) => s + v, 0) / ma20Period;
      const maDeviation = (candle.c - ma20) / ma20 * 100;
      const barBody = Math.abs(candle.c - candle.o) / candle.o * 100;
      const recentBearBars = entryIdx >= 10
        ? todayCandles.slice(entryIdx - 10, entryIdx).filter((c: any) => c.c < c.o).length
        : 999;

      // 緩和A条件
      if (!(maDeviation < 0.5 && barBody < 0.2 && recentBearBars <= 4)) continue;

      // シミュレート
      const sl = SL_MAP[symbol]?.long || 0.5;
      const slPrice = entryPrice * (1 - sl / 100);
      const tpPrice = entryPrice * (1 + TP_PCT / 100);
      const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;
      let pnl = 0;
      for (let j = entryIdx + 1; j < todayCandles.length; j++) {
        const fc = todayCandles[j];
        if (fc.t >= "11:27" && fc.t < "11:30") { pnl = Math.round((fc.c - entryPrice) * shares); break; }
        if (fc.t >= "15:25") { pnl = Math.round((fc.c - entryPrice) * shares); break; }
        if (fc.l <= slPrice) { pnl = Math.round((slPrice - entryPrice) * shares); break; }
        if (fc.h >= tpPrice) { pnl = Math.round((tpPrice - entryPrice) * shares); break; }
        if (j === todayCandles.length - 1) { pnl = Math.round((fc.c - entryPrice) * shares); }
      }
      trades.push({ pnl, signal: "バイパス" });
    }
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const gross = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const loss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const pf = loss > 0 ? (gross / loss).toFixed(2) : "∞";
    console.log(`| MA${maPeriod} | ${trades.length}件 | ${trades.length > 0 ? (wins/trades.length*100).toFixed(1) : 0}% | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円 | ${pf} |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
