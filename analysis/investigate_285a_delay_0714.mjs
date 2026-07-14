/**
 * 7/14の285Aエントリー遅延原因調査
 * 
 * 問題: 13:47に66000超え3本確認完了したのに、14:36まで285Aにエントリーされなかった
 * 
 * 仮説:
 * 1. 損切り後30分再エントリー禁止（10:29エントリー→11:00損切り → 11:30まで禁止）→ 13:47には解除済み
 * 2. 大台確認ステートマシンの5本維持要件（ROUND_LEVEL_CONFIRM_BARS=5）
 * 3. 押し目待ちステートで待機中にキャンセルされた
 * 4. 板読みスコア不足でブロック
 * 5. HTFフィルターでブロック
 * 6. 証拠金超過
 * 
 * 調査: rt_candles の285Aデータを使って、大台確認ステートマシンの挙動を再現する
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 285Aの7/14全キャンドルデータ
const [candles] = await conn.query(
  `SELECT candleTime as time, open, high, low, close, volume, boardSnapshot
   FROM rt_candles 
   WHERE symbol = '285A' AND tradeDate = '2026-07-14' 
   ORDER BY candleTime ASC`
);

console.log(`=== 7/14 285A キャンドル分析 (全${candles.length}本) ===\n`);

// 取引データ
const [trades] = await conn.query(
  `SELECT action, price, tradeTime, reason, side FROM rt_trades 
   WHERE symbol = '285A' AND tradeDate = '2026-07-14' 
   ORDER BY tradeTime ASC, id ASC`
);

console.log("7/14 285A 取引:");
for (const t of trades) {
  console.log(`  ${t.tradeTime} | ${t.action} @${t.price} | ${t.reason?.substring(0, 60)}`);
}

// 損切り時刻の確認
const stopLossTrade = trades.find(t => t.action === "sell" && t.tradeTime === "11:00");
console.log(`\n損切り時刻: ${stopLossTrade ? stopLossTrade.tradeTime : "なし"}`);
if (stopLossTrade) {
  console.log(`  → 再エントリー禁止期間: ${stopLossTrade.tradeTime}〜11:30 (30分間)`);
  console.log(`  → 13:47時点では禁止期間解除済み ✓`);
}

// 大台確認ステートマシンの再現
console.log("\n\n=== 大台確認ステートマシン再現 (13:00以降) ===\n");
console.log("ROUND_LEVEL_CONFIRM_BARS = 5 (5本連続維持が必要)");
console.log("大台レベル候補: 66000, 67000, 68000, 69000\n");

// 各キリ番レベルについて確認バーの推移を追跡
const levels = [66000, 67000, 68000, 69000];

for (const level of levels) {
  console.log(`\n--- キリ番 ${level}円 超え確認 ---`);
  let confirmCount = 0;
  let confirmed = false;
  let confirmTime = null;
  let confirmPrice = null;
  
  const pmCandles = candles.filter(c => c.time >= "13:00" && c.time <= "15:30");
  
  for (const c of pmCandles) {
    if (confirmed) break;
    
    if (c.close >= level) {
      confirmCount++;
      if (confirmCount <= 6) {
        console.log(`  ${c.time}: close=${c.close} >= ${level} → 確認${confirmCount}本目`);
      }
      if (confirmCount >= 5 && !confirmed) {
        confirmed = true;
        confirmTime = c.time;
        confirmPrice = c.close;
        console.log(`  ★ 5本確認完了 @${c.time} (close=${c.close})`);
      }
    } else {
      if (confirmCount > 0) {
        console.log(`  ${c.time}: close=${c.close} < ${level} → リセット (${confirmCount}本でキャンセル)`);
      }
      confirmCount = 0;
    }
  }
  
  if (!confirmed) {
    console.log(`  → 5本連続維持達成せず`);
  }
}

// 実際のシグナル発生タイミングを確認
// 大台シグナルはprocessCandle内のgenerateSignal()で発生する
// 大台超えシグナルの条件: close > level && prev_close <= level (キリ番を初めて超えた瞬間)
console.log("\n\n=== 大台超えシグナル発生タイミング (13:00以降) ===\n");
console.log("条件: 前足close <= level かつ 今足close > level");

const pmCandles = candles.filter(c => c.time >= "13:00" && c.time <= "15:30");

for (let i = 1; i < pmCandles.length; i++) {
  const prev = pmCandles[i - 1];
  const curr = pmCandles[i];
  
  for (const level of levels) {
    if (prev.close <= level && curr.close > level) {
      console.log(`  ${curr.time}: ${level}円超えシグナル発生 (prev=${prev.close} → curr=${curr.close})`);
    }
    if (prev.close >= level && curr.close < level) {
      console.log(`  ${curr.time}: ${level}円割れ (prev=${prev.close} → curr=${curr.close})`);
    }
  }
}

// 13:40〜14:40の詳細な価格推移
console.log("\n\n=== 13:40〜14:40 詳細価格推移 ===\n");
const detailCandles = candles.filter(c => c.time >= "13:40" && c.time <= "14:40");
for (const c of detailCandles) {
  const board = c.boardSnapshot ? (typeof c.boardSnapshot === 'string' ? JSON.parse(c.boardSnapshot) : c.boardSnapshot) : null;
  const boardInfo = board ? `BPR=${board.buyPressureRatio?.toFixed(3) ?? "?"} sig=${board.signal}` : "板なし";
  
  // キリ番との関係
  let levelInfo = "";
  for (const level of levels) {
    if (Math.abs(c.close - level) < 500) {
      levelInfo += ` [${level}${c.close >= level ? "超" : "未満"}]`;
    }
  }
  
  console.log(`  ${c.time}: O=${c.open} H=${c.high} L=${c.low} C=${c.close} V=${c.volume} | ${boardInfo}${levelInfo}`);
}

// 重要: 10:29のエントリーは何のシグナルだったか
console.log("\n\n=== 10:29エントリーの詳細 ===");
const entryTrade = trades.find(t => t.action === "buy" && t.tradeTime === "10:29");
if (entryTrade) {
  console.log(`  シグナル: ${entryTrade.reason}`);
  console.log(`  価格: ${entryTrade.price}`);
  
  // 10:29前後のキャンドル
  const aroundEntry = candles.filter(c => c.time >= "10:25" && c.time <= "10:35");
  console.log("  前後のキャンドル:");
  for (const c of aroundEntry) {
    console.log(`    ${c.time}: O=${c.open} H=${c.high} L=${c.low} C=${c.close}`);
  }
}

// 14:36エントリーの詳細
console.log("\n\n=== 14:36エントリーの詳細 ===");
const entry1436 = trades.find(t => t.action === "buy" && t.tradeTime === "14:36");
if (entry1436) {
  console.log(`  シグナル: ${entry1436.reason}`);
  console.log(`  価格: ${entry1436.price}`);
  
  // 14:36前後のキャンドル
  const aroundEntry2 = candles.filter(c => c.time >= "14:30" && c.time <= "14:42");
  console.log("  前後のキャンドル:");
  for (const c of aroundEntry2) {
    console.log(`    ${c.time}: O=${c.open} H=${c.high} L=${c.low} C=${c.close}`);
  }
}

// 結論: なぜ13:47〜14:36の間にエントリーされなかったか
console.log("\n\n=== 結論 ===");
console.log("大台確認ステートマシンのフロー:");
console.log("1. 大台超えシグナル発生 → roundLevelPendingStates に登録");
console.log("2. 5本連続維持確認 → roundPullbackStates に移行（押し目待ち）");
console.log("3. 押し目確認 or タイムアウト(5本) → enterPosition()");
console.log("");
console.log("★重要: シグナル発生は「前足<=level かつ 今足>level」の瞬間のみ");
console.log("  → 既にlevel超えの状態が続いている場合、新たなシグナルは発生しない");
console.log("  → 一度キリ番を割ってから再度超えないと新シグナルは出ない");

await conn.end();
