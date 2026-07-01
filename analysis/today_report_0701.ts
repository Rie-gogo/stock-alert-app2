import { getDb } from "../server/db";
import { rtTrades } from "../drizzle/schema";
import { eq } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const today = "2026-07-01";
  
  const trades = await db.select().from(rtTrades).where(eq(rtTrades.tradeDate, today));
  
  // Sort by time
  const sorted = [...trades].sort((a, b) => (a.tradeTime || "").localeCompare(b.tradeTime || ""));
  
  // Pair entries and exits by tracking open positions
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
  
  // Print all trade pairs
  console.log("=== 本日(7/1)の全取引ペア ===");
  console.log("時刻        | 方向  | 銘柄              | エントリー→エグジット | 決済 | 損益        | シグナル");
  console.log("-".repeat(120));
  
  for (const p of pairs) {
    const exitReason = (p.exit.reason || "").includes("利確") ? "TP" :
                       (p.exit.reason || "").includes("損切り") ? "SL" :
                       (p.exit.reason || "").includes("BE") ? "BE" :
                       (p.exit.reason || "").includes("大引け") ? "EOD" : "OTH";
    const entryReason = (p.entry.reason || "").split("｜")[0].substring(0, 50);
    console.log(`${p.entry.tradeTime}-${p.exit.tradeTime} | ${p.side.padEnd(5)} | ${p.entry.symbol} ${(p.entry.symbolName || "").padEnd(14)} | ${Number(p.entry.price).toFixed(0)}→${Number(p.exit.price).toFixed(0)} | ${exitReason.padEnd(3)} | ${(p.pnl >= 0 ? "+" : "") + p.pnl.toLocaleString() + "円"} | ${entryReason}`);
  }
  
  // Summary
  console.log("\n=== サマリー ===");
  const wins = pairs.filter(p => p.pnl > 0);
  const losses = pairs.filter(p => p.pnl < 0);
  const bes = pairs.filter(p => p.pnl === 0);
  const totalPnl = pairs.reduce((s, p) => s + p.pnl, 0);
  
  console.log(`完了取引: ${pairs.length}件`);
  console.log(`勝ち: ${wins.length}件 (+${wins.reduce((s, p) => s + p.pnl, 0).toLocaleString()}円)`);
  console.log(`負け: ${losses.length}件 (${losses.reduce((s, p) => s + p.pnl, 0).toLocaleString()}円)`);
  console.log(`引分(BE): ${bes.length}件`);
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`勝率: ${pairs.length > 0 ? (wins.length / pairs.length * 100).toFixed(1) : 0}%`);
  if (wins.length > 0) console.log(`平均利益: +${Math.round(wins.reduce((s, p) => s + p.pnl, 0) / wins.length).toLocaleString()}円`);
  if (losses.length > 0) console.log(`平均損失: ${Math.round(losses.reduce((s, p) => s + p.pnl, 0) / losses.length).toLocaleString()}円`);
  
  // LONG/SHORT
  console.log("\n=== LONG/SHORT別 ===");
  const longs = pairs.filter(p => p.side === "LONG");
  const shorts = pairs.filter(p => p.side === "SHORT");
  const longPnl = longs.reduce((s, p) => s + p.pnl, 0);
  const shortPnl = shorts.reduce((s, p) => s + p.pnl, 0);
  console.log(`LONG:  ${longs.length}件, 勝${longs.filter(p => p.pnl > 0).length}/負${longs.filter(p => p.pnl < 0).length}/引分${longs.filter(p => p.pnl === 0).length}, 損益: ${longPnl >= 0 ? "+" : ""}${longPnl.toLocaleString()}円`);
  console.log(`SHORT: ${shorts.length}件, 勝${shorts.filter(p => p.pnl > 0).length}/負${shorts.filter(p => p.pnl < 0).length}/引分${shorts.filter(p => p.pnl === 0).length}, 損益: ${shortPnl >= 0 ? "+" : ""}${shortPnl.toLocaleString()}円`);
  
  // By symbol
  console.log("\n=== 銘柄別 ===");
  const symMap = new Map<string, Pair[]>();
  for (const p of pairs) {
    const key = `${p.entry.symbol} ${p.entry.symbolName}`;
    if (!symMap.has(key)) symMap.set(key, []);
    symMap.get(key)!.push(p);
  }
  const symEntries = [...symMap.entries()].sort((a, b) => {
    const pnlA = a[1].reduce((s, p) => s + p.pnl, 0);
    const pnlB = b[1].reduce((s, p) => s + p.pnl, 0);
    return pnlB - pnlA;
  });
  for (const [sym, symPairs] of symEntries) {
    const pnl = symPairs.reduce((s, p) => s + p.pnl, 0);
    const w = symPairs.filter(p => p.pnl > 0).length;
    const l = symPairs.filter(p => p.pnl < 0).length;
    console.log(`  ${sym.padEnd(22)}: ${symPairs.length}件 (勝${w}/負${l}/引分${symPairs.length - w - l}), 損益: ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円`);
  }
  
  // Exit reason
  console.log("\n=== エグジット理由別 ===");
  const exitMap = new Map<string, Pair[]>();
  for (const p of pairs) {
    const reason = (p.exit.reason || "").includes("利確") ? "TP(利確)" :
                   (p.exit.reason || "").includes("損切り") ? "SL(損切り)" :
                   (p.exit.reason || "").includes("BE") ? "BE(建値)" :
                   (p.exit.reason || "").includes("大引け") ? "EOD(大引け)" : "OTHER";
    if (!exitMap.has(reason)) exitMap.set(reason, []);
    exitMap.get(reason)!.push(p);
  }
  for (const [reason, rPairs] of exitMap) {
    const pnl = rPairs.reduce((s, p) => s + p.pnl, 0);
    console.log(`  ${reason.padEnd(12)}: ${rPairs.length}件, 損益: ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円`);
  }
  
  // Signal type analysis
  console.log("\n=== シグナル種別 ===");
  const sigMap = new Map<string, Pair[]>();
  for (const p of pairs) {
    const reason = (p.entry.reason || "").split("｜")[0].replace(/\(.*?\)/g, "").trim();
    if (!sigMap.has(reason)) sigMap.set(reason, []);
    sigMap.get(reason)!.push(p);
  }
  for (const [sig, sPairs] of [...sigMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const pnl = sPairs.reduce((s, p) => s + p.pnl, 0);
    const w = sPairs.filter(p => p.pnl > 0).length;
    console.log(`  ${sig.substring(0, 45).padEnd(45)}: ${sPairs.length}件, 勝${w}件, 損益: ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円`);
  }
  
  // Session (AM/PM)
  console.log("\n=== 前場/後場別 ===");
  const amPairs = pairs.filter(p => {
    const h = parseInt((p.entry.tradeTime || "09:00").split(":")[0]);
    return h < 12;
  });
  const pmPairs = pairs.filter(p => {
    const h = parseInt((p.entry.tradeTime || "09:00").split(":")[0]);
    return h >= 12;
  });
  const amPnl = amPairs.reduce((s, p) => s + p.pnl, 0);
  const pmPnl = pmPairs.reduce((s, p) => s + p.pnl, 0);
  console.log(`前場: ${amPairs.length}件, 勝${amPairs.filter(p => p.pnl > 0).length}/負${amPairs.filter(p => p.pnl < 0).length}/引分${amPairs.filter(p => p.pnl === 0).length}, 損益: ${amPnl >= 0 ? "+" : ""}${amPnl.toLocaleString()}円`);
  console.log(`後場: ${pmPairs.length}件, 勝${pmPairs.filter(p => p.pnl > 0).length}/負${pmPairs.filter(p => p.pnl < 0).length}/引分${pmPairs.filter(p => p.pnl === 0).length}, 損益: ${pmPnl >= 0 ? "+" : ""}${pmPnl.toLocaleString()}円`);
  
  // Special notes
  console.log("\n=== 特記事項 ===");
  const slCount = pairs.filter(p => (p.exit.reason || "").includes("損切り")).length;
  const tpCount = pairs.filter(p => (p.exit.reason || "").includes("利確")).length;
  const beCount = pairs.filter(p => (p.exit.reason || "").includes("BE")).length;
  
  if (slCount >= 4) {
    console.log(`⚠️ 損切り多発: ${slCount}件（全${pairs.length}件中${(slCount/pairs.length*100).toFixed(0)}%）`);
  }
  
  // Check for consecutive losses
  let maxConsecLoss = 0;
  let currentConsec = 0;
  for (const p of pairs) {
    if (p.pnl < 0) {
      currentConsec++;
      maxConsecLoss = Math.max(maxConsecLoss, currentConsec);
    } else {
      currentConsec = 0;
    }
  }
  if (maxConsecLoss >= 3) {
    console.log(`⚠️ 最大連続損失: ${maxConsecLoss}連敗`);
  }
  
  // Check for specific signal underperformance
  for (const [sig, sPairs] of sigMap) {
    const pnl = sPairs.reduce((s, p) => s + p.pnl, 0);
    if (sPairs.length >= 2 && pnl < -20000) {
      console.log(`⚠️ シグナル不調: ${sig.substring(0, 40)} (${sPairs.length}件, ${pnl.toLocaleString()}円)`);
    }
  }
  
  // Check for symbol with all losses
  for (const [sym, symPairs] of symMap) {
    const allLoss = symPairs.every(p => p.pnl <= 0) && symPairs.some(p => p.pnl < 0);
    if (allLoss && symPairs.length >= 2) {
      console.log(`⚠️ 全敗銘柄: ${sym} (${symPairs.length}件全て損失/引分)`);
    }
  }
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
