/**
 * Confirm Break バックテスト
 * 
 * 0.8%乖離率でブロックされた73件に対して、
 * リアルタイム条件でConfirm Break再エントリーを検証する。
 * 
 * ユーザー指定のConfirm Breakフロー:
 * ① 大台突破 → 0.8%以上乖離 → 即エントリー禁止
 * ② 反発開始（戻り高値形成の起点）
 * ③ 戻り高値形成（SHORTの場合: 一度上昇して高値を付ける）
 * ④ 戻り高値更新なし（次足で高値更新しない = 反発終了の確認）
 * ⑤ 安値再割れ（直近安値を下回る = Confirm Break完了 → SHORT）
 * 
 * 未来データ不使用: 各足の判定は当該足確定時点の情報のみ使用
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// ============================================================
// 定数
// ============================================================
const SL = 0.005;  // 0.5%
const TP = 0.015;  // 1.5%
const CONFIRM_BREAK_TIMEOUT = 30; // 最大30本（30分）待機
const FORCE_EXIT_TIME = "15:25";
const INITIAL_CAPITAL = 3_000_000;
const LOT_RATIO = 0.9;

// ============================================================
// 1. データ取得
// ============================================================

// 全エントリートレード
const [allEntries] = await conn.execute(`
  SELECT id, tradeDate, symbol, symbolName, action, price, shares, amount, reason, tradeTime, side, boardSignal
  FROM rt_trades
  WHERE action IN ('buy','short')
  ORDER BY tradeDate, tradeTime
`);

// 全決済トレード
const [allExits] = await conn.execute(`
  SELECT id, tradeDate, symbol, action, price, shares, pnl, reason, tradeTime, side
  FROM rt_trades
  WHERE action IN ('sell','cover')
  ORDER BY tradeDate, tradeTime
`);

// エントリーと決済をペアリング
const exitsCopy = [...allExits];
const trades = [];
for (const entry of allEntries) {
  const exit = exitsCopy.find(
    e => e.tradeDate === entry.tradeDate && e.symbol === entry.symbol && e.side === entry.side
      && e.tradeTime >= entry.tradeTime && e.pnl !== null
  );
  if (exit) {
    trades.push({
      id: entry.id,
      tradeDate: entry.tradeDate,
      symbol: entry.symbol,
      symbolName: entry.symbolName,
      action: entry.action,
      entryPrice: parseFloat(entry.price),
      exitPrice: parseFloat(exit.price),
      shares: entry.shares,
      pnl: exit.pnl,
      reason: entry.reason,
      tradeTime: entry.tradeTime,
      exitTime: exit.tradeTime,
      side: entry.side,
      boardSignal: entry.boardSignal,
      exitReason: exit.reason,
    });
    const idx = exitsCopy.indexOf(exit);
    exitsCopy.splice(idx, 1);
  }
}

// 大台シグナル判定
function isRoundSignal(reason) {
  return reason.includes("大台確認") || reason.includes("大台超え") || reason.includes("大台割れ");
}
function getRoundLevel(reason) {
  const m = reason.match(/(\d+(?:\.\d+)?)円/);
  return m ? parseFloat(m[1]) : null;
}

// 乖離率計算
for (const t of trades) {
  t.isRound = isRoundSignal(t.reason);
  t.roundLevel = t.isRound ? getRoundLevel(t.reason) : null;
  t.divergence = t.isRound && t.roundLevel ? Math.abs(t.entryPrice - t.roundLevel) / t.roundLevel : null;
}

// 0.8%でブロックされた取引を特定
const blocked08 = trades.filter(t => t.isRound && t.divergence !== null && t.divergence > 0.008);
const passed08 = trades.filter(t => !t.isRound || t.divergence === null || t.divergence <= 0.008);

console.log(`総トレード: ${trades.length}件`);
console.log(`0.8%ブロック対象: ${blocked08.length}件`);
console.log(`0.8%通過: ${passed08.length}件`);

// ============================================================
// 2. Confirm Break シミュレーション
// ============================================================

/**
 * Confirm Break ステートマシン (SHORT用)
 * 
 * ブロックされた時点（= 元のエントリー足）から1分足を追跡:
 * 
 * Phase 1: 反発待ち
 *   - ブロック時のclose価格を基準(signalPrice)とする
 *   - close > signalPrice の足が出現 → 反発開始、swingHighをその足のhighに設定
 * 
 * Phase 2: 戻り高値形成
 *   - 高値更新中: high > swingHigh → swingHigh更新
 *   - 高値更新なし: high < swingHigh → Phase 3へ
 * 
 * Phase 3: 安値再割れ確認
 *   - swingHighが確定した足以降で、close < signalPrice → Confirm Break成立 → SHORT
 *   - ただし再度high > swingHighなら Phase 2に戻る
 * 
 * LONG用は逆（反落待ち → 戻り安値形成 → 高値再突破）
 */

const confirmBreakResults = [];

for (const blockedTrade of blocked08) {
  const { symbol, tradeDate, tradeTime, entryPrice, side, reason, roundLevel } = blockedTrade;
  
  // この銘柄・日付の1分足を取得
  const [candleRows] = await conn.query(
    `SELECT candleTime, open, high, low, close, volume
     FROM rt_candles WHERE symbol = ? AND tradeDate = ?
     ORDER BY candleTime ASC`,
    [symbol, tradeDate]
  );
  
  const candles = candleRows.map(r => ({
    candleTime: r.candleTime,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
  
  // ブロックされた足のインデックスを特定
  const blockIdx = candles.findIndex(c => c.candleTime >= tradeTime);
  if (blockIdx < 0 || candles.length - blockIdx < 3) {
    confirmBreakResults.push({
      ...blockedTrade,
      cbResult: "NO_DATA",
      cbEntryPrice: null,
      cbEntryTime: null,
      cbExitPrice: null,
      cbExitTime: null,
      cbPnl: null,
      cbExitReason: null,
      cbHoldBars: null,
      cbDelay: null,
    });
    continue;
  }
  
  const signalPrice = candles[blockIdx].close; // ブロック時のclose = 元のエントリー想定価格
  const isShort = side === "short" || blockedTrade.action === "short";
  
  // Confirm Break ステートマシン
  let phase = 1; // 1=反発待ち, 2=戻り高値/安値形成, 3=再割れ確認
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  let swingConfirmedIdx = -1;
  let cbEntryIdx = -1;
  let cbEntryPrice = 0;
  let timedOut = false;
  
  for (let i = blockIdx + 1; i < candles.length && i <= blockIdx + CONFIRM_BREAK_TIMEOUT; i++) {
    const c = candles[i];
    
    // 15:25以降はエントリーしない
    if (c.candleTime >= FORCE_EXIT_TIME) {
      timedOut = true;
      break;
    }
    
    if (isShort) {
      // === SHORT Confirm Break ===
      switch (phase) {
        case 1: // 反発待ち: close > signalPrice
          if (c.close > signalPrice || c.high > signalPrice) {
            phase = 2;
            swingHigh = c.high;
            swingConfirmedIdx = i;
          }
          break;
          
        case 2: // 戻り高値形成中
          if (c.high > swingHigh) {
            // 高値更新 → 継続
            swingHigh = c.high;
            swingConfirmedIdx = i;
          } else {
            // 高値更新なし → Phase 3（戻り高値確定）
            phase = 3;
          }
          break;
          
        case 3: // 安値再割れ確認
          if (c.high > swingHigh) {
            // 再度高値更新 → Phase 2に戻る
            swingHigh = c.high;
            swingConfirmedIdx = i;
            phase = 2;
          } else if (c.close < signalPrice) {
            // Confirm Break成立! → SHORT エントリー
            cbEntryIdx = i;
            cbEntryPrice = c.close;
            break;
          }
          break;
      }
    } else {
      // === LONG Confirm Break ===
      switch (phase) {
        case 1: // 反落待ち: close < signalPrice
          if (c.close < signalPrice || c.low < signalPrice) {
            phase = 2;
            swingLow = c.low;
            swingConfirmedIdx = i;
          }
          break;
          
        case 2: // 戻り安値形成中
          if (c.low < swingLow) {
            // 安値更新 → 継続
            swingLow = c.low;
            swingConfirmedIdx = i;
          } else {
            // 安値更新なし → Phase 3（戻り安値確定）
            phase = 3;
          }
          break;
          
        case 3: // 高値再突破確認
          if (c.low < swingLow) {
            // 再度安値更新 → Phase 2に戻る
            swingLow = c.low;
            swingConfirmedIdx = i;
            phase = 2;
          } else if (c.close > signalPrice) {
            // Confirm Break成立! → LONG エントリー
            cbEntryIdx = i;
            cbEntryPrice = c.close;
            break;
          }
          break;
      }
    }
    
    if (cbEntryIdx >= 0) break;
  }
  
  // Confirm Breakが成立しなかった場合
  if (cbEntryIdx < 0) {
    confirmBreakResults.push({
      ...blockedTrade,
      cbResult: timedOut ? "TIMEOUT_EOD" : "TIMEOUT",
      cbEntryPrice: null,
      cbEntryTime: null,
      cbExitPrice: null,
      cbExitTime: null,
      cbPnl: null,
      cbExitReason: null,
      cbHoldBars: null,
      cbDelay: cbEntryIdx < 0 ? null : 0,
    });
    continue;
  }
  
  // Confirm Break成立 → TP/SL/EODシミュレーション
  const shares = Math.floor((INITIAL_CAPITAL * LOT_RATIO) / cbEntryPrice);
  let cbExitPrice = 0;
  let cbExitTime = "";
  let cbExitReason = "";
  let cbHoldBars = 0;
  
  for (let i = cbEntryIdx + 1; i < candles.length; i++) {
    const c = candles[i];
    cbHoldBars = i - cbEntryIdx;
    
    if (isShort) {
      // SHORT: SL = high >= entry * (1 + SL%), TP = low <= entry * (1 - TP%)
      const slPrice = cbEntryPrice * (1 + SL);
      const tpPrice = cbEntryPrice * (1 - TP);
      
      if (c.high >= slPrice) {
        cbExitPrice = slPrice;
        cbExitTime = c.candleTime;
        cbExitReason = "SL";
        break;
      }
      if (c.low <= tpPrice) {
        cbExitPrice = tpPrice;
        cbExitTime = c.candleTime;
        cbExitReason = "TP";
        break;
      }
    } else {
      // LONG: SL = low <= entry * (1 - SL%), TP = high >= entry * (1 + TP%)
      const slPrice = cbEntryPrice * (1 - SL);
      const tpPrice = cbEntryPrice * (1 + TP);
      
      if (c.low <= slPrice) {
        cbExitPrice = slPrice;
        cbExitTime = c.candleTime;
        cbExitReason = "SL";
        break;
      }
      if (c.high >= tpPrice) {
        cbExitPrice = tpPrice;
        cbExitTime = c.candleTime;
        cbExitReason = "TP";
        break;
      }
    }
    
    // 大引け強制決済
    if (c.candleTime >= "15:25") {
      cbExitPrice = c.close;
      cbExitTime = c.candleTime;
      cbExitReason = "EOD";
      break;
    }
  }
  
  // 最後まで決済されなかった場合
  if (!cbExitReason) {
    const lastCandle = candles[candles.length - 1];
    cbExitPrice = lastCandle.close;
    cbExitTime = lastCandle.candleTime;
    cbExitReason = "EOD";
    cbHoldBars = candles.length - 1 - cbEntryIdx;
  }
  
  // PnL計算
  let cbPnl;
  if (isShort) {
    cbPnl = (cbEntryPrice - cbExitPrice) * shares;
  } else {
    cbPnl = (cbExitPrice - cbEntryPrice) * shares;
  }
  
  confirmBreakResults.push({
    ...blockedTrade,
    cbResult: "ENTRY",
    cbEntryPrice,
    cbEntryTime: candles[cbEntryIdx].candleTime,
    cbExitPrice,
    cbExitTime,
    cbPnl: Math.round(cbPnl),
    cbExitReason,
    cbHoldBars,
    cbDelay: cbEntryIdx - blockIdx,
  });
}

await conn.end();

// ============================================================
// 3. 結果集計
// ============================================================

const cbEntries = confirmBreakResults.filter(r => r.cbResult === "ENTRY");
const cbTimeouts = confirmBreakResults.filter(r => r.cbResult === "TIMEOUT" || r.cbResult === "TIMEOUT_EOD");
const cbNoData = confirmBreakResults.filter(r => r.cbResult === "NO_DATA");

console.log("\n" + "=".repeat(70));
console.log("  Confirm Break バックテスト結果");
console.log("=".repeat(70));

console.log(`\nブロック取引: ${blocked08.length}件`);
console.log(`  → CB成立(エントリー): ${cbEntries.length}件`);
console.log(`  → タイムアウト: ${cbTimeouts.length}件`);
console.log(`  → データ不足: ${cbNoData.length}件`);

// --- Confirm Break成立取引の統計 ---
function calcStats(arr, label) {
  if (arr.length === 0) { console.log(`\n${label}: 取引なし`); return null; }
  const wins = arr.filter(t => t > 0);
  const losses = arr.filter(t => t <= 0);
  const total = arr.reduce((s, v) => s + v, 0);
  const grossProfit = wins.reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? "∞" : "0.00";
  const expectation = Math.round(total / arr.length);
  
  // Max DD
  let peak = 0, maxDD = 0, cum = 0;
  for (const v of arr) {
    cum += v;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  
  return { count: arr.length, winRate: (wins.length / arr.length * 100).toFixed(1), total, pf, expectation, maxDD, wins: wins.length, losses: losses.length };
}

const cbPnls = cbEntries.map(r => r.cbPnl);
const cbStats = calcStats(cbPnls, "Confirm Break");

// --- 3方式比較 ---
// Baseline: 全トレード
const baselinePnls = trades.map(t => t.pnl);
const baselineStats = calcStats(baselinePnls, "Baseline");

// 0.8%ブロック: passed08のみ
const block08Pnls = passed08.map(t => t.pnl);
const block08Stats = calcStats(block08Pnls, "0.8%ブロック");

// 0.8%+Confirm Break: passed08 + CB成立取引
const combinedPnls = [...passed08.map(t => t.pnl), ...cbPnls];
// 日時順にソートするために元データを使う
const combinedTrades = [
  ...passed08.map(t => ({ date: t.tradeDate, time: t.tradeTime, pnl: t.pnl })),
  ...cbEntries.map(r => ({ date: r.tradeDate, time: r.cbEntryTime, pnl: r.cbPnl })),
].sort((a, b) => a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date));
const combinedPnlsSorted = combinedTrades.map(t => t.pnl);
const combinedStats = calcStats(combinedPnlsSorted, "0.8%+CB");

console.log("\n" + "=".repeat(70));
console.log("  3方式比較");
console.log("=".repeat(70));
console.log("\n指標 | Baseline | 0.8%ブロック | 0.8%+Confirm Break");
console.log("-".repeat(70));
console.log(`総損益 | ${baselineStats.total} | ${block08Stats.total} | ${combinedStats.total}`);
console.log(`PF | ${baselineStats.pf} | ${block08Stats.pf} | ${combinedStats.pf}`);
console.log(`最大DD | ${baselineStats.maxDD} | ${block08Stats.maxDD} | ${combinedStats.maxDD}`);
console.log(`期待値 | ${baselineStats.expectation} | ${block08Stats.expectation} | ${combinedStats.expectation}`);
console.log(`取引数 | ${baselineStats.count} | ${block08Stats.count} | ${combinedStats.count}`);
console.log(`勝率 | ${baselineStats.winRate}% | ${block08Stats.winRate}% | ${combinedStats.winRate}%`);

// 平均保有時間
const baselineHoldBars = trades.map(t => {
  if (!t.tradeTime || !t.exitTime) return 0;
  const [eh, em] = t.tradeTime.split(":").map(Number);
  const [xh, xm] = t.exitTime.split(":").map(Number);
  return (xh * 60 + xm) - (eh * 60 + em);
}).filter(v => v > 0);
const avgHoldBaseline = baselineHoldBars.length > 0 ? Math.round(baselineHoldBars.reduce((s, v) => s + v, 0) / baselineHoldBars.length) : 0;

const cbHoldBars = cbEntries.map(r => r.cbHoldBars);
const avgHoldCB = cbHoldBars.length > 0 ? Math.round(cbHoldBars.reduce((s, v) => s + v, 0) / cbHoldBars.length) : 0;
const avgDelayCB = cbEntries.length > 0 ? Math.round(cbEntries.reduce((s, r) => s + r.cbDelay, 0) / cbEntries.length) : 0;

console.log(`平均保有時間 | ${avgHoldBaseline}分 | ${avgHoldBaseline}分 | CB部分:${avgHoldCB}分(遅延${avgDelayCB}分)`);

// --- 7/7 と 7/16 の比較 ---
console.log("\n" + "=".repeat(70));
console.log("  7/7 と 7/16 の比較");
console.log("=".repeat(70));

function dayPnl(tradesArr, date) {
  return tradesArr.filter(t => t.date === date || t.tradeDate === date).reduce((s, t) => s + (t.pnl || t.cbPnl || 0), 0);
}

const bl77 = trades.filter(t => t.tradeDate === "2026-07-07").reduce((s, t) => s + t.pnl, 0);
const bl716 = trades.filter(t => t.tradeDate === "2026-07-16").reduce((s, t) => s + t.pnl, 0);
const b08_77 = passed08.filter(t => t.tradeDate === "2026-07-07").reduce((s, t) => s + t.pnl, 0);
const b08_716 = passed08.filter(t => t.tradeDate === "2026-07-16").reduce((s, t) => s + t.pnl, 0);
const cb77 = cbEntries.filter(r => r.tradeDate === "2026-07-07").reduce((s, r) => s + r.cbPnl, 0);
const cb716 = cbEntries.filter(r => r.tradeDate === "2026-07-16").reduce((s, r) => s + r.cbPnl, 0);
const combined77 = b08_77 + cb77;
const combined716 = b08_716 + cb716;

console.log("\n日付 | Baseline | 0.8%ブロック | 0.8%+CB");
console.log("-".repeat(60));
console.log(`7/7 | ${bl77} | ${b08_77} | ${combined77}`);
console.log(`7/16 | ${bl716} | ${b08_716} | ${combined716}`);

// --- ブロック取引回収率 ---
console.log("\n" + "=".repeat(70));
console.log("  ブロック取引回収分析");
console.log("=".repeat(70));

const originalBlockedPnl = blocked08.reduce((s, t) => s + t.pnl, 0);
const cbRecoveredPnl = cbEntries.reduce((s, r) => s + r.cbPnl, 0);
const cbProfitTrades = cbEntries.filter(r => r.cbPnl > 0);
const cbLossTrades = cbEntries.filter(r => r.cbPnl <= 0);

console.log(`\nブロック取引の元損益: ${originalBlockedPnl}円`);
console.log(`  うち利益取引: ${blocked08.filter(t => t.pnl > 0).length}件, +${blocked08.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0)}円`);
console.log(`  うち損失取引: ${blocked08.filter(t => t.pnl <= 0).length}件, ${blocked08.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0)}円`);
console.log(`\nConfirm Break再エントリー:`);
console.log(`  成立: ${cbEntries.length}件 / ${blocked08.length}件 (${(cbEntries.length / blocked08.length * 100).toFixed(1)}%)`);
console.log(`  CB追加利益: +${cbProfitTrades.reduce((s, r) => s + r.cbPnl, 0)}円 (${cbProfitTrades.length}件)`);
console.log(`  CB追加損失: ${cbLossTrades.reduce((s, r) => s + r.cbPnl, 0)}円 (${cbLossTrades.length}件)`);
console.log(`  CB純損益: ${cbRecoveredPnl}円`);
console.log(`\n回収率: ${originalBlockedPnl !== 0 ? (cbRecoveredPnl / Math.abs(originalBlockedPnl) * 100).toFixed(1) : 0}%`);
console.log(`  (元のブロック取引損益 ${originalBlockedPnl}円 に対してCBで ${cbRecoveredPnl}円 を回収/追加)`);

// --- 個別取引詳細 ---
console.log("\n" + "=".repeat(70));
console.log("  Confirm Break 個別取引詳細");
console.log("=".repeat(70));
console.log("\n日付 | 銘柄 | 方向 | 元PnL | CB結果 | CB遅延 | CBエントリー | CB損益 | CB決済理由 | CB保有");
console.log("-".repeat(120));

for (const r of confirmBreakResults) {
  const dir = r.side === "short" || r.action === "short" ? "S" : "L";
  if (r.cbResult === "ENTRY") {
    console.log(`${r.tradeDate} | ${r.symbol} | ${dir} | ${r.pnl} | ENTRY | ${r.cbDelay}本 | ${r.cbEntryPrice} @ ${r.cbEntryTime} | ${r.cbPnl} | ${r.cbExitReason} | ${r.cbHoldBars}本`);
  } else {
    console.log(`${r.tradeDate} | ${r.symbol} | ${dir} | ${r.pnl} | ${r.cbResult} | - | - | - | - | -`);
  }
}

// --- 日別損益 ---
console.log("\n" + "=".repeat(70));
console.log("  日別損益比較");
console.log("=".repeat(70));

const allDates = [...new Set(trades.map(t => t.tradeDate))].sort();
console.log("\n日付 | BL損益 | 0.8%損益 | CB損益 | 0.8%+CB損益");
console.log("-".repeat(70));

let blWinDays = 0, blLossDays = 0;
let b08WinDays = 0, b08LossDays = 0;
let combWinDays = 0, combLossDays = 0;

for (const d of allDates) {
  const blDay = trades.filter(t => t.tradeDate === d).reduce((s, t) => s + t.pnl, 0);
  const b08Day = passed08.filter(t => t.tradeDate === d).reduce((s, t) => s + t.pnl, 0);
  const cbDay = cbEntries.filter(r => r.tradeDate === d).reduce((s, r) => s + r.cbPnl, 0);
  const combDay = b08Day + cbDay;
  
  if (blDay > 0) blWinDays++; else if (blDay < 0) blLossDays++;
  if (b08Day > 0) b08WinDays++; else if (b08Day < 0) b08LossDays++;
  if (combDay > 0) combWinDays++; else if (combDay < 0) combLossDays++;
  
  console.log(`${d} | ${blDay} | ${b08Day} | ${cbDay > 0 ? "+" : ""}${cbDay || 0} | ${combDay}`);
}

console.log(`\n日別勝率:`);
console.log(`  Baseline: ${blWinDays}勝${blLossDays}敗 (${(blWinDays/(blWinDays+blLossDays)*100).toFixed(1)}%)`);
console.log(`  0.8%ブロック: ${b08WinDays}勝${b08LossDays}敗 (${(b08WinDays/(b08WinDays+b08LossDays)*100).toFixed(1)}%)`);
console.log(`  0.8%+CB: ${combWinDays}勝${combLossDays}敗 (${(combWinDays/(combWinDays+combLossDays)*100).toFixed(1)}%)`);

// --- CB決済理由別 ---
console.log("\n" + "=".repeat(70));
console.log("  CB決済理由別");
console.log("=".repeat(70));
const byReason = {};
for (const r of cbEntries) {
  if (!byReason[r.cbExitReason]) byReason[r.cbExitReason] = { count: 0, pnl: 0 };
  byReason[r.cbExitReason].count++;
  byReason[r.cbExitReason].pnl += r.cbPnl;
}
console.log("\n理由 | 件数 | 損益");
for (const [reason, data] of Object.entries(byReason)) {
  console.log(`${reason} | ${data.count}件 | ${data.pnl}円`);
}

// --- 追加利益/追加損失 ---
console.log("\n" + "=".repeat(70));
console.log("  追加利益/追加損失の内訳");
console.log("=".repeat(70));
console.log(`\n追加利益（CBで利益になった取引）:`);
for (const r of cbProfitTrades.sort((a, b) => b.cbPnl - a.cbPnl)) {
  console.log(`  ${r.tradeDate} ${r.symbol} ${r.side} 元PnL:${r.pnl} → CB PnL:+${r.cbPnl} (遅延${r.cbDelay}本, ${r.cbExitReason})`);
}
console.log(`\n追加損失（CBで損失になった取引）:`);
for (const r of cbLossTrades.sort((a, b) => a.cbPnl - b.cbPnl)) {
  console.log(`  ${r.tradeDate} ${r.symbol} ${r.side} 元PnL:${r.pnl} → CB PnL:${r.cbPnl} (遅延${r.cbDelay}本, ${r.cbExitReason})`);
}

console.log("\n完了");
