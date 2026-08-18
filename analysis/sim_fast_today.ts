import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.8, "6526": 1.0,
  "5803": 0.6, "6981": 0.9, "285A": 0.6, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};
interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [rows] = await conn.query(`
    SELECT symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate = '2026-08-18' AND symbol IN ('285A','6976','6146','6981')
    ORDER BY symbol, candleTime
  `) as any[];

  const bySymbol: Record<string, C[]> = {};
  for (const r of rows as any[]) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = [];
    bySymbol[r.symbol].push({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  }

  console.log(`\n=== 本日8/18前場: 即エントリー条件の検証 ===\n`);

  // 本番でエントリーされた5件のシグナル発生時刻を推定（CB=2なので、エントリー時刻の3分前がシグナル発生）
  const entries = [
    { symbol: "285A", entryTime: "09:45", entryPrice: 60970 },
    { symbol: "6976", entryTime: "09:59", entryPrice: 11000 },
    { symbol: "6146", entryTime: "10:13", entryPrice: 64260 },
    { symbol: "6981", entryTime: "10:25", entryPrice: 7980 },
    { symbol: "6976", entryTime: "10:44", entryPrice: 10355 },
  ];

  for (const entry of entries) {
    const candles = bySymbol[entry.symbol];
    if (!candles) { console.log(`${entry.symbol}: データなし`); continue; }

    // シグナル発生時刻を推定（エントリーの3分前: CB=2 + MW=1 = 3本）
    const entryIdx = candles.findIndex(c => c.t === entry.entryTime);
    if (entryIdx < 3) { console.log(`${entry.symbol} ${entry.entryTime}: インデックス不足`); continue; }
    
    const sigIdx = entryIdx - 3; // シグナル発生足
    const sigCandle = candles[sigIdx];
    
    // 出来高比率計算（直近20本平均）
    const lookback = 20;
    const startIdx = Math.max(0, sigIdx - lookback);
    const recentVols = candles.slice(startIdx, sigIdx);
    const avgVol = recentVols.length > 0 ? recentVols.reduce((s, c) => s + c.v, 0) / recentVols.length : 1;
    const volRatio = avgVol > 0 ? sigCandle.v / avgVol : 0;

    // sell_pressure判定（直近3本中2本以上陰線）
    const recent3 = candles.slice(Math.max(0, sigIdx - 2), sigIdx + 1);
    const bearCount = recent3.filter(c => c.c < c.o).length;
    const isSellPressure = bearCount >= 2;

    // 即エントリー条件判定
    const fastCondition = isSellPressure && volRatio >= 1.5;

    // 即エントリー時の価格（シグナル発生の次の足）
    const fastEntryIdx = sigIdx + 1;
    const fastEntryPrice = candles[fastEntryIdx]?.c;

    // 即エントリーした場合のSL/TP到達
    const sl = SL_MAP[entry.symbol];
    let fastResult = "—";
    let fastPnl = 0;
    if (fastCondition && fastEntryPrice) {
      const shares = Math.floor(3000000 / fastEntryPrice / 100) * 100 || 100;
      const slPrice = fastEntryPrice * (1 + sl / 100);
      const tpPrice = fastEntryPrice * (1 - TP_PCT / 100);
      for (let j = fastEntryIdx + 1; j < candles.length; j++) {
        if (candles[j].h >= slPrice) { fastResult = "SL"; fastPnl = Math.round((fastEntryPrice - slPrice) * shares); break; }
        if (candles[j].l <= tpPrice) { fastResult = "TP"; fastPnl = Math.round((fastEntryPrice - tpPrice) * shares); break; }
      }
      if (fastResult === "—") {
        const lastC = candles[candles.length - 1].c;
        fastResult = "保有中"; fastPnl = Math.round((fastEntryPrice - lastC) * (Math.floor(3000000 / fastEntryPrice / 100) * 100 || 100));
      }
    }

    // 通常エントリーの結果
    const normalShares = Math.floor(3000000 / entry.entryPrice / 100) * 100 || 100;
    const normalSlPrice = entry.entryPrice * (1 + sl / 100);
    const normalTpPrice = entry.entryPrice * (1 - TP_PCT / 100);
    let normalResult = "保有中";
    let normalPnl = 0;
    for (let j = entryIdx + 1; j < candles.length; j++) {
      if (candles[j].h >= normalSlPrice) { normalResult = "SL"; normalPnl = Math.round((entry.entryPrice - normalSlPrice) * normalShares); break; }
      if (candles[j].l <= normalTpPrice) { normalResult = "TP"; normalPnl = Math.round((entry.entryPrice - normalTpPrice) * normalShares); break; }
    }
    if (normalResult === "保有中") {
      const lastC = candles[candles.length - 1].c;
      normalPnl = Math.round((entry.entryPrice - lastC) * normalShares);
    }

    console.log(`--- ${entry.symbol} (エントリー: ${entry.entryTime} @${entry.entryPrice}円) ---`);
    console.log(`  シグナル発生: ${sigCandle.t} @${sigCandle.c}円`);
    console.log(`  出来高: ${sigCandle.v} (平均${Math.round(avgVol)}, ${volRatio.toFixed(2)}倍)`);
    console.log(`  sell_pressure: ${isSellPressure} (直近3本陰線${bearCount}本)`);
    console.log(`  即エントリー条件: ${fastCondition ? "★合致" : "不合致"}`);
    if (fastCondition) {
      console.log(`  即エントリー: ${candles[fastEntryIdx].t} @${fastEntryPrice}円 → ${fastResult} ${fastPnl >= 0 ? "+" : ""}${fastPnl.toLocaleString()}円`);
    }
    console.log(`  通常エントリー: ${entry.entryTime} @${entry.entryPrice}円 → ${normalResult} ${normalPnl >= 0 ? "+" : ""}${normalPnl.toLocaleString()}円`);
    if (fastCondition) {
      const diff = fastPnl - normalPnl;
      console.log(`  差分: ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円 (即エントリーの方が${diff >= 0 ? "有利" : "不利"})`);
    }
    console.log();
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
