/**
 * アイスバーグ検出と勝率の関係を分析
 * 10日間の全取引について、エントリー時のiceberg検出状態と損益の相関を調べる
 */
import { getDb } from '../server/db';

async function main() {
  const db = await getDb();
  
  const dates = ['2026-06-19','2026-06-22','2026-06-24','2026-06-25','2026-06-26','2026-06-29','2026-06-30','2026-07-01','2026-07-02'];
  
  interface TradeWithBoard {
    date: string;
    time: string;
    symbol: string;
    side: string;
    pnl: number;
    icebergAsk: boolean;
    icebergBid: boolean;
    askCancel: boolean;
    bidCancel: boolean;
    bpr: number;
    signal: string;
    largeBidWall: number;
    largeAskWall: number;
  }
  
  const allTrades: TradeWithBoard[] = [];
  
  for (const date of dates) {
    const [trades] = await db.execute(`
      SELECT * FROM rt_trades WHERE tradeDate = '${date}' ORDER BY tradeTime
    `) as any;
    
    // エントリーと決済をペアリング
    const entries = trades.filter((t: any) => t.action === 'buy' || t.action === 'short');
    const exits = trades.filter((t: any) => t.action === 'sell' || t.action === 'cover');
    
    for (const exit of exits) {
      const pnl = Number(exit.pnl || 0);
      const entry = entries.find((e: any) => e.symbol === exit.symbol && e.side === exit.side && e.tradeTime <= exit.tradeTime);
      if (!entry) continue;
      
      const [candles] = await db.execute(`
        SELECT boardSnapshot FROM rt_candles 
        WHERE tradeDate = '${date}' AND symbol = '${entry.symbol}' AND candleTime = '${entry.tradeTime}'
        LIMIT 1
      `) as any;
      
      if (candles.length === 0) continue;
      const bs = candles[0].boardSnapshot;
      
      allTrades.push({
        date,
        time: entry.tradeTime,
        symbol: entry.symbol,
        side: entry.side,
        pnl,
        icebergAsk: bs?.icebergAskDetected || false,
        icebergBid: bs?.icebergBidDetected || false,
        askCancel: bs?.askCancelDetected || false,
        bidCancel: bs?.bidCancelDetected || false,
        bpr: bs?.buyPressureRatio || 0.5,
        signal: bs?.signal || 'none',
        largeBidWall: bs?.largeBidWallRatio || 0,
        largeAskWall: bs?.largeAskWallRatio || 0,
      });
      
      // 使い終わったentryを除外（同じエントリーが複数回マッチしないように）
      const idx = entries.indexOf(entry);
      if (idx >= 0) entries.splice(idx, 1);
    }
  }
  
  console.log(`=== アイスバーグ・大口検出と勝率の関係（${dates.length}日間, ${allTrades.length}取引） ===\n`);
  
  // 1. アイスバーグ検出別の分析
  const shortTrades = allTrades.filter(t => t.side === 'short');
  const longTrades = allTrades.filter(t => t.side === 'long');
  
  const calcStats = (trades: TradeWithBoard[]) => {
    const wins = trades.filter(t => t.pnl > 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    return { count: trades.length, wins: wins.length, winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : 'N/A', totalPnl };
  };
  
  console.log('--- SHORT取引のアイスバーグ分析 ---');
  const shortIceBid = shortTrades.filter(t => t.icebergBid);
  const shortIceAsk = shortTrades.filter(t => t.icebergAsk && !t.icebergBid);
  const shortNoIce = shortTrades.filter(t => !t.icebergAsk && !t.icebergBid);
  
  let stats = calcStats(shortIceBid);
  console.log(`  icebergBid検出時のSHORT: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  console.log(`    → 大口が買い板を食べている = 大口売り仕掛け → SHORTと同方向`);
  
  stats = calcStats(shortIceAsk);
  console.log(`  icebergAsk検出時のSHORT: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  console.log(`    → 大口が売り板を食べている = 大口買い仕掛け → SHORTと逆方向`);
  
  stats = calcStats(shortNoIce);
  console.log(`  iceberg検出なしのSHORT: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  
  console.log('\n--- LONG取引のアイスバーグ分析 ---');
  const longIceAsk = longTrades.filter(t => t.icebergAsk);
  const longIceBid = longTrades.filter(t => t.icebergBid && !t.icebergAsk);
  const longNoIce = longTrades.filter(t => !t.icebergAsk && !t.icebergBid);
  
  stats = calcStats(longIceAsk);
  console.log(`  icebergAsk検出時のLONG: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  console.log(`    → 大口が売り板を食べている = 大口買い仕掛け → LONGと同方向`);
  
  stats = calcStats(longIceBid);
  console.log(`  icebergBid検出時のLONG: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  console.log(`    → 大口が買い板を食べている = 大口売り仕掛け → LONGと逆方向`);
  
  stats = calcStats(longNoIce);
  console.log(`  iceberg検出なしのLONG: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  
  // 2. 板キャンセル検出別の分析
  console.log('\n--- 板キャンセル（見せ板）検出の分析 ---');
  const askCancelShort = shortTrades.filter(t => t.askCancel);
  const bidCancelShort = shortTrades.filter(t => t.bidCancel);
  const askCancelLong = longTrades.filter(t => t.askCancel);
  const bidCancelLong = longTrades.filter(t => t.bidCancel);
  
  stats = calcStats(askCancelShort);
  console.log(`  askCancel検出時のSHORT: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  console.log(`    → 売り板が突然消える = 見せ板で売りを誘った後に買い上げ → SHORTに不利`);
  
  stats = calcStats(bidCancelShort);
  console.log(`  bidCancel検出時のSHORT: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  console.log(`    → 買い板が突然消える = 見せ板で買いを誘った後に売り崩し → SHORTに有利`);
  
  stats = calcStats(askCancelLong);
  console.log(`  askCancel検出時のLONG: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  
  stats = calcStats(bidCancelLong);
  console.log(`  bidCancel検出時のLONG: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  
  // 3. 大口壁の分析
  console.log('\n--- 大口壁（largeBidWall/largeAskWall）の分析 ---');
  const bidWallShort = shortTrades.filter(t => t.largeBidWall >= 3.0);
  const askWallShort = shortTrades.filter(t => t.largeAskWall >= 3.0);
  const bidWallLong = longTrades.filter(t => t.largeBidWall >= 3.0);
  const askWallLong = longTrades.filter(t => t.largeAskWall >= 3.0);
  
  stats = calcStats(bidWallShort);
  console.log(`  大口買い壁あり時のSHORT: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  console.log(`    → 大口が買い支え = 見せ板の可能性 → 壁を割れば大きく下落`);
  
  stats = calcStats(askWallShort);
  console.log(`  大口売り壁あり時のSHORT: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  
  stats = calcStats(bidWallLong);
  console.log(`  大口買い壁あり時のLONG: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  
  stats = calcStats(askWallLong);
  console.log(`  大口売り壁あり時のLONG: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  console.log(`    → 大口が売り蓋 = 壁を超えれば大きく上昇`);
  
  // 4. 複合条件の分析
  console.log('\n--- 複合条件: 大口と同じ側のエントリー ---');
  // 「大口と同じ側」= icebergBid + SHORT, または icebergAsk + LONG
  const withInstitutional = allTrades.filter(t => 
    (t.side === 'short' && t.icebergBid) || (t.side === 'long' && t.icebergAsk)
  );
  // 「大口と逆側」= icebergAsk + SHORT, または icebergBid + LONG
  const againstInstitutional = allTrades.filter(t => 
    (t.side === 'short' && t.icebergAsk && !t.icebergBid) || (t.side === 'long' && t.icebergBid && !t.icebergAsk)
  );
  const noInstitutional = allTrades.filter(t => !t.icebergAsk && !t.icebergBid);
  
  stats = calcStats(withInstitutional);
  console.log(`  大口と同方向: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  for (const t of withInstitutional) {
    console.log(`    ${t.date} ${t.time} ${t.symbol} ${t.side} P&L=${t.pnl.toLocaleString()}円`);
  }
  
  stats = calcStats(againstInstitutional);
  console.log(`  大口と逆方向: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  for (const t of againstInstitutional) {
    console.log(`    ${t.date} ${t.time} ${t.symbol} ${t.side} P&L=${t.pnl.toLocaleString()}円`);
  }
  
  stats = calcStats(noInstitutional);
  console.log(`  大口検出なし: ${stats.count}件, 勝率${stats.winRate}%, 損益${stats.totalPnl.toLocaleString()}円`);
  
  process.exit(0);
}
main().catch(console.error);
