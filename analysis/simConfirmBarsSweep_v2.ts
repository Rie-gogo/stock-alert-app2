import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

/**
 * ROUND_LEVEL_CONFIRM_BARS スイープ v2: 3本 / 4本 / 5本
 * パターン: BUYのみ / SHORTのみ / 両方
 * 
 * 修正: エントリーのPnLはEXIT行から取得する
 */

async function main() {
  const db = await getDb();

  // Get all 大台確認 entries paired with their exits
  // Entry: action = 'buy' or 'short', reason LIKE '%大台確認%'
  // Exit: next row for same symbol+date with action = 'sell' or 'cover' and pnl IS NOT NULL
  const allTrades = await db.execute(sql`
    SELECT id, tradeDate, symbol, action, tradeTime, price, shares, pnl, reason
    FROM rt_trades 
    ORDER BY tradeDate, symbol, tradeTime, id
  `);
  const rows = (allTrades as any)[0];

  // Build entry-exit pairs for 大台確認
  interface TradePair {
    date: string;
    symbol: string;
    side: 'long' | 'short';
    entryTime: string;
    entryPrice: number;
    exitTime: string;
    exitPrice: number;
    shares: number;
    pnl: number;
    reason: string;
  }

  const pairs: TradePair[] = [];

  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i];
    if (!entry.reason?.includes('大台確認')) continue;
    if (entry.action !== 'buy' && entry.action !== 'short') continue;

    // Find the matching exit
    const exitAction = entry.action === 'buy' ? 'sell' : 'cover';
    for (let j = i + 1; j < rows.length; j++) {
      const exit = rows[j];
      if (exit.tradeDate !== entry.tradeDate) break;
      if (exit.symbol !== entry.symbol) continue;
      if (exit.action === exitAction && exit.pnl !== null) {
        pairs.push({
          date: entry.tradeDate,
          symbol: entry.symbol,
          side: entry.action === 'buy' ? 'long' : 'short',
          entryTime: entry.tradeTime,
          entryPrice: Number(entry.price),
          exitTime: exit.tradeTime,
          exitPrice: Number(exit.price),
          shares: Number(entry.shares),
          pnl: Number(exit.pnl),
          reason: entry.reason,
        });
        break;
      }
    }
  }

  const buyPairs = pairs.filter(p => p.side === 'long');
  const shortPairs = pairs.filter(p => p.side === 'short');

  console.log(`=== ROUND_LEVEL_CONFIRM_BARS スイープ v2（全期間） ===`);
  console.log(`データ期間: ${pairs[0]?.date} 〜 ${pairs[pairs.length - 1]?.date}`);
  console.log(`大台確認エントリー総数: ${pairs.length}件 (BUY: ${buyPairs.length}件, SHORT: ${shortPairs.length}件)\n`);

  // Results structure
  const results: Record<string, Record<number, { pnl: number; wins: number; losses: number; trades: number }>> = {
    'BUYのみ': { 3: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 4: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 5: { pnl: 0, wins: 0, losses: 0, trades: 0 } },
    'SHORTのみ': { 3: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 4: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 5: { pnl: 0, wins: 0, losses: 0, trades: 0 } },
    '両方': { 3: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 4: { pnl: 0, wins: 0, losses: 0, trades: 0 }, 5: { pnl: 0, wins: 0, losses: 0, trades: 0 } },
  };

  const dailyResults: Record<string, Record<string, Record<number, number>>> = {};

  for (const pair of pairs) {
    const { date, symbol, side, entryTime, entryPrice, shares, pnl: actualPnl } = pair;
    const isBuy = side === 'long';

    // Get candles around entry time
    const candles = await db.execute(sql`
      SELECT candleTime, open, high, low, close
      FROM rt_candles
      WHERE tradeDate = ${date} AND symbol = ${symbol}
        AND candleTime <= ${entryTime}
      ORDER BY candleTime DESC
      LIMIT 5
    `);
    const candleRows = (candles as any)[0];

    if (candleRows.length < 3) {
      // Not enough data, use actual PnL for all
      for (const bars of [3, 4, 5]) {
        const cat = isBuy ? 'BUYのみ' : 'SHORTのみ';
        results[cat][bars].pnl += actualPnl;
        results[cat][bars].trades++;
        if (actualPnl > 0) results[cat][bars].wins++; else results[cat][bars].losses++;
        results['両方'][bars].pnl += actualPnl;
        results['両方'][bars].trades++;
        if (actualPnl > 0) results['両方'][bars].wins++; else results['両方'][bars].losses++;
      }
      continue;
    }

    // Prices at different confirmation bar counts
    const price5 = entryPrice;
    const price4 = Number(candleRows[1].close);
    const price3 = Number(candleRows[2].close);

    // Get candles AFTER the earliest possible entry (2 bars before actual entry)
    const afterCandles = await db.execute(sql`
      SELECT candleTime, open, high, low, close
      FROM rt_candles
      WHERE tradeDate = ${date} AND symbol = ${symbol}
        AND candleTime > ${candleRows[2].candleTime}
      ORDER BY candleTime ASC
      LIMIT 120
    `);
    const afterRows = (afterCandles as any)[0];

    for (const bars of [3, 4, 5]) {
      let simEntryPrice: number;
      let startIdx: number;

      if (bars === 5) {
        simEntryPrice = price5;
        startIdx = afterRows.findIndex((c: any) => c.candleTime > entryTime);
        if (startIdx === -1) startIdx = afterRows.length;
      } else if (bars === 4) {
        simEntryPrice = price4;
        const time4 = candleRows[1].candleTime;
        startIdx = afterRows.findIndex((c: any) => c.candleTime > time4);
        if (startIdx === -1) startIdx = afterRows.length;
      } else {
        simEntryPrice = price3;
        const time3 = candleRows[2].candleTime;
        startIdx = afterRows.findIndex((c: any) => c.candleTime > time3);
        if (startIdx === -1) startIdx = afterRows.length;
      }

      // For CONFIRM_BARS=5, use actual PnL
      let simPnl: number;
      if (bars === 5) {
        simPnl = actualPnl;
      } else {
        // Simulate with SL=0.5%, TP=1.5%
        const slPct = 0.005;
        const tpPct = 0.015;
        simPnl = 0;
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
            // Check SL first (conservative)
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

        // If not exited, use last available close (forced exit at 15:25)
        if (!exited && afterRows.length > startIdx) {
          const lastClose = Number(afterRows[afterRows.length - 1].close);
          simPnl = side === 'long'
            ? Math.round((lastClose - simEntryPrice) * shares)
            : Math.round((simEntryPrice - lastClose) * shares);
        }
      }

      const isWin = simPnl > 0;
      const cat = isBuy ? 'BUYのみ' : 'SHORTのみ';

      results[cat][bars].pnl += simPnl;
      results[cat][bars].trades++;
      if (isWin) results[cat][bars].wins++; else results[cat][bars].losses++;

      results['両方'][bars].pnl += simPnl;
      results['両方'][bars].trades++;
      if (isWin) results['両方'][bars].wins++; else results['両方'][bars].losses++;

      // Daily tracking
      if (!dailyResults[date]) {
        dailyResults[date] = {
          'BUYのみ': { 3: 0, 4: 0, 5: 0 },
          'SHORTのみ': { 3: 0, 4: 0, 5: 0 },
          '両方': { 3: 0, 4: 0, 5: 0 },
        };
      }
      dailyResults[date][cat][bars] += simPnl;
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
    console.log('確認バー | 取引数 | 勝率          | 総PnL          | 平均PnL/件    | vs 5本差分');
    console.log('---------|--------|---------------|----------------|--------------|----------');
    for (const bars of [3, 4, 5]) {
      const r = results[pattern][bars];
      const winRate = r.trades > 0 ? Math.round(r.wins / r.trades * 100) : 0;
      const avgPnl = r.trades > 0 ? Math.round(r.pnl / r.trades) : 0;
      const diff = r.pnl - results[pattern][5].pnl;
      const diffStr = bars === 5 ? '(基準)' : `${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円`;
      console.log(`  ${bars}本    |  ${String(r.trades).padStart(3)}件 | ${String(winRate).padStart(3)}% (${String(r.wins).padStart(2)}勝${String(r.losses).padStart(2)}敗) | ${(r.pnl >= 0 ? '+' : '') + r.pnl.toLocaleString().padStart(10)}円 | ${(avgPnl >= 0 ? '+' : '') + avgPnl.toLocaleString().padStart(8)}円 | ${diffStr}`);
    }
    console.log('');
  }

  // Daily breakdown for each pattern
  const sortedDates = Object.keys(dailyResults).sort();

  for (const pattern of ['両方', 'BUYのみ', 'SHORTのみ']) {
    console.log('━'.repeat(90));
    console.log(`【日別比較（${pattern}）】`);
    console.log('━'.repeat(90));
    console.log('日付       | 3本確認       | 4本確認       | 5本確認(現行)  | 最適 | 3本vs5本     | 4本vs5本');
    console.log('-----------|--------------|--------------|---------------|------|-------------|----------');
    let total3 = 0, total4 = 0, total5 = 0;
    for (const date of sortedDates) {
      const d = dailyResults[date][pattern];
      if (!d || (d[3] === 0 && d[4] === 0 && d[5] === 0)) continue;
      const best = d[3] >= d[4] && d[3] >= d[5] ? '3本' : d[4] >= d[3] && d[4] >= d[5] ? '4本' : '5本';
      const diff3 = d[3] - d[5];
      const diff4 = d[4] - d[5];
      console.log(`${date} | ${(d[3] >= 0 ? '+' : '') + d[3].toLocaleString().padStart(10)}円 | ${(d[4] >= 0 ? '+' : '') + d[4].toLocaleString().padStart(10)}円 | ${(d[5] >= 0 ? '+' : '') + d[5].toLocaleString().padStart(10)}円 | ${best.padStart(4)} | ${(diff3 >= 0 ? '+' : '') + diff3.toLocaleString().padStart(9)}円 | ${(diff4 >= 0 ? '+' : '') + diff4.toLocaleString().padStart(9)}円`);
      total3 += d[3]; total4 += d[4]; total5 += d[5];
    }
    console.log('-----------|--------------|--------------|---------------|------|-------------|----------');
    const bestTotal = total3 >= total4 && total3 >= total5 ? '3本' : total4 >= total3 && total4 >= total5 ? '4本' : '5本';
    console.log(`合計       | ${(total3 >= 0 ? '+' : '') + total3.toLocaleString().padStart(10)}円 | ${(total4 >= 0 ? '+' : '') + total4.toLocaleString().padStart(10)}円 | ${(total5 >= 0 ? '+' : '') + total5.toLocaleString().padStart(10)}円 | ${bestTotal.padStart(4)} | ${((total3 - total5) >= 0 ? '+' : '') + (total3 - total5).toLocaleString().padStart(9)}円 | ${((total4 - total5) >= 0 ? '+' : '') + (total4 - total5).toLocaleString().padStart(9)}円`);
    console.log('');
  }

  // Win rate by day count
  console.log('━'.repeat(90));
  console.log('【日別勝率（各確認バーが最適だった日数）】');
  console.log('━'.repeat(90));
  for (const pattern of ['両方', 'BUYのみ', 'SHORTのみ']) {
    let best3 = 0, best4 = 0, best5 = 0, tie = 0;
    for (const date of sortedDates) {
      const d = dailyResults[date][pattern];
      if (!d || (d[3] === 0 && d[4] === 0 && d[5] === 0)) continue;
      if (d[3] > d[4] && d[3] > d[5]) best3++;
      else if (d[4] > d[3] && d[4] > d[5]) best4++;
      else if (d[5] > d[3] && d[5] > d[4]) best5++;
      else tie++;
    }
    const total = best3 + best4 + best5 + tie;
    console.log(`■ ${pattern}: 3本最適=${best3}日(${Math.round(best3/total*100)}%), 4本最適=${best4}日(${Math.round(best4/total*100)}%), 5本最適=${best5}日(${Math.round(best5/total*100)}%), 同率=${tie}日`);
  }

  await (db as any).end?.();
  process.exit(0);
}

main().catch(console.error);
