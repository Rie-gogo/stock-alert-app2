/**
 * キオクシア優先ルール 5日間シミュレーション v2
 * 
 * 前回の問題: 「実際にエントリーされた時刻」を基準にしていた
 * 今回の修正: 「285Aの大台シグナルが確認完了した時刻」を基準にする
 * 
 * 大台確認完了 = キリ番(100円単位)を5本連続で維持した時点
 * detectRoundLevel: step=100, prev_close <= level かつ curr_close > level で発生
 * 
 * ルール:
 * 1. 285Aが大台確認完了した時点で、保有中の他銘柄を全て強制決済
 * 2. 285Aにその時点の価格でエントリー
 * 3. 285A保有中は他銘柄の新規エントリーをブロック
 * 4. 285A: TP3% / SL1%
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const days = ["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13", "2026-07-14"];

const TP_PCT = 0.03;
const SL_PCT = 0.01;
const CONFIRM_BARS = 5; // 5本連続維持

console.log("=== キオクシア優先ルール v2 5日間シミュレーション ===");
console.log(`ルール: 285A大台確認完了(${CONFIRM_BARS}本維持)時点で他銘柄強制決済→285Aエントリー`);
console.log(`285A設定: TP=${(TP_PCT*100).toFixed(1)}% / SL=${(SL_PCT*100).toFixed(1)}%\n`);

// 取引をペアに組み立てる
async function getTradesForDay(day) {
  const [rows] = await conn.query(
    `SELECT id, symbol, action, price, shares, pnl, reason, tradeTime, side
     FROM rt_trades WHERE tradeDate = ? ORDER BY id ASC`,
    [day]
  );
  
  const positions = [];
  const openMap = new Map();
  
  for (const r of rows) {
    const key = r.symbol + "_" + r.side;
    if ((r.action === "buy" && r.side === "long") || (r.action === "short" && r.side === "short")) {
      if (!openMap.has(key)) {
        openMap.set(key, r);
      }
    } else if ((r.action === "sell" && r.side === "long") || (r.action === "cover" && r.side === "short")) {
      if (openMap.has(key)) {
        const entry = openMap.get(key);
        openMap.delete(key);
        positions.push({
          symbol: r.symbol,
          direction: r.side === "long" ? "long" : "short",
          entryTime: entry.tradeTime,
          exitTime: r.tradeTime,
          entryPrice: Number(entry.price),
          exitPrice: Number(r.price),
          shares: Number(entry.shares),
          pnl: Number(r.pnl),
          reason: entry.reason,
        });
      }
    }
  }
  return positions;
}

// 285Aのキャンドルデータから大台確認完了タイミングを全て検出
async function detect285ASignals(day) {
  const [candles] = await conn.query(
    `SELECT candleTime as time, open, high, low, close FROM rt_candles 
     WHERE symbol = '285A' AND tradeDate = ? 
     ORDER BY candleTime ASC`,
    [day]
  );
  
  if (candles.length < 2) return [];
  
  const signals = [];
  let pendingLevel = null;
  let pendingDirection = null;
  let confirmCount = 0;
  
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    
    // 大台超え検出 (100円単位)
    const prevLevel = Math.floor(prev.close / 100) * 100;
    const currLevel = Math.floor(curr.close / 100) * 100;
    
    let newSignal = false;
    
    if (currLevel > prevLevel) {
      // 上方向にキリ番を超えた → BUYシグナル候補
      const level = currLevel;
      if (pendingLevel !== level || pendingDirection !== "buy") {
        pendingLevel = level;
        pendingDirection = "buy";
        confirmCount = 1; // この足が1本目
        newSignal = true;
      }
    } else if (currLevel < prevLevel) {
      // 下方向にキリ番を割った → SELLシグナル候補
      const level = currLevel + 100;
      if (pendingLevel !== level || pendingDirection !== "sell") {
        pendingLevel = level;
        pendingDirection = "sell";
        confirmCount = 1;
        newSignal = true;
      }
    }
    
    // 確認バー処理（新シグナルでない場合）
    if (!newSignal && pendingLevel !== null) {
      const stillValid = pendingDirection === "buy"
        ? curr.close >= pendingLevel
        : curr.close <= pendingLevel;
      
      if (stillValid) {
        confirmCount++;
        if (confirmCount >= CONFIRM_BARS) {
          signals.push({
            time: curr.time,
            price: curr.close,
            direction: pendingDirection === "buy" ? "long" : "short",
            level: pendingLevel,
          });
          // リセット（次のシグナルを待つ）
          pendingLevel = null;
          pendingDirection = null;
          confirmCount = 0;
        }
      } else {
        // 維持失敗 → リセット
        pendingLevel = null;
        pendingDirection = null;
        confirmCount = 0;
      }
    }
  }
  
  return signals;
}

// 特定時刻の任意銘柄の価格を取得
async function getPriceAt(symbol, day, time) {
  const [rows] = await conn.query(
    `SELECT close FROM rt_candles WHERE symbol = ? AND tradeDate = ? AND candleTime = ?`,
    [symbol, day, time]
  );
  return rows.length > 0 ? Number(rows[0].close) : null;
}

// 285Aのエントリー後のTP/SL結果をシミュレート
async function simulate285AEntry(day, entryTime, entryPrice, direction) {
  const tp = direction === "long" ? entryPrice * (1 + TP_PCT) : entryPrice * (1 - TP_PCT);
  const sl = direction === "long" ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
  
  const [candles] = await conn.query(
    `SELECT candleTime as time, open, high, low, close FROM rt_candles 
     WHERE symbol = '285A' AND tradeDate = ? AND candleTime > ?
     ORDER BY candleTime ASC`,
    [day, entryTime]
  );
  
  for (const c of candles) {
    if (direction === "long") {
      if (c.low <= sl) return { exitTime: c.time, exitPrice: sl, pnl: Math.round((sl - entryPrice) * 100), result: "SL" };
      if (c.high >= tp) return { exitTime: c.time, exitPrice: tp, pnl: Math.round((tp - entryPrice) * 100), result: "TP" };
    } else {
      if (c.high >= sl) return { exitTime: c.time, exitPrice: sl, pnl: Math.round((entryPrice - sl) * 100), result: "SL" };
      if (c.low <= tp) return { exitTime: c.time, exitPrice: tp, pnl: Math.round((entryPrice - tp) * 100), result: "TP" };
    }
  }
  
  // 大引け決済
  if (candles.length > 0) {
    const lastPrice = candles[candles.length - 1].close;
    const pnl = direction === "long"
      ? Math.round((lastPrice - entryPrice) * 100)
      : Math.round((entryPrice - lastPrice) * 100);
    return { exitTime: candles[candles.length - 1].time, exitPrice: lastPrice, pnl, result: "大引け" };
  }
  
  return { exitTime: entryTime, exitPrice: entryPrice, pnl: 0, result: "データなし" };
}

// ===== メインシミュレーション =====
let totalActual = 0;
let totalSimulated = 0;
const dailyResults = [];

for (const day of days) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`【${day}】`);
  console.log(`${"=".repeat(60)}`);
  
  const trades = await getTradesForDay(day);
  const actualDayPnl = trades.reduce((s, t) => s + t.pnl, 0);
  
  // 285Aの大台確認完了シグナルを検出
  const signals285A = await detect285ASignals(day);
  
  // 09:30以前のシグナルは除外（NO_ENTRY_BEFORE）
  const validSignals = signals285A.filter(s => s.time >= "09:30" && s.time < "15:05");
  
  console.log(`\n実績: ${trades.length}件, PnL=${actualDayPnl.toLocaleString()}円`);
  for (const t of trades) {
    console.log(`  ${t.entryTime}〜${t.exitTime} | ${t.symbol} ${t.direction} @${t.entryPrice}→${t.exitPrice?.toFixed(0)} | PnL:${t.pnl.toLocaleString()}円`);
  }
  
  if (validSignals.length === 0) {
    console.log(`\n  → 285A大台確認完了シグナルなし → 変更なし`);
    totalActual += actualDayPnl;
    totalSimulated += actualDayPnl;
    dailyResults.push({ day, actual: actualDayPnl, simulated: actualDayPnl, diff: 0 });
    continue;
  }
  
  console.log(`\n285A大台確認完了シグナル (${validSignals.length}件):`);
  for (const s of validSignals) {
    console.log(`  ${s.time} | ${s.direction} @${s.price} | キリ番:${s.level}円`);
  }
  
  // --- シミュレーション ---
  console.log(`\n--- キオクシア優先ルール適用 ---`);
  
  let simDayPnl = 0;
  const processedTradeIndices = new Set();
  const kioxiaHoldingPeriods = []; // {start, end}
  
  for (const sig of validSignals) {
    console.log(`\n  ★285A大台確認完了 @${sig.time} (${sig.direction} @${sig.price}, キリ番${sig.level}円):`);
    
    // この時点で285Aが既にポジション保有中なら無視
    const alreadyHolding = kioxiaHoldingPeriods.some(p => sig.time >= p.start && sig.time <= p.end);
    if (alreadyHolding) {
      console.log(`    → 285A既にポジション保有中 → スキップ`);
      continue;
    }
    
    // この時点で保有中の他銘柄ポジション（強制決済対象）
    const conflicting = trades.filter((t, idx) =>
      t.symbol !== "285A" &&
      t.entryTime <= sig.time &&
      t.exitTime >= sig.time &&
      !processedTradeIndices.has(idx)
    );
    
    if (conflicting.length > 0) {
      console.log(`    保有中の他銘柄（強制決済）:`);
      for (const c of conflicting) {
        const idx = trades.indexOf(c);
        const priceAtTime = await getPriceAt(c.symbol, day, sig.time);
        let forcedPnl = 0;
        if (priceAtTime) {
          forcedPnl = c.direction === "long"
            ? Math.round((priceAtTime - c.entryPrice) * c.shares)
            : Math.round((c.entryPrice - priceAtTime) * c.shares);
        }
        console.log(`      ${c.symbol} ${c.direction} @${c.entryPrice}x${c.shares} → 強制決済@${priceAtTime} | PnL:${forcedPnl.toLocaleString()}円 (本来:${c.pnl.toLocaleString()}円, 差:${(forcedPnl - c.pnl).toLocaleString()}円)`);
        simDayPnl += forcedPnl;
        processedTradeIndices.add(idx);
      }
    } else {
      console.log(`    保有中の他銘柄: なし`);
    }
    
    // 285Aエントリー
    const simResult = await simulate285AEntry(day, sig.time, sig.price, sig.direction);
    console.log(`    285Aエントリー: ${sig.direction} @${sig.price} → ${simResult.result} @${simResult.exitPrice?.toFixed(0)} (${simResult.exitTime}) PnL:${simResult.pnl.toLocaleString()}円`);
    simDayPnl += simResult.pnl;
    
    kioxiaHoldingPeriods.push({ start: sig.time, end: simResult.exitTime });
    
    // 実績の285A取引で同時刻付近のものを処理済みにする
    const matching285A = trades.findIndex((t, idx) =>
      t.symbol === "285A" && !processedTradeIndices.has(idx) &&
      Math.abs(timeToMin(t.entryTime) - timeToMin(sig.time)) <= 10
    );
    if (matching285A >= 0) {
      processedTradeIndices.add(matching285A);
    }
  }
  
  // 処理されていない取引の損益を加算（285A保有中のものはブロック）
  for (let idx = 0; idx < trades.length; idx++) {
    if (processedTradeIndices.has(idx)) continue;
    const t = trades[idx];
    
    // 285A保有中にエントリーされる取引はブロック
    const blockedByKioxia = kioxiaHoldingPeriods.some(p =>
      t.entryTime >= p.start && t.entryTime <= p.end
    );
    
    if (blockedByKioxia && t.symbol !== "285A") {
      console.log(`    [ブロック] ${t.entryTime} ${t.symbol} ${t.direction} → 285A保有中 (失われるPnL:${t.pnl.toLocaleString()}円)`);
    } else {
      simDayPnl += t.pnl;
    }
  }
  
  const diff = simDayPnl - actualDayPnl;
  console.log(`\n  【結果】実績: ${actualDayPnl.toLocaleString()}円 → シミュレーション: ${simDayPnl.toLocaleString()}円 (差分: ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円)`);
  
  totalActual += actualDayPnl;
  totalSimulated += simDayPnl;
  dailyResults.push({ day, actual: actualDayPnl, simulated: simDayPnl, diff });
}

// ===== サマリー =====
console.log(`\n\n${"=".repeat(60)}`);
console.log(`【5日間サマリー】`);
console.log(`${"=".repeat(60)}\n`);

console.log("日付        | 実績        | シミュレーション | 差分");
console.log("-".repeat(65));
for (const r of dailyResults) {
  console.log(`${r.day} | ${r.actual.toLocaleString().padStart(10)}円 | ${r.simulated.toLocaleString().padStart(10)}円 | ${(r.diff >= 0 ? "+" : "") + r.diff.toLocaleString()}円`);
}
console.log("-".repeat(65));
const totalDiff = totalSimulated - totalActual;
console.log(`合計        | ${totalActual.toLocaleString().padStart(10)}円 | ${totalSimulated.toLocaleString().padStart(10)}円 | ${(totalDiff >= 0 ? "+" : "") + totalDiff.toLocaleString()}円`);
console.log(`\n改善率: ${totalActual !== 0 ? ((totalDiff / Math.abs(totalActual)) * 100).toFixed(1) : "N/A"}%`);

await conn.end();

function timeToMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
