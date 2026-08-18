import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, {long: number; short: number}> = {
  "8035": {long:0.5, short:0.8}, "6857": {long:0.6, short:0.6}, "6976": {long:0.6, short:0.8},
  "6526": {long:0.9, short:1.0}, "5803": {long:0.5, short:0.6}, "6981": {long:0.4, short:0.9},
  "285A": {long:0.8, short:0.6}, "6146": {long:0.8, short:0.8}, "6594": {long:0.5, short:0.5},
  "8316": {long:0.5, short:0.5},
};
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_VOL_LOOKBACK = 20;
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];

interface C { t: string; o: number; h: number; l: number; c: number; v: number; }
interface Trade { date: string; symbol: string; entryTime: string; entryPrice: number; result: string; pnl: number; mode: string; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  // 直近20営業日取得
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 20
  `) as any[];
  const dates = (dateRows as any[]).map(r => r.tradeDate).reverse();
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  // 全データ取得
  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${dates.map(d=>`'${d}'`).join(',')}) AND symbol IN (${SYMBOLS.map(s=>`'${s}'`).join(',')})
    ORDER BY tradeDate, symbol, candleTime
  `) as any[];

  // 日付×銘柄でグループ化
  const data: Record<string, Record<string, C[]>> = {};
  for (const r of allRows as any[]) {
    if (!data[r.tradeDate]) data[r.tradeDate] = {};
    if (!data[r.tradeDate][r.symbol]) data[r.tradeDate][r.symbol] = [];
    data[r.tradeDate][r.symbol].push({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  }

  // 大台割れ検出関数
  function detectRoundBreak(candles: C[]): {idx: number; level: number}[] {
    const breaks: {idx: number; level: number}[] = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i-1];
      const curr = candles[i];
      // 大台レベル計算
      const price = curr.c;
      let step: number;
      if (price >= 50000) step = 1000;
      else if (price >= 10000) step = 500;
      else if (price >= 5000) step = 100;
      else step = 50;
      
      const level = Math.ceil(prev.c / step) * step; // 前足が上にいた大台
      if (prev.c >= level && curr.c < level) {
        breaks.push({ idx: i, level });
      }
    }
    return breaks;
  }

  // シミュレーション
  const tradesWithSP: Trade[] = [];
  const tradesNoSP: Trade[] = [];

  for (const date of dates) {
    for (const symbol of SYMBOLS) {
      const candles = data[date]?.[symbol];
      if (!candles || candles.length < 30) continue;

      const breaks = detectRoundBreak(candles);
      const sl = SL_MAP[symbol].short;

      for (const brk of breaks) {
        const sigIdx = brk.idx;
        if (sigIdx < FAST_ENTRY_VOL_LOOKBACK) continue;
        // 9:00〜14:30のみ
        const timeStr = candles[sigIdx].t;
        if (timeStr < "09:05" || timeStr > "14:30") continue;

        // 出来高倍率
        const recentVols = candles.slice(sigIdx - FAST_ENTRY_VOL_LOOKBACK, sigIdx);
        const avgVol = recentVols.reduce((s, c) => s + c.v, 0) / recentVols.length;
        const volRatio = avgVol > 0 ? candles[sigIdx].v / avgVol : 0;
        const volCondition = volRatio >= FAST_ENTRY_VOL_RATIO;

        // sell_pressure
        const recent3 = candles.slice(Math.max(0, sigIdx - 2), sigIdx + 1);
        const bearCount = recent3.filter(c => c.c < c.o).length;
        const spCondition = bearCount >= 2;

        if (!volCondition) continue; // 出来高条件は両方必須

        // エントリー価格（即エントリー = シグナル足の終値）
        const entryPrice = candles[sigIdx].c;
        const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;
        const slPrice = entryPrice * (1 + sl / 100);
        const tpPrice = entryPrice * (1 - TP_PCT / 100);

        let result = "EOD";
        let pnl = 0;
        for (let j = sigIdx + 1; j < candles.length; j++) {
          if (candles[j].h >= slPrice) { result = "SL"; pnl = Math.round((entryPrice - slPrice) * shares); break; }
          if (candles[j].l <= tpPrice) { result = "TP"; pnl = Math.round((entryPrice - tpPrice) * shares); break; }
        }
        if (result === "EOD") {
          const lastC = candles[candles.length - 1].c;
          pnl = Math.round((entryPrice - lastC) * shares);
        }

        // sell_pressureなし（出来高のみ）→ 全件
        tradesNoSP.push({ date, symbol, entryTime: timeStr, entryPrice, result, pnl, mode: "vol_only" });

        // sell_pressureあり → spCondition合致のみ
        if (spCondition) {
          tradesWithSP.push({ date, symbol, entryTime: timeStr, entryPrice, result, pnl, mode: "sp+vol" });
        }
      }
    }
  }

  // 結果集計
  function summarize(trades: Trade[], label: string) {
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0).length;
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : "0";
    const avgWin = wins > 0 ? Math.round(trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0)/wins) : 0;
    const avgLoss = losses > 0 ? Math.round(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0)/losses) : 0;
    console.log(`\n【${label}】`);
    console.log(`  取引数: ${trades.length}件 (${wins}勝${losses}敗)`);
    console.log(`  勝率: ${winRate}%`);
    console.log(`  合計損益: ${total >= 0 ? "+" : ""}${total.toLocaleString()}円`);
    console.log(`  平均利益: +${avgWin.toLocaleString()}円 / 平均損失: ${avgLoss.toLocaleString()}円`);
    console.log(`  PF: ${losses > 0 && trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0) > 0 ? (trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0) / Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0))).toFixed(2) : "∞"}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`即エントリー条件: sell_pressureの必要性検証`);
  console.log(`${"=".repeat(60)}`);
  
  summarize(tradesWithSP, "A: sell_pressure + 出来高1.5倍（現行）");
  summarize(tradesNoSP, "B: 出来高1.5倍のみ（sell_pressureなし）");

  // sell_pressureなしで追加される取引
  const additionalTrades = tradesNoSP.filter(t => !tradesWithSP.some(w => w.date === t.date && w.symbol === t.symbol && w.entryTime === t.entryTime));
  summarize(additionalTrades, "C: sell_pressureなしで追加される取引（Bのうち、Aに含まれないもの）");

  // 本日の6146ディスコ（出来高1.66倍、sell_pressure不合致）のケース
  console.log(`\n--- 本日8/18 6146ディスコ 10:10のケース ---`);
  const disco = tradesNoSP.find(t => t.date === '2026-08-18' && t.symbol === '6146' && t.entryTime >= '10:09' && t.entryTime <= '10:11');
  if (disco) {
    console.log(`  ${disco.entryTime} @${disco.entryPrice}円 → ${disco.result} ${disco.pnl >= 0 ? "+" : ""}${disco.pnl.toLocaleString()}円`);
  } else {
    console.log(`  該当なし（大台割れシグナルとして検出されなかった可能性）`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
