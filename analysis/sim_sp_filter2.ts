import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, {long: number; short: number}> = {
  "8035": {long:0.5, short:0.8}, "6857": {long:0.6, short:0.6}, "6976": {long:0.6, short:0.8},
  "6526": {long:0.9, short:1.0}, "5803": {long:0.5, short:0.6}, "6981": {long:0.4, short:0.9},
  "285A": {long:0.8, short:0.6}, "6146": {long:0.8, short:0.8}, "6594": {long:0.5, short:0.5},
  "8316": {long:0.5, short:0.5},
};

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  // 実際のLONGエントリーのboardSignal分布を確認
  const [longEntries] = await conn.query(`
    SELECT tradeDate, symbol, tradeTime, price, pnl, reason, boardSignal, side
    FROM rt_trades 
    WHERE action = 'entry' AND side = 'long'
    ORDER BY tradeDate DESC
    LIMIT 50
  `) as any[];
  console.log(`=== 実際のLONGエントリー（最新50件） ===`);
  console.log(`件数: ${(longEntries as any[]).length}`);
  
  // 実際のSHORTエントリーのboardSignal分布
  const [shortEntries] = await conn.query(`
    SELECT boardSignal, COUNT(*) as cnt
    FROM rt_trades 
    WHERE action = 'entry' AND side = 'short'
    GROUP BY boardSignal
    ORDER BY cnt DESC
  `) as any[];
  console.log(`\n=== SHORTエントリーのboardSignal分布 ===`);
  for (const r of shortEntries as any[]) {
    console.log(`  ${r.boardSignal || "null"}: ${r.cnt}件`);
  }

  // 全エントリーのboardSignal分布
  const [allEntries] = await conn.query(`
    SELECT side, boardSignal, COUNT(*) as cnt
    FROM rt_trades 
    WHERE action = 'entry'
    GROUP BY side, boardSignal
    ORDER BY side, cnt DESC
  `) as any[];
  console.log(`\n=== 全エントリーのside×boardSignal分布 ===`);
  for (const r of allEntries as any[]) {
    console.log(`  ${r.side} / ${r.boardSignal || "null"}: ${r.cnt}件`);
  }

  // sell_pressureでブロックされたケースはDBに記録されないため、
  // 「LONGシグナルが出たがsell_pressureでブロックされた」ケースを推定する
  // → rt_score0_blocksのように専用テーブルがないため、ログベースでしか確認できない
  
  // 代替: 実際にLONGエントリーされた取引で、boardSignal=sell_pressureのものがあるか
  const [spLong] = await conn.query(`
    SELECT COUNT(*) as cnt FROM rt_trades 
    WHERE action = 'entry' AND side = 'long' AND boardSignal = 'sell_pressure'
  `) as any[];
  console.log(`\n=== sell_pressure時にLONGエントリーされた件数 ===`);
  console.log(`  ${(spLong as any[])[0].cnt}件 (フィルターが機能していれば0件のはず)`);

  // sell_pressure時にSHORTエントリーされた件数（参考）
  const [spShort] = await conn.query(`
    SELECT COUNT(*) as cnt FROM rt_trades 
    WHERE action = 'entry' AND side = 'short' AND boardSignal = 'sell_pressure'
  `) as any[];
  console.log(`  sell_pressure時SHORT: ${(spShort as any[])[0].cnt}件`);

  // LONGエントリーのboardSignal別損益
  const [longByBoard] = await conn.query(`
    SELECT boardSignal, 
           COUNT(*) as cnt,
           SUM(CASE WHEN action='exit' THEN 1 ELSE 0 END) as exits,
           side
    FROM rt_trades 
    WHERE side = 'long' AND action = 'entry'
    GROUP BY boardSignal
    ORDER BY cnt DESC
  `) as any[];
  console.log(`\n=== LONGエントリーのboardSignal分布 ===`);
  for (const r of longByBoard as any[]) {
    console.log(`  ${r.boardSignal || "null"}: ${r.cnt}件`);
  }

  // LONGの損益をboardSignal別に集計（entry+exit pair）
  const [longPnl] = await conn.query(`
    SELECT t1.boardSignal, 
           COUNT(*) as cnt,
           SUM(t2.pnl) as totalPnl,
           SUM(CASE WHEN t2.pnl > 0 THEN 1 ELSE 0 END) as wins
    FROM rt_trades t1
    JOIN rt_trades t2 ON t1.tradeDate = t2.tradeDate AND t1.symbol = t2.symbol AND t2.action = 'exit' AND t2.side = 'long'
    WHERE t1.action = 'entry' AND t1.side = 'long'
    GROUP BY t1.boardSignal
    ORDER BY cnt DESC
  `) as any[];
  console.log(`\n=== LONGエントリーのboardSignal別損益 ===`);
  for (const r of longPnl as any[]) {
    const winRate = r.cnt > 0 ? (Number(r.wins) / Number(r.cnt) * 100).toFixed(1) : "0";
    console.log(`  ${r.boardSignal || "null"}: ${r.cnt}件 ${r.wins}勝 勝率${winRate}% 損益${Number(r.totalPnl) >= 0 ? "+" : ""}${Number(r.totalPnl).toLocaleString()}円`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
