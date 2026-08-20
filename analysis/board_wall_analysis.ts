import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  
  const [trades] = await db.execute(sql`
    SELECT t.tradeDate, t.tradeTime, t.symbol, t.side, t.pnl, t.reason, t.boardSignal,
           c.boardSnapshot
    FROM rt_trades t
    LEFT JOIN rt_candles c ON t.symbol = c.symbol AND t.tradeDate = c.tradeDate AND t.tradeTime = c.candleTime
    WHERE t.tradeDate >= '2026-07-01'
    ORDER BY t.tradeDate, t.tradeTime
  `);
  
  interface Stats { cnt: number; wins: number; pnl: number; }
  const wallStats: Record<string, Stats> = {};
  const bprStats: Record<string, Stats> = {};
  const signalSideStats: Record<string, Stats> = {};
  
  const addStat = (map: Record<string, Stats>, key: string, pnl: number) => {
    if (!map[key]) map[key] = { cnt: 0, wins: 0, pnl: 0 };
    map[key].cnt++;
    if (pnl > 0) map[key].wins++;
    map[key].pnl += pnl;
  };
  
  for (const t of trades as any[]) {
    const bs = t.boardSnapshot;
    const pnl = Number(t.pnl);
    const side = t.side;
    
    if (bs && typeof bs === 'object') {
      const hasBuyWall = bs.largeBuyWall === true;
      const hasSellWall = bs.largeSellWall === true;
      
      let wallKey = "壁なし";
      if (hasBuyWall && hasSellWall) wallKey = "両方壁";
      else if (hasBuyWall) wallKey = "買い壁";
      else if (hasSellWall) wallKey = "売り壁";
      addStat(wallStats, `${wallKey}_${side}`, pnl);
      
      // BPR帯別
      const bpr = bs.buyPressureRatio || 0;
      let bprKey = "";
      if (bpr < 0.6) bprKey = "BPR<0.6(売優勢)";
      else if (bpr < 0.8) bprKey = "BPR0.6-0.8";
      else if (bpr < 1.0) bprKey = "BPR0.8-1.0";
      else if (bpr < 1.2) bprKey = "BPR1.0-1.2";
      else if (bpr < 1.5) bprKey = "BPR1.2-1.5";
      else bprKey = "BPR≥1.5(買優勢)";
      addStat(bprStats, `${bprKey}_${side}`, pnl);
      
      // 板シグナル×方向
      const sig = bs.signal || "neutral";
      addStat(signalSideStats, `${sig}_${side}`, pnl);
    }
  }
  
  const printStats = (title: string, map: Record<string, Stats>) => {
    console.log(`\n=== ${title} ===`);
    const entries = Object.entries(map).sort((a, b) => {
      const wrA = a[1].wins / a[1].cnt;
      const wrB = b[1].wins / b[1].cnt;
      return wrB - wrA;
    });
    for (const [key, v] of entries) {
      if (v.cnt < 3) continue;
      const wr = (v.wins / v.cnt * 100).toFixed(1);
      const mark = +wr >= 60 ? "★★" : +wr >= 50 ? "★" : "  ";
      console.log(`${mark} ${key}: ${v.cnt}件 ${v.wins}勝${v.cnt - v.wins}敗 勝率${wr}% ${v.pnl >= 0 ? "+" : ""}${v.pnl.toLocaleString()}円`);
    }
  };
  
  printStats("大口壁 × 方向 × 損益", wallStats);
  printStats("BPR帯 × 方向 × 損益", bprStats);
  printStats("板シグナル × 方向 × 損益", signalSideStats);
  
  // 大口壁の有無でのSHORT/LONG全体比較
  console.log("\n=== 大口壁の有無 × 全体比較 ===");
  const withWall = (trades as any[]).filter(t => {
    const bs = t.boardSnapshot;
    return bs && typeof bs === 'object' && (bs.largeBuyWall || bs.largeSellWall);
  });
  const noWall = (trades as any[]).filter(t => {
    const bs = t.boardSnapshot;
    return bs && typeof bs === 'object' && !bs.largeBuyWall && !bs.largeSellWall;
  });
  
  for (const [label, arr] of [["壁あり", withWall], ["壁なし", noWall]] as [string, any[]][]) {
    const wins = arr.filter(t => Number(t.pnl) > 0).length;
    const total = arr.reduce((s: number, t: any) => s + Number(t.pnl), 0);
    const wr = arr.length > 0 ? (wins / arr.length * 100).toFixed(1) : "0";
    console.log(`  ${label}: ${arr.length}件 ${wins}勝${arr.length - wins}敗 勝率${wr}% ${total >= 0 ? "+" : ""}${total.toLocaleString()}円`);
  }
  
  process.exit(0);
}
main();
