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
  
  const [blocks] = await db.execute(sql`
    SELECT b.trade_date, b.candle_time, b.symbol, b.side, b.board_score, b.signal_reason,
           c.boardSnapshot, b.context
    FROM rt_score0_blocks b
    LEFT JOIN rt_candles c ON b.symbol = c.symbol AND b.trade_date = c.tradeDate AND b.candle_time = c.candleTime
    WHERE b.trade_date >= '2026-07-01'
    ORDER BY b.trade_date, b.candle_time
  `);
  
  console.log(`本番取引: ${(trades as any[]).length}件, スコア0ブロック: ${(blocks as any[]).length}件\n`);
  
  interface Stats { cnt: number; wins: number; pnl: number; }
  const addStat = (m: Record<string, Stats>, k: string, pnl: number) => {
    if (!m[k]) m[k] = { cnt: 0, wins: 0, pnl: 0 };
    m[k].cnt++; if (pnl > 0) m[k].wins++; m[k].pnl += pnl;
  };
  
  // === 1. エントリー済み取引: BPR帯別 ===
  const bprBand = (bpr: number): string => {
    if (bpr < 0.6) return "<0.6";
    if (bpr < 0.8) return "0.6-0.8";
    if (bpr < 1.0) return "0.8-1.0";
    if (bpr < 1.2) return "1.0-1.2";
    if (bpr < 1.5) return "1.2-1.5";
    return "≥1.5";
  };
  
  const entryBpr: Record<string, Stats> = {};
  for (const t of trades as any[]) {
    const bs = t.boardSnapshot;
    if (!bs || typeof bs !== 'object') continue;
    const bpr = bs.buyPressureRatio || 0;
    addStat(entryBpr, `${bprBand(bpr)}_${t.side}`, Number(t.pnl));
  }
  
  const printMap = (title: string, m: Record<string, Stats>, filterSide?: string) => {
    console.log(`\n${title}`);
    const keys = Object.keys(m).filter(k => !filterSide || k.endsWith(`_${filterSide}`)).sort();
    for (const k of keys) {
      const v = m[k];
      const wr = (v.wins / v.cnt * 100).toFixed(1);
      console.log(`  ${k}: ${v.cnt}件 ${v.wins}勝${v.cnt-v.wins}敗 勝率${wr}% ${v.pnl >= 0 ? '+' : ''}${v.pnl.toLocaleString()}円`);
    }
  };
  
  printMap("=== エントリー済み: BPR帯 × SHORT ===", entryBpr, "short");
  printMap("=== エントリー済み: BPR帯 × LONG ===", entryBpr, "long");
  
  // === 2. ブロックされたシグナルのBPR帯 ===
  const blockBpr: Record<string, { cnt: number }> = {};
  for (const b of blocks as any[]) {
    const bs = b.boardSnapshot;
    if (!bs || typeof bs !== 'object') continue;
    const bpr = bs.buyPressureRatio || 0;
    const key = `${bprBand(bpr)}_${b.side}`;
    if (!blockBpr[key]) blockBpr[key] = { cnt: 0 };
    blockBpr[key].cnt++;
  }
  
  console.log("\n=== スコア0ブロック: BPR帯 × 方向 ===");
  for (const side of ["short", "long"]) {
    console.log(`--- ${side.toUpperCase()} ---`);
    for (const [k, v] of Object.entries(blockBpr).filter(([k]) => k.endsWith(`_${side}`)).sort()) {
      console.log(`  ${k.replace(`_${side}`, '')}: ${v.cnt}件ブロック`);
    }
  }
  
  // === 3. BPR単独フィルター vs 板読みスコア比較 ===
  console.log("\n=== 比較: 現行（板読みスコア） vs BPR単独フィルター ===");
  
  // 現行
  const curS = (trades as any[]).filter((t: any) => t.side === 'short');
  const curL = (trades as any[]).filter((t: any) => t.side === 'long');
  const sW = curS.filter((t: any) => Number(t.pnl) > 0).length;
  const sP = curS.reduce((s: number, t: any) => s + Number(t.pnl), 0);
  const lW = curL.filter((t: any) => Number(t.pnl) > 0).length;
  const lP = curL.reduce((s: number, t: any) => s + Number(t.pnl), 0);
  
  console.log(`\n現行（板読みスコア≥1でエントリー）:`);
  console.log(`  SHORT: ${curS.length}件 ${sW}勝 勝率${(sW/curS.length*100).toFixed(1)}% ${sP>=0?'+':''}${sP.toLocaleString()}円`);
  console.log(`  LONG:  ${curL.length}件 ${lW}勝 勝率${(lW/curL.length*100).toFixed(1)}% ${lP>=0?'+':''}${lP.toLocaleString()}円`);
  console.log(`  合計:  ${curS.length+curL.length}件 ${sW+lW}勝 ${sP+lP>=0?'+':''}${(sP+lP).toLocaleString()}円`);
  
  // BPR単独: 現在エントリーされた取引の中でBPR条件を満たすもの
  const bprS = curS.filter((t: any) => { const bs = t.boardSnapshot; return bs && typeof bs === 'object' && bs.buyPressureRatio < 1.0; });
  const bprL = curL.filter((t: any) => { const bs = t.boardSnapshot; return bs && typeof bs === 'object' && bs.buyPressureRatio >= 0.8 && bs.buyPressureRatio <= 1.2; });
  const bsW = bprS.filter((t: any) => Number(t.pnl) > 0).length;
  const bsP = bprS.reduce((s: number, t: any) => s + Number(t.pnl), 0);
  const blW = bprL.filter((t: any) => Number(t.pnl) > 0).length;
  const blP = bprL.reduce((s: number, t: any) => s + Number(t.pnl), 0);
  
  console.log(`\nBPR単独（SHORT: BPR<1.0, LONG: BPR0.8-1.2）で絞った場合:`);
  console.log(`  SHORT: ${bprS.length}件 ${bsW}勝 勝率${bprS.length>0?(bsW/bprS.length*100).toFixed(1):'0'}% ${bsP>=0?'+':''}${bsP.toLocaleString()}円`);
  console.log(`  LONG:  ${bprL.length}件 ${blW}勝 勝率${bprL.length>0?(blW/bprL.length*100).toFixed(1):'0'}% ${blP>=0?'+':''}${blP.toLocaleString()}円`);
  console.log(`  合計:  ${bprS.length+bprL.length}件 ${bsW+blW}勝 ${bsP+blP>=0?'+':''}${(bsP+blP).toLocaleString()}円`);
  
  // BPR条件を満たさないもの（除外される取引）
  const exclS = curS.filter((t: any) => { const bs = t.boardSnapshot; return !bs || typeof bs !== 'object' || bs.buyPressureRatio >= 1.0; });
  const exclL = curL.filter((t: any) => { const bs = t.boardSnapshot; return !bs || typeof bs !== 'object' || bs.buyPressureRatio < 0.8 || bs.buyPressureRatio > 1.2; });
  const esW = exclS.filter((t: any) => Number(t.pnl) > 0).length;
  const esP = exclS.reduce((s: number, t: any) => s + Number(t.pnl), 0);
  const elW = exclL.filter((t: any) => Number(t.pnl) > 0).length;
  const elP = exclL.reduce((s: number, t: any) => s + Number(t.pnl), 0);
  
  console.log(`\nBPR条件外（除外される取引）:`);
  console.log(`  SHORT(BPR≥1.0): ${exclS.length}件 ${esW}勝 勝率${exclS.length>0?(esW/exclS.length*100).toFixed(1):'0'}% ${esP>=0?'+':''}${esP.toLocaleString()}円`);
  console.log(`  LONG(BPR<0.8 or >1.2): ${exclL.length}件 ${elW}勝 勝率${exclL.length>0?(elW/exclL.length*100).toFixed(1):'0'}% ${elP>=0?'+':''}${elP.toLocaleString()}円`);
  
  process.exit(0);
}
main();
