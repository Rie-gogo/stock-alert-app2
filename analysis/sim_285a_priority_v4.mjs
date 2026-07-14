/**
 * キオクシア優先ルール 5日間シミュレーション v4
 * 
 * ユーザーの意図を正確に反映:
 * 「285Aのシグナルが出たら他エントリーを決済→285Aエントリー」
 * 
 * シグナル = 大台超え/割れが発生した瞬間（キリ番を超えた足）
 * → その時点で他銘柄を強制決済
 * → 285Aに即エントリー（確認待ちなし）
 * → TP3%/SL1%で管理
 * → 285A保有中は他銘柄エントリーをブロック
 * 
 * 実際のrt_tradesのreason欄からキリ番レベルを抽出し、
 * rt_candlesからそのレベルを最初に超えた時刻を特定する。
 * 
 * さらに、エンジンが見逃した可能性のあるシグナルも検出する。
 * (7/14の13:45 66000超えなど)
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const days = ["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13", "2026-07-14"];

const TP_PCT = 0.03;
const SL_PCT = 0.01;
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:05";

console.log("=== キオクシア優先ルール v4 5日間シミュレーション ===");
console.log(`ルール: 285A大台シグナル発生時点で他銘柄強制決済→285A即エントリー`);
console.log(`285A設定: TP=${(TP_PCT*100).toFixed(1)}% / SL=${(SL_PCT*100).toFixed(1)}%`);
console.log(`エントリー時間帯: ${NO_ENTRY_BEFORE}〜${NO_ENTRY_AFTER}`);
console.log(`キリ番: 100円単位\n`);

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

// 285Aの大台シグナル発生時刻を検出
// 実際のエンジンと同じロジック: 前足closeと今足closeが異なる100円レベルにある場合
// ただし、同じ方向の連続シグナルは最初のもののみ（エンジンのステートマシンと同様）
async function detect285ASignalTimes(day) {
  const [candles] = await conn.query(
    `SELECT candleTime as time, open, high, low, close FROM rt_candles 
     WHERE symbol = '285A' AND tradeDate = ? 
     ORDER BY candleTime ASC`,
    [day]
  );
  
  if (candles.length < 2) return [];
  
  const signals = [];
  let lastSignalDirection = null;
  let lastSignalLevel = null;
  
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    
    if (curr.time < NO_ENTRY_BEFORE || curr.time >= NO_ENTRY_AFTER) continue;
    
    const prevLevel = Math.floor(prev.close / 100) * 100;
    const currLevel = Math.floor(curr.close / 100) * 100;
    
    if (currLevel === prevLevel) continue;
    
    let direction, level;
    if (currLevel > prevLevel) {
      direction = "long";
      level = currLevel;
    } else {
      direction = "short";
      level = currLevel + 100;
    }
    
    // 同じ方向・同じレベルの連続シグナルは無視
    // ただし異なるレベルなら新しいシグナルとして扱う
    if (direction === lastSignalDirection && level === lastSignalLevel) continue;
    
    lastSignalDirection = direction;
    lastSignalLevel = level;
    
    signals.push({
      time: curr.time,
      price: curr.close,
      direction,
      level,
    });
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
      if (Number(c.low) <= sl) return { exitTime: c.time, exitPrice: sl, pnl: Math.round((sl - entryPrice) * 100), result: "SL" };
      if (Number(c.high) >= tp) return { exitTime: c.time, exitPrice: tp, pnl: Math.round((tp - entryPrice) * 100), result: "TP" };
    } else {
      if (Number(c.high) >= sl) return { exitTime: c.time, exitPrice: sl, pnl: Math.round((entryPrice - sl) * 100), result: "SL" };
      if (Number(c.low) <= tp) return { exitTime: c.time, exitPrice: tp, pnl: Math.round((entryPrice - tp) * 100), result: "TP" };
    }
  }
  
  if (candles.length > 0) {
    const lastPrice = Number(candles[candles.length - 1].close);
    const pnl = direction === "long"
      ? Math.round((lastPrice - entryPrice) * 100)
      : Math.round((entryPrice - lastPrice) * 100);
    return { exitTime: candles[candles.length - 1].time, exitPrice: lastPrice, pnl, result: "大引け" };
  }
  
  return { exitTime: entryTime, exitPrice: entryPrice, pnl: 0, result: "データなし" };
}

function timeToMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
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
  
  // 285Aの全シグナル発生時刻を検出
  const allSignals = await detect285ASignalTimes(day);
  
  console.log(`\n実績: ${trades.length}件, PnL=${actualDayPnl.toLocaleString()}円`);
  for (const t of trades) {
    console.log(`  ${t.entryTime}〜${t.exitTime} | ${t.symbol} ${t.direction} @${t.entryPrice}→${Number(t.exitPrice).toFixed(0)} | PnL:${t.pnl.toLocaleString()}円`);
  }
  
  console.log(`\n285A大台シグナル発生: ${allSignals.length}件 (最初の5件表示)`);
  for (const s of allSignals.slice(0, 5)) {
    console.log(`  ${s.time} | ${s.direction} @${s.price} | キリ番:${s.level}円`);
  }
  if (allSignals.length > 5) console.log(`  ... 他${allSignals.length - 5}件`);
  
  // --- シミュレーション ---
  // 285Aのシグナルが出るたびに:
  // 1. 他銘柄保有中なら強制決済
  // 2. 285Aにエントリー
  // 3. 285A決済まで次のシグナルは無視
  console.log(`\n--- キオクシア優先ルール適用 ---`);
  
  let simDayPnl = 0;
  const processedTradeIndices = new Set();
  const kioxiaHoldingPeriods = []; // {start, end}
  let kioxiaEntryCount = 0;
  
  for (const sig of allSignals) {
    // 285A保有中なら無視
    const alreadyHolding = kioxiaHoldingPeriods.some(p => sig.time >= p.start && sig.time <= p.end);
    if (alreadyHolding) continue;
    
    // この時点で保有中の他銘柄ポジション
    const conflicting = trades.filter((t, idx) =>
      t.symbol !== "285A" &&
      t.entryTime <= sig.time &&
      t.exitTime > sig.time &&
      !processedTradeIndices.has(idx)
    );
    
    kioxiaEntryCount++;
    console.log(`\n  [${kioxiaEntryCount}] 285Aシグナル @${sig.time} (${sig.direction} @${sig.price}, キリ番${sig.level}円):`);
    
    if (conflicting.length > 0) {
      console.log(`    ★強制決済:`);
      for (const c of conflicting) {
        const idx = trades.indexOf(c);
        const priceAtTime = await getPriceAt(c.symbol, day, sig.time);
        let forcedPnl = 0;
        if (priceAtTime) {
          forcedPnl = c.direction === "long"
            ? Math.round((priceAtTime - c.entryPrice) * c.shares)
            : Math.round((c.entryPrice - priceAtTime) * c.shares);
        }
        console.log(`      ${c.symbol} ${c.direction} @${c.entryPrice}x${c.shares} → @${priceAtTime} | PnL:${forcedPnl.toLocaleString()}円 (本来:${c.pnl.toLocaleString()}円)`);
        simDayPnl += forcedPnl;
        processedTradeIndices.add(idx);
      }
    }
    
    // 285Aエントリー
    const simResult = await simulate285AEntry(day, sig.time, sig.price, sig.direction);
    const exitPriceStr = typeof simResult.exitPrice === 'number' ? simResult.exitPrice.toFixed(0) : String(simResult.exitPrice);
    console.log(`    285A: ${sig.direction} @${sig.price} → ${simResult.result} @${exitPriceStr} (${simResult.exitTime}) PnL:${simResult.pnl.toLocaleString()}円`);
    simDayPnl += simResult.pnl;
    
    kioxiaHoldingPeriods.push({ start: sig.time, end: simResult.exitTime });
    
    // 実績の285A取引を処理済みにする
    for (let idx = 0; idx < trades.length; idx++) {
      if (processedTradeIndices.has(idx)) continue;
      const t = trades[idx];
      if (t.symbol === "285A") {
        const diff = Math.abs(timeToMin(t.entryTime) - timeToMin(sig.time));
        if (diff <= 20) {
          processedTradeIndices.add(idx);
          break;
        }
      }
    }
  }
  
  // 未処理の取引
  for (let idx = 0; idx < trades.length; idx++) {
    if (processedTradeIndices.has(idx)) continue;
    const t = trades[idx];
    
    const blockedByKioxia = kioxiaHoldingPeriods.some(p =>
      t.entryTime >= p.start && t.entryTime <= p.end
    );
    
    if (blockedByKioxia && t.symbol !== "285A") {
      console.log(`    [ブロック] ${t.entryTime} ${t.symbol} ${t.direction} PnL:${t.pnl.toLocaleString()}円`);
    } else if (t.symbol === "285A") {
      // 285Aの取引で処理されなかったもの（シグナルが検出されなかった場合）
      // → 実績通り加算
      simDayPnl += t.pnl;
    } else {
      simDayPnl += t.pnl;
    }
  }
  
  const diff = simDayPnl - actualDayPnl;
  console.log(`\n  【日次結果】実績: ${actualDayPnl.toLocaleString()}円 → シミュ: ${simDayPnl.toLocaleString()}円 (差分: ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円)`);
  console.log(`  285Aエントリー回数: ${kioxiaEntryCount}回`);
  
  totalActual += actualDayPnl;
  totalSimulated += simDayPnl;
  dailyResults.push({ day, actual: actualDayPnl, simulated: simDayPnl, diff, entries: kioxiaEntryCount });
}

// ===== サマリー =====
console.log(`\n\n${"=".repeat(60)}`);
console.log(`【5日間サマリー】`);
console.log(`${"=".repeat(60)}\n`);

console.log("日付        | 実績        | シミュレーション | 差分        | 285A回数");
console.log("-".repeat(75));
for (const r of dailyResults) {
  console.log(`${r.day} | ${r.actual.toLocaleString().padStart(10)}円 | ${r.simulated.toLocaleString().padStart(10)}円 | ${(r.diff >= 0 ? "+" : "") + r.diff.toLocaleString().padStart(9)}円 | ${r.entries}回`);
}
console.log("-".repeat(75));
const totalDiff = totalSimulated - totalActual;
console.log(`合計        | ${totalActual.toLocaleString().padStart(10)}円 | ${totalSimulated.toLocaleString().padStart(10)}円 | ${(totalDiff >= 0 ? "+" : "") + totalDiff.toLocaleString().padStart(9)}円 |`);
console.log(`\n改善率: ${totalActual !== 0 ? ((totalDiff / Math.abs(totalActual)) * 100).toFixed(1) : "N/A"}%`);

await conn.end();
