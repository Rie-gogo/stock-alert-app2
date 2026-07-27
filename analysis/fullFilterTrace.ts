/**
 * 全フィルターブロック追跡シミュレーション (7/17-7/24)
 * 
 * 目的: 各フィルターが何件のシグナルをブロックしているかを正確に計測し、
 *       取引数激減の主因を特定する
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

// --- Constants from realtimeSimEngine.ts ---
const IS_BULLISH_SLOPE_THRESHOLD = -0.03;
const IS_BULLISH_MA_PERIOD = 20;
const IS_BULLISH_FALLBACK_THRESHOLD = 0.2;
const ROUND_DISTANCE_BLOCK_THRESHOLD_PCT = 0.8;
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:20";
const ROUND_LEVEL_CONFIRM_BARS = 5;
const ROUND_PULLBACK_MAX_WAIT = 5;
const HTF_TIMEFRAME_MINUTES = 3;
const PULLBACK_DEPTH_LOOKBACK = 20;
const PULLBACK_DEPTH_MIN = 0.30;
const PULLBACK_DEPTH_MAX = 0.70;

interface Candle {
  symbol: string;
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Simplified round level detection
function detectRoundLevel(candle: Candle, prevCandle: Candle | null): { type: "break_above" | "break_below"; level: number } | null {
  if (!prevCandle) return null;
  const price = candle.close;
  const prevPrice = prevCandle.close;
  
  // Determine step based on price level
  let step: number;
  if (price >= 50000) step = 500;
  else if (price >= 10000) step = 100;
  else if (price >= 5000) step = 50;
  else if (price >= 1000) step = 10;
  else step = 5;
  
  // Check if price crossed a round level
  const prevLevel = Math.floor(prevPrice / step) * step;
  const currLevel = Math.floor(price / step) * step;
  
  if (currLevel < prevLevel) {
    // Break below
    return { type: "break_below", level: prevLevel };
  }
  if (currLevel > prevLevel) {
    // Break above
    return { type: "break_above", level: currLevel };
  }
  return null;
}

// Simplified signal detection (covers main signal types)
function detectSignals(buffer: Candle[], idx: number): Array<{ type: "buy" | "sell"; reason: string; confidence: "strong" | "medium"; signalType: string }> {
  const signals: Array<{ type: "buy" | "sell"; reason: string; confidence: "strong" | "medium"; signalType: string }> = [];
  if (idx < 1) return signals;
  
  const candle = buffer[idx];
  const prev = buffer[idx - 1];
  
  // 1. Round level detection
  const rl = detectRoundLevel(candle, prev);
  if (rl) {
    if (rl.type === "break_below") {
      // Determine confidence based on volume and trend
      const recentVols = buffer.slice(Math.max(0, idx - 10), idx).map(c => c.volume);
      const avgVol = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0;
      const confidence = candle.volume > avgVol * 1.2 ? "strong" : "medium";
      signals.push({ type: "sell", reason: `大台割れ (${rl.level}円割り込み)`, confidence, signalType: "大台割れ" });
    } else {
      const recentVols = buffer.slice(Math.max(0, idx - 10), idx).map(c => c.volume);
      const avgVol = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0;
      const confidence = candle.volume > avgVol * 1.2 ? "strong" : "medium";
      signals.push({ type: "buy", reason: `大台超え (${rl.level}円突破)`, confidence, signalType: "大台超え" });
    }
  }
  
  // 2. VWAP cross (simplified)
  if (idx >= 20) {
    const vwapWindow = buffer.slice(0, idx + 1);
    let cumVol = 0, cumTP = 0;
    for (const c of vwapWindow) {
      const tp = (c.high + c.low + c.close) / 3;
      cumVol += c.volume;
      cumTP += tp * c.volume;
    }
    const vwap = cumVol > 0 ? cumTP / cumVol : candle.close;
    
    if (prev.close > vwap && candle.close < vwap) {
      signals.push({ type: "sell", reason: `VWAPクロス下抜け`, confidence: "strong", signalType: "VWAPクロス" });
    }
    if (prev.close < vwap && candle.close > vwap) {
      signals.push({ type: "buy", reason: `VWAP反発`, confidence: "strong", signalType: "VWAP反発" });
    }
  }
  
  // 3. Dow theory (simplified - new low/high)
  if (idx >= 20) {
    const lookback = buffer.slice(Math.max(0, idx - 20), idx);
    const recentLow = Math.min(...lookback.map(c => c.low));
    const recentHigh = Math.max(...lookback.map(c => c.high));
    
    if (candle.close < recentLow && prev.close >= recentLow) {
      signals.push({ type: "sell", reason: `ダウ理論: 直近安値更新`, confidence: "strong", signalType: "ダウ理論" });
    }
    if (candle.close > recentHigh && prev.close <= recentHigh) {
      signals.push({ type: "buy", reason: `ダウ理論: 直近高値更新`, confidence: "strong", signalType: "ダウ理論" });
    }
  }
  
  return signals;
}

// isBullish calculation (MA20 slope method)
function calcIsBullish(buffer: Candle[], idx: number): boolean {
  if (idx < IS_BULLISH_MA_PERIOD) {
    // Fallback: open-based
    const openPrice = buffer[0].open;
    const priceChangeRatio = (buffer[idx].close - openPrice) / openPrice * 100;
    return priceChangeRatio >= IS_BULLISH_FALLBACK_THRESHOLD;
  }
  
  const maWindow = buffer.slice(idx - IS_BULLISH_MA_PERIOD + 1, idx + 1);
  const ma = maWindow.reduce((s, c) => s + c.close, 0) / maWindow.length;
  const prevMaWindow = buffer.slice(idx - IS_BULLISH_MA_PERIOD, idx);
  const prevMa = prevMaWindow.reduce((s, c) => s + c.close, 0) / prevMaWindow.length;
  const slope = ((ma - prevMa) / prevMa) * 100;
  return slope > IS_BULLISH_SLOPE_THRESHOLD;
}

// HTF trend (simplified)
function getHigherTfTrend(buffer: Candle[], idx: number): "up" | "down" | "neutral" {
  const htfBars = Math.floor((idx + 1) / HTF_TIMEFRAME_MINUTES);
  if (htfBars < 25) return "neutral";
  
  // Simple: check if 3-min MA is rising or falling
  const recentClose = buffer[idx].close;
  const pastClose = buffer[Math.max(0, idx - 15)].close;
  const change = (recentClose - pastClose) / pastClose * 100;
  if (change > 0.3) return "up";
  if (change < -0.3) return "down";
  return "neutral";
}

// Round distance calculation
function calcRoundDistance(price: number, level: number): number {
  return Math.abs(price - level) / level * 100;
}

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL || "", connectionLimit: 3 });
  const db = drizzle(pool);
  
  // Get all candle data for 7/17-7/24
  const [rows] = await db.execute(
    sql`SELECT symbol, tradeDate, candleTime, open, high, low, close, volume 
        FROM rt_candles 
        WHERE tradeDate >= '2026-07-17' AND tradeDate <= '2026-07-24'
        ORDER BY symbol, tradeDate, candleTime`
  );
  
  const candles = (rows as any[]).map(r => ({
    symbol: r.symbol,
    tradeDate: r.tradeDate,
    candleTime: r.candleTime,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
  
  console.log(`データ読み込み: ${candles.length}本`);
  
  // Group by symbol+date
  const grouped: Map<string, Candle[]> = new Map();
  for (const c of candles) {
    const key = `${c.symbol}_${c.tradeDate}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(c);
  }
  
  // Track blocks by filter type
  interface BlockRecord {
    filter: string;
    symbol: string;
    date: string;
    time: string;
    signalType: string;
    side: string;
    price: number;
    level?: number;
    confidence: string;
  }
  
  const blockRecords: BlockRecord[] = [];
  const entryRecords: Array<{ symbol: string; date: string; time: string; side: string; price: number; signalType: string }> = [];
  
  for (const [key, buffer] of grouped) {
    const [symbol, date] = key.split("_");
    
    // Track pending round level states
    let pendingRound: { direction: "buy" | "sell"; level: number; confirmCount: number; pullbackWait: number; reason: string } | null = null;
    let inPosition = false;
    
    for (let i = 1; i < buffer.length; i++) {
      const candle = buffer[i];
      const candleTime = candle.candleTime;
      
      // Skip outside trading hours
      if (candleTime < NO_ENTRY_BEFORE || candleTime > NO_ENTRY_AFTER) continue;
      if (inPosition) continue; // Simplified: skip if already in position
      
      // Process pending round level confirmation
      if (pendingRound) {
        pendingRound.confirmCount++;
        
        // Check if price reverted
        if (pendingRound.direction === "sell" && candle.close > pendingRound.level) {
          pendingRound = null;
        } else if (pendingRound.direction === "buy" && candle.close < pendingRound.level) {
          pendingRound = null;
        } else if (pendingRound.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) {
          // Confirmed! Now check pullback or direct entry
          // Check round distance filter
          const dist = calcRoundDistance(candle.close, pendingRound.level);
          if (dist > ROUND_DISTANCE_BLOCK_THRESHOLD_PCT) {
            blockRecords.push({
              filter: "大台乖離率フィルター",
              symbol, date, time: candleTime,
              signalType: pendingRound.direction === "sell" ? "大台割れ" : "大台超え",
              side: pendingRound.direction === "sell" ? "SHORT" : "LONG",
              price: candle.close,
              level: pendingRound.level,
              confidence: "strong",
            });
            pendingRound = null;
          } else {
            // Entry!
            entryRecords.push({
              symbol, date, time: candleTime,
              side: pendingRound.direction === "sell" ? "SHORT" : "LONG",
              price: candle.close,
              signalType: pendingRound.direction === "sell" ? "大台割れ" : "大台超え",
            });
            inPosition = true;
            pendingRound = null;
          }
        }
        continue;
      }
      
      // Detect signals
      const signals = detectSignals(buffer, i);
      if (signals.length === 0) continue;
      
      // Process first signal only (priority)
      const sig = signals[0];
      const isBullish = calcIsBullish(buffer, i);
      
      if (sig.type === "buy") {
        // BUY filters
        if (sig.confidence === "medium") {
          blockRecords.push({
            filter: "BUY medium全ブロック",
            symbol, date, time: candleTime,
            signalType: sig.signalType,
            side: "LONG",
            price: candle.close,
            confidence: "medium",
          });
          continue;
        }
        
        if (sig.signalType === "大台超え") {
          // Start confirmation state machine
          const price = candle.close;
          let step: number;
          if (price >= 50000) step = 500;
          else if (price >= 10000) step = 100;
          else if (price >= 5000) step = 50;
          else if (price >= 1000) step = 10;
          else step = 5;
          const level = Math.floor(price / step) * step;
          pendingRound = { direction: "buy", level, confirmCount: 0, pullbackWait: 0, reason: sig.reason };
          continue;
        }
        
        // Direct BUY entry
        entryRecords.push({
          symbol, date, time: candleTime,
          side: "LONG",
          price: candle.close,
          signalType: sig.signalType,
        });
        inPosition = true;
        
      } else {
        // SELL filters
        
        // isBullish check
        if (isBullish) {
          blockRecords.push({
            filter: "isBullish方式",
            symbol, date, time: candleTime,
            signalType: sig.signalType,
            side: "SHORT",
            price: candle.close,
            confidence: sig.confidence,
          });
          continue;
        }
        
        // HTF filter
        const htf = getHigherTfTrend(buffer, i);
        if (htf === "up") {
          blockRecords.push({
            filter: "HTFフィルター",
            symbol, date, time: candleTime,
            signalType: sig.signalType,
            side: "SHORT",
            price: candle.close,
            confidence: sig.confidence,
          });
          continue;
        }
        
        // Pullback depth filter (for ダウ理論 only)
        if (sig.signalType === "ダウ理論" && i >= PULLBACK_DEPTH_LOOKBACK) {
          const lookback = buffer.slice(i - PULLBACK_DEPTH_LOOKBACK, i);
          const swingHigh = Math.max(...lookback.map(c => c.high));
          const swingLow = Math.min(...lookback.map(c => c.low));
          if (swingHigh > swingLow) {
            const depth = (candle.close - swingLow) / (swingHigh - swingLow);
            if (depth < PULLBACK_DEPTH_MIN || depth > PULLBACK_DEPTH_MAX) {
              blockRecords.push({
                filter: "押し目深さフィルター",
                symbol, date, time: candleTime,
                signalType: sig.signalType,
                side: "SHORT",
                price: candle.close,
                confidence: sig.confidence,
              });
              continue;
            }
          }
        }
        
        // Medium block
        if (sig.confidence === "medium") {
          blockRecords.push({
            filter: "SHORT medium全ブロック",
            symbol, date, time: candleTime,
            signalType: sig.signalType,
            side: "SHORT",
            price: candle.close,
            confidence: "medium",
          });
          continue;
        }
        
        if (sig.signalType === "大台割れ") {
          // Start confirmation state machine
          const price = candle.close;
          let step: number;
          if (price >= 50000) step = 500;
          else if (price >= 10000) step = 100;
          else if (price >= 5000) step = 50;
          else if (price >= 1000) step = 10;
          else step = 5;
          const level = Math.floor(price / step) * step + step; // The level that was broken
          pendingRound = { direction: "sell", level, confirmCount: 0, pullbackWait: 0, reason: sig.reason };
          continue;
        }
        
        // Direct SHORT entry
        entryRecords.push({
          symbol, date, time: candleTime,
          side: "SHORT",
          price: candle.close,
          signalType: sig.signalType,
        });
        inPosition = true;
      }
    }
  }
  
  // === Output Results ===
  console.log("\n=== フィルター別ブロック数（7/17-7/24 全銘柄） ===");
  const filterCounts: Record<string, number> = {};
  for (const b of blockRecords) {
    filterCounts[b.filter] = (filterCounts[b.filter] || 0) + 1;
  }
  const sorted = Object.entries(filterCounts).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) {
    console.log(`  ${k}: ${v}件`);
  }
  console.log(`  合計ブロック: ${blockRecords.length}件`);
  console.log(`  エントリー: ${entryRecords.length}件`);
  
  // By date
  console.log("\n=== 日別ブロック内訳 ===");
  const dateBlocks: Record<string, Record<string, number>> = {};
  for (const b of blockRecords) {
    if (!dateBlocks[b.date]) dateBlocks[b.date] = {};
    dateBlocks[b.date][b.filter] = (dateBlocks[b.date][b.filter] || 0) + 1;
  }
  const dateEntries: Record<string, number> = {};
  for (const e of entryRecords) {
    dateEntries[e.date] = (dateEntries[e.date] || 0) + 1;
  }
  
  console.log("| 日付 | エントリー | isBullish | medium(BUY) | medium(SHORT) | 大台乖離率 | HTF | 押し目深さ | 合計ブロック |");
  console.log("|------|-----------|-----------|-------------|---------------|-----------|-----|-----------|------------|");
  const dates = [...new Set([...Object.keys(dateBlocks), ...Object.keys(dateEntries)])].sort();
  for (const d of dates) {
    const db2 = dateBlocks[d] || {};
    const entry = dateEntries[d] || 0;
    const isBull = db2["isBullish方式"] || 0;
    const medBuy = db2["BUY medium全ブロック"] || 0;
    const medShort = db2["SHORT medium全ブロック"] || 0;
    const roundDist = db2["大台乖離率フィルター"] || 0;
    const htf = db2["HTFフィルター"] || 0;
    const pullback = db2["押し目深さフィルター"] || 0;
    const total = Object.values(db2).reduce((a, b) => a + b, 0);
    console.log(`| ${d} | ${entry} | ${isBull} | ${medBuy} | ${medShort} | ${roundDist} | ${htf} | ${pullback} | ${total} |`);
  }
  
  // By symbol
  console.log("\n=== 銘柄別ブロック内訳 ===");
  const symBlocks: Record<string, Record<string, number>> = {};
  for (const b of blockRecords) {
    if (!symBlocks[b.symbol]) symBlocks[b.symbol] = {};
    symBlocks[b.symbol][b.filter] = (symBlocks[b.symbol][b.filter] || 0) + 1;
  }
  const symEntries: Record<string, number> = {};
  for (const e of entryRecords) {
    symEntries[e.symbol] = (symEntries[e.symbol] || 0) + 1;
  }
  
  console.log("| 銘柄 | エントリー | isBullish | medium(BUY) | medium(SHORT) | 大台乖離率 | HTF | 押し目深さ |");
  console.log("|------|-----------|-----------|-------------|---------------|-----------|-----|-----------|");
  const symbols = [...new Set([...Object.keys(symBlocks), ...Object.keys(symEntries)])].sort();
  for (const s of symbols) {
    const sb = symBlocks[s] || {};
    const entry = symEntries[s] || 0;
    console.log(`| ${s} | ${entry} | ${sb["isBullish方式"] || 0} | ${sb["BUY medium全ブロック"] || 0} | ${sb["SHORT medium全ブロック"] || 0} | ${sb["大台乖離率フィルター"] || 0} | ${sb["HTFフィルター"] || 0} | ${sb["押し目深さフィルター"] || 0} |`);
  }
  
  // Signal type breakdown for 大台乖離率
  console.log("\n=== 大台乖離率フィルターの詳細 ===");
  const roundBlocks = blockRecords.filter(b => b.filter === "大台乖離率フィルター");
  console.log(`  合計: ${roundBlocks.length}件`);
  console.log(`  LONG: ${roundBlocks.filter(b => b.side === "LONG").length}件`);
  console.log(`  SHORT: ${roundBlocks.filter(b => b.side === "SHORT").length}件`);
  
  // Distance distribution
  const distances = roundBlocks.filter(b => b.level).map(b => calcRoundDistance(b.price, b.level!));
  if (distances.length > 0) {
    const ranges = [
      { min: 0.8, max: 1.0, label: "0.8-1.0%" },
      { min: 1.0, max: 1.5, label: "1.0-1.5%" },
      { min: 1.5, max: 2.0, label: "1.5-2.0%" },
      { min: 2.0, max: 100, label: "2.0%+" },
    ];
    console.log("  乖離率分布:");
    for (const r of ranges) {
      const count = distances.filter(d => d >= r.min && d < r.max).length;
      console.log(`    ${r.label}: ${count}件`);
    }
  }
  
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
