/**
 * round_level_divergence_sim.ts
 * 大台乖離率フィルターの影響度シミュレーション
 * 
 * 現在の大台確認シグナルのエントリーについて:
 * - 大台からの乖離率を計算
 * - 各閾値(0.3%, 0.5%, 0.8%, 1.0%)でブロックされるトレードを特定
 * - ブロックされたトレードの損益を集計し、フィルターの有効性を評価
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/round_level_divergence_sim.ts
 */
import mysql from "mysql2/promise";
import { TARGET_STOCKS, TRADE_EXCLUDED_SYMBOLS } from "../shared/stocks";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);

  const activeSymbols = TARGET_STOCKS
    .filter(s => !TRADE_EXCLUDED_SYMBOLS.has(s.symbol))
    .map(s => s.symbol);

  // 全rt_tradesから大台確認シグナルのみ抽出
  const [allTrades] = await conn.execute(
    `SELECT symbol, symbolName, tradeDate, tradeTime, action, side, price, pnl, reason
     FROM rt_trades 
     WHERE symbol IN (${activeSymbols.map(() => "?").join(",")})
     ORDER BY tradeDate, tradeTime`,
    activeSymbols
  ) as any[];

  // エントリーと決済をペアリング
  interface TradePair {
    symbol: string;
    symbolName: string;
    tradeDate: string;
    side: string;
    entryTime: string;
    exitTime: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    entryReason: string;
    exitReason: string;
  }

  const pairs: TradePair[] = [];
  const pendingEntries = new Map<string, any>();
  for (const t of allTrades) {
    const key = `${t.tradeDate}_${t.symbol}_${t.side}`;
    if (t.action === "buy" || t.action === "short") {
      pendingEntries.set(key, t);
    } else {
      const entry = pendingEntries.get(key);
      if (entry) {
        pairs.push({
          symbol: entry.symbol,
          symbolName: entry.symbolName,
          tradeDate: entry.tradeDate,
          side: entry.side,
          entryTime: entry.tradeTime,
          exitTime: t.tradeTime,
          entryPrice: parseFloat(entry.price),
          exitPrice: parseFloat(t.price),
          pnl: Number(t.pnl),
          entryReason: entry.reason || "",
          exitReason: t.reason || "",
        });
        pendingEntries.delete(key);
      }
    }
  }

  // 大台確認シグナルのみ抽出
  const roundLevelTrades = pairs.filter(t => 
    t.entryReason.includes("大台確認") || t.entryReason.includes("大台超え") || t.entryReason.includes("大台割れ")
  );

  console.log("=".repeat(100));
  console.log("大台確認シグナル 乖離率分析");
  console.log("=".repeat(100));
  console.log(`全トレード: ${pairs.length}件 / うち大台確認: ${roundLevelTrades.length}件`);

  // 各トレードの大台からの乖離率を計算
  interface RoundLevelTradeWithDiv extends TradePair {
    roundLevel: number;
    divergencePct: number;
  }

  const tradesWithDiv: RoundLevelTradeWithDiv[] = [];

  for (const t of roundLevelTrades) {
    // reasonから大台レベルを抽出
    const matchYen = t.entryReason.match(/(\d+)円(突破|割り込み|割れ)/);
    let roundLevel = 0;
    if (matchYen) {
      roundLevel = parseInt(matchYen[1]);
    }

    if (roundLevel === 0) continue;

    // 乖離率計算
    const divergencePct = Math.abs(t.entryPrice - roundLevel) / roundLevel * 100;

    tradesWithDiv.push({
      ...t,
      roundLevel,
      divergencePct,
    });
  }

  console.log(`\n大台レベル特定成功: ${tradesWithDiv.length}件`);

  // 乖離率でソートして全件表示
  console.log("\n--- 全大台確認トレード（乖離率順） ---");
  console.log(
    "日付".padEnd(12) + "時間".padEnd(7) + "銘柄".padEnd(8) + "方向".padEnd(7) +
    "大台".padStart(8) + "エントリー".padStart(10) + "乖離率".padStart(8) +
    "損益".padStart(10) + "結果".padStart(6)
  );
  console.log("-".repeat(100));

  for (const t of tradesWithDiv.sort((a, b) => a.divergencePct - b.divergencePct)) {
    const result = t.pnl > 0 ? "勝ち" : "負け";
    console.log(
      t.tradeDate.padEnd(12) + t.entryTime.padEnd(7) + t.symbol.padEnd(8) +
      t.side.toUpperCase().padEnd(7) +
      `${t.roundLevel}`.padStart(8) + `${t.entryPrice}`.padStart(10) +
      `${t.divergencePct.toFixed(2)}%`.padStart(8) +
      `${t.pnl >= 0 ? '+' : ''}${Math.round(t.pnl).toLocaleString()}`.padStart(10) +
      result.padStart(6)
    );
  }

  // 乖離率閾値別の影響度
  console.log("\n\n" + "=".repeat(100));
  console.log("乖離率フィルター閾値別 影響度シミュレーション");
  console.log("=".repeat(100));

  const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.5];

  console.log("\n--- 閾値別サマリー ---");
  console.log(
    "閾値".padEnd(8) + "ブロック件数".padStart(12) + "ブロック率".padStart(10) +
    "ブロック損益".padStart(14) + "残存件数".padStart(10) + "残存損益".padStart(12) +
    "勝ちブロック".padStart(12) + "負けブロック".padStart(12)
  );
  console.log("-".repeat(100));

  const totalRoundPnl = tradesWithDiv.reduce((s, t) => s + t.pnl, 0);
  const totalRoundWins = tradesWithDiv.filter(t => t.pnl > 0).length;

  for (const threshold of thresholds) {
    const blocked = tradesWithDiv.filter(t => t.divergencePct >= threshold);
    const remaining = tradesWithDiv.filter(t => t.divergencePct < threshold);
    const blockedPnl = blocked.reduce((s, t) => s + t.pnl, 0);
    const remainingPnl = remaining.reduce((s, t) => s + t.pnl, 0);
    const blockedWins = blocked.filter(t => t.pnl > 0).length;
    const blockedLosses = blocked.filter(t => t.pnl <= 0).length;

    console.log(
      `${threshold}%`.padEnd(8) +
      `${blocked.length}/${tradesWithDiv.length}`.padStart(12) +
      `${(blocked.length / tradesWithDiv.length * 100).toFixed(0)}%`.padStart(10) +
      `${blockedPnl >= 0 ? '+' : ''}${Math.round(blockedPnl).toLocaleString()}円`.padStart(14) +
      `${remaining.length}件`.padStart(10) +
      `${remainingPnl >= 0 ? '+' : ''}${Math.round(remainingPnl).toLocaleString()}円`.padStart(12) +
      `${blockedWins}件`.padStart(12) +
      `${blockedLosses}件`.padStart(12)
    );
  }

  // 銘柄別の乖離率分布
  console.log("\n\n" + "=".repeat(100));
  console.log("銘柄別 大台乖離率分布");
  console.log("=".repeat(100));

  const bySymbol = new Map<string, RoundLevelTradeWithDiv[]>();
  for (const t of tradesWithDiv) {
    const arr = bySymbol.get(t.symbol) || [];
    arr.push(t);
    bySymbol.set(t.symbol, arr);
  }

  for (const [sym, trades] of [...bySymbol.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const name = TARGET_STOCKS.find(s => s.symbol === sym)?.name || sym;
    const divs = trades.map(t => t.divergencePct).sort((a, b) => a - b);
    const avgDiv = divs.reduce((s, d) => s + d, 0) / divs.length;
    const medDiv = divs[Math.floor(divs.length / 2)];
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

    console.log(`\n  ${sym} ${name} (${trades.length}件, ${wins.length}勝${losses.length}敗, 損益${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}円)`);
    console.log(`    乖離率: 平均${avgDiv.toFixed(2)}% | 中央値${medDiv.toFixed(2)}% | 最小${divs[0].toFixed(2)}% | 最大${divs[divs.length - 1].toFixed(2)}%`);
    
    // 勝ちと負けの乖離率比較
    if (wins.length > 0) {
      const winDivs = wins.map(t => t.divergencePct);
      console.log(`    勝ちの乖離率: 平均${(winDivs.reduce((s, d) => s + d, 0) / winDivs.length).toFixed(2)}% | 最大${Math.max(...winDivs).toFixed(2)}%`);
    }
    if (losses.length > 0) {
      const lossDivs = losses.map(t => t.divergencePct);
      console.log(`    負けの乖離率: 平均${(lossDivs.reduce((s, d) => s + d, 0) / lossDivs.length).toFixed(2)}% | 最大${Math.max(...lossDivs).toFixed(2)}%`);
    }

    // 0.5%閾値でのブロック影響
    const blocked05 = trades.filter(t => t.divergencePct >= 0.5);
    if (blocked05.length > 0) {
      const blocked05Pnl = blocked05.reduce((s, t) => s + t.pnl, 0);
      const blocked05Wins = blocked05.filter(t => t.pnl > 0).length;
      console.log(`    0.5%でブロック: ${blocked05.length}件 (${blocked05Wins}勝${blocked05.length - blocked05Wins}敗, ${blocked05Pnl >= 0 ? '+' : ''}${Math.round(blocked05Pnl).toLocaleString()}円)`);
    }
  }

  // 結論
  console.log("\n\n" + "=".repeat(100));
  console.log("結論");
  console.log("=".repeat(100));
  console.log(`\n  大台確認トレード全体: ${tradesWithDiv.length}件, ${totalRoundWins}勝${tradesWithDiv.length - totalRoundWins}敗`);
  console.log(`  総損益: ${totalRoundPnl >= 0 ? '+' : ''}${Math.round(totalRoundPnl).toLocaleString()}円`);
  console.log(`  平均乖離率: ${(tradesWithDiv.reduce((s, t) => s + t.divergencePct, 0) / tradesWithDiv.length).toFixed(2)}%`);

  // 非大台シグナルとの比較
  const nonRoundTrades = pairs.filter(t => 
    !t.entryReason.includes("大台確認") && !t.entryReason.includes("大台超え") && !t.entryReason.includes("大台割れ")
  );
  const nonRoundPnl = nonRoundTrades.reduce((s, t) => s + t.pnl, 0);
  const nonRoundWins = nonRoundTrades.filter(t => t.pnl > 0).length;
  console.log(`\n  非大台シグナル: ${nonRoundTrades.length}件, ${nonRoundWins}勝${nonRoundTrades.length - nonRoundWins}敗`);
  console.log(`  非大台損益: ${nonRoundPnl >= 0 ? '+' : ''}${Math.round(nonRoundPnl).toLocaleString()}円`);

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
