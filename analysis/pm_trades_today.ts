import { getDb } from '../server/db.ts';

async function main() {
  const db = await getDb();
  
  // Get all exit trades from 7/8
  const result = await db.execute('SELECT * FROM rt_trades WHERE DATE(tradeTime) = "2026-07-08" AND action IN ("sell", "cover") ORDER BY tradeTime');
  const trades = Array.isArray(result) ? result : (result as any).rows ?? [];
  
  console.log('=== 7/8 本番決済一覧 ===');
  let totalPnl = 0;
  let pmPnl = 0;
  let pmCount = 0;
  let pmWin = 0;
  for (const t of trades) {
    const time = new Date(t.tradeTime).toTimeString().slice(0,5);
    const isPM = time >= '12:30';
    const pnl = Number(t.pnl);
    totalPnl += pnl;
    if (isPM) { 
      pmPnl += pnl; 
      pmCount++; 
      if (pnl > 0) pmWin++;
    }
    console.log(`  ${time} ${t.symbol} ${t.action} pnl=${pnl} ${isPM ? '[後場]' : '[前場]'}`);
  }
  console.log('');
  console.log(`全体損益: ${totalPnl}円 (${trades.length}件)`);
  console.log(`後場損益: ${pmPnl}円 (${pmCount}件, 勝率${pmCount > 0 ? Math.round(pmWin/pmCount*100) : 0}%)`);
  
  // Now check the simulation output - filter for PM only
  console.log('\n=== シミュレーション後場のみ ===');
  console.log('(sim_patternC_today.tsの結果から後場分を抽出)');
  
  // Trades from the sim that are PM session (entry time >= 12:30)
  const simTrades = [
    { entry: '13:22', exit: '13:27', symbol: '6981', side: 'long', entryP: 9436, exitP: 9388.82, pnl: -9436, reason: '損切り' },
    { entry: '13:17', exit: '14:16', symbol: '6857', side: 'short', entryP: 28295, exitP: 28436.475, pnl: -14147, reason: '損切り' },
    { entry: '13:35', exit: '14:44', symbol: '6526', side: 'short', entryP: 2625, exitP: 2585.625, pnl: 39375, reason: '利確' },
    { entry: '14:48', exit: '14:54', symbol: '8035', side: 'short', entryP: 67480, exitP: 67817.4, pnl: -33740, reason: '損切り' },
    { entry: '15:00', exit: '15:10', symbol: '6526', side: 'short', entryP: 2594, exitP: 2606.97, pnl: -12970, reason: '損切り' },
    { entry: '15:00', exit: '15:25', symbol: '5803', side: 'short', entryP: 4847, exitP: 4827, pnl: 10000, reason: '大引け強制決済' },
    { entry: '15:03', exit: '15:25', symbol: '6857', side: 'short', entryP: 27750, exitP: 27785, pnl: -3500, reason: '大引け強制決済' },
  ];
  
  let simPmPnl = 0;
  let simPmWin = 0;
  for (const t of simTrades) {
    simPmPnl += t.pnl;
    if (t.pnl > 0) simPmWin++;
    console.log(`  ${t.entry}-${t.exit} ${t.symbol} ${t.side} @${t.entryP}→${t.exitP} ${t.pnl > 0 ? '+' : ''}${t.pnl}円 [${t.reason}]`);
  }
  console.log(`\nシミュ後場損益: ${simPmPnl}円 (${simTrades.length}件, 勝率${Math.round(simPmWin/simTrades.length*100)}%)`);
  
  process.exit(0);
}
main();
