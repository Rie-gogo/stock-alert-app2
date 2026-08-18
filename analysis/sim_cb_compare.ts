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

// 大台（キリ番）リスト生成
function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  if (price >= 100000) {
    const base = Math.floor(price / 1000) * 1000;
    for (let i = -3; i <= 3; i++) levels.push(base + i * 1000);
  } else if (price >= 10000) {
    const base = Math.floor(price / 500) * 500;
    for (let i = -3; i <= 3; i++) levels.push(base + i * 500);
  } else if (price >= 5000) {
    const base = Math.floor(price / 200) * 200;
    for (let i = -3; i <= 3; i++) levels.push(base + i * 200);
  } else if (price >= 2000) {
    const base = Math.floor(price / 100) * 100;
    for (let i = -3; i <= 3; i++) levels.push(base + i * 100);
  } else {
    const base = Math.floor(price / 50) * 50;
    for (let i = -3; i <= 3; i++) levels.push(base + i * 50);
  }
  return levels;
}

interface C { t: string; o: number; h: number; l: number; c: number; v: number; }
interface Trade { date: string; symbol: string; time: string; price: number; result: string; pnl: number; }

function simulate(candles: C[], entryIdx: number, symbol: string): { result: string; pnl: number } {
  const sl = SL_MAP[symbol]?.short || 0.8;
  const entryPrice = candles[entryIdx].c;
  const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;
  const slPrice = entryPrice * (1 + sl / 100);
  const tpPrice = entryPrice * (1 - TP_PCT / 100);

  for (let j = entryIdx + 1; j < candles.length; j++) {
    // 前場強制決済
    if (candles[j].t >= "11:27" && candles[j].t < "11:30") {
      return { result: "AM_CLOSE", pnl: Math.round((entryPrice - candles[j].c) * shares) };
    }
    if (candles[j].h >= slPrice) return { result: "SL", pnl: Math.round((entryPrice - slPrice) * shares) };
    if (candles[j].l <= tpPrice) return { result: "TP", pnl: Math.round((entryPrice - tpPrice) * shares) };
  }
  const lastC = candles[candles.length - 1].c;
  return { result: "EOD", pnl: Math.round((entryPrice - lastC) * shares) };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 20
  `) as any[];
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${dates.map((d: string) => `'${d}'`).join(',')}) 
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY tradeDate, symbol, candleTime
  `) as any[];

  const data: Record<string, Record<string, C[]>> = {};
  for (const r of allRows as any[]) {
    if (!data[r.tradeDate]) data[r.tradeDate] = {};
    if (!data[r.tradeDate][r.symbol]) data[r.tradeDate][r.symbol] = [];
    data[r.tradeDate][r.symbol].push({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  }

  // 3パターンでシミュレーション
  const configs = [
    { name: "現行 (CB=2, MW=1)", cb: 2, mw: 1 },
    { name: "案A (CB=1, MW=0)", cb: 1, mw: 0 },
    { name: "案B (CB=1, MW=1)", cb: 1, mw: 1 },
  ];

  const allResults: Record<string, Trade[]> = {};

  for (const config of configs) {
    const trades: Trade[] = [];

    for (const date of dates) {
      for (const symbol of SYMBOLS) {
        const candles = data[date]?.[symbol];
        if (!candles || candles.length < 25) continue;

        let inPosition = false;
        let pendingLevel = 0;
        let pendingConfirm = 0;
        let pendingWait = 0;
        let pendingState: "none" | "confirming" | "waiting" = "none";
        let pendingSignalIdx = -1;

        for (let i = 1; i < candles.length; i++) {
          if (candles[i].t < "09:30" || candles[i].t >= "15:05") continue;
          if (candles[i].t >= "12:30" && candles[i].t < "12:50") continue; // 後場序盤禁止
          if (inPosition) continue;

          // 確認バーステートマシン処理
          if (pendingState === "confirming") {
            if (candles[i].c <= pendingLevel) {
              pendingConfirm++;
              if (pendingConfirm >= config.cb) {
                if (config.mw === 0) {
                  // MW=0: 確認完了で即エントリー
                  const { result, pnl } = simulate(candles, i, symbol);
                  trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl });
                  inPosition = true;
                  pendingState = "none";
                } else {
                  pendingState = "waiting";
                  pendingWait = 0;
                }
              }
            } else {
              pendingState = "none"; // キリ番上抜け → キャンセル
            }
            continue;
          }

          if (pendingState === "waiting") {
            pendingWait++;
            if (candles[i].c > pendingLevel) {
              pendingState = "none"; // キリ番上抜け → キャンセル
              continue;
            }
            if (pendingWait > config.mw) {
              // タイムアウト → エントリー
              const { result, pnl } = simulate(candles, i, symbol);
              trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl });
              inPosition = true;
              pendingState = "none";
            }
            continue;
          }

          // 大台割れシグナル検出
          if (i >= 2) {
            const prevClose = candles[i - 1].c;
            const currClose = candles[i].c;
            const levels = getRoundLevels(prevClose);
            
            for (const level of levels) {
              if (prevClose >= level && currClose < level) {
                // 大台割れ検出
                // 即エントリー条件チェック（出来高1.5倍）
                if (i >= 20) {
                  const recentVols = candles.slice(i - 20, i);
                  const avgVol = recentVols.reduce((s, c) => s + c.v, 0) / 20;
                  const volRatio = avgVol > 0 ? candles[i].v / avgVol : 0;
                  if (volRatio >= 1.5) {
                    // 即エントリー（全パターン共通）
                    const { result, pnl } = simulate(candles, i, symbol);
                    trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl });
                    inPosition = true;
                    break;
                  }
                }
                // 確認バー待機開始
                pendingLevel = level;
                pendingConfirm = 0;
                pendingWait = 0;
                pendingState = "confirming";
                pendingSignalIdx = i;
                break;
              }
            }
          }
        }
      }
    }
    allResults[config.name] = trades;
  }

  // 結果表示
  console.log(`${"=".repeat(70)}`);
  console.log(`大台割れSHORT: CB/MW比較シミュレーション（20営業日）`);
  console.log(`${"=".repeat(70)}\n`);

  console.log(`| 指標 | 現行 (CB=2, MW=1) | 案A (CB=1, MW=0) | 案B (CB=1, MW=1) |`);
  console.log(`|------|-------------------|------------------|------------------|`);

  for (const config of configs) {
    const trades = allResults[config.name];
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0).length;
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
    const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : "0";
    console.log(`| ${config.name.padEnd(18)} | ${trades.length}件 ${wins}勝${losses}敗 勝率${winRate}% | PF ${pf} | ${total >= 0 ? "+" : ""}${total.toLocaleString()}円 |`);
  }

  // 表形式で再表示
  console.log(`\n\n--- サマリー比較 ---\n`);
  const summaries = configs.map(config => {
    const trades = allResults[config.name];
    const wins = trades.filter(t => t.pnl > 0).length;
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
    return { name: config.name, cnt: trades.length, wins, winRate: (wins/trades.length*100).toFixed(1), total, pf };
  });

  console.log(`| 指標 | ${summaries.map(s => s.name).join(" | ")} |`);
  console.log(`|------|${"---|".repeat(summaries.length)}`);
  console.log(`| 取引数 | ${summaries.map(s => `${s.cnt}件`).join(" | ")} |`);
  console.log(`| 勝率 | ${summaries.map(s => `${s.winRate}%`).join(" | ")} |`);
  console.log(`| 損益 | ${summaries.map(s => `${s.total >= 0 ? "+" : ""}${s.total.toLocaleString()}円`).join(" | ")} |`);
  console.log(`| PF | ${summaries.map(s => s.pf).join(" | ")} |`);

  // 銘柄別比較
  console.log(`\n\n--- 銘柄別比較 ---\n`);
  console.log(`| 銘柄 | 現行損益 | 案A損益 | 案B損益 | A-現行 | B-現行 |`);
  console.log(`|------|----------|---------|---------|--------|--------|`);
  for (const sym of SYMBOLS) {
    const curr = allResults[configs[0].name].filter(t => t.symbol === sym);
    const a = allResults[configs[1].name].filter(t => t.symbol === sym);
    const b = allResults[configs[2].name].filter(t => t.symbol === sym);
    const currTotal = curr.reduce((s, t) => s + t.pnl, 0);
    const aTotal = a.reduce((s, t) => s + t.pnl, 0);
    const bTotal = b.reduce((s, t) => s + t.pnl, 0);
    if (curr.length === 0 && a.length === 0 && b.length === 0) continue;
    const diffA = aTotal - currTotal;
    const diffB = bTotal - currTotal;
    console.log(`| ${sym} | ${currTotal >= 0 ? "+" : ""}${currTotal.toLocaleString()}円(${curr.length}) | ${aTotal >= 0 ? "+" : ""}${aTotal.toLocaleString()}円(${a.length}) | ${bTotal >= 0 ? "+" : ""}${bTotal.toLocaleString()}円(${b.length}) | ${diffA >= 0 ? "+" : ""}${diffA.toLocaleString()}円 | ${diffB >= 0 ? "+" : ""}${diffB.toLocaleString()}円 |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
