/**
 * キオクシア優先ルール 5日間シミュレーション v3
 * 
 * 正しいアプローチ:
 * - 実際のエンジンでは「大台シグナル発生」→「5本確認」→「押し目待ち(最大5本)」→エントリー
 * - シグナル発生 = 前足close <= level かつ 今足close > level (100円単位キリ番)
 * - 確認 = 5本連続でキリ番以上を維持
 * - 押し目待ち = 最大5本待って押し目なければ「強トレンド」としてエントリー
 * 
 * このシミュレーションでは:
 * - 285Aの大台シグナル発生時点を検出
 * - 5本確認完了時点を計算
 * - その時点（確認完了時点）で他銘柄を強制決済→285Aエントリー
 *   （押し目待ちをスキップして即エントリー = 優先ルールの効果）
 * 
 * 注意: detectRoundLevel は step=100 なので、66000だけでなく66100, 66200...全て対象
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const days = ["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13", "2026-07-14"];

const TP_PCT = 0.03;
const SL_PCT = 0.01;
const CONFIRM_BARS = 5;

console.log("=== キオクシア優先ルール v3 5日間シミュレーション ===");
console.log(`ルール: 285A大台シグナル発生→${CONFIRM_BARS}本確認完了時点で他銘柄強制決済→285A即エントリー`);
console.log(`285A設定: TP=${(TP_PCT*100).toFixed(1)}% / SL=${(SL_PCT*100).toFixed(1)}%`);
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

// 285Aのキャンドルから大台確認完了タイミングを全て検出
// エンジンの挙動を忠実に再現:
// 1. シグナル発生（前足close <= level かつ 今足close > level）
// 2. その後5本連続でlevel以上を維持 → 確認完了
async function detect285AConfirmations(day) {
  const [candles] = await conn.query(
    `SELECT candleTime as time, open, high, low, close FROM rt_candles 
     WHERE symbol = '285A' AND tradeDate = ? 
     ORDER BY candleTime ASC`,
    [day]
  );
  
  if (candles.length < 2) return [];
  
  const confirmations = [];
  
  // 全てのキリ番超え/割れシグナルを検出し、確認完了を追跡
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    
    const prevLevel100 = Math.floor(prev.close / 100) * 100;
    const currLevel100 = Math.floor(curr.close / 100) * 100;
    
    if (currLevel100 === prevLevel100) continue;
    
    let direction, level;
    if (currLevel100 > prevLevel100) {
      // 上方向: BUY
      direction = "long";
      level = currLevel100; // 超えたキリ番
    } else {
      // 下方向: SHORT
      direction = "short";
      level = currLevel100 + 100; // 割ったキリ番
    }
    
    // この時点からCONFIRM_BARS本連続維持を確認
    let confirmed = true;
    let confirmTime = null;
    let confirmPrice = null;
    
    for (let j = 1; j <= CONFIRM_BARS; j++) {
      const checkIdx = i + j;
      if (checkIdx >= candles.length) {
        confirmed = false;
        break;
      }
      const checkCandle = candles[checkIdx];
      const stillValid = direction === "long"
        ? checkCandle.close >= level
        : checkCandle.close <= level;
      
      if (!stillValid) {
        confirmed = false;
        break;
      }
      
      if (j === CONFIRM_BARS) {
        confirmTime = checkCandle.time;
        confirmPrice = checkCandle.close;
      }
    }
    
    if (confirmed && confirmTime) {
      confirmations.push({
        signalTime: curr.time,
        confirmTime,
        price: confirmPrice,
        direction,
        level,
      });
    }
  }
  
  return confirmations;
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
  
  if (candles.length > 0) {
    const lastPrice = candles[candles.length - 1].close;
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
  
  // 285Aの全大台確認完了を検出
  const allConfirmations = await detect285AConfirmations(day);
  
  // 09:30以前と15:05以降を除外
  const validConfirmations = allConfirmations.filter(c => c.confirmTime >= "09:30" && c.confirmTime < "15:05");
  
  console.log(`\n実績: ${trades.length}件, PnL=${actualDayPnl.toLocaleString()}円`);
  for (const t of trades) {
    console.log(`  ${t.entryTime}〜${t.exitTime} | ${t.symbol} ${t.direction} @${t.entryPrice}→${t.exitPrice?.toFixed(0)} | PnL:${t.pnl.toLocaleString()}円`);
  }
  
  console.log(`\n285A大台確認完了: ${validConfirmations.length}件`);
  for (const c of validConfirmations) {
    console.log(`  シグナル${c.signalTime}→確認完了${c.confirmTime} | ${c.direction} @${c.price} | キリ番:${c.level}円`);
  }
  
  if (validConfirmations.length === 0) {
    console.log(`  → シグナルなし → 変更なし`);
    totalActual += actualDayPnl;
    totalSimulated += actualDayPnl;
    dailyResults.push({ day, actual: actualDayPnl, simulated: actualDayPnl, diff: 0 });
    continue;
  }
  
  // --- シミュレーション ---
  console.log(`\n--- キオクシア優先ルール適用 ---`);
  
  let simDayPnl = 0;
  const processedTradeIndices = new Set();
  const kioxiaHoldingPeriods = [];
  
  // 最初の確認完了のみ使用（1日1回のエントリーに制限）
  // → いや、実際のエンジンは複数回エントリーするので全て処理する
  // ただし285A保有中の新シグナルはスキップ
  
  for (const conf of validConfirmations) {
    // 285A保有中なら無視
    const alreadyHolding = kioxiaHoldingPeriods.some(p => 
      conf.confirmTime >= p.start && conf.confirmTime <= p.end
    );
    if (alreadyHolding) continue;
    
    console.log(`\n  ★285A確認完了 @${conf.confirmTime} (シグナル:${conf.signalTime}, ${conf.direction} @${conf.price}, キリ番${conf.level}円):`);
    
    // この時点で保有中の他銘柄ポジション
    const conflicting = trades.filter((t, idx) =>
      t.symbol !== "285A" &&
      t.entryTime <= conf.confirmTime &&
      t.exitTime >= conf.confirmTime &&
      !processedTradeIndices.has(idx)
    );
    
    if (conflicting.length > 0) {
      console.log(`    ★強制決済対象:`);
      for (const c of conflicting) {
        const idx = trades.indexOf(c);
        const priceAtTime = await getPriceAt(c.symbol, day, conf.confirmTime);
        let forcedPnl = 0;
        if (priceAtTime) {
          forcedPnl = c.direction === "long"
            ? Math.round((priceAtTime - c.entryPrice) * c.shares)
            : Math.round((c.entryPrice - priceAtTime) * c.shares);
        }
        console.log(`      ${c.symbol} ${c.direction} @${c.entryPrice}x${c.shares} → @${priceAtTime} | 強制PnL:${forcedPnl.toLocaleString()}円 (本来:${c.pnl.toLocaleString()}円)`);
        simDayPnl += forcedPnl;
        processedTradeIndices.add(idx);
      }
    } else {
      console.log(`    保有中の他銘柄: なし`);
    }
    
    // 285Aエントリー（確認完了時点の価格で即エントリー）
    const simResult = await simulate285AEntry(day, conf.confirmTime, conf.price, conf.direction);
    console.log(`    285A: ${conf.direction} @${conf.price} → ${simResult.result} @${simResult.exitPrice?.toFixed(0)} (${simResult.exitTime}) PnL:${simResult.pnl.toLocaleString()}円`);
    simDayPnl += simResult.pnl;
    
    kioxiaHoldingPeriods.push({ start: conf.confirmTime, end: simResult.exitTime });
    
    // 実績の285A取引を処理済みにする（同方向で近い時刻のもの）
    for (let idx = 0; idx < trades.length; idx++) {
      if (processedTradeIndices.has(idx)) continue;
      const t = trades[idx];
      if (t.symbol === "285A" && t.direction === conf.direction) {
        const diff = Math.abs(timeToMin(t.entryTime) - timeToMin(conf.confirmTime));
        if (diff <= 15) {
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
    } else {
      simDayPnl += t.pnl;
    }
  }
  
  const diff = simDayPnl - actualDayPnl;
  console.log(`\n  【結果】実績: ${actualDayPnl.toLocaleString()}円 → シミュ: ${simDayPnl.toLocaleString()}円 (差分: ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円)`);
  
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
