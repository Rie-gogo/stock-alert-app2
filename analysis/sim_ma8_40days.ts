/**
 * MA8統一 全シグナル 40営業日シミュレーション
 * isBullish(MA8傾き>0%) = true → SHORTブロック
 * 対象: 大台割れSHORT(即vol/即4a/CB2) + 大台超え逆張りSHORT
 * ※LONGにはisBullishフィルターは適用されない（本番エンジンと同じ）
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
const NO_REENTRY_MIN = 30;

function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  if (price >= 100000) { const b = Math.floor(price/1000)*1000; for(let i=-3;i<=3;i++) levels.push(b+i*1000); }
  else if (price >= 10000) { const b = Math.floor(price/500)*500; for(let i=-3;i<=3;i++) levels.push(b+i*500); }
  else if (price >= 5000) { const b = Math.floor(price/200)*200; for(let i=-3;i<=3;i++) levels.push(b+i*200); }
  else if (price >= 2000) { const b = Math.floor(price/100)*100; for(let i=-3;i<=3;i++) levels.push(b+i*100); }
  else { const b = Math.floor(price/50)*50; for(let i=-3;i<=3;i++) levels.push(b+i*50); }
  return levels.filter(l => l > 0);
}

function timeToMin(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

function calcIsBullish(closes: number[], maPeriod: number): boolean {
  if (closes.length < maPeriod + 1) return false;
  const cur = closes.slice(closes.length - maPeriod);
  const prev = closes.slice(closes.length - maPeriod - 1, closes.length - 1);
  const ma = cur.reduce((s, v) => s + v, 0) / maPeriod;
  const prevMa = prev.reduce((s, v) => s + v, 0) / maPeriod;
  return (ma - prevMa) / prevMa * 100 > 0;
}

interface Trade { pnl: number; signal: string; symbol: string; date: string; time: string; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);

  // 42日分取得（40営業日 + 前日バッファ用2日）
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 42
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const dates = allDates.slice(2); // 前日バッファ用に2日分確保
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

  // MA8とMA20の両方でシミュレーション
  for (const maPeriod of [8, 20]) {
    const trades: Trade[] = [];

    for (const date of dates) {
      const positions: Record<string, {price: number; shares: number; signal: string; entryMin: number}> = {};
      const lastSLTime: Record<string, number> = {};

      for (const symbol of SYMBOLS) {
        const allBuf = rawBuffers[symbol];
        if (!allBuf) continue;
        const todayCandles = allBuf.filter((b: any) => b.date === date).map((b: any) => b.c);
        if (todayCandles.length < 10) continue;
        const prevDayCloses = allBuf.filter((b: any) => b.date < date).map((b: any) => b.c.c);

        for (let i = 1; i < todayCandles.length; i++) {
          const candle = todayCandles[i];
          const tMin = timeToMin(candle.t);

          // 前場強制決済
          if (candle.t >= "11:27" && candle.t < "11:30" && positions[symbol]) {
            const pos = positions[symbol];
            trades.push({ pnl: Math.round((pos.price - candle.c) * pos.shares), signal: pos.signal, symbol, date, time: candle.t });
            delete positions[symbol]; continue;
          }
          // 大引け強制決済
          if (candle.t >= "15:25" && positions[symbol]) {
            const pos = positions[symbol];
            trades.push({ pnl: Math.round((pos.price - candle.c) * pos.shares), signal: pos.signal, symbol, date, time: candle.t });
            delete positions[symbol]; continue;
          }

          // ポジション管理
          if (positions[symbol]) {
            const pos = positions[symbol];
            const sl = SL_MAP[symbol]?.short || 0.8;
            const slPrice = pos.price * (1 + sl / 100);
            const tpPrice = pos.price * (1 - TP_PCT / 100);
            if (candle.h >= slPrice) { trades.push({ pnl: Math.round((pos.price - slPrice) * pos.shares), signal: pos.signal, symbol, date, time: candle.t }); lastSLTime[symbol] = tMin; delete positions[symbol]; }
            else if (candle.l <= tpPrice) { trades.push({ pnl: Math.round((pos.price - tpPrice) * pos.shares), signal: pos.signal, symbol, date, time: candle.t }); delete positions[symbol]; }
            continue;
          }

          // エントリー条件
          if (candle.t < "09:30" || candle.t >= "15:05") continue;
          if (candle.t >= "12:30" && candle.t < "12:50") continue;
          if (positions[symbol]) continue;
          if (lastSLTime[symbol] && tMin - lastSLTime[symbol] < NO_REENTRY_MIN) continue;

          const allCloses = [...prevDayCloses, ...todayCandles.slice(0, i + 1).map((c: any) => c.c)];
          const isBullish = calcIsBullish(allCloses, maPeriod);
          if (isBullish) continue; // SHORTブロック

          const prevCandle = todayCandles[i - 1];
          if (!prevCandle) continue;
          const levels = getRoundLevels(prevCandle.c);
          const shares = Math.floor(3000000 / candle.c / 100) * 100 || 100;

          // 大台割れSHORT
          for (const level of levels) {
            if (prevCandle.c >= level && candle.c < level) {
              const volAvg = i >= FAST_ENTRY_VOL_LOOKBACK
                ? todayCandles.slice(i - FAST_ENTRY_VOL_LOOKBACK, i).reduce((s: number, c: any) => s + c.v, 0) / FAST_ENTRY_VOL_LOOKBACK : 0;
              const volRatio = volAvg > 0 ? candle.v / volAvg : 0;
              const prevDistPct = (prevCandle.c - level) / level * 100;

              let signal = "大台割れ(CB2)";
              if (volRatio >= FAST_ENTRY_VOL_RATIO) signal = "大台割れ(即vol)";
              else if (prevDistPct <= FAST_ENTRY_PREV_DIST_PCT) signal = "大台割れ(即4a)";

              positions[symbol] = { price: candle.c, shares, signal, entryMin: tMin };
              break;
            }
          }

          // 大台超え逆張りSHORT（buy_pressure相当: 直近3本中2本陽線）
          if (!positions[symbol]) {
            const recentBars = todayCandles.slice(Math.max(0, i - 3), i);
            const bullBars = recentBars.filter((c: any) => c.c > c.o).length;
            if (bullBars >= 2) {
              for (const level of levels) {
                if (prevCandle.c <= level && candle.c > level) {
                  positions[symbol] = { price: candle.c, shares, signal: "大台超え逆張り", entryMin: tMin };
                  break;
                }
              }
            }
          }
        }

        // 残ポジション決済
        if (positions[symbol]) {
          const lastCandle = todayCandles[todayCandles.length - 1];
          const pos = positions[symbol];
          trades.push({ pnl: Math.round((pos.price - lastCandle.c) * pos.shares), signal: pos.signal, symbol, date, time: lastCandle.t });
          delete positions[symbol];
        }
      }
    }

    // 集計
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const gross = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const loss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const pf = loss > 0 ? (gross / loss).toFixed(2) : "∞";

    console.log(`\n========== MA${maPeriod} (${dates.length}営業日) ==========`);
    console.log(`| 全体 | ${trades.length}件 | 勝率${(wins/trades.length*100).toFixed(1)}% | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円 | PF ${pf} | 1日平均${Math.round(pnl/dates.length).toLocaleString()}円 |`);

    // シグナル別
    console.log(`\n| シグナル | 件数 | 勝率 | 損益 | PF |`);
    console.log(`|----------|------|------|------|-----|`);
    for (const sig of ["大台割れ(即vol)", "大台割れ(即4a)", "大台割れ(CB2)", "大台超え逆張り"]) {
      const st = trades.filter(t => t.signal === sig);
      if (st.length === 0) continue;
      const sw = st.filter(t => t.pnl > 0).length;
      const sp = st.reduce((s, t) => s + t.pnl, 0);
      const sg = st.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const sl2 = Math.abs(st.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
      const spf = sl2 > 0 ? (sg / sl2).toFixed(2) : "∞";
      console.log(`| ${sig} | ${st.length}件 | ${(sw/st.length*100).toFixed(1)}% | ${sp >= 0 ? "+" : ""}${sp.toLocaleString()}円 | ${spf} |`);
    }

    // 銘柄別
    console.log(`\n| 銘柄 | 件数 | 勝率 | 損益 |`);
    console.log(`|------|------|------|------|`);
    for (const sym of SYMBOLS) {
      const st = trades.filter(t => t.symbol === sym);
      if (st.length === 0) continue;
      const sw = st.filter(t => t.pnl > 0).length;
      const sp = st.reduce((s, t) => s + t.pnl, 0);
      console.log(`| ${sym} | ${st.length}件 | ${(sw/st.length*100).toFixed(1)}% | ${sp >= 0 ? "+" : ""}${sp.toLocaleString()}円 |`);
    }

    // 日別
    console.log(`\n| 日付 | 件数 | 損益 |`);
    console.log(`|------|------|------|`);
    for (const d of dates) {
      const dt = trades.filter(t => t.date === d);
      if (dt.length === 0) continue;
      const dp = dt.reduce((s, t) => s + t.pnl, 0);
      console.log(`| ${d} | ${dt.length}件 | ${dp >= 0 ? "+" : ""}${dp.toLocaleString()}円 |`);
    }
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
