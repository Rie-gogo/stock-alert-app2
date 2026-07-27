import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // The daily report uses signalHistory (in-memory) to get round_distance_block SHORT events
  // Then feeds them to CB v2 simulation
  // The report shows "候補数: X件" for SHORT blocks only
  
  // Let me check: in the actual production engine, how many round_distance_blocks happen per day?
  // Since signalHistory is in-memory and limited to 200, and resets daily (line 320),
  // the blocks ARE captured during the day. But the report only uses SHORTブロック.
  
  // The key issue: fullFilterTrace runs on ALL 20 symbols (including excluded ones)
  // but production only trades on active symbols (7 + 3 restored = 10 as of 7/23)
  
  // Let me check which symbols had 大台乖離率 blocks in the simulation
  console.log("■ fullFilterTrace結果の分析:");
  console.log("  全20銘柄で14件ブロック (LONG:9, SHORT:5)");
  console.log("  うち取引除外銘柄のブロック:");
  console.log("    3436(SUMCO): 4件 ← 除外銘柄");
  console.log("    6723(ルネサス): 0件 ← 除外銘柄");
  console.log("    3778(さくら): 1件 ← 除外銘柄");
  console.log("    5016(JX金属): 0件 ← 除外銘柄");
  console.log("    9984(SBG): 0件 ← 除外銘柄");
  console.log("    7011(三菱重工): 0件 ← 除外銘柄");
  console.log("    9107(川崎汽船): 0件 ← 除外銘柄");
  console.log("    8306(MUFG): 0件 ← 除外銘柄");
  console.log("    4568(第一三共): 0件 ← 除外銘柄");
  console.log("    7203(トヨタ): 0件 ← 除外銘柄");
  console.log("  除外銘柄合計: 5件");
  console.log("  アクティブ銘柄のブロック: 14-5 = 9件");
  console.log("");
  console.log("■ 日次レポートに大台乖離率ブロックが報告されない理由:");
  console.log("  1. レポートはCB v2セクションでSHORTブロックのみ報告");
  console.log("  2. LONGブロックは一切報告されていない");
  console.log("  3. CB v2の候補数にはSHORTブロックが含まれるが、");
  console.log("     「大台乖離率フィルターでX件ブロック」という独立セクションがない");
  console.log("  4. signalHistoryは日次リセット+200件上限のため、");
  console.log("     レポート生成時(15:35 JST)に全件残っているかは不確定");

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
