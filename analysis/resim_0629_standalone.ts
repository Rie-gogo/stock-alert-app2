/**
 * 6/29 再シミュレーション（現在の仕様 - スタンドアロン版）
 * - BEストップ: 含み益+0.5%到達でSLを建値に移動
 * - 後場BPRフィルター: 13:00以降 + SHORT + BPR>=0.65 でエントリーブロック
 * 
 * DB書き込みなしで高速にリプレイ
 */
import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// ---- 定数（本番と同じ） ----
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
const BE_TRIGGER_PERCENT = 0.5;
const PM_BPR_BLOCK_THRESHOLD = 0.65;
const PM_BPR_FILTER_START = "13:00";
const MAX_CONCURRENT = 3;

interface Position {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  entryTime: string;
  shares: number;
  beTriggered: boolean;
  beTriggeredAt: string | null;
  stopLine: number;
}

interface Trade {
  symbol: string;
  side: "long" | "short";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  reason: string;
  beTriggered: boolean;
}

async function main() {
  const db = await getDb();

  // 6/29の全取引データ（実際に行われた取引）を取得して比較用に
  const [actualTradesRows] = await db!.execute(sql`
    SELECT symbol, tradeDate, tradeTime, action, price, shares, pnl, reason
    FROM rt_trades 
    WHERE tradeDate = '2026-06-29'
    ORDER BY tradeTime ASC
  `);
  const actualTrades = actualTradesRows as any[];

  // 6/29の全1分足データを時系列順に取得
  const [candleRows] = await db!.execute(sql`
    SELECT symbol, tradeDate, candleTime, open, high, low, close, volume, boardSnapshot
    FROM rt_candles 
    WHERE tradeDate = '2026-06-29' 
    ORDER BY candleTime ASC, symbol ASC
  `);
  const candles = candleRows as any[];

  console.log(`=== 6/29 再シミュレーション（現在仕様: BEストップ + 後場BPRフィルター） ===`);
  console.log(`1分足データ: ${candles.length}本`);
  console.log(`実際の取引記録: ${actualTrades.length}件`);
  console.log(`---`);

  // 実際のエントリー/エグジットを再現し、BEストップとBPRフィルターを適用
  // まず実際の取引ペア（エントリー→エグジット）を構築
  const entryActions = actualTrades.filter((t: any) => t.action === "long" || t.action === "short");
  const exitActions = actualTrades.filter((t: any) => t.action === "sell" || t.action === "cover");

  // 取引ペアを構築（同じ銘柄の複数取引に対応、actionタイプマッチング）
  const tradePairs: Array<{
    entry: any;
    exit: any;
  }> = [];

  // long/buyはsellで決済、shortはcoverで決済
  const longQueue = new Map<string, any[]>(); // long/buy entries
  const shortQueue = new Map<string, any[]>(); // short entries
  for (const t of actualTrades) {
    if (t.action === "long" || t.action === "buy") {
      if (!longQueue.has(t.symbol)) longQueue.set(t.symbol, []);
      longQueue.get(t.symbol)!.push(t);
    } else if (t.action === "short") {
      if (!shortQueue.has(t.symbol)) shortQueue.set(t.symbol, []);
      shortQueue.get(t.symbol)!.push(t);
    } else if (t.action === "sell") {
      const queue = longQueue.get(t.symbol);
      if (queue && queue.length > 0) {
        const entry = queue.shift()!;
        tradePairs.push({ entry, exit: t });
      }
    } else if (t.action === "cover") {
      const queue = shortQueue.get(t.symbol);
      if (queue && queue.length > 0) {
        const entry = queue.shift()!;
        tradePairs.push({ entry, exit: t });
      }
    }
  }

  console.log(`取引ペア数: ${tradePairs.length}`);
  console.log(`\n`);

  // 各取引ペアについて、現仕様でシミュレーション
  const simTrades: Trade[] = [];
  const bprBlocked: any[] = [];

  for (const pair of tradePairs) {
    const { entry, exit } = pair;
    const symbol = entry.symbol;
    const side = (entry.action === "buy" || entry.action === "long") ? "long" : "short";
    const entryPrice = Number(entry.price);
    const entryTime = entry.tradeTime;
    const shares = Number(entry.shares);

    // ---- 後場BPRフィルターチェック ----
    if (side === "short" && entryTime >= PM_BPR_FILTER_START) {
      // エントリー時刻の板情報を取得
      const [boardRows] = await db!.execute(sql`
        SELECT boardSnapshot FROM rt_candles
        WHERE symbol = ${symbol} AND tradeDate = '2026-06-29' AND candleTime = ${entryTime}
        LIMIT 1
      `);
      const boardData = boardRows as any[];
      if (boardData.length > 0 && boardData[0].boardSnapshot) {
        const bs = typeof boardData[0].boardSnapshot === 'string' 
          ? JSON.parse(boardData[0].boardSnapshot) 
          : boardData[0].boardSnapshot;
        const bpr = bs.buyPressureRatio;
        if (typeof bpr === "number" && bpr >= PM_BPR_BLOCK_THRESHOLD) {
          bprBlocked.push({
            time: entryTime,
            symbol,
            bpr,
            wouldHavePnl: Number(exit.pnl),
          });
          console.log(`[BPR BLOCK] ${entryTime} ${symbol} SHORT ブロック (BPR=${bpr.toFixed(3)} >= ${PM_BPR_BLOCK_THRESHOLD}) → 回避損益: ${Number(exit.pnl) >= 0 ? '+' : ''}${Number(exit.pnl).toLocaleString()}円`);
          continue; // エントリーしない
        }
      }
    }

    // ---- BEストップシミュレーション ----
    // エントリー後の1分足を取得してBEトリガーとSL/TP判定
    const [postEntryRows] = await db!.execute(sql`
      SELECT candleTime, open, high, low, close, volume, boardSnapshot
      FROM rt_candles
      WHERE symbol = ${symbol} AND tradeDate = '2026-06-29' AND candleTime > ${entryTime}
      ORDER BY candleTime ASC
    `);
    const postCandles = postEntryRows as any[];

    let beTriggered = false;
    let beTriggeredAt: string | null = null;
    let stopLine = side === "long" 
      ? entryPrice * (1 - STOP_LOSS_PERCENT / 100)
      : entryPrice * (1 + STOP_LOSS_PERCENT / 100);
    const tpLine = side === "long"
      ? entryPrice * (1 + TAKE_PROFIT_PERCENT / 100)
      : entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);

    let exitPrice = 0;
    let exitTime = "";
    let exitReason = "";
    let exited = false;

    for (const c of postCandles) {
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);
      const time = c.candleTime;

      // 大引け（15:25以降）は強制決済
      if (time >= "15:25") {
        exitPrice = close;
        exitTime = time;
        exitReason = "大引け強制決済";
        exited = true;
        break;
      }

      // BEトリガー判定（まだ発動していない場合）
      if (!beTriggered) {
        if (side === "long") {
          const unrealizedPct = (high - entryPrice) / entryPrice * 100;
          if (unrealizedPct >= BE_TRIGGER_PERCENT) {
            beTriggered = true;
            beTriggeredAt = time;
            stopLine = entryPrice; // SLを建値に移動
          }
        } else {
          const unrealizedPct = (entryPrice - low) / entryPrice * 100;
          if (unrealizedPct >= BE_TRIGGER_PERCENT) {
            beTriggered = true;
            beTriggeredAt = time;
            stopLine = entryPrice; // SLを建値に移動
          }
        }
      }

      // SL/BE建値決済チェック
      if (side === "long") {
        if (low <= stopLine) {
          exitPrice = stopLine;
          exitTime = time;
          exitReason = beTriggered ? "BE建値決済" : "損切り";
          exited = true;
          break;
        }
      } else {
        if (high >= stopLine) {
          exitPrice = stopLine;
          exitTime = time;
          exitReason = beTriggered ? "BE建値決済" : "損切り";
          exited = true;
          break;
        }
      }

      // TP利確チェック
      if (side === "long") {
        if (high >= tpLine) {
          exitPrice = tpLine;
          exitTime = time;
          exitReason = "利確";
          exited = true;
          break;
        }
      } else {
        if (low <= tpLine) {
          exitPrice = tpLine;
          exitTime = time;
          exitReason = "利確";
          exited = true;
          break;
        }
      }
    }

    // 決済されなかった場合（データ不足）→実際の決済を使用
    if (!exited) {
      exitPrice = Number(exit.price);
      exitTime = exit.tradeTime;
      exitReason = exit.reason || "実際の決済";
    }

    // PnL計算
    const pnl = side === "long"
      ? Math.round((exitPrice - entryPrice) * shares)
      : Math.round((entryPrice - exitPrice) * shares);

    simTrades.push({
      symbol,
      side,
      entryTime,
      exitTime,
      entryPrice,
      exitPrice: Math.round(exitPrice * 100) / 100,
      shares,
      pnl,
      reason: exitReason,
      beTriggered,
    });

    const mark = pnl >= 0 ? "✓" : "✗";
    console.log(`[${mark}] ${entryTime}→${exitTime} ${symbol} ${side.toUpperCase()} @${entryPrice}→${Math.round(exitPrice)} PnL:${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円 [${exitReason}]${beTriggered ? ` ★BE(${beTriggeredAt})` : ''}`);
  }

  // ---- サマリー ----
  console.log(`\n${"=".repeat(60)}`);
  console.log(`=== 結果サマリー ===`);
  console.log(`${"=".repeat(60)}`);
  console.log(`取引数: ${simTrades.length}`);
  console.log(`勝ち: ${simTrades.filter(t => t.pnl > 0).length}`);
  console.log(`負け: ${simTrades.filter(t => t.pnl < 0).length}`);
  console.log(`引分(BE建値決済): ${simTrades.filter(t => t.pnl === 0).length}`);
  
  const totalPnl = simTrades.reduce((sum, t) => sum + t.pnl, 0);
  console.log(`総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  
  const wins = simTrades.filter(t => t.pnl > 0);
  const losses = simTrades.filter(t => t.pnl < 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  console.log(`平均利益: +${Math.round(avgWin).toLocaleString()}円`);
  console.log(`平均損失: ${Math.round(avgLoss).toLocaleString()}円`);
  
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
  console.log(`PF: ${pf}`);

  console.log(`\n--- BEストップ効果 ---`);
  const beTrades = simTrades.filter(t => t.beTriggered);
  console.log(`BE発動: ${beTrades.length}件`);
  console.log(`  BE建値決済(±0): ${beTrades.filter(t => t.pnl === 0).length}件`);
  console.log(`  BE発動後TP: ${beTrades.filter(t => t.pnl > 0).length}件`);
  console.log(`  BE発動後SL(建値): ${beTrades.filter(t => t.reason === "BE建値決済").length}件`);

  console.log(`\n--- 後場BPRフィルター効果 ---`);
  console.log(`BPRブロック: ${bprBlocked.length}件`);
  const blockedLoss = bprBlocked.filter(b => b.wouldHavePnl < 0);
  const blockedWin = bprBlocked.filter(b => b.wouldHavePnl > 0);
  console.log(`  正しいブロック(損失回避): ${blockedLoss.length}件 (${blockedLoss.reduce((s, b) => s + b.wouldHavePnl, 0).toLocaleString()}円回避)`);
  console.log(`  誤ブロック(利益逃し): ${blockedWin.length}件 (${blockedWin.reduce((s, b) => s + b.wouldHavePnl, 0).toLocaleString()}円逃し)`);
  const bprNetEffect = -bprBlocked.reduce((s, b) => s + b.wouldHavePnl, 0);
  console.log(`  ネット効果: ${bprNetEffect >= 0 ? '+' : ''}${bprNetEffect.toLocaleString()}円`);

  // 比較
  const actualPnl = actualTrades
    .filter((t: any) => t.action === "sell" || t.action === "cover")
    .reduce((sum: number, t: any) => sum + Number(t.pnl || 0), 0);
  
  console.log(`\n${"=".repeat(60)}`);
  console.log(`=== 実際の6/29結果との比較 ===`);
  console.log(`${"=".repeat(60)}`);
  console.log(`実際の総損益: ${actualPnl.toLocaleString()}円`);
  console.log(`現仕様での総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  console.log(`改善額: ${(totalPnl - actualPnl) >= 0 ? '+' : ''}${(totalPnl - actualPnl).toLocaleString()}円`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
