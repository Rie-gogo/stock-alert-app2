/**
 * 6/29 再シミュレーション（現在の仕様）
 * - BEストップ: 含み益+0.5%到達でSLを建値に移動
 * - 後場BPRフィルター: 13:00以降 + SHORT + BPR>=0.65 でエントリーブロック
 * 
 * rt_candlesの1分足データを時系列順にprocessCandleに流し込み、
 * 実際のエンジンで6/29の取引をリプレイする
 */
import { processCandle, getSignalHistory, getOpenPositions, getDashboardStatus } from "../server/realtimeSimEngine";
import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // 6/29の全1分足データを時系列順に取得
  const [rows] = await db!.execute(sql`
    SELECT symbol, tradeDate, candleTime, open, high, low, close, volume, boardSnapshot
    FROM rt_candles 
    WHERE tradeDate = '2026-06-29' 
    ORDER BY candleTime ASC, symbol ASC
  `);
  const candles = rows as any[];

  console.log(`=== 6/29 再シミュレーション（現在仕様: BEストップ + 後場BPRフィルター） ===`);
  console.log(`1分足データ: ${candles.length}本`);
  console.log(`---`);

  // 取引結果を記録
  const trades: any[] = [];

  for (const candle of candles) {
    // boardSnapshotをパース
    let boardSnapshot = null;
    if (candle.boardSnapshot) {
      try {
        boardSnapshot = typeof candle.boardSnapshot === 'string' 
          ? JSON.parse(candle.boardSnapshot) 
          : candle.boardSnapshot;
      } catch (e) {}
    }

    const result = await processCandle({
      symbol: candle.symbol,
      tradeDate: candle.tradeDate,
      candleTime: candle.candleTime,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
      boardSnapshot,
    });

    if (result.action === "entry") {
      console.log(`[ENTRY] ${result.candleTime} ${result.symbol} ${(result as any).side} @${(result as any).entryPrice}円`);
    } else if (result.action === "exit") {
      const pnl = (result as any).pnl || 0;
      trades.push({
        time: result.candleTime,
        symbol: result.symbol,
        side: (result as any).side,
        entryPrice: (result as any).entryPrice,
        exitPrice: (result as any).exitPrice,
        pnl,
        reason: (result as any).reason,
        beTriggered: (result as any).beTriggered || false,
      });
      const mark = pnl >= 0 ? "✓" : "✗";
      console.log(`[EXIT ${mark}] ${result.candleTime} ${result.symbol} ${(result as any).side} PnL:${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円 (${(result as any).reason})${(result as any).beTriggered ? ' [BE発動済]' : ''}`);
    }
  }

  // シグナル履歴からBPRブロックとBEトリガーを抽出
  const history = getSignalHistory();
  const bprBlocks = history.filter((h: any) => h.action === "pm_bpr_block");
  const beTriggered = history.filter((h: any) => h.action === "be_trigger");

  console.log(`\n=== 結果サマリー ===`);
  console.log(`取引数: ${trades.length}`);
  console.log(`勝ち: ${trades.filter(t => t.pnl > 0).length}`);
  console.log(`負け: ${trades.filter(t => t.pnl < 0).length}`);
  console.log(`引分(BE建値決済含む): ${trades.filter(t => t.pnl === 0).length}`);
  
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  console.log(`総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  console.log(`平均利益: +${Math.round(avgWin).toLocaleString()}円`);
  console.log(`平均損失: ${Math.round(avgLoss).toLocaleString()}円`);
  
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
  console.log(`PF: ${pf}`);

  console.log(`\n--- BEストップ ---`);
  console.log(`BE発動回数: ${beTriggered.length}`);
  const beTrades = trades.filter(t => t.beTriggered);
  console.log(`BE建値決済: ${beTrades.filter(t => t.pnl === 0).length}件`);
  console.log(`BE発動後TP: ${beTrades.filter(t => t.pnl > 0).length}件`);

  console.log(`\n--- 後場BPRフィルター ---`);
  console.log(`BPRブロック回数: ${bprBlocks.length}`);
  for (const b of bprBlocks) {
    console.log(`  ${(b as any).time} ${(b as any).symbol} ${(b as any).reason}`);
  }

  console.log(`\n--- 全取引詳細 ---`);
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    console.log(`#${i+1} ${t.time} ${t.symbol} ${t.side} @${t.entryPrice}→${t.exitPrice} PnL:${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString()}円 [${t.reason}]${t.beTriggered ? ' ★BE' : ''}`);
  }

  // 比較: 実際の6/29結果
  console.log(`\n=== 実際の6/29結果との比較 ===`);
  const actualPnl = -75081; // 実際の6/29総損益
  console.log(`実際の総損益: ${actualPnl.toLocaleString()}円`);
  console.log(`現仕様での総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  console.log(`改善額: ${(totalPnl - actualPnl) >= 0 ? '+' : ''}${(totalPnl - actualPnl).toLocaleString()}円`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
