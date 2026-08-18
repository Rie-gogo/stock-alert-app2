import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, {long: number; short: number}> = {
  "8035": {long:0.5, short:0.8}, "6857": {long:0.6, short:0.6}, "6976": {long:0.6, short:0.8},
  "6526": {long:0.9, short:1.0}, "5803": {long:0.5, short:0.6}, "6981": {long:0.4, short:0.9},
  "285A": {long:0.8, short:0.6}, "6146": {long:0.8, short:0.8}, "6594": {long:0.5, short:0.5},
  "8316": {long:0.5, short:0.5},
};
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];

interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  // 40営業日取得
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 40
  `) as any[];
  const dates = (dateRows as any[]).map(r => r.tradeDate).reverse();
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  // 全データ取得
  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${dates.map(d=>`'${d}'`).join(',')}) AND symbol IN (${SYMBOLS.map(s=>`'${s}'`).join(',')})
    ORDER BY tradeDate, symbol, candleTime
  `) as any[];

  const data: Record<string, Record<string, C[]>> = {};
  for (const r of allRows as any[]) {
    if (!data[r.tradeDate]) data[r.tradeDate] = {};
    if (!data[r.tradeDate][r.symbol]) data[r.tradeDate][r.symbol] = [];
    data[r.tradeDate][r.symbol].push({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  }

  // sell_pressureの判定: 直近3本中2本以上陰線
  function isSellPressure(candles: C[], idx: number): boolean {
    const recent3 = candles.slice(Math.max(0, idx - 2), idx + 1);
    const bearCount = recent3.filter(c => c.c < c.o).length;
    return bearCount >= 2;
  }

  // LONGシグナル検出（大台超え以外: GC, 逆三尊, ダウ理論高値更新など）
  // 簡易版: 大台超え（close > 前足close && 大台を超えた）をLONGシグナルとして検出
  // 実際のエンジンではGC/逆三尊/ダウ理論も含むが、ここでは大台超えLONGで検証
  // ただし大台超えLONGは現在停止中なので、他のLONGシグナルで検証する
  
  // 方法: 実際のrt_tradesからLONGエントリーを取得し、同時刻のsell_pressure状態を確認
  const [longTrades] = await conn.query(`
    SELECT tradeDate, symbol, tradeTime, price, pnl, reason, boardSignal
    FROM rt_trades 
    WHERE side = 'long' AND action = 'entry' AND tradeDate IN (${dates.map(d=>`'${d}'`).join(',')})
    ORDER BY tradeDate, tradeTime
  `) as any[];
  
  console.log(`=== LONGエントリー時のboardSignal分布 ===\n`);
  const longArr = longTrades as any[];
  console.log(`LONGエントリー総数: ${longArr.length}件`);
  
  const signalDist: Record<string, number> = {};
  for (const t of longArr) {
    const sig = t.boardSignal || "null";
    signalDist[sig] = (signalDist[sig] || 0) + 1;
  }
  for (const [sig, count] of Object.entries(signalDist).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${sig}: ${count}件`);
  }

  // sell_pressureでブロックされたLONGシグナルを探す
  // → rt_tradesにはエントリーされたものしかないので、ブロックされたものはない
  // → シミュレーションで「sell_pressure時にLONGシグナルが出ていた」ケースを再現する必要がある
  
  // 代替アプローチ: 全LONGエントリー時点でsell_pressureだったか確認し、
  // もしsell_pressureフィルターがなかったら追加でエントリーされていたケースを推定
  
  // 実際のアプローチ: rt_candlesから「LONGシグナルが出るべき条件」を検出し、
  // sell_pressure状態だった場合をカウント
  
  // 最も正確な方法: 大台超えLONGシグナル（現在停止中）以外で、
  // GC/逆三尊/ダウ理論のLONGシグナルが発火する条件を再現するのは複雑
  
  // 簡易的に: 実際にエントリーされたLONG取引の前後で、sell_pressureだった足を確認
  // sell_pressureフィルターが「ブロックした」ケースは記録されていないため、
  // 「もしsell_pressureフィルターを外したら」のシミュレーションが必要
  
  // → エンジンのコードを読んで、sell_pressureフィルターが適用される箇所を特定し、
  //   その条件を外した場合の結果をシミュレーション
  
  console.log(`\n\n=== sell_pressureフィルターの効果検証 ===`);
  console.log(`（sell_pressure時にLONGエントリーしていたら損益はどうなったか）\n`);
  
  // 全銘柄・全日でGC（MA5がMA20を上抜け）を検出し、sell_pressure時のものを抽出
  interface Trade { date: string; symbol: string; time: string; price: number; result: string; pnl: number; spState: boolean; }
  const gcTrades: Trade[] = [];
  
  for (const date of dates) {
    for (const symbol of SYMBOLS) {
      const candles = data[date]?.[symbol];
      if (!candles || candles.length < 25) continue;
      const sl = SL_MAP[symbol].long;
      
      for (let i = 20; i < candles.length - 1; i++) {
        if (candles[i].t < "09:05" || candles[i].t > "14:30") continue;
        
        // 簡易GC検出: MA5 > MA20 かつ前足でMA5 <= MA20
        const ma5 = candles.slice(i-4, i+1).reduce((s,c)=>s+c.c, 0) / 5;
        const ma5prev = candles.slice(i-5, i).reduce((s,c)=>s+c.c, 0) / 5;
        const ma20 = candles.slice(i-19, i+1).reduce((s,c)=>s+c.c, 0) / 20;
        const ma20prev = candles.slice(i-20, i).reduce((s,c)=>s+c.c, 0) / 20;
        
        if (ma5prev <= ma20prev && ma5 > ma20) {
          // GCシグナル発生
          const sp = isSellPressure(candles, i);
          const entryPrice = candles[i].c;
          const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;
          const slPrice = entryPrice * (1 - sl / 100);
          const tpPrice = entryPrice * (1 + TP_PCT / 100);
          
          let result = "EOD";
          let pnl = 0;
          for (let j = i + 1; j < candles.length; j++) {
            if (candles[j].l <= slPrice) { result = "SL"; pnl = Math.round((slPrice - entryPrice) * shares); break; }
            if (candles[j].h >= tpPrice) { result = "TP"; pnl = Math.round((tpPrice - entryPrice) * shares); break; }
          }
          if (result === "EOD") {
            const lastC = candles[candles.length - 1].c;
            pnl = Math.round((lastC - entryPrice) * shares);
          }
          
          gcTrades.push({ date, symbol, time: candles[i].t, price: entryPrice, result, pnl, spState: sp });
        }
      }
    }
  }
  
  const spBlocked = gcTrades.filter(t => t.spState);
  const spPassed = gcTrades.filter(t => !t.spState);
  
  console.log(`GCシグナル検出数: ${gcTrades.length}件`);
  console.log(`  sell_pressureあり（ブロック対象）: ${spBlocked.length}件`);
  console.log(`  sell_pressureなし（通過）: ${spPassed.length}件`);
  
  function summarize(trades: Trade[], label: string) {
    if (trades.length === 0) { console.log(`\n【${label}】 0件`); return; }
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0).length;
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = (wins / trades.length * 100).toFixed(1);
    const grossProfit = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
    const grossLoss = Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
    const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
    console.log(`\n【${label}】`);
    console.log(`  ${trades.length}件 (${wins}勝${losses}敗) 勝率${winRate}%`);
    console.log(`  合計損益: ${total >= 0 ? "+" : ""}${total.toLocaleString()}円`);
    console.log(`  PF: ${pf}`);
  }
  
  summarize(spBlocked, "sell_pressure時のGC LONG（ブロック対象 → もしエントリーしていたら）");
  summarize(spPassed, "sell_pressureなし時のGC LONG（通過 → 実際にエントリー可能）");
  
  // ブロック対象の詳細
  if (spBlocked.length > 0) {
    console.log(`\n\n--- sell_pressure時にブロックされるGC LONGの詳細 ---\n`);
    console.log(`日付       | 銘柄 | 時刻  | 価格       | 結果 | 損益`);
    console.log(`${"─".repeat(65)}`);
    for (const t of spBlocked.slice(0, 30)) {
      console.log(`${t.date} | ${t.symbol.padEnd(4)} | ${t.time} | ${t.price.toLocaleString().padStart(8)}円 | ${t.result.padEnd(3)} | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円`);
    }
  }
  
  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
