import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // The daily report has these sections:
  // 1. 【当日サマリー】 - basic stats
  // 2. 【銘柄別損益】
  // 3. 【取引詳細】
  // 4. 【CB v2 SHORTシミュレーション】 - only SHORT blocks from 0.8% filter
  // 5. 【分岐型シミュレーション】 - drop_0.6 bypass
  // 6. 【スコア0+信頼度強 仮想エントリーシミュレーション】
  
  // The 14件 comes from fullFilterTrace simulation which:
  // - Runs on ALL 20 symbols (including excluded)
  // - Doesn't apply board score, HTF, sell_pressure filters
  // - Counts both LONG and SHORT blocks
  
  // In production:
  // - TRADE_EXCLUDED_SYMBOLS blocks 10 symbols before any signal processing
  // - Board score filter blocks signals before they reach the state machine
  // - HTF filter blocks signals before they reach the state machine
  // - Only signals that PASS all pre-filters reach the state machine
  // - Only state machine confirmed signals that exceed 0.8% get blocked by the distance filter
  
  // So in production, the actual 0.8% blocks are MUCH fewer because:
  // 1. Fewer active symbols (7-10 vs 20)
  // 2. Board score blocks many signals before they reach state machine
  // 3. HTF filter blocks many signals before they reach state machine
  
  // The CB v2 report only shows SHORT blocks that were in signalHistory
  // Let me check: does the signalHistory even survive to report time?
  
  console.log("■ 日次レポートにおける大台乖離率フィルターの報告状況");
  console.log("");
  console.log("  レポート構造:");
  console.log("  - 【CB v2 SHORTシミュレーション】セクション");
  console.log("    → signalHistoryから action='round_distance_block' かつ 'SHORTブロック' を抽出");
  console.log("    → これが「候補数: X件」として表示される");
  console.log("    → LONGブロックは一切報告されない");
  console.log("");
  console.log("  問題点:");
  console.log("  1. LONGの大台乖離率ブロックは報告されない（CB v2はSHORT専用）");
  console.log("  2. 「大台乖離率フィルターでX件ブロック」という独立セクションが存在しない");
  console.log("  3. signalHistoryはin-memoryで、サーバー再起動時にリセットされる");
  console.log("  4. 本番では前段フィルター（板読みスコア、HTF等）で多くのシグナルが");
  console.log("     ステートマシンに到達する前にブロックされるため、");
  console.log("     大台乖離率フィルターまで到達するケースが少ない");
  console.log("");
  console.log("■ fullFilterTraceの14件 vs 本番の実際のブロック数");
  console.log("  fullFilterTrace: 板読みスコア・HTF・sell_pressureフィルターなし → 14件");
  console.log("  本番: 上記フィルターあり → 大幅に少ない（推定0-3件/日）");
  console.log("");
  console.log("  理由: 本番では大台超え/割れシグナルが生成されても、");
  console.log("  板読みスコア<1 or HTF=down/up で事前にブロックされ、");
  console.log("  ステートマシンに登録されない → 大台乖離率チェックに到達しない");

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
