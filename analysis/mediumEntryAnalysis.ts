import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // Check medium entries 7/1-7/16 - what signal types were they?
  const r1 = await db.execute(sql`
    SELECT tradeDate, symbol, tradeTime, action, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-16'
    AND (action = 'buy' OR action = 'short')
    AND reason NOT LIKE '%信頼度：強%'
    ORDER BY tradeDate, tradeTime
    LIMIT 60
  `);
  console.log("■ medium信頼度エントリー (7/1-7/16) - シグナルタイプ分析");
  const byType: Record<string, number> = {};
  for (const row of (r1 as any)[0]) {
    const reason = row.reason as string;
    let sigType = "不明";
    if (reason.includes("大台超え")) sigType = "大台超え(SM)";
    else if (reason.includes("大台割れ")) sigType = "大台割れ(SM)";
    else if (reason.includes("ダウ理論") || reason.includes("押し目確認")) sigType = "ダウ理論/押し目(SM)";
    else if (reason.includes("VWAP反発")) sigType = "VWAP反発";
    else if (reason.includes("VWAPクロス下抜け")) sigType = "VWAPクロス下抜け";
    else if (reason.includes("三尊")) sigType = "三尊";
    else if (reason.includes("逆三尊")) sigType = "逆三尊";
    else if (reason.includes("デッドクロス")) sigType = "デッドクロス";
    else if (reason.includes("ゴールデンクロス")) sigType = "ゴールデンクロス";
    else if (reason.includes("長い上ヒゲ")) sigType = "長い上ヒゲ";
    else if (reason.includes("長い下ヒゲ")) sigType = "長い下ヒゲ";
    else if (reason.includes("戻り売り")) sigType = "戻り売り";
    else if (reason.includes("スイング")) sigType = "スイング";
    else sigType = reason.substring(0, 30);
    byType[sigType] = (byType[sigType] || 0) + 1;
  }
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    const isSM = type.includes("SM") ? " ← ステートマシン経由" : " ← 直接エントリー";
    console.log(`  ${type}: ${count}件${isSM}`);
  }

  // Now check: after 7/16, what entries exist and their signal types?
  console.log("\n■ 7/17-7/24 エントリーのシグナルタイプ");
  const r2 = await db.execute(sql`
    SELECT tradeDate, symbol, tradeTime, action, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-17' AND tradeDate <= '2026-07-24'
    AND (action = 'buy' OR action = 'short')
    ORDER BY tradeDate, tradeTime
  `);
  for (const row of (r2 as any)[0]) {
    const reason = (row.reason as string).substring(0, 100);
    console.log(`  ${row.tradeDate} ${row.tradeTime} ${row.action} ${row.symbol}: ${reason}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
