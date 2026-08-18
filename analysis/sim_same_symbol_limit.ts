import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  // 本番の全取引データを使って、同一銘柄制限の影響を検証
  const [trades] = await conn.query(`
    SELECT tradeDate, symbol, tradeTime, action, price, price, pnl, reason
    FROM rt_trades
    WHERE tradeDate >= '2026-07-01' AND pnl IS NOT NULL
    ORDER BY tradeDate, tradeTime
  `) as any[];
  await conn.end();

  // 日別に集計
  type DayResult = { withLimit: number; withoutLimit: number; blocked: { sym: string; pnl: number; time: string; reason: string }[] };
  const days: Record<string, DayResult> = {};

  let prevDate = "";
  let activePositions = new Set<string>();

  for (const t of trades) {
    const d = t.tradeDate;
    if (d !== prevDate) { activePositions = new Set(); prevDate = d; }
    if (!days[d]) days[d] = { withLimit: 0, withoutLimit: 0, blocked: [] };

    const pnl = Number(t.pnl);
    days[d].withoutLimit += pnl;

    // 同一銘柄制限シミュレーション: 同日に同銘柄のエントリーが既にあればブロック
    // ただし本番では「決済後に再エントリー可能」なので、実際にはもっと複雑
    // ここでは「同日に同銘柄の2回目以降」を特定
  }

  // 本番データから「同日同銘柄の複数エントリー」を特定
  const [multiEntries] = await conn.query ? [] : [];
  
  // 別アプローチ: 本番データで同日同銘柄が複数回ある場合を確認
  const conn2 = await mysql.createConnection(DATABASE_URL);
  const [dupCheck] = await conn2.query(`
    SELECT tradeDate, symbol, COUNT(*) as cnt, 
           GROUP_CONCAT(tradeTime ORDER BY tradeTime) as times,
           GROUP_CONCAT(pnl ORDER BY tradeTime) as pnls,
           SUM(pnl) as totalPnl
    FROM rt_trades
    WHERE tradeDate >= '2026-07-01' AND pnl IS NOT NULL AND action IN ('long','short')
    GROUP BY tradeDate, symbol
    HAVING cnt > 1
    ORDER BY tradeDate, symbol
  `) as any[];

  // 1回目と2回目以降を分離
  const [allByDay] = await conn2.query(`
    SELECT tradeDate, symbol, tradeTime, pnl, action, reason,
           ROW_NUMBER() OVER (PARTITION BY tradeDate, symbol ORDER BY tradeTime) as rn
    FROM rt_trades
    WHERE tradeDate >= '2026-07-01' AND pnl IS NOT NULL AND action IN ('long','short')
    ORDER BY tradeDate, tradeTime
  `) as any[];
  await conn2.end();

  let firstOnly = { total: 0, wins: 0, pnl: 0 };
  let secondPlus = { total: 0, wins: 0, pnl: 0 };
  let all = { total: 0, wins: 0, pnl: 0 };

  for (const t of allByDay) {
    const pnl = Number(t.pnl);
    all.total++; if (pnl > 0) all.wins++; all.pnl += pnl;
    if (t.rn === 1) { firstOnly.total++; if (pnl > 0) firstOnly.wins++; firstOnly.pnl += pnl; }
    else { secondPlus.total++; if (pnl > 0) secondPlus.wins++; secondPlus.pnl += pnl; }
  }

  console.log("=== 同一銘柄制限の影響分析（本番データ）===");
  console.log("期間: 7/1〜8/17\n");
  console.log("| 条件 | 取引数 | 勝率 | 総損益 | 1件平均 |");
  console.log("|---|---|---|---|---|");
  console.log(`| 全取引 | ${all.total}件 ${all.wins}勝${all.total-all.wins}敗 | ${(all.wins/all.total*100).toFixed(1)}% | ${all.pnl>=0?"+":""}${all.pnl.toLocaleString()}円 | ${Math.round(all.pnl/all.total).toLocaleString()}円 |`);
  console.log(`| 1回目のみ（制限あり） | ${firstOnly.total}件 ${firstOnly.wins}勝${firstOnly.total-firstOnly.wins}敗 | ${(firstOnly.wins/firstOnly.total*100).toFixed(1)}% | ${firstOnly.pnl>=0?"+":""}${firstOnly.pnl.toLocaleString()}円 | ${Math.round(firstOnly.pnl/firstOnly.total).toLocaleString()}円 |`);
  console.log(`| 2回目以降（制限で除外される分） | ${secondPlus.total}件 ${secondPlus.wins}勝${secondPlus.total-secondPlus.wins}敗 | ${secondPlus.total>0?(secondPlus.wins/secondPlus.total*100).toFixed(1):"0"}% | ${secondPlus.pnl>=0?"+":""}${secondPlus.pnl.toLocaleString()}円 | ${secondPlus.total>0?Math.round(secondPlus.pnl/secondPlus.total).toLocaleString():"0"}円 |`);

  // 2回目以降の詳細
  console.log("\n--- 同日同銘柄の2回目以降の取引詳細 ---");
  const secondTrades = allByDay.filter((t: any) => t.rn > 1);
  for (const t of secondTrades) {
    console.log(`  ${t.tradeDate} ${t.symbol} ${t.tradeTime} ${t.action} pnl=${Number(t.pnl)>=0?"+":""}${Number(t.pnl).toLocaleString()}円 (${t.rn}回目) ${t.reason?.substring(0,40)||""}`);
  }

  // 日別で「制限なし」の方が良い日 vs 悪い日
  console.log("\n--- 日別: 2回目以降の損益 ---");
  const dayPnl: Record<string, number> = {};
  for (const t of secondTrades) {
    if (!dayPnl[t.tradeDate]) dayPnl[t.tradeDate] = 0;
    dayPnl[t.tradeDate] += Number(t.pnl);
  }
  let plusDays = 0, minusDays = 0;
  for (const [d, p] of Object.entries(dayPnl).sort()) {
    console.log(`  ${d}: ${p>=0?"+":""}${p.toLocaleString()}円`);
    if (p > 0) plusDays++; else minusDays++;
  }
  console.log(`\n2回目以降がプラスの日: ${plusDays}日 / マイナスの日: ${minusDays}日`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
