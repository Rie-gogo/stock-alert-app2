import { getDb } from "../server/db";
import { rtCandles, rtTrades } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";

interface BoardSnapshot {
  bpr?: number;
  buyPressureRatio?: number;
  sellPressureRatio?: number;
  largeOrderBias?: number;
  marketOrderRatio?: number;
}

async function main() {
  const db = await getDb();
  const today = "2026-07-01";
  
  // Get all trades for today
  const trades = await db.select().from(rtTrades).where(eq(rtTrades.tradeDate, today));
  const sorted = [...trades].sort((a, b) => (a.tradeTime || "").localeCompare(b.tradeTime || ""));
  
  // Get PM SHORT entries
  const pmShortEntries = sorted.filter(t => {
    if (t.pnl !== null) return false;
    if (t.action !== "short") return false;
    const h = parseInt((t.tradeTime || "09:00").split(":")[0]);
    return h >= 13;
  });
  
  console.log("=== 後場SHORTエントリーのBPR確認 ===\n");
  
  // For each PM SHORT entry, find the candle at that time and check BPR
  for (const entry of pmShortEntries) {
    // Get candles for this symbol on this date around entry time
    const candles = await db.select().from(rtCandles).where(
      and(
        eq(rtCandles.symbol, entry.symbol),
        eq(rtCandles.tradeDate, today)
      )
    );
    
    // Find candle at or just before entry time
    const entryTime = entry.tradeTime || "13:00";
    const relevantCandles = candles
      .filter(c => (c.candleTime || "") <= entryTime)
      .sort((a, b) => (b.candleTime || "").localeCompare(a.candleTime || ""));
    
    const nearestCandle = relevantCandles[0];
    const bs = nearestCandle?.boardSnapshot as BoardSnapshot | null;
    const bpr = bs?.bpr ?? bs?.buyPressureRatio ?? null;
    
    // Find the corresponding exit
    const exitTrade = sorted.find(t => 
      t.symbol === entry.symbol && 
      t.pnl !== null && 
      (t.tradeTime || "") > entryTime
    );
    
    const pnl = exitTrade ? Number(exitTrade.pnl || 0) : 0;
    const exitReason = exitTrade?.reason?.includes("利確") ? "TP" :
                       exitTrade?.reason?.includes("損切り") ? "SL" :
                       exitTrade?.reason?.includes("BE") ? "BE" :
                       exitTrade?.reason?.includes("大引け") ? "EOD" : "OTH";
    
    const blocked = bpr !== null && bpr >= 0.65;
    
    console.log(`${entry.tradeTime} | ${entry.symbol} ${(entry.symbolName || "").padEnd(14)} | BPR: ${bpr !== null ? bpr.toFixed(3) : "N/A"} | ${blocked ? "★ブロック" : "  許可"} | ${exitReason} | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円`);
    console.log(`  シグナル: ${(entry.reason || "").split("｜")[0]}`);
    console.log("");
  }
  
  // Simulate Pattern C
  console.log("\n=== パターンC適用シミュレーション ===\n");
  
  // Reconstruct all trade pairs
  interface Pair {
    entry: typeof trades[0];
    exit: typeof trades[0];
    pnl: number;
    side: string;
  }
  
  const pairs: Pair[] = [];
  const openPositions = new Map<string, typeof trades[0]>();
  
  for (const t of sorted) {
    const isEntry = t.pnl === null && (t.action === "buy" || t.action === "short");
    if (isEntry) {
      openPositions.set(t.symbol, t);
    } else if (t.pnl !== null || t.action === "cover") {
      const entry = openPositions.get(t.symbol);
      if (entry) {
        pairs.push({
          entry,
          exit: t,
          pnl: Number(t.pnl || 0),
          side: entry.action === "short" ? "SHORT" : "LONG"
        });
        openPositions.delete(t.symbol);
      }
    }
  }
  
  // Check which PM SHORT pairs would be blocked by BPR >= 0.65
  const blockedPairs: Pair[] = [];
  const allowedPairs: Pair[] = [];
  
  for (const p of pairs) {
    const h = parseInt((p.entry.tradeTime || "09:00").split(":")[0]);
    if (p.side === "SHORT" && h >= 13) {
      // Get BPR for this entry
      const candles = await db.select().from(rtCandles).where(
        and(
          eq(rtCandles.symbol, p.entry.symbol),
          eq(rtCandles.tradeDate, today)
        )
      );
      
      const entryTime = p.entry.tradeTime || "13:00";
      const relevantCandles = candles
        .filter(c => (c.candleTime || "") <= entryTime)
        .sort((a, b) => (b.candleTime || "").localeCompare(a.candleTime || ""));
      
      const nearestCandle = relevantCandles[0];
      const bs = nearestCandle?.boardSnapshot as BoardSnapshot | null;
      const bpr = bs?.bpr ?? bs?.buyPressureRatio ?? null;
      
      if (bpr !== null && bpr >= 0.65) {
        blockedPairs.push(p);
      } else {
        allowedPairs.push(p);
      }
    } else {
      allowedPairs.push(p);
    }
  }
  
  // Calculate results
  const currentTotal = pairs.reduce((s, p) => s + p.pnl, 0);
  const patternCTotal = allowedPairs.reduce((s, p) => s + p.pnl, 0);
  const blockedTotal = blockedPairs.reduce((s, p) => s + p.pnl, 0);
  
  console.log("【現行（実際の結果）】");
  console.log(`  取引数: ${pairs.length}件`);
  console.log(`  勝ち: ${pairs.filter(p => p.pnl > 0).length}件`);
  console.log(`  負け: ${pairs.filter(p => p.pnl < 0).length}件`);
  console.log(`  引分: ${pairs.filter(p => p.pnl === 0).length}件`);
  console.log(`  総損益: ${currentTotal >= 0 ? "+" : ""}${currentTotal.toLocaleString()}円`);
  
  console.log("\n【パターンC適用（後場全SHORT BPR>=0.65ブロック）】");
  console.log(`  取引数: ${allowedPairs.length}件`);
  console.log(`  勝ち: ${allowedPairs.filter(p => p.pnl > 0).length}件`);
  console.log(`  負け: ${allowedPairs.filter(p => p.pnl < 0).length}件`);
  console.log(`  引分: ${allowedPairs.filter(p => p.pnl === 0).length}件`);
  console.log(`  総損益: ${patternCTotal >= 0 ? "+" : ""}${patternCTotal.toLocaleString()}円`);
  
  console.log("\n【ブロックされた取引】");
  console.log(`  件数: ${blockedPairs.length}件`);
  console.log(`  損益合計: ${blockedTotal >= 0 ? "+" : ""}${blockedTotal.toLocaleString()}円`);
  if (blockedPairs.length > 0) {
    console.log("  詳細:");
    for (const p of blockedPairs) {
      const exitReason = (p.exit.reason || "").includes("利確") ? "TP" :
                         (p.exit.reason || "").includes("損切り") ? "SL" :
                         (p.exit.reason || "").includes("BE") ? "BE" :
                         (p.exit.reason || "").includes("大引け") ? "EOD" : "OTH";
      console.log(`    ${p.entry.tradeTime} | ${p.entry.symbol} ${p.entry.symbolName} | ${exitReason} | ${p.pnl >= 0 ? "+" : ""}${p.pnl.toLocaleString()}円`);
    }
  }
  
  console.log("\n【差分】");
  const diff = patternCTotal - currentTotal;
  console.log(`  パターンC - 現行 = ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円`);
  if (diff > 0) {
    console.log(`  → パターンCの方が有利（損失回避効果あり）`);
  } else if (diff < 0) {
    console.log(`  → 現行の方が有利（ブロックにより利益を逸失）`);
  } else {
    console.log(`  → 差なし（BPR>=0.65の後場SHORTなし）`);
  }
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
