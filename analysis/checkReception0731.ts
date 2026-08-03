import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // 今日の日付を確認
  const now = new Date();
  const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = jstDate.toISOString().split('T')[0];
  console.log(`=== ${today} 1分足受信状況 ===\n`);
  console.log(`現在時刻(JST): ${jstDate.toISOString().replace('T', ' ').substring(0, 19)}\n`);
  
  // 銘柄別の受信数と最終受信時刻
  const [rows] = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt, MIN(candleTime) as firstTime, MAX(candleTime) as lastTime
    FROM rt_candles
    WHERE tradeDate = ${today}
    GROUP BY symbol
    ORDER BY cnt DESC
  `);
  
  const received = rows as any[];
  console.log(`受信銘柄数: ${received.length}銘柄\n`);
  console.log(`${'銘柄'.padEnd(6)} | ${'受信数'.padStart(6)} | ${'最初'.padStart(5)} | ${'最終'.padStart(5)}`);
  console.log(`${'-'.repeat(6)} | ${'-'.repeat(6)} | ${'-'.repeat(5)} | ${'-'.repeat(5)}`);
  
  for (const r of received) {
    console.log(`${String(r.symbol).padEnd(6)} | ${String(r.cnt).padStart(6)} | ${r.firstTime} | ${r.lastTime}`);
  }
  
  // 全20銘柄のリスト
  const allSymbols = ['285A','3436','3778','4568','5016','5803','6526','6723','6758','6857','6920','6976','6981','7011','7203','8035','8306','8316','9107','9984'];
  const receivedSymbols = received.map((r: any) => r.symbol);
  const missing = allSymbols.filter(s => !receivedSymbols.includes(s));
  
  console.log(`\n=== 未受信銘柄（${missing.length}銘柄）===`);
  for (const s of missing) {
    console.log(`  ❌ ${s}`);
  }
  
  // 昨日との比較
  const yesterday = '2026-07-30';
  const [yRows] = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt
    FROM rt_candles
    WHERE tradeDate = ${yesterday}
    GROUP BY symbol
    ORDER BY cnt DESC
  `);
  
  const yReceived = (yRows as any[]).map((r: any) => r.symbol);
  console.log(`\n=== 昨日(7/30)との比較 ===`);
  console.log(`昨日受信: ${yReceived.length}銘柄`);
  console.log(`本日受信: ${received.length}銘柄`);
  
  const newMissing = missing.filter(s => yReceived.includes(s));
  if (newMissing.length > 0) {
    console.log(`\n昨日は受信していたが本日未受信:`);
    for (const s of newMissing) {
      console.log(`  ⚠️ ${s}`);
    }
  }
  
  // 直近の受信パターン（最後の10分）
  const [recentRows] = await db.execute(sql`
    SELECT symbol, candleTime
    FROM rt_candles
    WHERE tradeDate = ${today}
    ORDER BY candleTime DESC
    LIMIT 50
  `);
  
  console.log(`\n=== 直近受信（最新10件）===`);
  const recentArr = (recentRows as any[]).slice(0, 10);
  for (const r of recentArr) {
    console.log(`  ${r.candleTime} | ${r.symbol}`);
  }
  
  process.exit(0);
}
main().catch(console.error);
