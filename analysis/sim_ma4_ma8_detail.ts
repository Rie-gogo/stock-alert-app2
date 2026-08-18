/**
 * MA4 vs MA8 シグナル別・方向別 詳細シミュレーション（20営業日）
 * シグナル: 大台割れSHORT(即vol/即4a/CB2), 大台超え逆張りSHORT, ダウ理論LONG, GC LONG, 逆三尊LONG
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

interface Trade { pnl: number; signal: string; side: string; symbol: string; date: string; time: string; }

async function runFullSim(maPeriod: number, dates: string[], rawBuffers: Record<string, any[]>): Promise<Trade[]> {
  const trades: Trade[] = [];

  for (const date of dates) {
    const positions: Record<string, {price: number; shares: number; side: string; signal: string}> = {};
    const lastSLTime: Record<string, number> = {};

    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const todayCandles = allBuf.filter((b: any) => b.date === date).map((b: any) => b.c);
      if (todayCandles.length < 25) continue;
      const prevDayCloses = allBuf.filter((b: any) => b.date < date).map((b: any) => b.c.c);

      for (let i = 1; i < todayCandles.length; i++) {
        const candle = todayCandles[i];
        const tMin = timeToMin(candle.t);

        // 前場強制決済
        if (candle.t >= "11:27" && candle.t < "11:30" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = pos.side === "short"
            ? Math.round((pos.price - candle.c) * pos.shares)
            : Math.round((candle.c - pos.price) * pos.shares);
          trades.push({ pnl, signal: pos.signal, side: pos.side, symbol, date, time: candle.t });
          delete positions[symbol]; continue;
        }
        // 大引け強制決済
        if (candle.t >= "15:25" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = pos.side === "short"
            ? Math.round((pos.price - candle.c) * pos.shares)
            : Math.round((candle.c - pos.price) * pos.shares);
          trades.push({ pnl, signal: pos.signal, side: pos.side, symbol, date, time: candle.t });
          delete positions[symbol]; continue;
        }

        // ポジション管理（SL/TP）
        if (positions[symbol]) {
          const pos = positions[symbol];
          const slPct = pos.side === "short" ? (SL_MAP[symbol]?.short || 0.8) : (SL_MAP[symbol]?.long || 0.5);
          if (pos.side === "short") {
            const slPrice = pos.price * (1 + slPct / 100);
            const tpPrice = pos.price * (1 - TP_PCT / 100);
            if (candle.h >= slPrice) { trades.push({ pnl: Math.round((pos.price - slPrice) * pos.shares), signal: pos.signal, side: "short", symbol, date, time: candle.t }); lastSLTime[symbol] = tMin; delete positions[symbol]; }
            else if (candle.l <= tpPrice) { trades.push({ pnl: Math.round((pos.price - tpPrice) * pos.shares), signal: pos.signal, side: "short", symbol, date, time: candle.t }); delete positions[symbol]; }
          } else {
            const slPrice = pos.price * (1 - slPct / 100);
            const tpPrice = pos.price * (1 + TP_PCT / 100);
            if (candle.l <= slPrice) { trades.push({ pnl: Math.round((slPrice - pos.price) * pos.shares), signal: pos.signal, side: "long", symbol, date, time: candle.t }); lastSLTime[symbol] = tMin; delete positions[symbol]; }
            else if (candle.h >= tpPrice) { trades.push({ pnl: Math.round((tpPrice - pos.price) * pos.shares), signal: pos.signal, side: "long", symbol, date, time: candle.t }); delete positions[symbol]; }
          }
          continue;
        }

        // エントリー条件
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;
        if (positions[symbol]) continue;
        if (lastSLTime[symbol] && tMin - lastSLTime[symbol] < NO_REENTRY_MIN) continue;

        const allCloses = [...prevDayCloses, ...todayCandles.slice(0, i + 1).map((c: any) => c.c)];
        const isBullish = calcIsBullish(allCloses, maPeriod);
        const prevCandle = todayCandles[i - 1];
        const shares = Math.floor(3000000 / candle.c / 100) * 100 || 100;

        // === SHORT シグナル ===
        if (!isBullish) {
          // 大台割れSHORT
          const levels = getRoundLevels(prevCandle.c);
          for (const level of levels) {
            if (prevCandle.c >= level && candle.c < level) {
              // 3方式判定
              const volAvg = i >= FAST_ENTRY_VOL_LOOKBACK
                ? todayCandles.slice(i - FAST_ENTRY_VOL_LOOKBACK, i).reduce((s: number, c: any) => s + c.v, 0) / FAST_ENTRY_VOL_LOOKBACK
                : 0;
              const volRatio = volAvg > 0 ? candle.v / volAvg : 0;
              const prevDistPct = (prevCandle.c - level) / level * 100;

              let signal = "大台割れ(CB2)";
              if (volRatio >= FAST_ENTRY_VOL_RATIO) signal = "大台割れ(即vol)";
              else if (prevDistPct <= FAST_ENTRY_PREV_DIST_PCT) signal = "大台割れ(即4a)";

              positions[symbol] = { price: candle.c, shares, side: "short", signal };
              break;
            }
          }

          // 大台超え逆張りSHORT（buy_pressure時）
          if (!positions[symbol]) {
            const recentBars = todayCandles.slice(Math.max(0, i - 3), i);
            const bullBars = recentBars.filter((c: any) => c.c > c.o).length;
            const buyPressure = bullBars >= 2;
            if (buyPressure) {
              for (const level of levels) {
                if (prevCandle.c <= level && candle.c > level) {
                  positions[symbol] = { price: candle.c, shares, side: "short", signal: "大台超え逆張り" };
                  break;
                }
              }
            }
          }
        }

        // === LONG シグナル ===
        if (isBullish && !positions[symbol]) {
          // ダウ理論LONG（直近20本高値更新）
          if (i >= 20) {
            const recent20 = todayCandles.slice(i - 20, i);
            const maxHigh = Math.max(...recent20.map((c: any) => c.h));
            if (candle.h > maxHigh) {
              positions[symbol] = { price: candle.c, shares, side: "long", signal: "ダウ理論" };
            }
          }

          // GC LONG（MA5 > MA20クロス）
          if (!positions[symbol] && i >= 20) {
            const ma5 = todayCandles.slice(i - 4, i + 1).reduce((s: number, c: any) => s + c.c, 0) / 5;
            const prevMa5 = todayCandles.slice(i - 5, i).reduce((s: number, c: any) => s + c.c, 0) / 5;
            const ma20 = todayCandles.slice(i - 19, i + 1).reduce((s: number, c: any) => s + c.c, 0) / 20;
            const prevMa20 = todayCandles.slice(i - 20, i).reduce((s: number, c: any) => s + c.c, 0) / 20;
            if (prevMa5 <= prevMa20 && ma5 > ma20) {
              positions[symbol] = { price: candle.c, shares, side: "long", signal: "GC" };
            }
          }

          // 逆三尊LONG（簡易W底）
          if (!positions[symbol] && i >= 30) {
            const recent30 = todayCandles.slice(i - 30, i);
            const minLow = Math.min(...recent30.map((c: any) => c.l));
            const minIdx = recent30.findIndex((c: any) => c.l === minLow);
            if (minIdx >= 5 && minIdx <= 25) {
              const left = recent30.slice(0, minIdx);
              const right = recent30.slice(minIdx + 1);
              const leftMin = Math.min(...left.map((c: any) => c.l));
              const rightMin = right.length > 3 ? Math.min(...right.slice(0, Math.min(right.length, 10)).map((c: any) => c.l)) : Infinity;
              if (leftMin > minLow && rightMin > minLow && candle.c > candle.o) {
                positions[symbol] = { price: candle.c, shares, side: "long", signal: "逆三尊" };
              }
            }
          }
        }
      }

      // 残ポジション決済
      if (positions[symbol]) {
        const lastCandle = todayCandles[todayCandles.length - 1];
        const pos = positions[symbol];
        const pnl = pos.side === "short"
          ? Math.round((pos.price - lastCandle.c) * pos.shares)
          : Math.round((lastCandle.c - pos.price) * pos.shares);
        trades.push({ pnl, signal: pos.signal, side: pos.side, symbol, date, time: lastCandle.t });
        delete positions[symbol];
      }
    }
  }
  return trades;
}

function summarize(trades: Trade[], label: string) {
  const wins = trades.filter(t => t.pnl > 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const gross = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = loss > 0 ? (gross / loss).toFixed(2) : "∞";
  return `| ${label} | ${trades.length}件 | ${trades.length > 0 ? (wins/trades.length*100).toFixed(1) : 0}% | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円 | ${pf} |`;
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 22
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const dates = allDates.slice(2);
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

  for (const maPeriod of [4, 8, 20]) {
    const trades = await runFullSim(maPeriod, dates, rawBuffers);
    const shorts = trades.filter(t => t.side === "short");
    const longs = trades.filter(t => t.side === "long");

    console.log(`\n========== MA${maPeriod} ==========`);
    console.log(`| 区分 | 件数 | 勝率 | 損益 | PF |`);
    console.log(`|------|------|------|------|-----|`);
    console.log(summarize(trades, "**全体**"));
    console.log(summarize(shorts, "SHORT合計"));
    console.log(summarize(longs, "LONG合計"));
    console.log(`\n--- シグナル別 ---`);
    console.log(`| シグナル | 件数 | 勝率 | 損益 | PF |`);
    console.log(`|----------|------|------|------|-----|`);
    const signals = ["大台割れ(即vol)", "大台割れ(即4a)", "大台割れ(CB2)", "大台超え逆張り", "ダウ理論", "GC", "逆三尊"];
    for (const sig of signals) {
      const st = trades.filter(t => t.signal === sig);
      if (st.length > 0) console.log(summarize(st, sig));
    }
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
