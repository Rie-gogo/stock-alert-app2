import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, {long: number; short: number}> = {
  "8035": {long:0.5, short:0.8}, "6857": {long:0.6, short:0.6}, "6976": {long:0.6, short:0.8},
  "6526": {long:0.9, short:1.0}, "5803": {long:0.5, short:0.6}, "6981": {long:0.4, short:0.9},
  "285A": {long:0.8, short:0.6}, "6146": {long:0.8, short:0.8}, "6594": {long:0.5, short:0.5},
  "8316": {long:0.5, short:0.5},
};

interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);

  // ブロックされた9件のシグナル
  const blocked = [
    { symbol: "6976", time: "09:44", price: 10860 },
    { symbol: "6976", time: "09:48", price: 10905 },
    { symbol: "6981", time: "10:10", price: 8093 },
    { symbol: "6976", time: "10:20", price: 11070 },
    { symbol: "6981", time: "10:25", price: 8148 },
    { symbol: "6976", time: "13:52", price: 11025 },
    { symbol: "6976", time: "14:02", price: 11060 },
    { symbol: "6526", time: "14:07", price: 2128.5 },
    { symbol: "6976", time: "14:14", price: 11060 },
  ];

  // rt_candlesデータ取得
  const symbols = [...new Set(blocked.map(b => b.symbol))];
  const [allRows] = await conn.query(`
    SELECT symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate = '2026-08-17'
      AND symbol IN (${symbols.map(s => `'${s}'`).join(',')})
    ORDER BY symbol, candleTime
  `) as any[];

  const data: Record<string, C[]> = {};
  for (const r of allRows as any[]) {
    if (!data[r.symbol]) data[r.symbol] = [];
    data[r.symbol].push({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  }

  console.log(`${"=".repeat(80)}`);
  console.log(`8/17（月）LONGシグナル: スコア0ブロック9件の検証`);
  console.log(`${"=".repeat(80)}\n`);
  console.log(`本番結果: LONGエントリー0件（全てスコア0でブロック）`);
  console.log(`本番SHORT: 1件（6146ディスコ -51,592円）\n`);

  console.log(`--- もしLONGエントリーしていたら ---\n`);
  console.log(`| # | 時刻 | 銘柄 | エントリー | SL% | 決済 | 損益 | シグナル |`);
  console.log(`|---|------|------|-----------|-----|------|------|----------|`);

  let totalPnl = 0;
  let wins = 0;
  for (let idx = 0; idx < blocked.length; idx++) {
    const b = blocked[idx];
    const candles = data[b.symbol];
    if (!candles) continue;

    const sl = SL_MAP[b.symbol]?.long || 0.5;
    const entryPrice = b.price;
    const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;
    const slPrice = entryPrice * (1 - sl / 100);
    const tpPrice = entryPrice * (1 + TP_PCT / 100);

    // エントリー時刻のインデックスを探す
    const entryIdx = candles.findIndex(c => c.t === b.time);
    if (entryIdx < 0) continue;

    let result = "EOD";
    let pnl = 0;
    let exitTime = "";
    for (let j = entryIdx + 1; j < candles.length; j++) {
      if (candles[j].t >= "11:27" && candles[j].t < "11:30") {
        result = "前場決済";
        pnl = Math.round((candles[j].c - entryPrice) * shares);
        exitTime = candles[j].t;
        break;
      }
      if (candles[j].t >= "15:25") {
        result = "大引け";
        pnl = Math.round((candles[j].c - entryPrice) * shares);
        exitTime = candles[j].t;
        break;
      }
      if (candles[j].l <= slPrice) {
        result = "SL";
        pnl = Math.round((slPrice - entryPrice) * shares);
        exitTime = candles[j].t;
        break;
      }
      if (candles[j].h >= tpPrice) {
        result = "TP";
        pnl = Math.round((tpPrice - entryPrice) * shares);
        exitTime = candles[j].t;
        break;
      }
    }
    if (result === "EOD") {
      const lastC = candles[candles.length - 1].c;
      pnl = Math.round((lastC - entryPrice) * shares);
      exitTime = candles[candles.length - 1].t;
    }

    totalPnl += pnl;
    if (pnl > 0) wins++;

    const sigShort = b.symbol === "6526" ? "逆三尊" : "ダウ理論";
    console.log(`| ${idx+1} | ${b.time} | ${b.symbol} | @${b.price.toLocaleString()}円×${shares} | ${sl}% | ${result}(${exitTime}) | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円 | ${sigShort} |`);
  }

  console.log(`\n**合計: ${blocked.length}件 ${wins}勝${blocked.length - wins}敗 ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円**`);

  // 静かな上昇バイパスの条件確認
  console.log(`\n\n--- 静かな上昇バイパス条件の確認 ---\n`);
  console.log(`条件: isBullish=true + MA乖離<0.3% + 実体<0.1% + 直近10本陰線3本以下`);
  console.log(`→ 条件を満たせばスコア0でもLONGエントリー許可\n`);

  for (const b of blocked) {
    const candles = data[b.symbol];
    if (!candles) continue;
    const entryIdx = candles.findIndex(c => c.t === b.time);
    if (entryIdx < 0 || entryIdx < 20) continue;

    // MA20計算
    const ma20 = candles.slice(entryIdx - 19, entryIdx + 1).reduce((s, c) => s + c.close, 0) / 20;
    const maDeviation = Math.abs(candles[entryIdx].c - ma20) / ma20 * 100;

    // MA20傾き（isBullish）
    const prevMa20 = candles.slice(entryIdx - 20, entryIdx).reduce((s, c) => s + c.close, 0) / 20;
    const slope = (ma20 - prevMa20) / prevMa20 * 100;
    const isBullish = slope > 0;

    // 実体率
    const bodyPct = Math.abs(candles[entryIdx].c - candles[entryIdx].o) / candles[entryIdx].o * 100;

    // 直近10本陰線数
    const recent10 = candles.slice(entryIdx - 9, entryIdx + 1);
    const bearBars = recent10.filter(c => c.c < c.o).length;

    const bypass = isBullish && maDeviation < 0.3 && bodyPct < 0.1 && bearBars <= 3;

    console.log(`${b.time} ${b.symbol}: isBullish=${isBullish}(傾き${slope.toFixed(3)}%) MA乖離=${maDeviation.toFixed(3)}% 実体=${bodyPct.toFixed(3)}% 陰線=${bearBars}本 → バイパス=${bypass ? "✓適用" : "✗不適用"}`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
