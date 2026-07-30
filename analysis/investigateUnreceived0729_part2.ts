import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // 未受信銘柄と受信銘柄の特徴比較
  const missing = ["285A", "6526", "6976", "3436", "3778", "5016"];
  const received = ["4568", "5803", "6723", "6758", "6857", "6920", "6981", "7011", "7203", "8035", "8306", "8316", "9107", "9984"];

  console.log("=== 未受信6銘柄 vs 受信14銘柄の特徴比較 ===\n");
  
  // stocks.tsの情報に基づく
  const stockInfo: Record<string, {name: string, sector: string, basePrice: number, ticker: string}> = {
    "8035": { name: "東京エレクトロン", sector: "半導体", basePrice: 24800, ticker: "8035.T" },
    "6857": { name: "アドバンテスト", sector: "半導体", basePrice: 8800, ticker: "6857.T" },
    "6976": { name: "太陽誘電", sector: "電子部品", basePrice: 14500, ticker: "6976.T" },
    "6526": { name: "ソシオネクスト", sector: "半導体", basePrice: 3250, ticker: "6526.T" },
    "5803": { name: "フジクラ", sector: "電線", basePrice: 4400, ticker: "5803.T" },
    "6981": { name: "村田製作所", sector: "電子部品", basePrice: 10000, ticker: "6981.T" },
    "285A": { name: "キオクシアHD", sector: "半導体", basePrice: 70000, ticker: "285A.T" },
    "6920": { name: "レーザーテック", sector: "半導体", basePrice: 22400, ticker: "6920.T" },
    "6758": { name: "ソニーグループ", sector: "電機", basePrice: 3650, ticker: "6758.T" },
    "8316": { name: "三井住友FG", sector: "銀行", basePrice: 3900, ticker: "8316.T" },
    "9984": { name: "ソフトバンクG", sector: "通信・投資", basePrice: 8420, ticker: "9984.T" },
    "7011": { name: "三菱重工業", sector: "機械", basePrice: 2900, ticker: "7011.T" },
    "9107": { name: "川崎汽船", sector: "海運", basePrice: 2100, ticker: "9107.T" },
    "8306": { name: "三菱UFJ FG", sector: "銀行", basePrice: 1650, ticker: "8306.T" },
    "4568": { name: "第一三共", sector: "医薬", basePrice: 4500, ticker: "4568.T" },
    "5016": { name: "JX金属", sector: "非鉄", basePrice: 3600, ticker: "5016.T" },
    "7203": { name: "トヨタ自動車", sector: "自動車", basePrice: 2800, ticker: "7203.T" },
    "3778": { name: "さくらインターネット", sector: "IT", basePrice: 4100, ticker: "3778.T" },
    "3436": { name: "SUMCO", sector: "半導体材料", basePrice: 4100, ticker: "3436.T" },
    "6723": { name: "ルネサスエレクトロニクス", sector: "半導体", basePrice: 2200, ticker: "6723.T" },
  };

  console.log("【未受信銘柄】");
  console.log(`${"銘柄".padEnd(6)} ${"名前".padEnd(20)} ${"セクター".padEnd(12)} ${"基準価格".padStart(10)} ${"ticker".padEnd(8)}`);
  for (const sym of missing) {
    const info = stockInfo[sym];
    console.log(`${sym.padEnd(6)} ${info.name.padEnd(20)} ${info.sector.padEnd(12)} ${String(info.basePrice).padStart(10)} ${info.ticker.padEnd(8)}`);
  }

  console.log("\n【受信銘柄】");
  console.log(`${"銘柄".padEnd(6)} ${"名前".padEnd(20)} ${"セクター".padEnd(12)} ${"基準価格".padStart(10)} ${"ticker".padEnd(8)}`);
  for (const sym of received) {
    const info = stockInfo[sym];
    console.log(`${sym.padEnd(6)} ${info.name.padEnd(20)} ${info.sector.padEnd(12)} ${String(info.basePrice).padStart(10)} ${info.ticker.padEnd(8)}`);
  }

  // 共通点分析
  console.log("\n\n=== 共通点分析 ===\n");
  
  // ticker形式の分析
  console.log("1. ticker形式:");
  console.log(`   未受信: ${missing.map(s => stockInfo[s].ticker).join(", ")}`);
  console.log(`   受信:   ${received.map(s => stockInfo[s].ticker).join(", ")}`);
  
  // 数値コードか英数字混合か
  const missingNumeric = missing.filter(s => /^\d+$/.test(s));
  const missingAlpha = missing.filter(s => /[A-Z]/.test(s));
  console.log(`\n2. 銘柄コード形式:`);
  console.log(`   未受信 - 数字のみ: ${missingNumeric.join(", ")} (${missingNumeric.length}件)`);
  console.log(`   未受信 - 英字含む: ${missingAlpha.join(", ")} (${missingAlpha.length}件)`);
  console.log(`   受信 - 数字のみ: ${received.filter(s => /^\d+$/.test(s)).join(", ")} (${received.filter(s => /^\d+$/.test(s)).length}件)`);
  console.log(`   受信 - 英字含む: ${received.filter(s => /[A-Z]/.test(s)).join(", ")} (${received.filter(s => /[A-Z]/.test(s)).length}件)`);

  // セクター分析
  console.log(`\n3. セクター:`);
  console.log(`   未受信: ${[...new Set(missing.map(s => stockInfo[s].sector))].join(", ")}`);
  console.log(`   受信:   ${[...new Set(received.map(s => stockInfo[s].sector))].join(", ")}`);

  // 価格帯分析
  const missingPrices = missing.map(s => stockInfo[s].basePrice);
  const receivedPrices = received.map(s => stockInfo[s].basePrice);
  console.log(`\n4. 基準価格帯:`);
  console.log(`   未受信: ${Math.min(...missingPrices)} ~ ${Math.max(...missingPrices)} (平均: ${Math.round(missingPrices.reduce((a,b)=>a+b,0)/missingPrices.length)})`);
  console.log(`   受信:   ${Math.min(...receivedPrices)} ~ ${Math.max(...receivedPrices)} (平均: ${Math.round(receivedPrices.reduce((a,b)=>a+b,0)/receivedPrices.length)})`);

  // 7/28の受信開始時刻分析（遅い銘柄が7/29で欠落した可能性）
  console.log("\n\n=== 7/28の受信開始時刻と7/29欠落の相関 ===\n");
  const [rows28] = await db.execute(sql`
    SELECT symbol, MIN(candleTime) as firstCandle
    FROM rt_candles
    WHERE tradeDate = '2026-07-28'
    GROUP BY symbol
    ORDER BY firstCandle DESC
  `);
  
  console.log("7/28の受信開始時刻（遅い順）:");
  for (const row of rows28 as any[]) {
    const isMissing = missing.includes(row.symbol);
    console.log(`  ${row.firstCandle} - ${row.symbol} ${isMissing ? "❌ 7/29未受信" : "✅"}`);
  }

  // 7/23-7/28で欠落した日があるか確認
  console.log("\n\n=== 過去に欠落した日があるか（7/1以降） ===\n");
  const [allDates] = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE tradeDate >= '2026-07-01' ORDER BY tradeDate
  `);
  const tradingDates = (allDates as any[]).map(r => r.tradeDate);
  
  console.log(`取引日数: ${tradingDates.length}日`);
  console.log(`日付: ${tradingDates.join(", ")}`);
  
  // 各銘柄がどの日に欠落しているか
  console.log("\n銘柄別欠落日:");
  for (const sym of [...missing, ...received].sort()) {
    const [present] = await db.execute(sql`
      SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = ${sym} AND tradeDate >= '2026-07-01' ORDER BY tradeDate
    `);
    const presentDates = new Set((present as any[]).map(r => r.tradeDate));
    const missingDates = tradingDates.filter(d => !presentDates.has(d));
    if (missingDates.length > 0) {
      const isMissing0729 = missing.includes(sym);
      console.log(`  ${sym} ${isMissing0729 ? "❌" : "✅"}: 欠落日 = ${missingDates.join(", ")} (${missingDates.length}日)`);
    }
  }

  // KABUステーション側の銘柄登録順序の推測
  console.log("\n\n=== TARGET_STOCKSの定義順序と受信状況 ===\n");
  const targetOrder = ["8035","6857","6976","6526","5803","6981","285A","6920","6758","8316","9984","7011","9107","8306","4568","5016","7203","3778","3436","6723"];
  
  console.log(`${"#".padStart(3)} ${"銘柄".padEnd(6)} ${"7/29受信".padEnd(10)} ${"位置"}`);
  for (let i = 0; i < targetOrder.length; i++) {
    const sym = targetOrder[i];
    const isMissing0729 = missing.includes(sym);
    console.log(`${String(i+1).padStart(3)} ${sym.padEnd(6)} ${isMissing0729 ? "❌ 未受信" : "✅ 受信  "} ${i < 7 ? "アクティブ前半" : i < 10 ? "7/23復活" : "除外銘柄"}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
