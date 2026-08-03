import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

/**
 * 本日(7/31)のrt_candlesデータを使って、CONFIRM_BARS=5の場合のシミュレーションを行う。
 * 実際のエンジンのprocessCandle()を直接呼ぶのは複雑なので、
 * 既知の事実に基づいて分析する:
 * 
 * 実際のトレード結果(CONFIRM_BARS=4):
 *   #1: 6758 SHORT 10:54 VWAPクロス → -13,016円 (CONFIRM_BARSに無関係)
 *   #2: 6857 BUY 13:48 大台確認(32400円) → -16,310円
 *   #3: 6526 BUY 14:16 逆三尊 → -12,600円 (CONFIRM_BARSに無関係)
 *   #4: 6857 BUY 14:20 大台確認(32500円) → -16,355円
 * 
 * CONFIRM_BARS=5の場合:
 *   - VWAPクロスと逆三尊は変わらない
 *   - 大台確認は1本遅れる → エントリータイミングが変わる or ブロックされる
 * 
 * 大台確認のフロー:
 *   シグナル発火 → confirmCount++ × N本 → 確認完了 → 押し目待ち(MAX5本) → エントリー
 *   
 * 確認中にclose < levelになったらキャンセル。
 * 
 * 正確にシミュレーションするため、6857の全バーを使って手動でステートマシンを再現する。
 */

async function main() {
  const db = await getDb();
  
  const [candles] = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE tradeDate = '2026-07-31' AND symbol = '6857'
    ORDER BY candleTime ASC
  `);
  
  const bars = (candles as any[]).map((c: any) => ({
    time: c.candleTime as string,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  }));
  
  // 大台レベル検出: 100円刻み (6857は3万円台なので)
  // 6857の株価は32000-33000円台 → 大台は100円刻み
  function getRoundLevels(price: number): number[] {
    // 1000円以上の銘柄は100円刻み
    const step = price >= 10000 ? 100 : (price >= 1000 ? 100 : 10);
    const base = Math.floor(price / step) * step;
    return [base, base + step];
  }
  
  // シミュレーション: CONFIRM_BARS=5
  const CONFIRM_BARS = 5;
  const PULLBACK_MAX_WAIT = 5;
  const SL_PCT = 0.005; // 0.5%
  const TP_PCT = 0.015; // 1.5%
  
  interface PendingState {
    direction: 'buy';
    level: number;
    confirmCount: number;
    reason: string;
  }
  
  interface PullbackState {
    direction: 'buy';
    level: number;
    signalPrice: number;
    waitCount: number;
    pulledBack: boolean;
    reason: string;
  }
  
  interface Position {
    entryPrice: number;
    entryTime: string;
    sl: number;
    tp: number;
    reason: string;
  }
  
  let pending: PendingState | null = null;
  let pullback: PullbackState | null = null;
  let position: Position | null = null;
  const trades: any[] = [];
  let prevClose = 0;
  
  // 大台超えシグナル検出（簡易版）
  function detectRoundBreakout(bar: typeof bars[0], prevC: number): { level: number; reason: string } | null {
    if (prevC === 0) return null;
    const step = bar.close >= 10000 ? 100 : (bar.close >= 1000 ? 100 : 10);
    // 前バーのcloseが大台以下で、今バーのcloseが大台超え
    const roundAbove = Math.ceil(prevC / step) * step;
    if (prevC < roundAbove && bar.close >= roundAbove) {
      return { level: roundAbove, reason: `大台超え (${roundAbove}円突破)` };
    }
    return null;
  }
  
  const NO_ENTRY_AFTER = '14:50';
  
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    
    // ポジション決済チェック
    if (position) {
      if (bar.low <= position.sl) {
        const pnl = Math.round((position.sl - position.entryPrice) * 100);
        trades.push({
          entryTime: position.entryTime,
          exitTime: bar.time,
          entryPrice: position.entryPrice,
          exitPrice: position.sl,
          pnl,
          reason: position.reason,
          exitReason: '損切り'
        });
        position = null;
      } else if (bar.high >= position.tp) {
        const pnl = Math.round((position.tp - position.entryPrice) * 100);
        trades.push({
          entryTime: position.entryTime,
          exitTime: bar.time,
          entryPrice: position.entryPrice,
          exitPrice: position.tp,
          pnl,
          reason: position.reason,
          exitReason: '利確'
        });
        position = null;
      }
      // EOD (15:25以降)
      if (position && bar.time >= '15:25') {
        const pnl = Math.round((bar.close - position.entryPrice) * 100);
        trades.push({
          entryTime: position.entryTime,
          exitTime: bar.time,
          entryPrice: position.entryPrice,
          exitPrice: bar.close,
          pnl,
          reason: position.reason,
          exitReason: 'EOD決済'
        });
        position = null;
      }
    }
    
    // 押し目待ちステート処理
    if (pullback && !position) {
      pullback.waitCount++;
      if (bar.low < pullback.signalPrice) {
        pullback.pulledBack = true;
      }
      if (pullback.pulledBack && bar.close >= pullback.signalPrice) {
        // 押し目確認 → エントリー
        if (bar.time < NO_ENTRY_AFTER) {
          const entryPrice = bar.close;
          position = {
            entryPrice,
            entryTime: bar.time,
            sl: Math.round(entryPrice * (1 - SL_PCT) * 100) / 100,
            tp: Math.round(entryPrice * (1 + TP_PCT) * 100) / 100,
            reason: pullback.reason,
          };
          console.log(`  [ENTRY] ${bar.time} BUY @${entryPrice} (${pullback.reason}) SL:${position.sl} TP:${position.tp}`);
        }
        pullback = null;
      } else if (pullback.waitCount >= PULLBACK_MAX_WAIT) {
        // タイムアウト → 強トレンドエントリー（現行ロジックでは廃止されている可能性あり）
        // 現行では押し目タイムアウト後もエントリーする
        if (bar.time < NO_ENTRY_AFTER) {
          const entryPrice = bar.close;
          position = {
            entryPrice,
            entryTime: bar.time,
            sl: Math.round(entryPrice * (1 - SL_PCT) * 100) / 100,
            tp: Math.round(entryPrice * (1 + TP_PCT) * 100) / 100,
            reason: pullback.reason + ' (押し目タイムアウト)',
          };
          console.log(`  [ENTRY-TIMEOUT] ${bar.time} BUY @${entryPrice} (${pullback.reason}) SL:${position.sl} TP:${position.tp}`);
        }
        pullback = null;
      }
    }
    
    // 大台確認バーステート処理
    if (pending && !position) {
      const stillValid = bar.close >= pending.level;
      if (stillValid) {
        pending.confirmCount++;
        if (pending.confirmCount >= CONFIRM_BARS) {
          console.log(`  [CONFIRM] ${bar.time} 大台確認完了(${CONFIRM_BARS}本維持) level=${pending.level}`);
          pullback = {
            direction: 'buy',
            level: pending.level,
            signalPrice: bar.close,
            waitCount: 0,
            pulledBack: false,
            reason: `大台確認(${CONFIRM_BARS}本維持): ${pending.reason}`,
          };
          pending = null;
        }
      } else {
        console.log(`  [CANCEL] ${bar.time} 大台確認キャンセル: close=${bar.close} < level=${pending.level}`);
        pending = null;
      }
    }
    
    // 新規シグナル検出（ポジションなし、pending/pullbackなしの時のみ）
    if (!position && !pending && !pullback && prevClose > 0) {
      const signal = detectRoundBreakout(bar, prevClose);
      if (signal && bar.time < NO_ENTRY_AFTER) {
        pending = {
          direction: 'buy',
          level: signal.level,
          confirmCount: 0,
          reason: signal.reason,
        };
        console.log(`  [SIGNAL] ${bar.time} 大台超えシグナル: ${signal.reason} (close=${bar.close})`);
      }
    }
    
    prevClose = bar.close;
  }
  
  console.log("\n\n=== CONFIRM_BARS=5 シミュレーション結果 (6857 大台確認のみ) ===\n");
  let totalPnl = 0;
  for (const t of trades) {
    totalPnl += t.pnl;
    console.log(`  ${t.entryTime}→${t.exitTime} | @${t.entryPrice}→@${t.exitPrice} | ${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString()}円 | ${t.reason} | ${t.exitReason}`);
  }
  console.log(`\n  6857大台確認 合計: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円 (${trades.length}件)`);
  
  // 比較
  console.log("\n\n=== 比較 ===");
  console.log(`  CONFIRM_BARS=4 (実績): 6857大台確認 -32,665円 (2件0勝2敗)`);
  console.log(`  CONFIRM_BARS=5 (仮想): 6857大台確認 ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円 (${trades.length}件)`);
  
  const diff = totalPnl - (-32665);
  console.log(`\n  差分: ${diff >= 0 ? '+' : ''}${diff.toLocaleString()}円`);
  
  // 全体比較
  const otherPnl = -13016 + (-12600); // VWAPクロス + 逆三尊
  console.log(`\n\n=== 本日全体の比較 ===`);
  console.log(`  CONFIRM_BARS=4 (実績): -58,281円 (4件0勝4敗)`);
  console.log(`  CONFIRM_BARS=5 (仮想): ${(totalPnl + otherPnl) >= 0 ? '+' : ''}${(totalPnl + otherPnl).toLocaleString()}円 (${trades.length + 2}件)`);
  console.log(`  ※ VWAPクロス(-13,016円)と逆三尊(-12,600円)はCONFIRM_BARSに無関係`);
  
  process.exit(0);
}
main().catch(console.error);
