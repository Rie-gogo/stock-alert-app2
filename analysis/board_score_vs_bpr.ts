import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  
  // 全取引 + boardSnapshot を取得
  const [trades] = await db.execute(sql`
    SELECT t.tradeDate, t.tradeTime, t.symbol, t.side, t.pnl, t.reason, t.boardSignal,
           c.boardSnapshot
    FROM rt_trades t
    LEFT JOIN rt_candles c ON t.symbol = c.symbol AND t.tradeDate = c.tradeDate AND t.tradeTime = c.candleTime
    WHERE t.tradeDate >= '2026-07-01'
    ORDER BY t.tradeDate, t.tradeTime
  `);
  
  // スコア0ブロックされた取引も取得
  const [blocks] = await db.execute(sql`
    SELECT b.trade_date, b.candle_time, b.symbol, b.direction, b.board_score, b.board_signal,
           c.boardSnapshot
    FROM rt_score0_blocks b
    LEFT JOIN rt_candles c ON b.symbol = c.symbol AND b.trade_date = c.tradeDate AND b.candle_time = c.candleTime
    WHERE b.trade_date >= '2026-07-01'
    ORDER BY b.trade_date, b.candle_time
  `.mapWith(() => null)`);
  // Fix query above
  process.exit(0);
  
  console.log(`=== 本番取引: ${(trades as any[]).length}件, スコア0ブロック: ${(blocks as any[]).length}件 ===\n`);
  
  // 1. 板読みスコア別の成績（取引のみ）
  console.log("=== 板読みスコア別の成績（エントリーされた取引） ===");
  // boardSignalから推定（実際のスコアはrt_tradesに保存されていない）
  
  // 2. BPR帯別の成績（取引 + ブロック含む全シグナル）
  interface Stats { cnt: number; wins: number; losses: number; pnl: number; }
  const bprBand = (bpr: number): string => {
    if (bpr < 0.5) return "<0.5";
    if (bpr < 0.6) return "0.5-0.6";
    if (bpr < 0.7) return "0.6-0.7";
    if (bpr < 0.8) return "0.7-0.8";
    if (bpr < 0.9) return "0.8-0.9";
    if (bpr < 1.0) return "0.9-1.0";
    if (bpr < 1.1) return "1.0-1.1";
    if (bpr < 1.2) return "1.1-1.2";
    if (bpr < 1.3) return "1.2-1.3";
    if (bpr < 1.5) return "1.3-1.5";
    return "≥1.5";
  };
  
  // エントリーされた取引のBPR帯別
  const entryByBpr: Record<string, Stats> = {};
  for (const t of trades as any[]) {
    const bs = t.boardSnapshot;
    if (!bs || typeof bs !== 'object') continue;
    const bpr = bs.buyPressureRatio || 0;
    const side = t.side;
    const pnl = Number(t.pnl);
    const key = `${bprBand(bpr)}_${side}`;
    if (!entryByBpr[key]) entryByBpr[key] = { cnt: 0, wins: 0, losses: 0, pnl: 0 };
    entryByBpr[key].cnt++;
    if (pnl > 0) entryByBpr[key].wins++;
    else entryByBpr[key].losses++;
    entryByBpr[key].pnl += pnl;
  }
  
  console.log("\n=== エントリー済み取引: BPR帯 × 方向 ===");
  for (const side of ["short", "long"]) {
    console.log(`\n--- ${side.toUpperCase()} ---`);
    const keys = Object.keys(entryByBpr).filter(k => k.endsWith(`_${side}`)).sort();
    for (const k of keys) {
      const v = entryByBpr[k];
      const wr = (v.wins / v.cnt * 100).toFixed(1);
      console.log(`  ${k.replace(`_${side}`, '')}: ${v.cnt}件 ${v.wins}勝${v.losses}敗 勝率${wr}% ${v.pnl >= 0 ? '+' : ''}${v.pnl.toLocaleString()}円`);
    }
  }
  
  // 3. ブロックされたシグナルのBPR帯別（もしエントリーしていたら）
  console.log("\n=== スコア0ブロック: BPR帯 × 方向 ===");
  const blockByBpr: Record<string, { cnt: number }> = {};
  const blockBySignal: Record<string, { cnt: number }> = {};
  for (const b of blocks as any[]) {
    const bs = b.boardSnapshot;
    const side = b.direction;
    const signal = b.board_signal || "unknown";
    
    const sigKey = `${signal}_${side}`;
    if (!blockBySignal[sigKey]) blockBySignal[sigKey] = { cnt: 0 };
    blockBySignal[sigKey].cnt++;
    
    if (bs && typeof bs === 'object') {
      const bpr = bs.buyPressureRatio || 0;
      const key = `${bprBand(bpr)}_${side}`;
      if (!blockByBpr[key]) blockByBpr[key] = { cnt: 0 };
      blockByBpr[key].cnt++;
    }
  }
  
  for (const side of ["short", "long"]) {
    console.log(`\n--- ${side.toUpperCase()} ブロック ---`);
    const keys = Object.keys(blockByBpr).filter(k => k.endsWith(`_${side}`)).sort();
    for (const k of keys) {
      console.log(`  ${k.replace(`_${side}`, '')}: ${blockByBpr[k].cnt}件ブロック`);
    }
  }
  
  console.log("\n=== ブロック: 板シグナル × 方向 ===");
  for (const [k, v] of Object.entries(blockBySignal).sort((a, b) => b[1].cnt - a[1].cnt)) {
    console.log(`  ${k}: ${v.cnt}件ブロック`);
  }
  
  // 4. BPR単独フィルターのシミュレーション
  // 「BPR < 1.0ならSHORT許可、BPR 0.8-1.2ならLONG許可」とした場合
  console.log("\n=== BPR単独フィルター vs 板読みスコアフィルター ===");
  
  // 現行（板読みスコア）: エントリーされた取引の成績
  const currentShort = (trades as any[]).filter((t: any) => t.side === 'short');
  const currentLong = (trades as any[]).filter((t: any) => t.side === 'long');
  const shortWins = currentShort.filter((t: any) => Number(t.pnl) > 0).length;
  const shortPnl = currentShort.reduce((s: number, t: any) => s + Number(t.pnl), 0);
  const longWins = currentLong.filter((t: any) => Number(t.pnl) > 0).length;
  const longPnl = currentLong.reduce((s: number, t: any) => s + Number(t.pnl), 0);
  
  console.log(`\n現行（板読みスコア）:`);
  console.log(`  SHORT: ${currentShort.length}件 ${shortWins}勝 勝率${(shortWins/currentShort.length*100).toFixed(1)}% ${shortPnl >= 0 ? '+' : ''}${shortPnl.toLocaleString()}円`);
  console.log(`  LONG:  ${currentLong.length}件 ${longWins}勝 勝率${(longWins/currentLong.length*100).toFixed(1)}% ${longPnl >= 0 ? '+' : ''}${longPnl.toLocaleString()}円`);
  console.log(`  合計:  ${currentShort.length + currentLong.length}件 ${shortWins + longWins}勝 ${shortPnl + longPnl >= 0 ? '+' : ''}${(shortPnl + longPnl).toLocaleString()}円`);
  
  // BPR単独: エントリー + ブロックの全シグナルからBPRだけでフィルター
  // ブロックされた取引の損益は不明なので、エントリーされた取引のBPR帯別成績から推定
  console.log(`\nBPR単独フィルター（BPR<1.0→SHORT許可, BPR0.8-1.2→LONG許可）の場合:`);
  
  let bprShort = { cnt: 0, wins: 0, pnl: 0 };
  let bprLong = { cnt: 0, wins: 0, pnl: 0 };
  for (const t of trades as any[]) {
    const bs = t.boardSnapshot;
    if (!bs || typeof bs !== 'object') continue;
    const bpr = bs.buyPressureRatio || 0;
    const side = t.side;
    const pnl = Number(t.pnl);
    
    if (side === 'short' && bpr < 1.0) {
      bprShort.cnt++; if (pnl > 0) bprShort.wins++; bprShort.pnl += pnl;
    }
    if (side === 'long' && bpr >= 0.8 && bpr <= 1.2) {
      bprLong.cnt++; if (pnl > 0) bprLong.wins++; bprLong.pnl += pnl;
    }
  }
  
  console.log(`  SHORT(BPR<1.0): ${bprShort.cnt}件 ${bprShort.wins}勝 勝率${bprShort.cnt > 0 ? (bprShort.wins/bprShort.cnt*100).toFixed(1) : 0}% ${bprShort.pnl >= 0 ? '+' : ''}${bprShort.pnl.toLocaleString()}円`);
  console.log(`  LONG(BPR0.8-1.2): ${bprLong.cnt}件 ${bprLong.wins}勝 勝率${bprLong.cnt > 0 ? (bprLong.wins/bprLong.cnt*100).toFixed(1) : 0}% ${bprLong.pnl >= 0 ? '+' : ''}${bprLong.pnl.toLocaleString()}円`);
  
  // 板読みスコアの各要素の寄与度
  console.log("\n=== 板読みスコアの要素別: エントリーされた取引で各要素がプラスだったか ===");
  let elementStats: Record<string, { plusTrades: number; minusTrades: number; plusPnl: number; minusPnl: number }> = {};
  
  for (const t of trades as any[]) {
    const bs = t.boardSnapshot;
    if (!bs || typeof bs !== 'object') continue;
    const pnl = Number(t.pnl);
    const isWin = pnl > 0;
    const bpr = bs.buyPressureRatio || 0;
    const side = t.side;
    
    // 各要素の状態を記録
    const elements: Record<string, boolean> = {
      "BPR有利": (side === 'short' && bpr < 1.0) || (side === 'long' && bpr >= 0.8 && bpr <= 1.2),
      "sell_pressure": bs.signal === 'sell_pressure',
      "buy_pressure": bs.signal === 'buy_pressure',
      "neutral": bs.signal === 'neutral',
      "大口買い壁": bs.largeBuyWall === true,
      "大口売り壁": bs.largeSellWall === true,
    };
    
    for (const [name, active] of Object.entries(elements)) {
      if (!elementStats[name]) elementStats[name] = { plusTrades: 0, minusTrades: 0, plusPnl: 0, minusPnl: 0 };
      if (active) {
        if (isWin) { elementStats[name].plusTrades++; elementStats[name].plusPnl += pnl; }
        else { elementStats[name].minusTrades++; elementStats[name].minusPnl += pnl; }
      }
    }
  }
  
  for (const [name, v] of Object.entries(elementStats)) {
    const total = v.plusTrades + v.minusTrades;
    if (total === 0) continue;
    const wr = (v.plusTrades / total * 100).toFixed(1);
    const totalPnl = v.plusPnl + v.minusPnl;
    console.log(`  ${name}: ${total}件 ${v.plusTrades}勝${v.minusTrades}敗 勝率${wr}% ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  }
  
  process.exit(0);
}
main();
