import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

/**
 * ROUND_LEVEL_CONFIRM_BARS スイープ: 3本 / 4本 / 5本
 * パターン: BUYのみ / SHORTのみ / 両方
 * 全期間のrt_tradesから大台確認エントリーを抽出し、
 * 確認バー短縮による2分/1分早いエントリーの効果をシミュレーション
 */

async function main() {
  const db = await getDb();

  // Get all 大台確認 entries
  const entries = await db.execute(sql`
    SELECT tradeDate, symbol, action, tradeTime, price, shares, pnl, reason, side
    FROM rt_trades 
    WHERE reason LIKE '%大台確認%'
      AND action IN ('buy', 'short')
    ORDER BY tradeDate, tradeTime
  `);
  const entryRows = (entries as any)[0];

  const buyEntries = entryRows.filter((e: any) => e.action === 'buy');
  const shortEntries = entryRows.filter((e: any) => e.action === 'short');

  console.log(`=== ROUND_LEVEL_CONFIRM_BARS スイープ（全期間） ===`);
  console.log(`データ期間: ${entryRows[0]?.tradeDate} 〜 ${entryRows[entryRows.length - 1]?.tradeDate}`);
  console.log(`大台確認エントリー総数: ${entryRows.length}件 (BUY: ${buyEntries.length}件, SHORT: ${shortEntries.length}件)\n`);

  // For each CONFIRM_BARS value (3, 4, 5):
  // - 5本(現行): エントリー価格はそのまま
  // - 4本: エントリーが1分早い → 1本前の終値でエントリー
  // - 3本: エントリーが2分早い → 2本前の終値でエントリー
  
  const results: Record<string, Record<number, { pnl: number; wins: number; losses: number; trades: number }>> = {
    'BUYのみ': { 3: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 4: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 5: { pnl: 0, wins: 0, losses: 0, trades: 0 } },
    'SHORTのみ': { 3: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 4: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 5: { pnl: 0, wins: 0, losses: 0, trades: 0 } },
    '両方': { 3: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 4: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 5: { pnl: 0, wins: 0, losses: 0, trades: 0 } },
  };

  // Daily breakdown
  const dailyResults: Record<string, Record<string, Record<number, number>>> = {};

  for (const entry of entryRows) {
    const date = entry.tradeDate;
    const symbol = entry.symbol;
    const entryTime = entry.tradeTime;
    const entryPrice = Number(entry.price);
    const shares = Number(entry.shares);
    const actualPnl = Number(entry.pnl);
    const side = entry.action === 'buy' ? 'long' : 'short';
    const isBuy = entry.action === 'buy';

    // Get candles around entry time to find prices 1 and 2 bars earlier
    const candles = await db.execute(sql`
      SELECT candleTime, open, high, low, close
      FROM rt_candles
      WHERE tradeDate = ${date} AND symbol = ${symbol}
        AND candleTime <= ${entryTime}
      ORDER BY candleTime DESC
      LIMIT 5
    `);
    const candleRows = (candles as any)[0];

    if (candleRows.length < 3) continue;

    // candleRows[0] = entry bar (current, CONFIRM_BARS=5)
    // candleRows[1] = 1 bar before (CONFIRM_BARS=4)
    // candleRows[2] = 2 bars before (CONFIRM_BARS=3)
    const price5 = entryPrice; // current (5-bar confirmation)
    const price4 = Number(candleRows[1].close); // 1 bar earlier (4-bar confirmation)
    const price3 = Number(candleRows[2].close); // 2 bars earlier (3-bar confirmation)

    // Get candles AFTER entry to simulate exit
    const afterCandles = await db.execute(sql`
      SELECT candleTime, open, high, low, close
      FROM rt_candles
      WHERE tradeDate = ${date} AND symbol = ${symbol}
        AND candleTime > ${candleRows[2].candleTime}
      ORDER BY candleTime ASC
      LIMIT 120
    `);
    const afterRows = (afterCandles as any)[0];

    // Simulate for each CONFIRM_BARS value
    for (const bars of [3, 4, 5]) {
      let simEntryPrice: number;
      let startIdx: number;

      if (bars === 5) {
        simEntryPrice = price5;
        // Find the index in afterRows that corresponds to the actual entry time
        startIdx = afterRows.findIndex((c: any) => c.candleTime >= entryTime);
        if (startIdx === -1) startIdx = afterRows.length;
      } else if (bars === 4) {
        simEntryPrice = price4;
        // Entry happens 1 bar earlier
        const time4 = candleRows[1].candleTime;
        startIdx = afterRows.findIndex((c: any) => c.candleTime >= time4);
        if (startIdx === -1) startIdx = afterRows.length;
      } else {
        simEntryPrice = price3;
        // Entry happens 2 bars earlier
        const time3 = candleRows[2].candleTime;
        startIdx = afterRows.findIndex((c: any) => c.candleTime >= time3);
        if (startIdx === -1) startIdx = afterRows.length;
      }

      // Simulate with SL=0.5%, TP=1.5%
      const slPct = 0.005;
      const tpPct = 0.015;
      let simPnl = 0;
      let exited = false;

      const slPrice = side === 'long' 
        ? simEntryPrice * (1 - slPct) 
        : simEntryPrice * (1 + slPct);
      const tpPrice = side === 'long'
        ? simEntryPrice * (1 + tpPct)
        : simEntryPrice * (1 - tpPct);

      for (let i = startIdx; i < afterRows.length; i++) {
        const c = afterRows[i];
        const high = Number(c.high);
        const low = Number(c.low);

        if (side === 'long') {
          if (low <= slPrice) {
            simPnl = Math.round((slPrice - simEntryPrice) * shares);
            exited = true;
            break;
          }
          if (high >= tpPrice) {
            simPnl = Math.round((tpPrice - simEntryPrice) * shares);
            exited = true;
            break;
          }
        } else {
          if (high >= slPrice) {
            simPnl = Math.round((simEntryPrice - slPrice) * shares);
            exited = true;
            break;
          }
          if (low <= tpPrice) {
            simPnl = Math.round((simEntryPrice - tpPrice) * shares);
            exited = true;
            break;
          }
        }
      }

      // If not exited within available candles, use last close
      if (!exited && afterRows.length > startIdx) {
        const lastClose = Number(afterRows[afterRows.length - 1].close);
        simPnl = side === 'long'
          ? Math.round((lastClose - simEntryPrice) * shares)
          : Math.round((simEntryPrice - lastClose) * shares);
      }

      // For CONFIRM_BARS=5, use actual PnL from DB for accuracy
      if (bars === 5) {
        simPnl = actualPnl;
      }

      const isWin = simPnl > 0;

      // Accumulate results
      if (isBuy) {
        results['BUYのみ'][bars].pnl += simPnl;
        results['BUYのみ'][bars].trades++;
        if (isWin) results['BUYのみ'][bars].wins++; else results['BUYのみ'][bars].losses++;
      } else {
        results['SHORTのみ'][bars].pnl += simPnl;
        results['SHORTのみ'][bars].trades++;
        if (isWin) results['SHORTのみ'][bars].wins++; else results['SHORTのみ'][bars].losses++;
      }
      results['両方'][bars].pnl += simPnl;
      results['両方'][bars].trades++;
      if (isWin) results['両方'][bars].wins++; else results['両方'][bars].losses++;

      // Daily tracking
      if (!dailyResults[date]) dailyResults[date] = { 'BUYのみ': { 3: 0, 4: 0, 5: 0 }, 'SHORTのみ': { 3: 0, 4: 0, 5: 0 }, '両方': { 3: 0, 4: 0, 5: 0 } };
      if (isBuy) dailyResults[date]['BUYのみ'][bars] += simPnl;
      else dailyResults[date]['SHORTのみ'][bars] += simPnl;
      dailyResults[date]['両方'][bars] += simPnl;
    }
  }

  // Print results
  console.log('━'.repeat(90));
  console.log('【総合結果】');
  console.log('━'.repeat(90));
  console.log('');
  
  for (const pattern of ['BUYのみ', 'SHORTのみ', '両方']) {
    console.log(`■ ${pattern}`);
    console.log('確認バー | 取引数 | 勝率      | 総PnL          | 平均PnL/件    | vs 5本差分');
    console.log('---------|--------|-----------|----------------|--------------|----------');
    for (const bars of [3, 4, 5]) {
      const r = results[pattern][bars];
      const winRate = r.trades > 0 ? Math.round(r.wins / r.trades * 100) : 0;
      const avgPnl = r.trades > 0 ? Math.round(r.pnl / r.trades) : 0;
      const diff = r.pnl - results[pattern][5].pnl;
      const diffStr = bars === 5 ? '(基準)' : `${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円`;
      console.log(`  ${bars}本    |  ${String(r.trades).padStart(3)}件 | ${String(winRate).padStart(3)}% (${r.wins}勝${r.losses}敗) | ${(r.pnl >= 0 ? '+' : '') + r.pnl.toLocaleString().padStart(10)}円 | ${(avgPnl >= 0 ? '+' : '') + avgPnl.toLocaleString().padStart(8)}円 | ${diffStr}`);
    }
    console.log('');
  }

  // Daily breakdown
  console.log('━'.repeat(90));
  console.log('【日別比較（両方）】');
  console.log('━'.repeat(90));
  console.log('日付       | 3本確認       | 4本確認       | 5本確認(現行)  | 3本vs5本差分');
  console.log('-----------|--------------|--------------|---------------|------------');
  const sortedDates = Object.keys(dailyResults).sort();
  for (const date of sortedDates) {
    const d = dailyResults[date]['両方'];
    if (!d) continue;
    const diff = d[3] - d[5];
    console.log(`${date} | ${(d[3] >= 0 ? '+' : '') + d[3].toLocaleString().padStart(10)}円 | ${(d[4] >= 0 ? '+' : '') + d[4].toLocaleString().padStart(10)}円 | ${(d[5] >= 0 ? '+' : '') + d[5].toLocaleString().padStart(10)}円 | ${(diff >= 0 ? '+' : '') + diff.toLocaleString().padStart(10)}円`);
  }

  // BUY-only daily
  console.log('');
  console.log('━'.repeat(90));
  console.log('【日別比較（BUYのみ）】');
  console.log('━'.repeat(90));
  console.log('日付       | 3本確認       | 4本確認       | 5本確認(現行)  | 3本vs5本差分');
  console.log('-----------|--------------|--------------|---------------|------------');
  for (const date of sortedDates) {
    const d = dailyResults[date]['BUYのみ'];
    if (!d || (d[3] === 0 && d[4] === 0 && d[5] === 0)) continue;
    const diff = d[3] - d[5];
    console.log(`${date} | ${(d[3] >= 0 ? '+' : '') + d[3].toLocaleString().padStart(10)}円 | ${(d[4] >= 0 ? '+' : '') + d[4].toLocaleString().padStart(10)}円 | ${(d[5] >= 0 ? '+' : '') + d[5].toLocaleString().padStart(10)}円 | ${(diff >= 0 ? '+' : '') + diff.toLocaleString().padStart(10)}円`);
  }

  // SHORT-only daily
  console.log('');
  console.log('━'.repeat(90));
  console.log('【日別比較（SHORTのみ）】');
  console.log('━'.repeat(90));
  console.log('日付       | 3本確認       | 4本確認       | 5本確認(現行)  | 3本vs5本差分');
  console.log('-----------|--------------|--------------|---------------|------------');
  for (const date of sortedDates) {
    const d = dailyResults[date]['SHORTのみ'];
    if (!d || (d[3] === 0 && d[4] === 0 && d[5] === 0)) continue;
    const diff = d[3] - d[5];
    console.log(`${date} | ${(d[3] >= 0 ? '+' : '') + d[3].toLocaleString().padStart(10)}円 | ${(d[4] >= 0 ? '+' : '') + d[4].toLocaleString().padStart(10)}円 | ${(d[5] >= 0 ? '+' : '') + d[5].toLocaleString().padStart(10)}円 | ${(diff >= 0 ? '+' : '') + diff.toLocaleString().padStart(10)}円`);
  }

  await (db as any).end?.();
  process.exit(0);
}

main().catch(console.error);
