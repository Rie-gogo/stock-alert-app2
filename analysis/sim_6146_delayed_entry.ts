import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL!;

interface BlockedSignal {
  tradeDate: string;
  candleTime: string;
  entryPrice: number;
}

const BLOCKED_SIGNALS: BlockedSignal[] = [
  { tradeDate: "2026-08-07", candleTime: "13:41", entryPrice: 59150 },
  { tradeDate: "2026-08-10", candleTime: "10:12", entryPrice: 61820 },
  { tradeDate: "2026-08-13", candleTime: "10:00", entryPrice: 65840 },
  { tradeDate: "2026-08-13", candleTime: "10:52", entryPrice: 65940 },
];

const SL_PCT = 0.8; // ディスコのSL
const TP_PCT = 1.5;
const SYMBOL = "6146";
const WAIT_BARS = 2; // 1〜2本待機

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);

  console.log("=== ディスコ(6146) 遅延エントリーシミュレーション ===");
  console.log(`条件: 信頼度強LONG + sell_pressure → ${WAIT_BARS}本待機 → 高値更新のみ → LONG（B案）`);
  console.log("");

  let totalPnl = 0;
  let wins = 0;
  let losses = 0;

  for (const sig of BLOCKED_SIGNALS) {
    // ブロック時点以降の足を取得
    const [rows] = await conn.query(
      `SELECT candleTime, open, high, low, close, boardSnapshot
       FROM rt_candles
       WHERE symbol = ? AND tradeDate = ? AND candleTime > ?
       ORDER BY candleTime ASC
       LIMIT 60`,
      [SYMBOL, sig.tradeDate, sig.candleTime]
    ) as any[];

    if (!rows || rows.length === 0) {
      console.log(`${sig.tradeDate} ${sig.candleTime}: データなし（スキップ）`);
      continue;
    }

    // 現行（即ブロック）の場合の仮想損益も計算
    const immediateEntry = sig.entryPrice;
    let immediatePnl = 0;
    let immediateResult = "EOD";
    for (const bar of rows) {
      const high = parseFloat(bar.high);
      const low = parseFloat(bar.low);
      const slLine = immediateEntry * (1 + SL_PCT / 100);
      const tpLine = immediateEntry * (1 - TP_PCT / 100); // LONGなので逆
      // LONG: SL = entry * (1 - SL%), TP = entry * (1 + TP%)
      const slLineLong = immediateEntry * (1 - SL_PCT / 100);
      const tpLineLong = immediateEntry * (1 + TP_PCT / 100);
      if (low <= slLineLong) {
        immediatePnl = Math.round((slLineLong - immediateEntry) * 100);
        immediateResult = "SL";
        break;
      }
      if (high >= tpLineLong) {
        immediatePnl = Math.round((tpLineLong - immediateEntry) * 100);
        immediateResult = "TP";
        break;
      }
    }
    if (immediateResult === "EOD") {
      const lastBar = rows[rows.length - 1];
      immediatePnl = Math.round((parseFloat(lastBar.close) - immediateEntry) * 100);
    }

    // 遅延エントリー: WAIT_BARS本待機後、sell_pressure解消 + 高値更新を確認
    let delayedEntryPrice: number | null = null;
    let delayedEntryTime = "";
    let highSinceSignal = sig.entryPrice;

    for (let i = 0; i < rows.length; i++) {
      const bar = rows[i];
      const barHigh = parseFloat(bar.high);
      const barClose = parseFloat(bar.close);
      highSinceSignal = Math.max(highSinceSignal, barHigh);

      // 最初のWAIT_BARS本は待機
      if (i < WAIT_BARS) continue;

      // B案: 高値更新のみで条件成立（sell_pressure解消判定を省略）
      const highBreakout = barHigh > sig.entryPrice;

      if (highBreakout) {
        delayedEntryPrice = barClose; // 確認足の終値でエントリー
        delayedEntryTime = bar.candleTime;
        break;
      }
    }

    if (delayedEntryPrice === null) {
      console.log(`${sig.tradeDate} ${sig.candleTime} @${sig.entryPrice}: 遅延条件未成立（エントリーなし）`);
      console.log(`  → 即エントリーの場合: ${immediateResult} ${immediatePnl >= 0 ? "+" : ""}${immediatePnl.toLocaleString()}円`);
      console.log("");
      continue;
    }

    // 遅延エントリー後のSL/TP/EOD判定
    const entryIdx = rows.findIndex((r: any) => r.candleTime === delayedEntryTime);
    const afterEntry = rows.slice(entryIdx + 1);

    let delayedPnl = 0;
    let delayedResult = "EOD";
    const slLineLong = delayedEntryPrice * (1 - SL_PCT / 100);
    const tpLineLong = delayedEntryPrice * (1 + TP_PCT / 100);

    for (const bar of afterEntry) {
      const high = parseFloat(bar.high);
      const low = parseFloat(bar.low);
      if (low <= slLineLong) {
        delayedPnl = Math.round((slLineLong - delayedEntryPrice) * 100);
        delayedResult = "SL";
        break;
      }
      if (high >= tpLineLong) {
        delayedPnl = Math.round((tpLineLong - delayedEntryPrice) * 100);
        delayedResult = "TP";
        break;
      }
    }
    if (delayedResult === "EOD" && afterEntry.length > 0) {
      const lastBar = afterEntry[afterEntry.length - 1];
      delayedPnl = Math.round((parseFloat(lastBar.close) - delayedEntryPrice) * 100);
    }

    totalPnl += delayedPnl;
    if (delayedPnl > 0) wins++;
    else losses++;

    console.log(`${sig.tradeDate} ${sig.candleTime} @${sig.entryPrice}:`);
    console.log(`  → 即エントリー: ${immediateResult} ${immediatePnl >= 0 ? "+" : ""}${immediatePnl.toLocaleString()}円`);
    console.log(`  → 遅延エントリー: ${delayedEntryTime} @${delayedEntryPrice.toFixed(0)} → ${delayedResult} ${delayedPnl >= 0 ? "+" : ""}${delayedPnl.toLocaleString()}円`);
    console.log(`  → 差額: ${(delayedPnl - immediatePnl) >= 0 ? "+" : ""}${(delayedPnl - immediatePnl).toLocaleString()}円`);
    console.log("");
  }

  console.log("=== 総合結果 ===");
  console.log(`遅延エントリー: ${wins}勝${losses}敗, 総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
