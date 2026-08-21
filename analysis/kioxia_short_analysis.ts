import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();

  // 285Aの全レコードを取得
  const r = await db.execute(sql`
    SELECT id, tradeDate, tradeTime, action, side, price, shares, pnl, reason, boardSignal
    FROM rt_trades
    WHERE symbol = '285A'
    ORDER BY id ASC
  `);
  const allRows = (r as any)[0] as any[];
  console.log(`285A 全レコード: ${allRows.length}件`);

  // エントリーとイグジットをペアリング
  interface TradePair {
    date: string; entryTime: string; exitTime: string; side: string;
    entryPrice: number; exitPrice: number; pnl: number;
    reason: string; boardSignal: string; exitReason: string;
  }
  const trades: TradePair[] = [];
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    if (row.action === 'short' && row.side === 'short') {
      // 次のcover を探す
      for (let j = i + 1; j < allRows.length; j++) {
        const exitRow = allRows[j];
        if (exitRow.action === 'cover' && exitRow.side === 'short' && exitRow.tradeDate === row.tradeDate) {
          trades.push({
            date: row.tradeDate,
            entryTime: row.tradeTime,
            exitTime: exitRow.tradeTime,
            side: 'short',
            entryPrice: Number(row.price),
            exitPrice: Number(exitRow.price),
            pnl: Number(exitRow.pnl),
            reason: row.reason || '',
            boardSignal: row.boardSignal || '',
            exitReason: exitRow.reason || '',
          });
          break;
        }
      }
    }
  }

  console.log(`\n=== キオクシア(285A) SHORT分析 ===`);
  console.log(`SHORT取引数: ${trades.length}件`);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  console.log(`勝敗: ${wins.length}勝${losses.length}敗 勝率${(wins.length / trades.length * 100).toFixed(1)}%`);
  console.log(`合計損益: ${totalPnl > 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  console.log(`平均利益: +${(wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(0)}円`);
  console.log(`平均損失: ${(losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(0)}円`);

  // 全取引一覧
  console.log(`\n--- 全SHORT取引一覧 ---`);
  console.log('日付       | 時間        | エントリー | イグジット | 損益      | シグナル | 板読み | 決済理由');
  console.log('-'.repeat(120));
  for (const t of trades) {
    const mark = t.pnl > 0 ? '○' : '×';
    // シグナルから方式を抽出
    let signalType = '不明';
    if (t.reason.includes('即vol')) signalType = '即vol';
    else if (t.reason.includes('即4a')) signalType = '即4a';
    else if (t.reason.includes('安値更新')) signalType = '安値更新即';
    else if (t.reason.includes('大台割れ')) signalType = '大台割れCB';
    else if (t.reason.includes('過熱反転')) signalType = '過熱反転';
    else if (t.reason.includes('デッドクロス')) signalType = 'デッドクロス';
    else if (t.reason.includes('三尊')) signalType = '三尊';
    else if (t.reason.includes('VWAP')) signalType = 'VWAP';
    console.log(`${mark} ${t.date} | ${t.entryTime}→${t.exitTime} | @${t.entryPrice} | @${t.exitPrice.toFixed(0)} | ${t.pnl > 0 ? '+' : ''}${t.pnl.toLocaleString()}円 | ${signalType} | ${t.boardSignal} | ${t.exitReason.substring(0, 20)}`);
  }

  // シグナル別集計
  console.log(`\n--- シグナル別集計 ---`);
  const signalGroups: Record<string, TradePair[]> = {};
  for (const t of trades) {
    let signalType = '不明';
    if (t.reason.includes('即vol')) signalType = '即vol';
    else if (t.reason.includes('即4a')) signalType = '即4a';
    else if (t.reason.includes('安値更新')) signalType = '安値更新即';
    else if (t.reason.includes('大台割れ')) signalType = '大台割れCB';
    else if (t.reason.includes('過熱反転')) signalType = '過熱反転';
    else if (t.reason.includes('デッドクロス')) signalType = 'デッドクロス';
    else if (t.reason.includes('三尊')) signalType = '三尊';
    else if (t.reason.includes('VWAP')) signalType = 'VWAP';
    if (!signalGroups[signalType]) signalGroups[signalType] = [];
    signalGroups[signalType].push(t);
  }
  for (const [signal, group] of Object.entries(signalGroups).sort((a, b) => b[1].length - a[1].length)) {
    const w = group.filter(t => t.pnl > 0).length;
    const l = group.filter(t => t.pnl <= 0).length;
    const pnl = group.reduce((s, t) => s + t.pnl, 0);
    console.log(`${signal}: ${group.length}件 ${w}勝${l}敗 勝率${(w / group.length * 100).toFixed(0)}% 損益${pnl > 0 ? '+' : ''}${pnl.toLocaleString()}円`);
  }

  // 時間帯別集計
  console.log(`\n--- 時間帯別集計 ---`);
  const timeGroups: Record<string, TradePair[]> = {};
  for (const t of trades) {
    const hour = t.entryTime.substring(0, 2);
    if (!timeGroups[hour]) timeGroups[hour] = [];
    timeGroups[hour].push(t);
  }
  for (const [hour, group] of Object.entries(timeGroups).sort()) {
    const w = group.filter(t => t.pnl > 0).length;
    const l = group.filter(t => t.pnl <= 0).length;
    const pnl = group.reduce((s, t) => s + t.pnl, 0);
    console.log(`${hour}時台: ${group.length}件 ${w}勝${l}敗 勝率${(w / group.length * 100).toFixed(0)}% 損益${pnl > 0 ? '+' : ''}${pnl.toLocaleString()}円`);
  }

  // 板読み別集計
  console.log(`\n--- 板読みシグナル別集計 ---`);
  const boardGroups: Record<string, TradePair[]> = {};
  for (const t of trades) {
    const bs = t.boardSignal || 'unknown';
    if (!boardGroups[bs]) boardGroups[bs] = [];
    boardGroups[bs].push(t);
  }
  for (const [bs, group] of Object.entries(boardGroups).sort((a, b) => b[1].length - a[1].length)) {
    const w = group.filter(t => t.pnl > 0).length;
    const l = group.filter(t => t.pnl <= 0).length;
    const pnl = group.reduce((s, t) => s + t.pnl, 0);
    console.log(`${bs}: ${group.length}件 ${w}勝${l}敗 勝率${(w / group.length * 100).toFixed(0)}% 損益${pnl > 0 ? '+' : ''}${pnl.toLocaleString()}円`);
  }

  // 決済理由別集計
  console.log(`\n--- 決済理由別集計 ---`);
  const exitGroups: Record<string, TradePair[]> = {};
  for (const t of trades) {
    let exitType = '不明';
    if (t.exitReason.includes('利確')) exitType = '利確(TP)';
    else if (t.exitReason.includes('損切り')) exitType = '損切り(SL)';
    else if (t.exitReason.includes('前場')) exitType = '前場強制決済';
    else if (t.exitReason.includes('大引け') || t.exitReason.includes('強制決済')) exitType = '大引け決済';
    else exitType = t.exitReason.substring(0, 15);
    if (!exitGroups[exitType]) exitGroups[exitType] = [];
    exitGroups[exitType].push(t);
  }
  for (const [exit, group] of Object.entries(exitGroups).sort((a, b) => b[1].length - a[1].length)) {
    const w = group.filter(t => t.pnl > 0).length;
    const l = group.filter(t => t.pnl <= 0).length;
    const pnl = group.reduce((s, t) => s + t.pnl, 0);
    console.log(`${exit}: ${group.length}件 ${w}勝${l}敗 損益${pnl > 0 ? '+' : ''}${pnl.toLocaleString()}円`);
  }

  // プラス取引とマイナス取引の共通点分析
  console.log(`\n--- プラス取引の共通点 ---`);
  const winSignals = wins.map(t => {
    if (t.reason.includes('即vol')) return '即vol';
    if (t.reason.includes('即4a')) return '即4a';
    if (t.reason.includes('安値更新')) return '安値更新即';
    if (t.reason.includes('大台割れ')) return '大台割れCB';
    if (t.reason.includes('過熱反転')) return '過熱反転';
    if (t.reason.includes('デッドクロス')) return 'デッドクロス';
    return '不明';
  });
  const winBoards = wins.map(t => t.boardSignal);
  const winHours = wins.map(t => t.entryTime.substring(0, 2));
  console.log(`シグナル: ${JSON.stringify(winSignals)}`);
  console.log(`板読み: ${JSON.stringify(winBoards)}`);
  console.log(`時間帯: ${JSON.stringify(winHours)}`);

  console.log(`\n--- マイナス取引の共通点 ---`);
  const lossSignals = losses.map(t => {
    if (t.reason.includes('即vol')) return '即vol';
    if (t.reason.includes('即4a')) return '即4a';
    if (t.reason.includes('安値更新')) return '安値更新即';
    if (t.reason.includes('大台割れ')) return '大台割れCB';
    if (t.reason.includes('過熱反転')) return '過熱反転';
    if (t.reason.includes('三尊')) return '三尊';
    return '不明';
  });
  const lossBoards = losses.map(t => t.boardSignal);
  const lossHours = losses.map(t => t.entryTime.substring(0, 2));
  console.log(`シグナル: ${JSON.stringify(lossSignals)}`);
  console.log(`板読み: ${JSON.stringify(lossBoards)}`);
  console.log(`時間帯: ${JSON.stringify(lossHours)}`);

  // ブロックされたSHORTシグナル
  console.log(`\n--- ブロックされたSHORTシグナル ---`);
  const rBlocks = await db.execute(sql`
    SELECT trade_date, candle_time, side, signal_reason, context
    FROM rt_score0_blocks
    WHERE symbol = '285A' AND side = 'short'
    ORDER BY trade_date, candle_time
  `);
  const blocks = (rBlocks as any)[0] as any[];
  console.log(`ブロック数: ${blocks.length}件`);
  for (const b of blocks) {
    console.log(`  ${b.trade_date} ${b.candle_time} | ${b.signal_reason?.substring(0, 40)} | ${b.context?.substring(0, 30)}`);
  }

  // 8/19・8/20のSHORTエントリー確認
  console.log(`\n--- 8/19・8/20のSHORT取引 ---`);
  const aug1920 = trades.filter(t => t.date === '2026-08-19' || t.date === '2026-08-20');
  for (const t of aug1920) {
    console.log(`${t.date} ${t.entryTime} | @${t.entryPrice} | ${t.pnl > 0 ? '+' : ''}${t.pnl.toLocaleString()}円 | ${t.reason.substring(0, 50)}`);
  }

  process.exit(0);
}
main();
