import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// On 7/7 at 13:50, exposure was 881万 (余力10万). Any signal after that until 13:56 would be blocked.
// At 14:02, exposure was 854万 (余力37万). Most entries need 150-800万, so anything would be blocked.
// Without 6920 (435万), exposure at 13:50 would be 446万 (余力445万) - plenty of room!

// The critical window is 13:50 to 14:03 (when 6920 exited)
// During this time, exposure was 881万 → only 10万 headroom
// ANY entry signal during this window would have been blocked by exposure limit

// Let's check: what symbols had signals during 13:50-14:02 on 7/7?
// We know 6976 entered at 14:02 (161万) when exposure was 854万 (37万 headroom)
// Wait - 161万 > 37万, so 6976 should have been BLOCKED!
// But it wasn't... let me re-check

// Actually, 6981 exited (cover) at 13:56, so:
// After 13:56: exposure = 881 - 188 = 693万 (余力198万)
// Then 6976 enters at 14:02: 693 + 161 = 854万 ← OK, under 891万

// So the real blocked window is 13:50 to 13:56 (6 minutes)
// During those 6 minutes, exposure was 881万 (余力10万)
// Without 6920, it would be 446万 (余力445万)

// Were there any signals during 13:50-13:56 for other symbols?
// Let's check what candles existed during that time
const [candles] = await conn.query(`
  SELECT DISTINCT symbol FROM rt_candles
  WHERE tradeDate = '2026-07-07' AND candleTime >= '13:50' AND candleTime <= '13:56'
    AND symbol NOT IN ('5016', '6920', '6981', '5803', '6976')
`);
console.log("=== 7/7 13:50-13:56 にデータがある銘柄（既にポジション持っている銘柄除く）===");
console.log(candles.map(c => c.symbol).join(', '));

// The real question is: during those 6 minutes, did any of the remaining symbols 
// generate a signal that would have been caught by processCandle?
// We can't know this without running the full engine, but we can estimate:
// - The engine generates signals based on pattern detection (ダウ理論, 大台, etc.)
// - In a 6-minute window, the probability of a new signal is relatively low
// - Most signals are already being processed (5803 and 6981 just entered)

// Let's also check 7/6: 6920 held from 10:24-10:31 (7 min, 464万)
// During that time, exposure was 464万 alone. No other positions were open.
// Without 6920, exposure would be 0. But 8035 entered at 10:07 and exited at 10:22,
// then re-entered at 10:40. So during 10:24-10:31, only 6920 was open.
// Headroom without 6920: 891万 full. But were there signals?

console.log("\n=== 7/6 10:24-10:31 にデータがある銘柄 ===");
const [candles2] = await conn.query(`
  SELECT DISTINCT symbol FROM rt_candles
  WHERE tradeDate = '2026-07-06' AND candleTime >= '10:24' AND candleTime <= '10:31'
    AND symbol NOT IN ('5016', '6920')
`);
console.log(candles2.map(c => c.symbol).join(', '));
console.log("(これらの銘柄は6920がなければ891万円の余力で自由にエントリー可能だった)");

// Summary
console.log("\n=== 証拠金ブロック分析サマリー ===");
console.log("7/6: 6920保有中(10:24-10:31)のexposure = 464万円 → 余力427万円");
console.log("     他銘柄は余力内でエントリー可能 → ブロックなし");
console.log("");
console.log("7/7: 6920保有中(13:25-14:03)の最大exposure = 881万円 → 余力10万円");
console.log("     13:50-13:56の6分間: 事実上全エントリーブロック状態");
console.log("     除外すれば: 最大exposure = 446万円 → 余力445万円");
console.log("     → この6分間に追加シグナルが出ていれば、エントリー可能だった");
console.log("");
console.log("7/8-10: 除外銘柄の取引なし → 影響ゼロ");

await conn.end();
