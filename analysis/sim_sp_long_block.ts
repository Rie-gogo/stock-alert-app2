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

  // 方法1: devserverログからsell_pressure LONGブロックのログを探す（DBにはない可能性）
  // 方法2: rt_tradesのblocked_reasonを確認
  const [cols] = await conn.query(`SHOW COLUMNS FROM rt_trades`) as any[];
  const colNames = (cols as any[]).map(c => c.Field);
  console.log(`rt_tradesカラム: ${colNames.join(', ')}`);

  // sell_pressureブロックの記録があるか確認
  if (colNames.includes('blockedReason') || colNames.includes('blocked_reason')) {
    const col = colNames.includes('blockedReason') ? 'blockedReason' : 'blocked_reason';
    const [blocked] = await conn.query(`SELECT * FROM rt_trades WHERE ${col} LIKE '%sell_pressure%' ORDER BY tradeDate DESC LIMIT 20`) as any[];
    console.log(`\nsell_pressureブロック記録: ${(blocked as any[]).length}件`);
    for (const r of (blocked as any[]).slice(0, 5)) {
      console.log(`  ${r.tradeDate} ${r.symbol} ${r.entryTime || r.candleTime} ${r[col]}`);
    }
  }

  // 方法3: rt_signal_historyテーブルがあるか確認
  const [tables] = await conn.query(`SHOW TABLES LIKE 'rt_signal%'`) as any[];
  console.log(`\nシグナル関連テーブル: ${(tables as any[]).map((t:any) => Object.values(t)[0]).join(', ')}`);

  // 方法4: devserverログから直接検索
  console.log(`\n--- devserverログからsell_pressure LONGブロックを検索 ---`);
  
  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
