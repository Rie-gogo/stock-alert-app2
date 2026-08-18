/**
 * MA期間別 LONGへの影響検証
 * isBullish=trueの時にLONG（静かな上昇バイパス）が許可される
 * MA期間が短い → 上昇転換を早く検知 → LONGが早く許可される
 * MA期間が長い → 上昇転換の検知が遅い → LONGの許可が遅れる
 * 
 * 検証: ダウ理論LONG（直近20本高値更新）シグナルに対して、
 * 各MA期間でisBullish判定し、isBullish=trueの時のみエントリーした場合の成績
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
const MA_PERIODS = [5, 10, 15, 20, 30, 50];

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 31
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const dates = allDates.slice(1);
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${allDates.map((d: string) => `'${d}'`).join(',')})
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY symbol, tradeDate, candleTime
  `) as any[];

  const rawBuffers: Record<string, {date: string; c: {t:string;o:number;h:number;l:number;c:number;v:number}}[]> = {};
  for (const r of allRows as any[]) {
    if (!rawBuffers[r.symbol]) rawBuffers[r.symbol] = [];
    rawBuffers[r.symbol].push({ date: String(r.tradeDate), c: { t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) } });
  }

  // 結果格納
  const results: Record<number, {trades: number; wins: number; pnl: number; blocked: number; blockedPnl: number}> = {};
  const noFilterResult = {trades: 0, wins: 0, pnl: 0, blocked: 0, blockedPnl: 0};
  for (const maPeriod of MA_PERIODS) {
    results[maPeriod] = {trades: 0, wins: 0, pnl: 0, blocked: 0, blockedPnl: 0};
  }

  for (const date of dates) {
    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const bufUpToDate = allBuf.filter(b => b.date <= date);
      const todayCandles = allBuf.filter(b => b.date === date).map(b => b.c);
      if (todayCandles.length < 25) continue;

      const entered: Record<number, boolean> = {};
      let enteredNoFilter = false;

      for (let i = 20; i < todayCandles.length; i++) {
        const candle = todayCandles[i];
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;

        // ダウ理論LONG: 直近20本の高値更新
        const recent20 = todayCandles.slice(Math.max(0, i-20), i);
        const maxHigh = Math.max(...recent20.map(c => c.h));
        if (candle.h <= maxHigh) continue; // 高値更新なし

        const globalIdx = bufUpToDate.findIndex(b => b.date === date && b.c.t === candle.t);
        if (globalIdx < 0) continue;

        // シミュレーション
        const sl = SL_MAP[symbol]?.long || 0.5;
        const price = candle.c;
        const shares = Math.floor(3000000 / price / 100) * 100 || 100;
        const slPrice = price * (1 - sl / 100);
        const tpPrice = price * (1 + TP_PCT / 100);
        let pnl = 0;
        for (let j = i + 1; j < todayCandles.length; j++) {
          if (todayCandles[j].t >= "11:27" && todayCandles[j].t < "11:30") { pnl = Math.round((todayCandles[j].c - price) * shares); break; }
          if (todayCandles[j].t >= "15:25") { pnl = Math.round((todayCandles[j].c - price) * shares); break; }
          if (todayCandles[j].l <= slPrice) { pnl = Math.round((slPrice - price) * shares); break; }
          if (todayCandles[j].h >= tpPrice) { pnl = Math.round((tpPrice - price) * shares); break; }
        }

        // isBullish無効
        if (!enteredNoFilter) {
          noFilterResult.trades++;
          if (pnl > 0) noFilterResult.wins++;
          noFilterResult.pnl += pnl;
          enteredNoFilter = true;
        }

        // 各MA期間で判定（LONGはisBullish=trueの時のみ許可）
        for (const maPeriod of MA_PERIODS) {
          if (entered[maPeriod]) continue;
          if (globalIdx < maPeriod + 1) continue;

          const w = bufUpToDate.slice(globalIdx - maPeriod + 1, globalIdx + 1).map(b => b.c.c);
          const pw = bufUpToDate.slice(globalIdx - maPeriod, globalIdx).map(b => b.c.c);
          const ma = w.reduce((s, v) => s + v, 0) / maPeriod;
          const prevMa = pw.reduce((s, v) => s + v, 0) / maPeriod;
          const isBullish = (ma - prevMa) / prevMa * 100 > 0;

          if (!isBullish) {
            // LONGブロック（MA下向き時）
            results[maPeriod].blocked++;
            results[maPeriod].blockedPnl += pnl;
          } else {
            // LONGエントリー許可
            results[maPeriod].trades++;
            if (pnl > 0) results[maPeriod].wins++;
            results[maPeriod].pnl += pnl;
            entered[maPeriod] = true;
          }
        }
      }
    }
  }

  // 結果表示
  console.log(`=== MA期間別 isBullish判定のLONGへの影響検証 ===\n`);
  console.log(`| MA期間 | 取引数 | 勝率 | 損益 | ブロック数 | ブロック損益 | 判定 |`);
  console.log(`|--------|--------|------|------|-----------|------------|------|`);
  console.log(`| なし | ${noFilterResult.trades}件 | ${(noFilterResult.wins/noFilterResult.trades*100).toFixed(1)}% | ${noFilterResult.pnl >= 0 ? "+" : ""}${noFilterResult.pnl.toLocaleString()}円 | 0件 | - | ベースライン |`);

  for (const maPeriod of MA_PERIODS) {
    const r = results[maPeriod];
    const wr = r.trades > 0 ? (r.wins/r.trades*100).toFixed(1) : "-";
    const blockedJudge = r.blockedPnl < 0 ? "ブロック正解" : "★過剰ブロック";
    console.log(`| MA${maPeriod} | ${r.trades}件 | ${wr}% | ${r.pnl >= 0 ? "+" : ""}${r.pnl.toLocaleString()}円 | ${r.blocked}件 | ${r.blockedPnl >= 0 ? "+" : ""}${r.blockedPnl.toLocaleString()}円 | ${blockedJudge} |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
