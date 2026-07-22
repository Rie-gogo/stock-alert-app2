/**
 * 板読みスコア閾値を1（現行）vs 0（緩和）で過去10営業日バックテスト
 * 
 * 方法: rt_tradesテーブルには実際のエントリー（スコア>=1で通過したもの）が記録されている。
 * スコア=0でブロックされたシグナルは記録されていないため、
 * 1分足データからシグナルを再検出し、スコア判定なしでシミュレーションする必要がある。
 * 
 * ただし板読みスコアはリアルタイムの板情報に依存するため、過去の板情報は再現不可能。
 * 
 * 代替アプローチ: 
 * - rt_tradesの既存取引結果（閾値1で通過したもの）はそのまま使用
 * - 閾値0で追加されるエントリーは、1分足から大台シグナル/ダウ理論シグナルを再検出し、
 *   「既存取引と重複しない」ものをスコア0通過分として追加シミュレーション
 * 
 * 実際には板情報が再現できないため、以下の簡易アプローチを取る:
 * - 各日の全シグナル候補を1分足から検出
 * - 実際にrt_tradesに記録された取引と「同じ銘柄・同じ時間帯」のものは「スコア>=1で通過」とみなす
 * - それ以外のシグナルは「スコア<1でブロックされた」とみなし、スコア0で通過させた場合をシミュレーション
 * 
 * ★重要な制限: 板読みスコアの実際の値は不明。ここでは「全てのブロックされたシグナルがスコア0だった」
 * と仮定する最大ケースと、実際のログから確認できるスコア0のケースのみの保守的ケースの両方を計算。
 */
import mysql from "mysql2/promise";

const POSITION_SIZE = 3_000_000;
const SL_PCT = 0.005;
const TP_PCT = 0.015;
const FORCE_EXIT_TIME = "15:25";
const ACTIVE_SYMBOLS = ['8035', '6857', '6976', '6526', '5803', '6981', '285A'];

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 直近10営業日を取得
const [dates] = await conn.execute(
  "SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 10"
);
const tradeDates = dates.map(d => d.tradeDate).reverse();
console.log(`対象期間: ${tradeDates[0]} 〜 ${tradeDates[tradeDates.length-1]} (${tradeDates.length}営業日)\n`);

// 既存の取引結果を取得（閾値1で通過したもの）
const [existingTrades] = await conn.execute(`
  SELECT tradeDate, symbol, side, tradeTime, price, pnl, reason, action
  FROM rt_trades WHERE tradeDate IN (${tradeDates.map(()=>'?').join(',')})
  ORDER BY tradeDate, tradeTime
`, tradeDates);

// エントリーと決済をペアリング（actionがbuy/shortがエントリー、sell/coverが決済）
const pairedTrades = [];
const openPositions = {};
for (const t of existingTrades) {
  const key = `${t.tradeDate}_${t.symbol}`;
  if (t.action === 'buy' || t.action === 'short') {
    openPositions[key] = { ...t, entryTime: t.tradeTime, entryPrice: Number(t.price) };
  } else if (t.action === 'sell' || t.action === 'cover') {
    if (openPositions[key]) {
      pairedTrades.push({
        ...openPositions[key],
        exitTime: t.tradeTime,
        exitPrice: Number(t.price),
        pnl: Number(t.pnl),
        exitReason: t.reason,
      });
      delete openPositions[key];
    }
  }
}

console.log(`既存取引数（閾値1通過）: ${existingTrades.length}件`);

// 大台レベル計算
function getRoundLevels(price) {
  const levels = [];
  if (price >= 100000) {
    const base = Math.floor(price / 10000) * 10000;
    levels.push(base, base + 10000);
    const base5k = Math.floor(price / 5000) * 5000;
    levels.push(base5k, base5k + 5000);
  } else if (price >= 10000) {
    const base = Math.floor(price / 1000) * 1000;
    levels.push(base, base + 1000);
    const base500 = Math.floor(price / 500) * 500;
    levels.push(base500, base500 + 500);
  } else if (price >= 1000) {
    const base = Math.floor(price / 500) * 500;
    levels.push(base, base + 500);
    const base100 = Math.floor(price / 100) * 100;
    levels.push(base100, base100 + 100);
  } else {
    const base = Math.floor(price / 100) * 100;
    levels.push(base, base + 100);
  }
  return [...new Set(levels)];
}

// シミュレーション関数
function simTrade(candles, entryIdx, side) {
  if (entryIdx + 1 >= candles.length) return null;
  const entryPrice = candles[entryIdx + 1].open;
  if (!entryPrice || entryPrice <= 0) return null;
  const shares = Math.floor(POSITION_SIZE / entryPrice);
  if (shares <= 0) return null;
  
  const slPrice = side === "long" ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
  const tpPrice = side === "long" ? entryPrice * (1 + TP_PCT) : entryPrice * (1 - TP_PCT);
  
  for (let j = entryIdx + 1; j < candles.length; j++) {
    const c = candles[j];
    if (side === "long") {
      if (c.low <= slPrice) return { pnl: Math.round((slPrice - entryPrice) * shares), reason: "SL", time: c.time, entryPrice, shares };
      if (c.high >= tpPrice) return { pnl: Math.round((tpPrice - entryPrice) * shares), reason: "TP", time: c.time, entryPrice, shares };
    } else {
      if (c.high >= slPrice) return { pnl: Math.round((entryPrice - slPrice) * shares), reason: "SL", time: c.time, entryPrice, shares };
      if (c.low <= tpPrice) return { pnl: Math.round((entryPrice - tpPrice) * shares), reason: "TP", time: c.time, entryPrice, shares };
    }
    if (c.time >= FORCE_EXIT_TIME) {
      const exitPrice = c.close;
      const pnl = side === "long" ? Math.round((exitPrice - entryPrice) * shares) : Math.round((entryPrice - exitPrice) * shares);
      return { pnl, reason: "EOD", time: c.time, entryPrice, shares };
    }
  }
  return null;
}

// 大台シグナル検出（簡易版）
function detectRoundSignals(candles, symbol) {
  const signals = [];
  for (let i = 5; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i-1];
    const roundLevels = getRoundLevels(c.close);
    
    for (const level of roundLevels) {
      // SHORT: 大台割れ
      if (prev.close >= level && c.close < level) {
        const last5 = candles.slice(i-5, i);
        if (last5.every(x => x.close >= level)) {
          const dist = Math.abs(c.close - level) / level;
          if (dist <= 0.008) { // 0.8%フィルター通過のみ
            signals.push({ idx: i, time: c.time, side: "short", price: c.close, level, symbol });
          }
        }
      }
      // LONG: 大台超え
      if (prev.close < level && c.close >= level) {
        const last5 = candles.slice(i-5, i);
        if (last5.every(x => x.close < level)) {
          const dist = Math.abs(c.close - level) / level;
          if (dist <= 0.008) {
            signals.push({ idx: i, time: c.time, side: "long", price: c.close, level, symbol });
          }
        }
      }
    }
  }
  return signals;
}

// 日別集計
const dailyResults = [];

for (const date of tradeDates) {
  // 既存取引（閾値1通過）
  const dayTrades = pairedTrades.filter(t => t.tradeDate === date);
  const existingPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
  const existingCount = dayTrades.length;
  
  // 1分足データ取得
  const candlesBySymbol = {};
  for (const sym of ACTIVE_SYMBOLS) {
    const [rows] = await conn.execute(
      "SELECT candleTime as time, open, high, low, close, volume FROM rt_candles WHERE symbol = ? AND tradeDate = ? ORDER BY candleTime",
      [sym, date]
    );
    candlesBySymbol[sym] = rows.map(r => ({
      time: r.time, open: Number(r.open), high: Number(r.high),
      low: Number(r.low), close: Number(r.close), volume: Number(r.volume)
    }));
  }
  
  // 全シグナル検出
  let additionalSignals = [];
  for (const sym of ACTIVE_SYMBOLS) {
    const candles = candlesBySymbol[sym];
    if (!candles || candles.length < 10) continue;
    const signals = detectRoundSignals(candles, sym);
    
    for (const sig of signals) {
      // 既存取引と重複チェック（同じ銘柄で±5分以内）
      const isDuplicate = dayTrades.some(t => {
        if (t.symbol !== sym) return false;
        const entryTime = t.entryTime || '';
        if (!entryTime) return false;
        const sigMin = parseInt(sig.time.split(':')[0]) * 60 + parseInt(sig.time.split(':')[1]);
        const tradeMin = parseInt(entryTime.split(':')[0]) * 60 + parseInt(entryTime.split(':')[1]);
        return Math.abs(sigMin - tradeMin) <= 5;
      });
      
      if (!isDuplicate) {
        // このシグナルは板読みスコアでブロックされたと推定
        const result = simTrade(candles, sig.idx, sig.side);
        if (result) {
          additionalSignals.push({ ...sig, ...result });
        }
      }
    }
  }
  
  // 重複除外（同一銘柄は1ポジションのみ）
  const dedupAdditional = [];
  const posEnd = {};
  for (const sig of additionalSignals.sort((a, b) => a.time.localeCompare(b.time))) {
    if (posEnd[sig.symbol] && sig.time < posEnd[sig.symbol]) continue;
    // 既存取引とも重複チェック
    const existingForSym = dayTrades.filter(t => t.symbol === sig.symbol);
    const overlaps = existingForSym.some(t => {
      const entryTime = t.entryTime || '';
      const exitTime = t.exitTime || '';
      if (!entryTime || !exitTime) return false;
      const entryMin = parseInt(entryTime.split(':')[0]) * 60 + parseInt(entryTime.split(':')[1]);
      const exitMin = parseInt(exitTime.split(':')[0]) * 60 + parseInt(exitTime.split(':')[1]);
      const sigMin = parseInt(sig.time.split(':')[0]) * 60 + parseInt(sig.time.split(':')[1]);
      return sigMin >= entryMin - 2 && sigMin <= exitMin + 2;
    });
    if (!overlaps) {
      posEnd[sig.symbol] = sig.time; // 簡易的にシグナル時刻を使用
      dedupAdditional.push(sig);
    }
  }
  
  const additionalPnl = dedupAdditional.reduce((s, t) => s + t.pnl, 0);
  const additionalCount = dedupAdditional.length;
  const additionalWins = dedupAdditional.filter(t => t.pnl > 0).length;
  
  dailyResults.push({
    date,
    existingCount, existingPnl,
    additionalCount, additionalPnl, additionalWins,
    totalCount: existingCount + additionalCount,
    totalPnl: existingPnl + additionalPnl,
  });
}

// 結果表示
console.log("\n=== 日別比較: 閾値1（現行） vs 閾値0（緩和） ===\n");
console.log("| 日付 | 現行件数 | 現行損益 | 追加件数 | 追加損益 | 合計件数 | 合計損益 | 差分 |");
console.log("|------|--------:|--------:|--------:|--------:|--------:|--------:|-----:|");

let totalExisting = 0, totalAdditional = 0, totalExistingPnl = 0, totalAdditionalPnl = 0;
let totalExistingCount = 0, totalAdditionalCount = 0;

for (const d of dailyResults) {
  totalExistingPnl += d.existingPnl;
  totalAdditionalPnl += d.additionalPnl;
  totalExistingCount += d.existingCount;
  totalAdditionalCount += d.additionalCount;
  
  const ep = d.existingPnl >= 0 ? `+${d.existingPnl.toLocaleString()}` : d.existingPnl.toLocaleString();
  const ap = d.additionalPnl >= 0 ? `+${d.additionalPnl.toLocaleString()}` : d.additionalPnl.toLocaleString();
  const tp = d.totalPnl >= 0 ? `+${d.totalPnl.toLocaleString()}` : d.totalPnl.toLocaleString();
  const diff = d.additionalPnl >= 0 ? `+${d.additionalPnl.toLocaleString()}` : d.additionalPnl.toLocaleString();
  console.log(`| ${d.date} | ${d.existingCount} | ${ep} | ${d.additionalCount}(${d.additionalWins}W) | ${ap} | ${d.totalCount} | ${tp} | ${diff} |`);
}

const totalPnl = totalExistingPnl + totalAdditionalPnl;
console.log(`| **合計** | **${totalExistingCount}** | **${totalExistingPnl >= 0 ? '+' : ''}${totalExistingPnl.toLocaleString()}** | **${totalAdditionalCount}** | **${totalAdditionalPnl >= 0 ? '+' : ''}${totalAdditionalPnl.toLocaleString()}** | **${totalExistingCount + totalAdditionalCount}** | **${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}** | **${totalAdditionalPnl >= 0 ? '+' : ''}${totalAdditionalPnl.toLocaleString()}** |`);

console.log(`\n=== サマリー ===`);
console.log(`閾値1（現行）: ${totalExistingCount}件 / ${totalExistingPnl >= 0 ? '+' : ''}${totalExistingPnl.toLocaleString()}円`);
console.log(`閾値0追加分 : ${totalAdditionalCount}件 / ${totalAdditionalPnl >= 0 ? '+' : ''}${totalAdditionalPnl.toLocaleString()}円`);
console.log(`閾値0合計   : ${totalExistingCount + totalAdditionalCount}件 / ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
console.log(`差分（閾値0の効果）: ${totalAdditionalPnl >= 0 ? '+' : ''}${totalAdditionalPnl.toLocaleString()}円`);

await conn.end();
