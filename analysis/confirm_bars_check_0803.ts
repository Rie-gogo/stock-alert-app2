/**
 * CONFIRM_BARS=5だった場合の8/3の結果を検証
 * 大台確認シグナルのみがCONFIRM_BARSに影響される
 */
import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);
  const today = "2026-08-03";

  // 1. 本日の全トレード取得
  // rt_trades has: symbol, side, price, shares, pnl, reason, tradeTime, action
  // buy/short = entry, sell/cover = exit
  // Need to pair entries with exits
  const [allTrades] = await conn.execute(
    `SELECT id, symbol, side, action, price, shares, pnl, reason, tradeTime
     FROM rt_trades WHERE tradeDate = ? ORDER BY id`, [today]
  ) as any[];

  // Pair entries (buy/short) with exits (sell/cover)
  const trades: any[] = [];
  const openPositions: Map<string, any> = new Map();
  for (const t of allTrades) {
    if (t.action === 'buy' || t.action === 'short') {
      openPositions.set(t.symbol, t);
    } else if (t.action === 'sell' || t.action === 'cover') {
      const entry = openPositions.get(t.symbol);
      if (entry) {
        trades.push({
          symbol: t.symbol,
          side: entry.side,
          entryPrice: Number(entry.price),
          exitPrice: Number(t.price),
          entryTime: entry.tradeTime,
          exitTime: t.tradeTime,
          pnl: Number(t.pnl),
          reason: entry.reason,
          exitReason: t.reason,
          shares: Number(entry.shares),
        });
        openPositions.delete(t.symbol);
      }
    }
  }

  console.log(`=== 8/3 全トレード (${trades.length}件) ===\n`);

  for (const t of trades) {
    const isRoundLevel = t.reason.includes("大台");
    console.log(`${t.entryTime} ${t.symbol} ${t.side} @${t.entryPrice} → @${t.exitPrice} ${t.shares}株 損益:${t.pnl}円`);
    console.log(`  理由: ${t.reason}`);
    console.log(`  決済: ${t.exitReason}`);
    console.log(`  CONFIRM_BARSに影響: ${isRoundLevel ? "★YES" : "NO"}`);
    console.log("");
  }

  // 2. 大台確認シグナルのトレードを抽出
  const roundLevelTrades = trades.filter((t: any) => t.reason.includes("大台"));

  if (roundLevelTrades.length === 0) {
    console.log("★ 本日は大台確認シグナルのトレードがないため、CONFIRM_BARS=5でも結果は完全に同じです。");
    await conn.end();
    process.exit(0);
  }

  console.log(`\n=== 大台確認シグナル: ${roundLevelTrades.length}件 ===\n`);

  let totalPnlDiff = 0;

  for (const t of roundLevelTrades) {
    const symbol = t.symbol;
    const entryTime = t.entryTime;
    const side = t.side;
    const entryPrice = Number(t.entryPrice);
    const shares = Number(t.shares);

    // エントリー前後のバーを取得（CONFIRM_BARS=5なら1分遅れでエントリー）
    const [candles] = await conn.execute(
      `SELECT candleTime, open, high, low, close, volume
       FROM rt_candles
       WHERE symbol = ? AND tradeDate = ? AND candleTime >= ?
       ORDER BY candleTime LIMIT 15`, [symbol, today, entryTime]
    ) as any[];

    // CONFIRM_BARS=5の場合、エントリーが1バー遅れる
    // エントリーバーの次のバーのopenが新しいエントリー価格
    console.log(`--- ${symbol} ${side} エントリー ${entryTime} @${entryPrice} (${shares}株) ---`);
    console.log(`実績損益: ${t.pnl}円 (${t.exitReason})`);

    if (candles.length >= 2) {
      const nextBar = candles[1];
      const newEntryPrice = Number(nextBar.open);
      const priceDiff = side === "long" ? newEntryPrice - entryPrice : entryPrice - newEntryPrice;

      console.log(`\nCONFIRM_BARS=5の場合:`);
      console.log(`  エントリー: ${nextBar.candleTime} @${newEntryPrice}（1バー遅れ）`);
      console.log(`  価格差: ${priceDiff > 0 ? "+" : ""}${priceDiff.toFixed(1)}円/株（${side === "long" ? "高く買う" : "安く売る"} = 不利）`);

      // 新しいSL/TPで決済をシミュレート
      // 銘柄別SL取得
      const slMap: Record<string, number> = {
        "8035": 0.7, "6857": 0.9, "6976": 1.0, "6526": 0.9,
        "5803": 0.7, "6981": 0.9, "285A": 1.5, "6920": 1.0,
        "6758": 0.5, "8316": 0.5,
      };
      const slPct = slMap[symbol] || 0.5;
      const tpPct = 1.5;

      let newExitPrice: number | null = null;
      let newExitReason = "";
      let newExitTime = "";

      // 新しいエントリー価格からSL/TPラインを計算
      const slLine = side === "long"
        ? newEntryPrice * (1 - slPct / 100)
        : newEntryPrice * (1 + slPct / 100);
      const tpLine = side === "long"
        ? newEntryPrice * (1 + tpPct / 100)
        : newEntryPrice * (1 - tpPct / 100);

      // エントリー後のバーを走査（2番目のバーから）
      for (let i = 2; i < candles.length; i++) {
        const c = candles[i];
        const high = Number(c.high);
        const low = Number(c.low);

        if (side === "long") {
          if (low <= slLine) {
            newExitPrice = slLine;
            newExitReason = `損切り (SL:${slLine.toFixed(0)})`;
            newExitTime = c.candleTime;
            break;
          }
          if (high >= tpLine) {
            newExitPrice = tpLine;
            newExitReason = `利確 (TP:${tpLine.toFixed(0)})`;
            newExitTime = c.candleTime;
            break;
          }
        } else {
          if (high >= slLine) {
            newExitPrice = slLine;
            newExitReason = `損切り (SL:${slLine.toFixed(0)})`;
            newExitTime = c.candleTime;
            break;
          }
          if (low <= tpLine) {
            newExitPrice = tpLine;
            newExitReason = `利確 (TP:${tpLine.toFixed(0)})`;
            newExitTime = c.candleTime;
            break;
          }
        }
      }

      // 15本以内に決済されなかった場合、もっと先のバーを取得
      if (!newExitPrice) {
        const lastTime = candles[candles.length - 1].candleTime;
        const [moreCandles] = await conn.execute(
          `SELECT candleTime, open, high, low, close, volume
           FROM rt_candles
           WHERE symbol = ? AND tradeDate = ? AND candleTime > ?
           ORDER BY candleTime LIMIT 60`, [symbol, today, lastTime]
        ) as any[];

        for (const c of moreCandles) {
          const high = Number(c.high);
          const low = Number(c.low);

          if (side === "long") {
            if (low <= slLine) { newExitPrice = slLine; newExitReason = `損切り`; newExitTime = c.candleTime; break; }
            if (high >= tpLine) { newExitPrice = tpLine; newExitReason = `利確`; newExitTime = c.candleTime; break; }
          } else {
            if (high >= slLine) { newExitPrice = slLine; newExitReason = `損切り`; newExitTime = c.candleTime; break; }
            if (low <= tpLine) { newExitPrice = tpLine; newExitReason = `利確`; newExitTime = c.candleTime; break; }
          }
        }

        if (!newExitPrice) {
          // EOD決済
          const [lastCandle] = await conn.execute(
            `SELECT candleTime, close FROM rt_candles
             WHERE symbol = ? AND tradeDate = ? ORDER BY candleTime DESC LIMIT 1`, [symbol, today]
          ) as any[];
          if (lastCandle.length > 0) {
            newExitPrice = Number(lastCandle[0].close);
            newExitReason = "EOD決済";
            newExitTime = lastCandle[0].candleTime;
          }
        }
      }

      if (newExitPrice) {
        const newPnl = side === "long"
          ? Math.round((newExitPrice - newEntryPrice) * shares)
          : Math.round((newEntryPrice - newExitPrice) * shares);
        const pnlDiff = newPnl - Number(t.pnl);
        totalPnlDiff += pnlDiff;

        console.log(`  決済: ${newExitTime} @${newExitPrice.toFixed(1)} (${newExitReason})`);
        console.log(`  新損益: ${newPnl > 0 ? "+" : ""}${newPnl}円`);
        console.log(`  差分: ${pnlDiff > 0 ? "+" : ""}${pnlDiff}円 (${pnlDiff > 0 ? "改善" : pnlDiff < 0 ? "悪化" : "同じ"})`);
      }
    }
    console.log("");
  }

  // 3. 総合比較
  const totalPnl = trades.reduce((sum: number, t: any) => sum + Number(t.pnl), 0);
  const nonRoundPnl = trades.filter((t: any) => !t.reason.includes("大台")).reduce((sum: number, t: any) => sum + Number(t.pnl), 0);
  const roundPnl = roundLevelTrades.reduce((sum: number, t: any) => sum + Number(t.pnl), 0);

  console.log("=== 総合比較 ===");
  console.log(`実績総損益: ${totalPnl}円`);
  console.log(`  大台確認以外: ${nonRoundPnl}円（変わらず）`);
  console.log(`  大台確認: ${roundPnl}円`);
  console.log(`CONFIRM_BARS=5の場合の差分: ${totalPnlDiff > 0 ? "+" : ""}${totalPnlDiff}円`);
  console.log(`CONFIRM_BARS=5の場合の推定総損益: ${totalPnl + totalPnlDiff}円`);

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
