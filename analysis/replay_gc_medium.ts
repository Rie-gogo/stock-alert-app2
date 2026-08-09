/**
 * 本番エンジンを使った再シミュレーション
 * 
 * 方法: realtimeSimEngine.tsのprocessCandle関数を直接呼び出し、
 * 過去30日のrt_candlesデータを再投入して結果を比較する。
 * 
 * 比較:
 * - 現行（GC medium禁止）
 * - 提案（GC medium許可: close>MA20条件付き）
 * 
 * ※ 本番コードは変更しない。代わりにエンジンの内部状態をリセットして
 *   2回再生し、結果を比較する。
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

// 本番エンジンのprocessCandleを直接インポート
// ただし、medium判定を変更するためにはエンジン内部のロジックを変える必要がある
// → 代替案: rt_candlesからGCが発生するタイミングを特定し、
//   その時点の全フィルター条件（板データ含む）をrt_tradesのsignalHistoryから確認

// 実際にはprocessCandleはDB書き込みを行うため、直接呼び出しは危険
// → 安全な方法: rt_candles + rt_board_snapshots（もしあれば）から
//   エンジンのフィルター条件を手動で再現する

async function main() {
  const db = await getDb();
  
  // まず、過去30日でGCが発生した全タイミングを特定
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol IN ('8035','6857','6976','6526','5803','6981','285A','6146','6594','8316') ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  console.log('='.repeat(80));
  console.log('  GC medium許可シミュレーション（本番フィルター再現版）');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1] + ' (' + dates.length + '日)');
  console.log('  条件: GC(MA5>MA10クロス) + close>MA20 + 陽線 + 時間帯フィルター');
  console.log('  追加フィルター: ATR>0.12%, 3分足HTFがdownでない, 同日1回まで');
  console.log('='.repeat(80));
  
  const ACTIVE_SYMBOLS = ['8035', '6857', '6976', '6526', '5803', '6981', '285A', '6146', '6594', '8316'];
  const SYMBOL_SL_MAP: Record<string, number> = {
    "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
    "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
    "6594": 0.5, "8316": 0.5,
  };
  const TP_PCT = 1.5;
  
  interface Trade {
    symbol: string; date: string; entryTime: string; exitTime: string;
    entryPrice: number; exitPrice: number; pnl: number;
    exitReason: string; holdMin: number; reason: string;
  }
  
  const allTrades: Trade[] = [];
  
  for (const sym of ACTIVE_SYMBOLS) {
    for (const date of dates) {
      const candlesRes = await db.execute(sql.raw(
        `SELECT open, high, low, close, candleTime, volume FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '${sym}' ORDER BY candleTime`
      ));
      const candles = ((candlesRes as any)[0] || []).map((r: any) => ({
        open: Number(r.open), high: Number(r.high), low: Number(r.low),
        close: Number(r.close), candleTime: r.candleTime, volume: Number(r.volume || 0),
      }));
      
      if (candles.length < 30) continue;
      
      const slPct = SYMBOL_SL_MAP[sym] || 0.5;
      let inPosition = false;
      let entryPrice = 0;
      let entryTime = '';
      let entryReason = '';
      let dailyEntryDone = false; // 1日1回制限
      
      const closes: number[] = [];
      const highs: number[] = [];
      const lows: number[] = [];
      let prevMA5 = 0, prevMA10 = 0;
      
      for (let i = 0; i < candles.length; i++) {
        const curr = candles[i];
        closes.push(curr.close);
        highs.push(curr.high);
        lows.push(curr.low);
        
        // Position management
        if (inPosition) {
          const tpPrice = entryPrice * (1 + TP_PCT / 100);
          const slPrice = entryPrice * (1 - slPct / 100);
          
          if (curr.high >= tpPrice) {
            const lots = Math.floor(2000000 / entryPrice);
            const pnl = Math.round((tpPrice - entryPrice) * lots);
            const eMin = parseInt(entryTime.split(':')[0]) * 60 + parseInt(entryTime.split(':')[1]);
            const xMin = parseInt(curr.candleTime.split(':')[0]) * 60 + parseInt(curr.candleTime.split(':')[1]);
            allTrades.push({ symbol: sym, date, entryTime, exitTime: curr.candleTime, entryPrice, exitPrice: tpPrice, pnl, exitReason: '利確(TP)', holdMin: xMin - eMin, reason: entryReason });
            inPosition = false;
          } else if (curr.low <= slPrice) {
            const lots = Math.floor(2000000 / entryPrice);
            const pnl = Math.round((slPrice - entryPrice) * lots);
            const eMin = parseInt(entryTime.split(':')[0]) * 60 + parseInt(entryTime.split(':')[1]);
            const xMin = parseInt(curr.candleTime.split(':')[0]) * 60 + parseInt(curr.candleTime.split(':')[1]);
            allTrades.push({ symbol: sym, date, entryTime, exitTime: curr.candleTime, entryPrice, exitPrice: slPrice, pnl, exitReason: '損切り(SL)', holdMin: xMin - eMin, reason: entryReason });
            inPosition = false;
          } else if (i === candles.length - 1) {
            const lots = Math.floor(2000000 / entryPrice);
            const pnl = Math.round((curr.close - entryPrice) * lots);
            const eMin = parseInt(entryTime.split(':')[0]) * 60 + parseInt(entryTime.split(':')[1]);
            const xMin = parseInt(curr.candleTime.split(':')[0]) * 60 + parseInt(curr.candleTime.split(':')[1]);
            allTrades.push({ symbol: sym, date, entryTime, exitTime: curr.candleTime, entryPrice, exitPrice: curr.close, pnl, exitReason: '大引け', holdMin: xMin - eMin, reason: entryReason });
            inPosition = false;
          }
          continue;
        }
        
        if (closes.length < 21 || dailyEntryDone) continue;
        
        // Time filters (same as production engine)
        const hour = parseInt(curr.candleTime.split(':')[0]);
        const min = parseInt(curr.candleTime.split(':')[1]);
        const timeMin = hour * 60 + min;
        if (timeMin < 570) continue;  // 09:30以前禁止
        if (timeMin > 905) continue;  // 15:05以降禁止
        if (timeMin >= 660 && timeMin < 690) continue; // 11:00-11:30禁止
        if (timeMin >= 750 && timeMin < 780) continue; // 12:30-13:00禁止
        
        // Calculate MAs
        const ma5 = closes.slice(-5).reduce((s, v) => s + v, 0) / 5;
        const ma10 = closes.slice(-10).reduce((s, v) => s + v, 0) / 10;
        const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((s, v) => s + v, 0) / 20 : 0;
        
        // GC detection
        const isGC = prevMA5 > 0 && prevMA10 > 0 && ma5 > ma10 && prevMA5 <= prevMA10;
        prevMA5 = ma5;
        prevMA10 = ma10;
        
        if (!isGC) continue;
        
        // === 本番フィルター再現 ===
        
        // 1. close > MA20 (上昇トレンド中のみ)
        if (ma20 <= 0 || curr.close <= ma20) continue;
        
        // 2. 陽線 (sell_pressureの代理: 陰線=売り圧力あり)
        if (curr.close <= curr.open) continue;
        
        // 3. ATRフィルター (本番と同じ: 直近7本のATR率 > 0.12%)
        if (closes.length >= 8) {
          let atrSum = 0;
          for (let j = closes.length - 7; j < closes.length; j++) {
            const h = highs[j];
            const l = lows[j];
            const prevC = closes[j - 1];
            const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
            atrSum += tr;
          }
          const atrPct = (atrSum / 7) / curr.close;
          if (atrPct < 0.0012) continue; // ATR < 0.12% → ボラ不足でスキップ
        }
        
        // 4. 3分足HTFフィルター (本番と同じ: 3分足トレンドがdownならブロック)
        if (closes.length >= 4) {
          // 簡易3分足: 直近3本のMA3とその前3本のMA3を比較
          const recent3 = closes.slice(-3).reduce((s, v) => s + v, 0) / 3;
          const prev3 = closes.slice(-6, -3).reduce((s, v) => s + v, 0) / 3;
          if (recent3 < prev3 * 0.999) continue; // 3分足が明確に下降中ならスキップ
        }
        
        // 5. isBullish判定 (MA20の傾きが-0.03%以上 = 上昇中ではSHORT禁止だが、LONG許可)
        // LONGなのでisBullishは制限にならない（SHORTのみブロック）
        
        // 6. 同日1回制限
        // → dailyEntryDoneで制御
        
        // All filters passed → LONG entry
        entryPrice = curr.close;
        entryTime = curr.candleTime;
        entryReason = `GC(MA5>MA10) close>MA20 @ ${curr.candleTime}`;
        inPosition = true;
        dailyEntryDone = true;
      }
    }
  }
  
  // Results
  console.log('\n  ─── 総合結果（1日1回制限、全本番フィルター再現） ───\n');
  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'INF';
  const avgHold = allTrades.length > 0 ? Math.round(allTrades.reduce((s, t) => s + t.holdMin, 0) / allTrades.length) : 0;
  
  console.log(`  件数: ${allTrades.length}件`);
  console.log(`  勝率: ${(wins.length / allTrades.length * 100).toFixed(1)}% (${wins.length}勝${losses.length}敗)`);
  console.log(`  総PnL: ${totalPnl.toLocaleString()}円`);
  console.log(`  平均PnL: ${Math.round(totalPnl / allTrades.length).toLocaleString()}円`);
  console.log(`  PF: ${pf}`);
  console.log(`  平均保有: ${avgHold}分`);
  console.log(`  平均勝ち: +${Math.round(grossWin / wins.length).toLocaleString()}円`);
  console.log(`  平均負け: ${Math.round(-grossLoss / losses.length).toLocaleString()}円`);
  
  // By symbol
  console.log('\n  ─── 銘柄別 ───\n');
  const symMap = new Map<string, Trade[]>();
  for (const t of allTrades) { const arr = symMap.get(t.symbol) || []; arr.push(t); symMap.set(t.symbol, arr); }
  for (const [sym, st] of [...symMap.entries()].sort((a, b) => b[1].reduce((s, t) => s + t.pnl, 0) - a[1].reduce((s, t) => s + t.pnl, 0))) {
    const w = st.filter(t => t.pnl > 0).length;
    const p = st.reduce((s, t) => s + t.pnl, 0);
    const gw = st.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(st.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const spf = gl > 0 ? (gw / gl).toFixed(2) : 'INF';
    console.log('    ' + sym.padEnd(6) + ' | ' + String(st.length).padStart(2) + '件 | 勝率: ' + (w / st.length * 100).toFixed(1).padStart(5) + '% | PnL: ' + p.toLocaleString().padStart(10) + '円 | PF: ' + spf);
  }
  
  // By date
  console.log('\n  ─── 日別 ───\n');
  const dateMap = new Map<string, Trade[]>();
  for (const t of allTrades) { const arr = dateMap.get(t.date) || []; arr.push(t); dateMap.set(t.date, arr); }
  let cumPnl = 0;
  for (const d of dates) {
    const dt = dateMap.get(d);
    if (!dt || dt.length === 0) continue;
    const dp = dt.reduce((s, t) => s + t.pnl, 0);
    cumPnl += dp;
    const w = dt.filter(t => t.pnl > 0).length;
    console.log('    ' + d + ' | ' + dt.length + '件 | ' + (dp >= 0 ? '+' : '') + dp.toLocaleString() + '円 | 累計: ' + (cumPnl >= 0 ? '+' : '') + cumPnl.toLocaleString() + '円 | ' + dt.map(t => t.symbol + (t.pnl > 0 ? '○' : '×')).join(', '));
  }
  
  // All trades detail
  console.log('\n  ─── 全トレード ───\n');
  for (let i = 0; i < allTrades.length; i++) {
    const t = allTrades[i];
    const mark = t.pnl > 0 ? '○' : '×';
    console.log(`  ${mark} ${t.date} | ${t.symbol} | ${t.entryTime}→${t.exitTime} | Entry:${t.entryPrice.toLocaleString()} | ${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString()}円 | ${t.exitReason} | ${t.holdMin}分`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
