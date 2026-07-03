/**
 * 大口追従型エントリー戦略 シミュレーション
 * 
 * 方針: シグナル（パターン認識）ではなく、大口の動き（BPR・アイスバーグ）を
 *       エントリートリガーとする。シグナルは補助的な確信度として使用。
 * 
 * エントリー条件:
 *   LONG: BPR >= threshold かつ bprDelta > deltaThreshold（大口が買い方向に動いている）
 *   SHORT: BPR <= (1-threshold) かつ bprDelta < -deltaThreshold（大口が売り方向に動いている）
 * 
 * 追加条件（シナリオ別）:
 *   - シグナル一致ボーナス: 同方向のシグナルがあればロット増
 *   - アイスバーグ確認: icebergBidCount/AskCountが一定以上
 *   - 時間帯制限: 09:30以降（寄り付きの混乱を回避）
 * 
 * データ: 7/3（10秒集約データ蓄積済み）
 */

import { getDb } from "../server/db";
import { detectSignals } from "../server/routers/stockData";

// ===== シナリオ定義 =====
interface Scenario {
  name: string;
  // BPRトリガー条件
  bprLongMin: number;       // LONG: BPR >= この値
  bprShortMax: number;      // SHORT: BPR <= この値
  bprDeltaMin: number;      // |bprDelta| >= この値
  // アイスバーグ条件
  requireIceberg: boolean;  // アイスバーグ検出を要求するか
  icebergMinCount: number;  // 必要なアイスバーグカウント
  // 時間帯
  startTime: string;
  endTime: string;
  // ポジション管理
  slPct: number;
  tpPct: number;
  beTriggerPct: number;
  // 再エントリー制限
  maxTradesPerSymbol: number;
  cooldownBars: number;     // 前回エントリーからの最低間隔（分）
}

const SCENARIOS: Scenario[] = [
  {
    name: "A) 現行シグナルベース（参考）",
    bprLongMin: 0, bprShortMax: 999, bprDeltaMin: 0,
    requireIceberg: false, icebergMinCount: 0,
    startTime: "09:05", endTime: "14:50",
    slPct: 0.005, tpPct: 0.0075, beTriggerPct: 0.005,
    maxTradesPerSymbol: 99, cooldownBars: 0,
  },
  {
    name: "B) BPR≥1.2/≤0.8 + Delta≥0.05",
    bprLongMin: 1.2, bprShortMax: 0.8, bprDeltaMin: 0.05,
    requireIceberg: false, icebergMinCount: 0,
    startTime: "09:30", endTime: "14:50",
    slPct: 0.005, tpPct: 0.0075, beTriggerPct: 0.005,
    maxTradesPerSymbol: 3, cooldownBars: 10,
  },
  {
    name: "C) BPR≥1.1/≤0.9 + Delta≥0.1",
    bprLongMin: 1.1, bprShortMax: 0.9, bprDeltaMin: 0.1,
    requireIceberg: false, icebergMinCount: 0,
    startTime: "09:30", endTime: "14:50",
    slPct: 0.005, tpPct: 0.0075, beTriggerPct: 0.005,
    maxTradesPerSymbol: 3, cooldownBars: 10,
  },
  {
    name: "D) BPR≥1.1/≤0.9 + iceberg≥2",
    bprLongMin: 1.1, bprShortMax: 0.9, bprDeltaMin: 0,
    requireIceberg: true, icebergMinCount: 2,
    startTime: "09:30", endTime: "14:50",
    slPct: 0.005, tpPct: 0.0075, beTriggerPct: 0.005,
    maxTradesPerSymbol: 3, cooldownBars: 10,
  },
  {
    name: "E) BPR≥1.15/≤0.85 + Delta≥0.08 + iceberg≥1",
    bprLongMin: 1.15, bprShortMax: 0.85, bprDeltaMin: 0.08,
    requireIceberg: true, icebergMinCount: 1,
    startTime: "09:30", endTime: "14:50",
    slPct: 0.005, tpPct: 0.0075, beTriggerPct: 0.005,
    maxTradesPerSymbol: 3, cooldownBars: 10,
  },
  {
    name: "F) BPR≥1.1/≤0.9 + Delta≥0.05 (広いSL1%)",
    bprLongMin: 1.1, bprShortMax: 0.9, bprDeltaMin: 0.05,
    requireIceberg: false, icebergMinCount: 0,
    startTime: "09:30", endTime: "14:50",
    slPct: 0.01, tpPct: 0.015, beTriggerPct: 0.008,
    maxTradesPerSymbol: 3, cooldownBars: 15,
  },
  {
    name: "G) BPR≥1.05/≤0.95 + Delta≥0.15 (強い勢い)",
    bprLongMin: 1.05, bprShortMax: 0.95, bprDeltaMin: 0.15,
    requireIceberg: false, icebergMinCount: 0,
    startTime: "09:30", endTime: "14:50",
    slPct: 0.005, tpPct: 0.0075, beTriggerPct: 0.005,
    maxTradesPerSymbol: 3, cooldownBars: 10,
  },
  {
    name: "H) BPR≥1.1/≤0.9 + Delta≥0.1 + 10:00以降",
    bprLongMin: 1.1, bprShortMax: 0.9, bprDeltaMin: 0.1,
    requireIceberg: false, icebergMinCount: 0,
    startTime: "10:00", endTime: "14:50",
    slPct: 0.005, tpPct: 0.0075, beTriggerPct: 0.005,
    maxTradesPerSymbol: 3, cooldownBars: 10,
  },
];

// ===== 定数 =====
const CAPITAL_PER_TRADE = 1_000_000;
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
  trigger: string;
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
  trigger: string;
  bprAtEntry: number;
  deltaAtEntry: number;
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
  
  // シグナル検出（シナリオA用）
  const signalsBySymbol: Record<string, Map<string, any>> = {};
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
    const sigMap = new Map<string, any>();
    for (const c of detected) {
      if ((c as any).signal) sigMap.set((c as any).time, (c as any).signal);
    }
    signalsBySymbol[sym] = sigMap;
  }
  
  // ===== シミュレーション実行 =====
  const results: { name: string; trades: Trade[] }[] = [];
  
  for (const scenario of SCENARIOS) {
    const trades: Trade[] = [];
    const positions: Map<string, Position> = new Map();
    const tradeCountPerSymbol: Map<string, number> = new Map();
    const lastEntryBar: Map<string, number> = new Map();
    
    // 全銘柄を時間順にマージ
    const allCandles: CandleRow[] = [];
    for (const sym of SYMBOLS) {
      if (bySymbol[sym]) allCandles.push(...bySymbol[sym]);
    }
    allCandles.sort((a, b) => a.candleTime.localeCompare(b.candleTime));
    
    const timeSlots = [...new Set(allCandles.map(c => c.candleTime))].sort();
    let barIndex = 0;
    
    for (const time of timeSlots) {
      barIndex++;
      const candlesAtTime = allCandles.filter(c => c.candleTime === time);
      
      for (const candle of candlesAtTime) {
        const sym = candle.symbol;
        
        // 1. 既存ポジションの管理
        const pos = positions.get(sym);
        if (pos) {
          let exitPrice = 0;
          let exitReason = "";
          
          if (pos.direction === "long") {
            if (!pos.beTriggered && candle.high >= pos.entry * (1 + scenario.beTriggerPct)) {
              pos.beTriggered = true;
              pos.sl = pos.entry;
            }
            if (candle.low <= pos.sl) {
              exitPrice = pos.sl;
              exitReason = pos.beTriggered && pos.sl === pos.entry ? "BE" : "SL";
            } else if (candle.high >= pos.tp) {
              exitPrice = pos.tp;
              exitReason = "TP";
            }
          } else {
            if (!pos.beTriggered && candle.low <= pos.entry * (1 - scenario.beTriggerPct)) {
              pos.beTriggered = true;
              pos.sl = pos.entry;
            }
            if (candle.high >= pos.sl) {
              exitPrice = pos.sl;
              exitReason = pos.beTriggered && pos.sl === pos.entry ? "BE" : "SL";
            } else if (candle.low <= pos.tp) {
              exitPrice = pos.tp;
              exitReason = "TP";
            }
          }
          
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
              trigger: pos.trigger,
              bprAtEntry: 0,
              deltaAtEntry: 0,
            });
            positions.delete(sym);
          }
          continue;
        }
        
        // 2. エントリー判定
        if (positions.has(sym)) continue;
        if (time < scenario.startTime || time > scenario.endTime) continue;
        if ((tradeCountPerSymbol.get(sym) || 0) >= scenario.maxTradesPerSymbol) continue;
        
        // クールダウン
        const lastBar = lastEntryBar.get(sym) || 0;
        if (barIndex - lastBar < scenario.cooldownBars) continue;
        
        // シナリオA: 現行シグナルベース
        if (scenario.name.startsWith("A)")) {
          const sigMap = signalsBySymbol[sym];
          if (!sigMap) continue;
          const sig = sigMap.get(time);
          if (!sig) continue;
          
          const direction: "long" | "short" = sig.direction === "long" ? "long" : "short";
          const entry = candle.close;
          const shares = Math.floor(CAPITAL_PER_TRADE / entry) * 100 / 100;
          const sl = direction === "long" ? entry * (1 - scenario.slPct) : entry * (1 + scenario.slPct);
          const tp = direction === "long" ? entry * (1 + scenario.tpPct) : entry * (1 - scenario.tpPct);
          
          positions.set(sym, {
            symbol: sym, direction, entry, sl, tp, shares,
            entryTime: time, beTriggered: false,
            trigger: `signal:${sig.type || sig.name}`,
          });
          tradeCountPerSymbol.set(sym, (tradeCountPerSymbol.get(sym) || 0) + 1);
          lastEntryBar.set(sym, barIndex);
          continue;
        }
        
        // シナリオB〜H: BPRベース大口追従
        const board = candle.boardSnapshot;
        if (!board) continue;
        
        const avgBpr = board.avgBprIn10s ?? board.buyPressureRatio ?? 0.5;
        const bprDelta = board.bprDeltaIn10s ?? 0;
        const icebergBid = board.icebergBidCount ?? (board.icebergBidDetected ? 1 : 0);
        const icebergAsk = board.icebergAskCount ?? (board.icebergAskDetected ? 1 : 0);
        
        let direction: "long" | "short" | null = null;
        let trigger = "";
        
        // LONG条件
        if (avgBpr >= scenario.bprLongMin && bprDelta >= scenario.bprDeltaMin) {
          if (!scenario.requireIceberg || icebergBid >= scenario.icebergMinCount) {
            direction = "long";
            trigger = `BPR:${avgBpr.toFixed(2)} Δ:${bprDelta.toFixed(3)} ice:${icebergBid}`;
          }
        }
        // SHORT条件
        else if (avgBpr <= scenario.bprShortMax && bprDelta <= -scenario.bprDeltaMin) {
          if (!scenario.requireIceberg || icebergAsk >= scenario.icebergMinCount) {
            direction = "short";
            trigger = `BPR:${avgBpr.toFixed(2)} Δ:${bprDelta.toFixed(3)} ice:${icebergAsk}`;
          }
        }
        
        if (!direction) continue;
        
        const entry = candle.close;
        const shares = Math.floor(CAPITAL_PER_TRADE / entry) * 100 / 100;
        const sl = direction === "long" ? entry * (1 - scenario.slPct) : entry * (1 + scenario.slPct);
        const tp = direction === "long" ? entry * (1 + scenario.tpPct) : entry * (1 - scenario.tpPct);
        
        positions.set(sym, {
          symbol: sym, direction, entry, sl, tp, shares,
          entryTime: time, beTriggered: false, trigger,
        });
        tradeCountPerSymbol.set(sym, (tradeCountPerSymbol.get(sym) || 0) + 1);
        lastEntryBar.set(sym, barIndex);
      }
    }
    
    results.push({ name: scenario.name, trades });
  }
  
  // ===== 結果出力 =====
  console.log("\n" + "=".repeat(110));
  console.log("大口追従型エントリー戦略 シミュレーション結果（7/3）");
  console.log("=".repeat(110));
  
  console.log("\n順位 | パターン                                    | 損益        | 取引 | 勝率  | PF    | SL | TP | BE | EOD");
  console.log("-".repeat(130));
  
  const sorted = [...results].sort((a, b) => {
    const pnlA = a.trades.reduce((s, t) => s + t.pnl, 0);
    const pnlB = b.trades.reduce((s, t) => s + t.pnl, 0);
    return pnlB - pnlA;
  });
  
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const pnl = r.trades.reduce((s, t) => s + t.pnl, 0);
    const wins = r.trades.filter(t => t.pnl > 0).length;
    const losses = r.trades.filter(t => t.pnl < 0).length;
    const winRate = r.trades.length > 0 ? (wins / r.trades.length * 100).toFixed(1) : "0.0";
    const grossProfit = r.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(r.trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
    const sl = r.trades.filter(t => t.reason === "SL").length;
    const tp = r.trades.filter(t => t.reason === "TP").length;
    const be = r.trades.filter(t => t.reason === "BE").length;
    const eod = r.trades.filter(t => t.reason === "EOD").length;
    console.log(`  ${(i+1).toString().padStart(2)} | ${r.name.padEnd(43)} | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString().padStart(10)}円 | ${r.trades.length.toString().padStart(3)}件 | ${winRate.padStart(5)}% | ${pf.padStart(5)} | ${sl.toString().padStart(2)} | ${tp.toString().padStart(2)} | ${be.toString().padStart(2)} | ${eod.toString().padStart(2)}`);
  }
  
  // 上位3パターンの取引詳細
  console.log("\n" + "=".repeat(110));
  console.log("上位パターン 取引詳細");
  console.log("=".repeat(110));
  
  for (let i = 0; i < Math.min(4, sorted.length); i++) {
    const r = sorted[i];
    console.log(`\n--- ${r.name} (${r.trades.length}件, ${r.trades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}円) ---`);
    for (const t of r.trades.slice(0, 20)) {
      const pnlStr = t.pnl >= 0 ? `+${t.pnl.toLocaleString()}` : t.pnl.toLocaleString();
      console.log(`  ${t.entryTime}→${t.exitTime} ${t.symbol} ${t.direction.toUpperCase().padEnd(5)} @${t.entry.toLocaleString()}→${t.exit.toLocaleString()} ${pnlStr.padStart(10)}円 [${t.reason}] (${t.trigger})`);
    }
    if (r.trades.length > 20) console.log(`  ... 他${r.trades.length - 20}件`);
  }
  
  // BPRトリガーの統計
  console.log("\n" + "=".repeat(110));
  console.log("BPRトリガー発生統計（シナリオC: BPR≥1.1/≤0.9 + Delta≥0.1）");
  console.log("=".repeat(110));
  
  for (const sym of SYMBOLS) {
    if (!bySymbol[sym]) continue;
    let longTriggers = 0, shortTriggers = 0;
    for (const c of bySymbol[sym]) {
      if (c.candleTime < "09:30" || c.candleTime > "14:50") continue;
      const b = c.boardSnapshot;
      if (!b) continue;
      const avgBpr = b.avgBprIn10s ?? b.buyPressureRatio ?? 0.5;
      const bprDelta = b.bprDeltaIn10s ?? 0;
      if (avgBpr >= 1.1 && bprDelta >= 0.1) longTriggers++;
      if (avgBpr <= 0.9 && bprDelta <= -0.1) shortTriggers++;
    }
    console.log(`  ${sym}: LONGトリガー ${longTriggers}回, SHORTトリガー ${shortTriggers}回`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
