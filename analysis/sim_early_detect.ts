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
  return levels.filter(l => l > 0);
}

interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

function simulate(candles: C[], entryIdx: number, symbol: string): { result: string; pnl: number; shares: number } {
  const sl = SL_MAP[symbol]?.short || 0.8;
  const entryPrice = candles[entryIdx].c;
  const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;
  const slPrice = entryPrice * (1 + sl / 100);
  const tpPrice = entryPrice * (1 - TP_PCT / 100);

  for (let j = entryIdx + 1; j < candles.length; j++) {
    if (candles[j].t >= "11:27" && candles[j].t < "11:30") {
      return { result: "AM_CLOSE", pnl: Math.round((entryPrice - candles[j].c) * shares), shares };
    }
    if (candles[j].h >= slPrice) return { result: "SL", pnl: Math.round((entryPrice - slPrice) * shares), shares };
    if (candles[j].l <= tpPrice) return { result: "TP", pnl: Math.round((entryPrice - tpPrice) * shares), shares };
  }
  const lastC = candles[candles.length - 1].c;
  return { result: "EOD", pnl: Math.round((entryPrice - lastC) * shares), shares };
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

  interface Trade { date: string; symbol: string; time: string; price: number; result: string; pnl: number; method: string; }

  // ===== 現行 (CB=2, MW=1) =====
  function runCurrent(): Trade[] {
    const trades: Trade[] = [];
    for (const date of dates) {
      for (const symbol of SYMBOLS) {
        const candles = data[date]?.[symbol];
        if (!candles || candles.length < 25) continue;
        let inPosition = false;
        let pendingLevel = 0; let pendingConfirm = 0; let pendingWait = 0;
        let pendingState: "none"|"confirming"|"waiting" = "none";
        for (let i = 1; i < candles.length; i++) {
          if (candles[i].t < "09:30" || candles[i].t >= "15:05") continue;
          if (candles[i].t >= "12:30" && candles[i].t < "12:50") continue;
          if (inPosition) continue;
          if (pendingState === "confirming") {
            if (candles[i].c <= pendingLevel) {
              pendingConfirm++;
              if (pendingConfirm >= 2) { pendingState = "waiting"; pendingWait = 0; }
            } else { pendingState = "none"; }
            continue;
          }
          if (pendingState === "waiting") {
            pendingWait++;
            if (candles[i].c > pendingLevel) { pendingState = "none"; continue; }
            if (pendingWait > 1) {
              const { result, pnl } = simulate(candles, i, symbol);
              trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "CB2MW1" });
              inPosition = true; pendingState = "none";
            }
            continue;
          }
          // 即エントリー（出来高1.5倍）
          if (i >= 20) {
            const prevClose = candles[i-1].c;
            const currClose = candles[i].c;
            const levels = getRoundLevels(prevClose);
            for (const level of levels) {
              if (prevClose >= level && currClose < level) {
                const recentVols = candles.slice(i-20, i);
                const avgVol = recentVols.reduce((s,c) => s + c.v, 0) / 20;
                const volRatio = avgVol > 0 ? candles[i].v / avgVol : 0;
                if (volRatio >= 1.5) {
                  const { result, pnl } = simulate(candles, i, symbol);
                  trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "即vol" });
                  inPosition = true; break;
                }
                pendingLevel = level; pendingConfirm = 0; pendingWait = 0; pendingState = "confirming"; break;
              }
            }
          }
        }
      }
    }
    return trades;
  }

  // ===== 案3: 接近予備検出 =====
  function runPlan3(approachPct: number): Trade[] {
    const trades: Trade[] = [];
    for (const date of dates) {
      for (const symbol of SYMBOLS) {
        const candles = data[date]?.[symbol];
        if (!candles || candles.length < 25) continue;
        let inPosition = false;
        let pendingLevel = 0; let pendingConfirm = 0; let pendingWait = 0;
        let pendingState: "none"|"confirming"|"waiting" = "none";
        let approachLevel = 0; // 予備シグナル発行済みのキリ番
        let approachActive = false;

        for (let i = 1; i < candles.length; i++) {
          if (candles[i].t < "09:30" || candles[i].t >= "15:05") continue;
          if (candles[i].t >= "12:30" && candles[i].t < "12:50") continue;
          if (inPosition) continue;

          // 通常の確認バーステートマシン処理
          if (pendingState === "confirming") {
            if (candles[i].c <= pendingLevel) {
              pendingConfirm++;
              if (pendingConfirm >= 2) { pendingState = "waiting"; pendingWait = 0; }
            } else { pendingState = "none"; }
            continue;
          }
          if (pendingState === "waiting") {
            pendingWait++;
            if (candles[i].c > pendingLevel) { pendingState = "none"; continue; }
            if (pendingWait > 1) {
              const { result, pnl } = simulate(candles, i, symbol);
              trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "CB2MW1" });
              inPosition = true; pendingState = "none";
            }
            continue;
          }

          const currClose = candles[i].c;
          const levels = getRoundLevels(currClose);

          // 予備シグナルがアクティブな場合: 割れたら即エントリー
          if (approachActive) {
            if (currClose < approachLevel) {
              // 割れた！即エントリー
              const { result, pnl } = simulate(candles, i, symbol);
              trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "予備→即" });
              inPosition = true; approachActive = false; continue;
            }
            // キリ番から離れた（上に戻った）→ 予備シグナル解除
            const distPct = (currClose - approachLevel) / approachLevel * 100;
            if (distPct > approachPct * 2) {
              approachActive = false;
            }
          }

          // 予備シグナル検出: closeがキリ番からapproachPct%以内に接近
          if (!approachActive) {
            for (const level of levels) {
              if (currClose >= level) {
                const distPct = (currClose - level) / level * 100;
                if (distPct <= approachPct && distPct > 0) {
                  approachActive = true;
                  approachLevel = level;
                  break;
                }
              }
            }
          }

          // 通常の大台割れ検出（予備シグナルなしの場合）
          if (i >= 2 && !approachActive) {
            const prevClose = candles[i-1].c;
            for (const level of getRoundLevels(prevClose)) {
              if (prevClose >= level && currClose < level) {
                // 即エントリー（出来高1.5倍）
                if (i >= 20) {
                  const recentVols = candles.slice(i-20, i);
                  const avgVol = recentVols.reduce((s,c) => s + c.v, 0) / 20;
                  const volRatio = avgVol > 0 ? candles[i].v / avgVol : 0;
                  if (volRatio >= 1.5) {
                    const { result, pnl } = simulate(candles, i, symbol);
                    trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "即vol" });
                    inPosition = true; break;
                  }
                }
                pendingLevel = level; pendingConfirm = 0; pendingWait = 0; pendingState = "confirming"; break;
              }
            }
          }
        }
      }
    }
    return trades;
  }

  // ===== 案4: 前足ギリギリ検出 =====
  function runPlan4(nearPct: number): Trade[] {
    const trades: Trade[] = [];
    for (const date of dates) {
      for (const symbol of SYMBOLS) {
        const candles = data[date]?.[symbol];
        if (!candles || candles.length < 25) continue;
        let inPosition = false;
        let pendingLevel = 0; let pendingConfirm = 0; let pendingWait = 0;
        let pendingState: "none"|"confirming"|"waiting" = "none";

        for (let i = 2; i < candles.length; i++) {
          if (candles[i].t < "09:30" || candles[i].t >= "15:05") continue;
          if (candles[i].t >= "12:30" && candles[i].t < "12:50") continue;
          if (inPosition) continue;

          if (pendingState === "confirming") {
            if (candles[i].c <= pendingLevel) {
              pendingConfirm++;
              if (pendingConfirm >= 2) { pendingState = "waiting"; pendingWait = 0; }
            } else { pendingState = "none"; }
            continue;
          }
          if (pendingState === "waiting") {
            pendingWait++;
            if (candles[i].c > pendingLevel) { pendingState = "none"; continue; }
            if (pendingWait > 1) {
              const { result, pnl } = simulate(candles, i, symbol);
              trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "CB2MW1" });
              inPosition = true; pendingState = "none";
            }
            continue;
          }

          const prevClose = candles[i-1].c;
          const currClose = candles[i].c;
          const levels = getRoundLevels(prevClose);

          for (const level of levels) {
            if (prevClose >= level && currClose < level) {
              // 大台割れ検出
              // 案4: 前足がキリ番のnearPct%以内 → 即エントリー
              const prevDist = (prevClose - level) / level * 100;
              if (prevDist <= nearPct) {
                const { result, pnl } = simulate(candles, i, symbol);
                trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "前足近→即" });
                inPosition = true; break;
              }
              // 即エントリー（出来高1.5倍）
              if (i >= 20) {
                const recentVols = candles.slice(i-20, i);
                const avgVol = recentVols.reduce((s,c) => s + c.v, 0) / 20;
                const volRatio = avgVol > 0 ? candles[i].v / avgVol : 0;
                if (volRatio >= 1.5) {
                  const { result, pnl } = simulate(candles, i, symbol);
                  trades.push({ date, symbol, time: candles[i].t, price: candles[i].c, result, pnl, method: "即vol" });
                  inPosition = true; break;
                }
              }
              // 通常フロー
              pendingLevel = level; pendingConfirm = 0; pendingWait = 0; pendingState = "confirming"; break;
            }
          }
        }
      }
    }
    return trades;
  }

  // 実行
  const currentTrades = runCurrent();
  const plan3Trades = runPlan3(0.15); // 0.15%以内に接近
  const plan4Trades_005 = runPlan4(0.05); // 前足が+0.05%以内
  const plan4Trades_010 = runPlan4(0.10); // 前足が+0.10%以内

  const configs = [
    { name: "現行 (CB=2, MW=1)", trades: currentTrades },
    { name: "案3 (接近0.15%→即)", trades: plan3Trades },
    { name: "案4a (前足+0.05%→即)", trades: plan4Trades_005 },
    { name: "案4b (前足+0.10%→即)", trades: plan4Trades_010 },
  ];

  console.log(`${"=".repeat(80)}`);
  console.log(`大台割れSHORT: 早期検出方式の比較シミュレーション（20営業日）`);
  console.log(`${"=".repeat(80)}\n`);

  console.log(`| 指標 | 現行 | 案3(接近0.15%) | 案4a(前足+0.05%) | 案4b(前足+0.10%) |`);
  console.log(`|------|------|----------------|------------------|------------------|`);

  const summaries = configs.map(({ name, trades }) => {
    const wins = trades.filter(t => t.pnl > 0).length;
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const gp = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? (gp / gl).toFixed(2) : "∞";
    const instant = trades.filter(t => t.method !== "CB2MW1").length;
    return { name, cnt: trades.length, wins, winRate: (wins/trades.length*100).toFixed(1), total, pf, instant };
  });

  console.log(`| 取引数 | ${summaries.map(s => `${s.cnt}件`).join(" | ")} |`);
  console.log(`| 即エントリー数 | ${summaries.map(s => `${s.instant}件`).join(" | ")} |`);
  console.log(`| 勝率 | ${summaries.map(s => `${s.winRate}%`).join(" | ")} |`);
  console.log(`| 損益 | ${summaries.map(s => `${s.total >= 0 ? "+" : ""}${s.total.toLocaleString()}円`).join(" | ")} |`);
  console.log(`| PF | ${summaries.map(s => s.pf).join(" | ")} |`);
  console.log(`| 現行比 | - | ${summaries.slice(1).map(s => `${(s.total - summaries[0].total) >= 0 ? "+" : ""}${(s.total - summaries[0].total).toLocaleString()}円`).join(" | ")} |`);

  // 方式別内訳
  console.log(`\n\n--- 方式別内訳 ---\n`);
  for (const { name, trades } of configs) {
    const byMethod: Record<string, {cnt: number; wins: number; pnl: number}> = {};
    for (const t of trades) {
      if (!byMethod[t.method]) byMethod[t.method] = {cnt: 0, wins: 0, pnl: 0};
      byMethod[t.method].cnt++;
      if (t.pnl > 0) byMethod[t.method].wins++;
      byMethod[t.method].pnl += t.pnl;
    }
    console.log(`${name}:`);
    for (const [method, v] of Object.entries(byMethod)) {
      console.log(`  ${method}: ${v.cnt}件 ${v.wins}勝 勝率${(v.wins/v.cnt*100).toFixed(1)}% ${v.pnl >= 0 ? "+" : ""}${v.pnl.toLocaleString()}円`);
    }
    console.log();
  }

  // 銘柄別比較
  console.log(`--- 銘柄別比較 ---\n`);
  console.log(`| 銘柄 | 現行 | 案3 | 案4a | 案4b | 案3-現行 | 案4b-現行 |`);
  console.log(`|------|------|-----|------|------|----------|-----------|`);
  for (const sym of SYMBOLS) {
    const vals = configs.map(({ trades }) => {
      const t = trades.filter(tr => tr.symbol === sym);
      return { cnt: t.length, pnl: t.reduce((s, tr) => s + tr.pnl, 0) };
    });
    if (vals.every(v => v.cnt === 0)) continue;
    const diff3 = vals[1].pnl - vals[0].pnl;
    const diff4b = vals[3].pnl - vals[0].pnl;
    console.log(`| ${sym} | ${vals[0].pnl >= 0 ? "+" : ""}${vals[0].pnl.toLocaleString()}(${vals[0].cnt}) | ${vals[1].pnl >= 0 ? "+" : ""}${vals[1].pnl.toLocaleString()}(${vals[1].cnt}) | ${vals[2].pnl >= 0 ? "+" : ""}${vals[2].pnl.toLocaleString()}(${vals[2].cnt}) | ${vals[3].pnl >= 0 ? "+" : ""}${vals[3].pnl.toLocaleString()}(${vals[3].cnt}) | ${diff3 >= 0 ? "+" : ""}${diff3.toLocaleString()} | ${diff4b >= 0 ? "+" : ""}${diff4b.toLocaleString()} |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
