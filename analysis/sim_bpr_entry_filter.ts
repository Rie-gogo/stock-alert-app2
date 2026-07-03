/**
 * BPRベース大口追従エントリーフィルター シミュレーション
 * 
 * 概要:
 * - シグナル発生時に即エントリーせず、boardSnapshotのBPR（買い圧力比率）が
 *   エントリー方向と一致していることを確認してからエントリーする
 * - LONGシグナル: avgBprIn10s >= threshold かつ bprDelta > 0
 * - SHORTシグナル: avgBprIn10s <= (1-threshold) かつ bprDelta < 0
 * - 確認できない場合は最大N分待機し、タイムアウトでキャンセル
 * 
 * データ: 7/3のみ（10秒集約データが蓄積されている唯一の日）
 */

import { getDb } from "../server/db";
import { detectSignals } from "../server/routers/stockData";

// ===== パラメータ =====
interface Scenario {
  name: string;
  bprThresholdLong: number;   // LONGエントリーに必要なBPR下限
  bprThresholdShort: number;  // SHORTエントリーに必要なBPR上限
  requirePositiveDelta: boolean; // bprDeltaの方向一致を要求するか
  maxWaitBars: number;        // 最大待機本数（分）
  description: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "A) 現行（フィルターなし）",
    bprThresholdLong: 0,
    bprThresholdShort: 999,
    requirePositiveDelta: false,
    maxWaitBars: 0,
    description: "ベースライン"
  },
  {
    name: "B) BPR≥0.60 LONG / ≤0.40 SHORT",
    bprThresholdLong: 0.60,
    bprThresholdShort: 0.40,
    requirePositiveDelta: false,
    maxWaitBars: 5,
    description: "緩い閾値"
  },
  {
    name: "C) BPR≥0.65 LONG / ≤0.35 SHORT",
    bprThresholdLong: 0.65,
    bprThresholdShort: 0.35,
    requirePositiveDelta: false,
    maxWaitBars: 5,
    description: "中程度の閾値"
  },
  {
    name: "D) BPR≥0.65 + Delta同方向",
    bprThresholdLong: 0.65,
    bprThresholdShort: 0.35,
    requirePositiveDelta: true,
    maxWaitBars: 5,
    description: "閾値+方向一致"
  },
  {
    name: "E) BPR≥0.70 LONG / ≤0.30 SHORT",
    bprThresholdLong: 0.70,
    bprThresholdShort: 0.30,
    requirePositiveDelta: false,
    maxWaitBars: 5,
    description: "厳しい閾値"
  },
  {
    name: "F) BPR≥0.60 + Delta + 待機10分",
    bprThresholdLong: 0.60,
    bprThresholdShort: 0.40,
    requirePositiveDelta: true,
    maxWaitBars: 10,
    description: "緩い閾値+方向+長い待機"
  },
  {
    name: "G) icebergBid≥2 LONG / icebergAsk≥2 SHORT",
    bprThresholdLong: 0,
    bprThresholdShort: 999,
    requirePositiveDelta: false,
    maxWaitBars: 5,
    description: "アイスバーグカウントのみ"
  },
];

// ===== 取引パラメータ（現行と同じ） =====
const CAPITAL_PER_TRADE = 1_000_000;
const SL_PCT = 0.005;
const TP_PCT = 0.0075;
const BE_TRIGGER_PCT = 0.005;

const SYMBOLS = ["6857","6920","6976","6981","7011","5803","6526","8035","8316","9984"];

interface CandleRow {
  symbol: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSnapshot: any;
}

interface Position {
  symbol: string;
  direction: "long" | "short";
  entry: number;
  sl: number;
  tp: number;
  shares: number;
  entryTime: string;
  beTriggered: boolean;
  signal: string;
}

interface PendingSignal {
  symbol: string;
  direction: "long" | "short";
  price: number;
  time: string;
  signal: string;
  waitBars: number;
}

interface Trade {
  symbol: string;
  direction: string;
  entryTime: string;
  exitTime: string;
  entry: number;
  exit: number;
  pnl: number;
  reason: string;
  signal: string;
}

async function main() {
  const db = await getDb();
  
  // 7/3のデータを取得
  const [rows] = await db.execute(
    `SELECT symbol, candleTime, open, high, low, close, volume, boardSnapshot 
     FROM rt_candles WHERE tradeDate = '2026-07-03' ORDER BY candleTime, symbol`
  ) as any;
  
  console.log(`データ: 7/3 ${rows.length}行`);
  
  // 銘柄別にデータを整理
  const bySymbol: Record<string, CandleRow[]> = {};
  for (const r of rows) {
    const snap = typeof r.boardSnapshot === 'string' ? JSON.parse(r.boardSnapshot) : r.boardSnapshot;
    const candle: CandleRow = {
      symbol: r.symbol,
      candleTime: r.candleTime,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      boardSnapshot: snap,
    };
    if (!bySymbol[candle.symbol]) bySymbol[candle.symbol] = [];
    bySymbol[candle.symbol].push(candle);
  }
  
  // シグナル検出（全銘柄）
  const signalsBySymbol: Record<string, any[]> = {};
  for (const sym of SYMBOLS) {
    if (!bySymbol[sym]) continue;
    const candles = bySymbol[sym].map(c => ({
      time: c.candleTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    const detected = detectSignals(candles as any, sym);
    signalsBySymbol[sym] = detected;
  }
  
  // 各シナリオでシミュレーション
  const results: { name: string; trades: Trade[]; blocked: number; delayed: number }[] = [];
  
  for (const scenario of SCENARIOS) {
    const trades: Trade[] = [];
    let blocked = 0;
    let delayed = 0;
    
    // 全銘柄を時間順にマージ
    const allCandles: CandleRow[] = [];
    for (const sym of SYMBOLS) {
      if (bySymbol[sym]) allCandles.push(...bySymbol[sym]);
    }
    allCandles.sort((a, b) => a.candleTime.localeCompare(b.candleTime));
    
    // ポジション管理
    const positions: Map<string, Position> = new Map();
    const pendingSignals: Map<string, PendingSignal> = new Map();
    const processedSignals: Set<string> = new Set();
    const dailySLCount: Map<string, number> = new Map();
    
    // 時間ごとに処理
    const timeSlots = [...new Set(allCandles.map(c => c.candleTime))].sort();
    
    for (const time of timeSlots) {
      const candlesAtTime = allCandles.filter(c => c.candleTime === time);
      
      for (const candle of candlesAtTime) {
        const sym = candle.symbol;
        
        // 1. 既存ポジションの管理
        const pos = positions.get(sym);
        if (pos) {
          let exitPrice = 0;
          let exitReason = "";
          
          if (pos.direction === "long") {
            // BEトリガー
            if (!pos.beTriggered && candle.high >= pos.entry * (1 + BE_TRIGGER_PCT)) {
              pos.beTriggered = true;
              pos.sl = pos.entry;
            }
            // SL
            if (candle.low <= pos.sl) {
              exitPrice = pos.sl;
              exitReason = pos.beTriggered && pos.sl === pos.entry ? "BE" : "SL";
            }
            // TP
            else if (candle.high >= pos.tp) {
              exitPrice = pos.tp;
              exitReason = "TP";
            }
          } else {
            // SHORT
            if (!pos.beTriggered && candle.low <= pos.entry * (1 - BE_TRIGGER_PCT)) {
              pos.beTriggered = true;
              pos.sl = pos.entry;
            }
            if (candle.high >= pos.sl) {
              exitPrice = pos.sl;
              exitReason = pos.beTriggered && pos.sl === pos.entry ? "BE" : "SL";
            }
            else if (candle.low <= pos.tp) {
              exitPrice = pos.tp;
              exitReason = "TP";
            }
          }
          
          // EOD
          if (!exitReason && time >= "15:25") {
            exitPrice = candle.close;
            exitReason = "EOD";
          }
          
          if (exitReason) {
            const pnl = pos.direction === "long"
              ? (exitPrice - pos.entry) * pos.shares
              : (pos.entry - exitPrice) * pos.shares;
            trades.push({
              symbol: sym,
              direction: pos.direction,
              entryTime: pos.entryTime,
              exitTime: time,
              entry: pos.entry,
              exit: exitPrice,
              pnl: Math.round(pnl),
              reason: exitReason,
              signal: pos.signal,
            });
            positions.delete(sym);
            if (exitReason === "SL") {
              dailySLCount.set(sym, (dailySLCount.get(sym) || 0) + 1);
            }
          }
          continue; // ポジション保有中は新規エントリーしない
        }
        
        // 2. 待機中のシグナルをチェック
        const pending = pendingSignals.get(sym);
        if (pending) {
          pending.waitBars++;
          
          // BPR確認
          const board = candle.boardSnapshot;
          let confirmed = false;
          
          if (scenario.name.startsWith("G)")) {
            // アイスバーグカウントベース
            if (pending.direction === "long" && board?.icebergBidCount >= 2) confirmed = true;
            if (pending.direction === "short" && board?.icebergAskCount >= 2) confirmed = true;
          } else if (scenario.bprThresholdLong > 0 || scenario.bprThresholdShort < 999) {
            const avgBpr = board?.avgBprIn10s ?? board?.buyPressureRatio ?? 0.5;
            const bprDelta = board?.bprDeltaIn10s ?? 0;
            
            if (pending.direction === "long") {
              const bprOk = avgBpr >= scenario.bprThresholdLong;
              const deltaOk = !scenario.requirePositiveDelta || bprDelta > 0;
              confirmed = bprOk && deltaOk;
            } else {
              const bprOk = avgBpr <= scenario.bprThresholdShort;
              const deltaOk = !scenario.requirePositiveDelta || bprDelta < 0;
              confirmed = bprOk && deltaOk;
            }
          }
          
          if (confirmed) {
            // エントリー実行
            delayed++;
            const entry = candle.close;
            const shares = Math.floor(CAPITAL_PER_TRADE / entry) * 100;
            const sl = pending.direction === "long" ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
            const tp = pending.direction === "long" ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);
            positions.set(sym, {
              symbol: sym,
              direction: pending.direction,
              entry,
              sl,
              tp,
              shares: shares / 100,
              entryTime: time,
              beTriggered: false,
              signal: pending.signal,
            });
            pendingSignals.delete(sym);
          } else if (pending.waitBars >= scenario.maxWaitBars) {
            // タイムアウト → キャンセル
            blocked++;
            pendingSignals.delete(sym);
          }
          continue;
        }
        
        // 3. 新規シグナル検出
        if (positions.has(sym) || pendingSignals.has(sym)) continue;
        if (time < "09:05" || time > "14:50") continue;
        
        // 同一銘柄SL2回制限
        if ((dailySLCount.get(sym) || 0) >= 2) continue;
        
        const signalCandles = signalsBySymbol[sym];
        if (!signalCandles) continue;
        
        const candleWithSignal = signalCandles.find((c: any) => c.time === time);
        if (!candleWithSignal?.signal) continue;
        
        const sig = candleWithSignal.signal;
        const sigKey = `${sym}_${time}_${sig.type}`;
        if (processedSignals.has(sigKey)) continue;
        processedSignals.add(sigKey);
        
        const direction: "long" | "short" = sig.direction === "long" ? "long" : "short";
        
        if (scenario.maxWaitBars === 0) {
          // フィルターなし（現行）→ 即エントリー
          const entry = candle.close;
          const shares = Math.floor(CAPITAL_PER_TRADE / entry) * 100;
          const sl = direction === "long" ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
          const tp = direction === "long" ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);
          positions.set(sym, {
            symbol: sym,
            direction,
            entry,
            sl,
            tp,
            shares: shares / 100,
            entryTime: time,
            beTriggered: false,
            signal: sig.type || sig.name || "unknown",
          });
        } else {
          // BPR確認待ちステートに入る
          // まず現在の足で即確認
          const board = candle.boardSnapshot;
          let immediateConfirm = false;
          
          if (scenario.name.startsWith("G)")) {
            if (direction === "long" && board?.icebergBidCount >= 2) immediateConfirm = true;
            if (direction === "short" && board?.icebergAskCount >= 2) immediateConfirm = true;
          } else if (scenario.bprThresholdLong > 0 || scenario.bprThresholdShort < 999) {
            const avgBpr = board?.avgBprIn10s ?? board?.buyPressureRatio ?? 0.5;
            const bprDelta = board?.bprDeltaIn10s ?? 0;
            
            if (direction === "long") {
              const bprOk = avgBpr >= scenario.bprThresholdLong;
              const deltaOk = !scenario.requirePositiveDelta || bprDelta > 0;
              immediateConfirm = bprOk && deltaOk;
            } else {
              const bprOk = avgBpr <= scenario.bprThresholdShort;
              const deltaOk = !scenario.requirePositiveDelta || bprDelta < 0;
              immediateConfirm = bprOk && deltaOk;
            }
          }
          
          if (immediateConfirm) {
            // 即エントリー
            const entry = candle.close;
            const shares = Math.floor(CAPITAL_PER_TRADE / entry) * 100;
            const sl = direction === "long" ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
            const tp = direction === "long" ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);
            positions.set(sym, {
              symbol: sym,
              direction,
              entry,
              sl,
              tp,
              shares: shares / 100,
              entryTime: time,
              beTriggered: false,
              signal: sig.type || sig.name || "unknown",
            });
          } else {
            // 待機ステートに入る
            pendingSignals.set(sym, {
              symbol: sym,
              direction,
              price: candle.close,
              time,
              signal: sig.type || sig.name || "unknown",
              waitBars: 0,
            });
          }
        }
      }
    }
    
    results.push({ name: scenario.name, trades, blocked, delayed });
  }
  
  // ===== 結果出力 =====
  console.log("\n" + "=".repeat(100));
  console.log("BPRベース大口追従エントリーフィルター シミュレーション結果（7/3）");
  console.log("=".repeat(100));
  
  const baseline = results[0];
  const baselinePnl = baseline.trades.reduce((s, t) => s + t.pnl, 0);
  
  console.log("\n順位 | パターン                              | 損益        | 差分       | 取引 | 勝率  | ブロック | 遅延エントリー");
  console.log("-".repeat(120));
  
  const sorted = [...results].sort((a, b) => {
    const pnlA = a.trades.reduce((s, t) => s + t.pnl, 0);
    const pnlB = b.trades.reduce((s, t) => s + t.pnl, 0);
    return pnlB - pnlA;
  });
  
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const pnl = r.trades.reduce((s, t) => s + t.pnl, 0);
    const wins = r.trades.filter(t => t.pnl > 0).length;
    const winRate = r.trades.length > 0 ? (wins / r.trades.length * 100).toFixed(1) : "0.0";
    const diff = pnl - baselinePnl;
    const diffStr = diff >= 0 ? `+${diff.toLocaleString()}円` : `${diff.toLocaleString()}円`;
    console.log(`  ${i + 1}  | ${r.name.padEnd(38)} | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString().padStart(10)}円 | ${diffStr.padStart(10)} | ${r.trades.length.toString().padStart(3)}件 | ${winRate.padStart(5)}% | ${r.blocked.toString().padStart(5)}件 | ${r.delayed.toString().padStart(5)}件`);
  }
  
  // 各シナリオの取引詳細
  for (const r of results) {
    console.log(`\n--- ${r.name} 取引詳細 ---`);
    if (r.trades.length === 0) {
      console.log("  取引なし");
      continue;
    }
    for (const t of r.trades) {
      const pnlStr = t.pnl >= 0 ? `+${t.pnl.toLocaleString()}` : t.pnl.toLocaleString();
      console.log(`  ${t.entryTime}→${t.exitTime} ${t.symbol} ${t.direction.toUpperCase()} @${t.entry.toLocaleString()}→${t.exit.toLocaleString()} ${pnlStr}円 [${t.reason}] (${t.signal})`);
    }
  }
  
  // 村田製作所と太陽誘電のBPR推移（エントリー前後）
  console.log("\n" + "=".repeat(80));
  console.log("村田製作所(6981) BPR推移 09:50-10:30");
  console.log("=".repeat(80));
  const murata = bySymbol["6981"]?.filter(c => c.candleTime >= "09:50" && c.candleTime <= "10:30") || [];
  for (const c of murata) {
    const b = c.boardSnapshot;
    const avgBpr = b?.avgBprIn10s?.toFixed(3) || "N/A";
    const delta = b?.bprDeltaIn10s?.toFixed(3) || "N/A";
    const iceBid = b?.icebergBidCount ?? 0;
    const iceAsk = b?.icebergAskCount ?? 0;
    console.log(`  ${c.candleTime} O:${c.open} H:${c.high} L:${c.low} C:${c.close} | BPR:${avgBpr} Δ:${delta} iceBid:${iceBid} iceAsk:${iceAsk}`);
  }
  
  console.log("\n" + "=".repeat(80));
  console.log("太陽誘電(6976) BPR推移 09:50-10:30");
  console.log("=".repeat(80));
  const taiyo = bySymbol["6976"]?.filter(c => c.candleTime >= "09:50" && c.candleTime <= "10:30") || [];
  for (const c of taiyo) {
    const b = c.boardSnapshot;
    const avgBpr = b?.avgBprIn10s?.toFixed(3) || "N/A";
    const delta = b?.bprDeltaIn10s?.toFixed(3) || "N/A";
    const iceBid = b?.icebergBidCount ?? 0;
    const iceAsk = b?.icebergAskCount ?? 0;
    console.log(`  ${c.candleTime} O:${c.open} H:${c.high} L:${c.low} C:${c.close} | BPR:${avgBpr} Δ:${delta} iceBid:${iceBid} iceAsk:${iceAsk}`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
