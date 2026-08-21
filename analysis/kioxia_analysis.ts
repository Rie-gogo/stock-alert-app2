import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

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
    entryReason: string; exitReason: string; entryBoard: string; exitBoard: string;
  }
  const pairs: TradePair[] = [];
  const entries: any[] = [];
  
  for (const row of allRows) {
    if (row.action === 'buy' || row.action === 'short') {
      entries.push(row);
    } else if (row.action === 'sell' || row.action === 'cover') {
      // 対応するエントリーを探す
      const matchIdx = entries.findIndex(e => 
        e.tradeDate === row.tradeDate && e.side === row.side &&
        ((e.action === 'buy' && row.action === 'sell') || (e.action === 'short' && row.action === 'cover'))
      );
      if (matchIdx >= 0) {
        const entry = entries[matchIdx];
        entries.splice(matchIdx, 1);
        pairs.push({
          date: entry.tradeDate, entryTime: entry.tradeTime, exitTime: row.tradeTime,
          side: entry.side, entryPrice: Number(entry.price), exitPrice: Number(row.price),
          pnl: Number(row.pnl), entryReason: entry.reason, exitReason: row.reason,
          entryBoard: entry.boardSignal, exitBoard: row.boardSignal
        });
      }
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`キオクシア(285A) くせ分析 - 全取引ペア: ${pairs.length}件`);
  console.log(`${'='.repeat(70)}`);

  let wins = 0, losses = 0, totalPnl = 0;
  const byReason: Record<string, { cnt: number; wins: number; pnl: number; details: string[] }> = {};
  const byExitReason: Record<string, { cnt: number; wins: number; pnl: number }> = {};
  const bySide: Record<string, { cnt: number; wins: number; pnl: number }> = {};
  const byHour: Record<string, { cnt: number; wins: number; pnl: number }> = {};
  const byBoard: Record<string, { cnt: number; wins: number; pnl: number }> = {};
  const byDate: Record<string, { cnt: number; wins: number; pnl: number; trades: any[] }> = {};

  for (const t of pairs) {
    const mark = t.pnl > 0 ? '✓' : '✗';
    console.log(`${mark} ${t.date} ${t.entryTime}→${t.exitTime} ${t.side} @${t.entryPrice}→${t.exitPrice} ${t.pnl > 0 ? '+' : ''}${t.pnl}円 board:${t.entryBoard}`);
    console.log(`    entry: ${t.entryReason.substring(0, 100)}`);
    console.log(`    exit:  ${t.exitReason.substring(0, 80)}`);

    if (t.pnl > 0) wins++; else losses++;
    totalPnl += t.pnl;

    // シグナル分類
    let sigKey = '不明';
    const er = t.entryReason;
    if (er.includes('即エントリー') && er.includes('出来高急増')) sigKey = '即vol SHORT';
    else if (er.includes('即エントリー') && er.includes('4本連続')) sigKey = '即4a SHORT';
    else if (er.includes('安値更新即')) sigKey = '安値更新即SHORT';
    else if (er.includes('大台確認') && er.includes('大台割れ')) sigKey = '大台割れCB SHORT';
    else if (er.includes('大台確認') && er.includes('大台超え')) sigKey = '大台超えLONG';
    else if (er.includes('逆三尊')) sigKey = '逆三尊LONG';
    else if (er.includes('三尊')) sigKey = '三尊SHORT';
    else if (er.includes('ダウ理論') && t.side === 'short') sigKey = 'ダウ理論SHORT';
    else if (er.includes('ダウ理論') && t.side === 'long') sigKey = 'ダウ理論LONG(押し目)';
    else if (er.includes('VWAP')) sigKey = 'VWAP SHORT';
    else if (er.includes('静かな上昇')) sigKey = '静かな上昇バイパスLONG';
    else if (er.includes('出来高ブレイク')) sigKey = '出来高ブレイクLONG';
    else if (er.includes('過熱反転')) sigKey = '過熱反転SHORT';
    else sigKey = er.substring(0, 30);

    if (!byReason[sigKey]) byReason[sigKey] = { cnt: 0, wins: 0, pnl: 0, details: [] };
    byReason[sigKey].cnt++;
    if (t.pnl > 0) byReason[sigKey].wins++;
    byReason[sigKey].pnl += t.pnl;
    byReason[sigKey].details.push(`${t.date} ${t.entryTime}→${t.exitTime} ${t.side} ${t.pnl > 0 ? '+' : ''}${t.pnl}円 board:${t.entryBoard}`);

    // 決済理由
    let exitKey = '不明';
    if (t.exitReason.includes('利確')) exitKey = '利確';
    else if (t.exitReason.includes('損切り')) exitKey = '損切り';
    else if (t.exitReason.includes('前場決済') || t.exitReason.includes('前場強制')) exitKey = '前場強制決済';
    else if (t.exitReason.includes('大引け')) exitKey = '大引け決済';
    else exitKey = t.exitReason.substring(0, 20);

    if (!byExitReason[exitKey]) byExitReason[exitKey] = { cnt: 0, wins: 0, pnl: 0 };
    byExitReason[exitKey].cnt++;
    if (t.pnl > 0) byExitReason[exitKey].wins++;
    byExitReason[exitKey].pnl += t.pnl;

    if (!bySide[t.side]) bySide[t.side] = { cnt: 0, wins: 0, pnl: 0 };
    bySide[t.side].cnt++;
    if (t.pnl > 0) bySide[t.side].wins++;
    bySide[t.side].pnl += t.pnl;

    const hour = t.entryTime.substring(0, 2);
    if (!byHour[hour]) byHour[hour] = { cnt: 0, wins: 0, pnl: 0 };
    byHour[hour].cnt++;
    if (t.pnl > 0) byHour[hour].wins++;
    byHour[hour].pnl += t.pnl;

    if (!byBoard[t.entryBoard]) byBoard[t.entryBoard] = { cnt: 0, wins: 0, pnl: 0 };
    byBoard[t.entryBoard].cnt++;
    if (t.pnl > 0) byBoard[t.entryBoard].wins++;
    byBoard[t.entryBoard].pnl += t.pnl;

    if (!byDate[t.date]) byDate[t.date] = { cnt: 0, wins: 0, pnl: 0, trades: [] };
    byDate[t.date].cnt++;
    if (t.pnl > 0) byDate[t.date].wins++;
    byDate[t.date].pnl += t.pnl;
    byDate[t.date].trades.push({ ...t, sigKey });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`全体: ${pairs.length}件 ${wins}勝${losses}敗 勝率${pairs.length > 0 ? (wins/pairs.length*100).toFixed(1) : 0}% 合計${totalPnl > 0 ? '+' : ''}${totalPnl}円`);
  console.log(`${'='.repeat(60)}`);

  console.log('\n--- 方向別 ---');
  for (const [k, v] of Object.entries(bySide)) {
    console.log(`  ${k}: ${v.cnt}件 ${v.wins}勝${v.cnt-v.wins}敗 勝率${(v.wins/v.cnt*100).toFixed(1)}% ${v.pnl > 0 ? '+' : ''}${v.pnl}円`);
  }

  console.log('\n--- シグナル別（損益順） ---');
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k}: ${v.cnt}件 ${v.wins}勝${v.cnt-v.wins}敗 勝率${(v.wins/v.cnt*100).toFixed(1)}% ${v.pnl > 0 ? '+' : ''}${v.pnl}円`);
    for (const d of v.details) console.log(`    ${d}`);
  }

  console.log('\n--- 決済理由別 ---');
  for (const [k, v] of Object.entries(byExitReason).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k}: ${v.cnt}件 ${v.wins}勝${v.cnt-v.wins}敗 勝率${(v.wins/v.cnt*100).toFixed(1)}% ${v.pnl > 0 ? '+' : ''}${v.pnl}円`);
  }

  console.log('\n--- 時間帯別 ---');
  for (const [k, v] of Object.entries(byHour).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${k}時台: ${v.cnt}件 ${v.wins}勝${v.cnt-v.wins}敗 勝率${(v.wins/v.cnt*100).toFixed(1)}% ${v.pnl > 0 ? '+' : ''}${v.pnl}円`);
  }

  console.log('\n--- 板読みシグナル別 ---');
  for (const [k, v] of Object.entries(byBoard).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k}: ${v.cnt}件 ${v.wins}勝${v.cnt-v.wins}敗 勝率${(v.wins/v.cnt*100).toFixed(1)}% ${v.pnl > 0 ? '+' : ''}${v.pnl}円`);
  }

  console.log('\n--- 日別損益 ---');
  for (const [d, v] of Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${d}: ${v.cnt}件 ${v.wins}勝${v.cnt-v.wins}敗 ${v.pnl > 0 ? '+' : ''}${v.pnl}円`);
    for (const tr of v.trades) {
      const m = tr.pnl > 0 ? '✓' : '✗';
      console.log(`    ${m} ${tr.entryTime}→${tr.exitTime} ${tr.side} ${tr.pnl > 0 ? '+' : ''}${tr.pnl}円 [${tr.sigKey}] board:${tr.entryBoard}`);
    }
  }

  // スコア0ブロック
  const r2 = await db.execute(sql`
    SELECT trade_date, candle_time, side, signal_reason, entry_price, board_score, confidence, context
    FROM rt_score0_blocks
    WHERE symbol = '285A'
    ORDER BY trade_date, candle_time
  `);
  const blocks = (r2 as any)[0] as any[];
  console.log(`\n=== スコア0ブロック (${blocks.length}件) ===`);
  for (const b of blocks) {
    console.log(`  ${b.trade_date} ${b.candle_time} ${b.side} @${b.entry_price} score:${b.board_score} conf:${b.confidence} [${String(b.signal_reason).substring(0, 70)}]`);
  }

  process.exit(0);
}
main();
