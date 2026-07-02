/**
 * Debug: Trace board reading score for 6920 (Laser Tech) on 7/2 at 09:50
 */
import { getDb } from "../server/db";

async function main() {
  const db = await getDb();
  
  // Get all candles for 6920 on 7/2 from 09:30 to 09:55
  const [rows] = await db.execute(`
    SELECT candleTime, boardSnapshot
    FROM rt_candles 
    WHERE tradeDate = '2026-07-02' AND symbol = '6920' AND candleTime >= '09:00' AND candleTime <= '09:55'
    ORDER BY candleTime
  `) as any;
  
  const bprHistory: number[] = [];
  
  for (const r of rows) {
    let snap: any = null;
    let bpr: number | null = null;
    if (r.boardSnapshot) {
      snap = typeof r.boardSnapshot === 'string' ? JSON.parse(r.boardSnapshot) : r.boardSnapshot;
      bpr = snap?.buyPressureRatio ?? null;
    }
    
    if (bpr !== null) {
      bprHistory.push(bpr);
      if (bprHistory.length > 5) bprHistory.shift();
    }
    
    // Only log from 09:45 onwards
    if (r.candleTime >= "09:45") {
      // Calculate board score for SHORT
      let score = 0;
      const details: string[] = [];
      
      if (!snap) {
        details.push("no snapshot → score=1");
        console.log(`${r.candleTime} | bpr=${bpr} | hist=[${bprHistory.map(h=>h.toFixed(2)).join(',')}] | SCORE=1 (no snap)`);
        continue;
      }
      
      // A: aggressive orders
      const marketOrderRatio = snap.marketOrderRatio ?? 0;
      if (marketOrderRatio >= 0.08) {
        if (bpr! < 1.0) { score += 2; details.push(`A:+2 (short, bpr<1, moratio=${marketOrderRatio})`); }
        else if (bpr! > 1.0) { score -= 2; details.push(`A:-2 (short, bpr>1, moratio=${marketOrderRatio})`); }
      } else {
        details.push(`A:0 (moratio=${marketOrderRatio?.toFixed(3)} < 0.08)`);
      }
      
      // B: large walls
      if (snap.largeBuyWall) { score += 1; details.push("B:+1 (largeBuyWall)"); }
      if (snap.largeSellWall) { score -= 1; details.push("B:-1 (largeSellWall)"); }
      if (!snap.largeBuyWall && !snap.largeSellWall) details.push("B:0 (no walls)");
      
      // C: BPR trend
      if (bprHistory.length >= 3) {
        const oldest = bprHistory[0];
        const newest = bprHistory[bprHistory.length - 1];
        const delta = newest - oldest;
        if (delta <= -0.15) { score += 1; details.push(`C:+1 (short, delta=${delta.toFixed(3)} <= -0.15)`); }
        else if (delta >= 0.15) { score -= 1; details.push(`C:-1 (short, delta=${delta.toFixed(3)} >= 0.15)`); }
        else { details.push(`C:0 (delta=${delta.toFixed(3)})`); }
      } else {
        details.push(`C:0 (hist.length=${bprHistory.length} < 3)`);
      }
      
      // D: market mode
      const cancelDetected = !!(snap.askCancelDetected || snap.bidCancelDetected);
      let mode: string;
      if (cancelDetected) {
        mode = "trap"; score -= 2; details.push("D:-2 (cancel detected → trap)");
      } else if (bprHistory.length >= 3) {
        const allNeutral = bprHistory.every(h => h >= 0.85 && h <= 1.15);
        if (allNeutral && bpr! >= 0.85 && bpr! <= 1.15) {
          mode = "quiet"; score -= 2; details.push("D:-2 (quiet)");
        } else if (bpr! > 1.2 || bpr! < 0.8) {
          mode = "active"; score += 1; details.push("D:+1 (active, bpr outside 0.8-1.2)");
        } else {
          const oldest = bprHistory[0];
          const newest = bprHistory[bprHistory.length - 1];
          if (Math.abs(newest - oldest) >= 0.1) {
            mode = "building"; score += 1; details.push(`D:+1 (building, |${newest.toFixed(2)}-${oldest.toFixed(2)}|=${Math.abs(newest-oldest).toFixed(2)} >= 0.1)`);
          } else {
            mode = "trap"; score -= 2; details.push(`D:-2 (trap, |${newest.toFixed(2)}-${oldest.toFixed(2)}|=${Math.abs(newest-oldest).toFixed(2)} < 0.1)`);
          }
        }
      } else {
        if (bpr! > 1.2 || bpr! < 0.8) {
          mode = "active"; score += 1; details.push("D:+1 (active, short hist)");
        } else {
          mode = "trap"; score -= 2; details.push("D:-2 (trap, short hist)");
        }
      }
      
      // E: pressure strength
      if (bpr! <= 0.65) { score += 1; details.push(`E:+1 (short, bpr=${bpr!.toFixed(2)} <= 0.65)`); }
      else if (bpr! >= 1.4) { score -= 1; details.push(`E:-1 (short, bpr=${bpr!.toFixed(2)} >= 1.4)`); }
      else { details.push(`E:0 (bpr=${bpr!.toFixed(2)})`); }
      
      // F: tick direction
      let tickDir = "neutral";
      const mod = snap.marketOrderDirection;
      if (mod === "buy") tickDir = "uptick";
      else if (mod === "sell") tickDir = "downtick";
      else if (bprHistory.length >= 3) {
        const first = bprHistory[0];
        const last = bprHistory[bprHistory.length - 1];
        const trend = last - first;
        if (trend >= 0.2) tickDir = "uptick";
        else if (trend <= -0.2) tickDir = "downtick";
        else if (last >= 1.3) tickDir = "uptick";
        else if (last <= 0.7) tickDir = "downtick";
      }
      if (tickDir === "downtick") { score += 2; details.push(`F:+2 (short, downtick)`); }
      else if (tickDir === "uptick") { score -= 2; details.push(`F:-2 (short, uptick)`); }
      else { details.push(`F:0 (neutral, mod=${mod})`); }
      
      // G: iceberg
      let icebergSide: string | null = null;
      if (snap.icebergAskDetected) icebergSide = "buy";
      if (snap.icebergBidDetected) icebergSide = "sell";
      if (icebergSide === "sell") { score += 1; details.push("G:+1 (short, iceberg sell)"); }
      else if (icebergSide === "buy") { score -= 1; details.push("G:-1 (short, iceberg buy)"); }
      else { details.push("G:0 (no iceberg)"); }
      
      const pass = score >= 1 ? "PASS" : "BLOCK";
      console.log(`${r.candleTime} | bpr=${bpr?.toFixed(2)} | hist=[${bprHistory.map(h=>h.toFixed(2)).join(',')}] | SCORE=${score} → ${pass}`);
      console.log(`  ${details.join(' | ')}`);
    }
  }
  
  process.exit(0);
}
main();
