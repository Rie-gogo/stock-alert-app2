/**
 * verify_direction_0803.ts
 * 8/3の各エントリーについて、方向性が正しかったか検証する
 * - エントリー後の最大順行幅（MFE）と最大逆行幅（MAE）
 * - エントリー後30分/60分/EODの価格推移
 * - 当日の始値→終値の方向性との一致
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/verify_direction_0803.ts
 */
import mysql from "mysql2/promise";

interface TradeEntry {
  symbol: string;
  symbolName: string;
  side: "long" | "short";
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  reason: string;
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);
  const today = "2026-08-03";

  // Get entries
  const [trades] = await conn.execute(
    `SELECT symbol, symbolName, side, tradeTime, price, pnl, reason, action
     FROM rt_trades WHERE tradeDate = ? ORDER BY tradeTime`, [today]
  ) as any[];

  // Pair entries with exits
  const entries: TradeEntry[] = [];
  const entryMap = new Map<string, any>();
  for (const t of trades) {
    if (t.action === "buy" || t.action === "short") {
      entryMap.set(`${t.symbol}_${t.side}`, t);
    } else {
      const key = `${t.symbol}_${t.side}`;
      const entry = entryMap.get(key);
      if (entry) {
        entries.push({
          symbol: entry.symbol,
          symbolName: entry.symbolName,
          side: entry.side,
          entryTime: entry.tradeTime,
          entryPrice: parseFloat(entry.price),
          exitTime: t.tradeTime,
          exitPrice: parseFloat(t.price),
          pnl: Number(t.pnl),
          reason: entry.reason,
        });
        entryMap.delete(key);
      }
    }
  }

  // Get all candles for today
  const [candles] = await conn.execute(
    `SELECT symbol, candleTime, open, high, low, close, volume
     FROM rt_candles WHERE tradeDate = ? ORDER BY symbol, candleTime`, [today]
  ) as any[];

  const candlesBySymbol = new Map<string, any[]>();
  for (const c of candles) {
    const arr = candlesBySymbol.get(c.symbol) || [];
    arr.push({
      time: c.candleTime,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: Number(c.volume),
    });
    candlesBySymbol.set(c.symbol, arr);
  }

  console.log("=" .repeat(100));
  console.log("8/3 エントリー方向性検証");
  console.log("=".repeat(100));

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const symbolCandles = candlesBySymbol.get(e.symbol) || [];
    const entryIdx = symbolCandles.findIndex((c: any) => c.time >= e.entryTime);
    
    if (entryIdx < 0) continue;

    // 当日の始値と終値
    const dayOpen = symbolCandles[0].open;
    const dayClose = symbolCandles[symbolCandles.length - 1].close;
    const dayDirection = dayClose > dayOpen ? "上昇" : dayClose < dayOpen ? "下落" : "横ばい";
    const dayChangePct = ((dayClose - dayOpen) / dayOpen * 100).toFixed(2);

    // エントリー後の値動き
    const afterEntry = symbolCandles.slice(entryIdx);
    
    // MFE (Maximum Favorable Excursion) - 最大順行幅
    // MAE (Maximum Adverse Excursion) - 最大逆行幅
    let mfe = 0, mae = 0;
    let mfeTime = "", maeTime = "";
    for (const c of afterEntry) {
      if (e.side === "long") {
        const favorable = (c.high - e.entryPrice) / e.entryPrice * 100;
        const adverse = (e.entryPrice - c.low) / e.entryPrice * 100;
        if (favorable > mfe) { mfe = favorable; mfeTime = c.time; }
        if (adverse > mae) { mae = adverse; maeTime = c.time; }
      } else {
        const favorable = (e.entryPrice - c.low) / e.entryPrice * 100;
        const adverse = (c.high - e.entryPrice) / e.entryPrice * 100;
        if (favorable > mfe) { mfe = favorable; mfeTime = c.time; }
        if (adverse > mae) { mae = adverse; maeTime = c.time; }
      }
    }

    // 30分後、60分後、EODの価格
    const entryMinutes = parseInt(e.entryTime.split(":")[0]) * 60 + parseInt(e.entryTime.split(":")[1]);
    const price30 = symbolCandles.find((c: any) => {
      const m = parseInt(c.time.split(":")[0]) * 60 + parseInt(c.time.split(":")[1]);
      return m >= entryMinutes + 30;
    });
    const price60 = symbolCandles.find((c: any) => {
      const m = parseInt(c.time.split(":")[0]) * 60 + parseInt(c.time.split(":")[1]);
      return m >= entryMinutes + 60;
    });
    const priceEOD = symbolCandles[symbolCandles.length - 1];

    // 方向性判定
    const eodPnlIfHeld = e.side === "long"
      ? (priceEOD.close - e.entryPrice) / e.entryPrice * 100
      : (e.entryPrice - priceEOD.close) / e.entryPrice * 100;
    const directionCorrect = eodPnlIfHeld > 0;

    console.log(`\n${"─".repeat(100)}`);
    console.log(`#${i + 1} ${e.symbol} ${e.symbolName} | ${e.side.toUpperCase()} | ${e.entryTime}→${e.exitTime} | @${e.entryPrice} | 損益: ${e.pnl >= 0 ? '+' : ''}${e.pnl.toLocaleString()}円`);
    console.log(`   シグナル: ${e.reason.substring(0, 80)}`);
    console.log(`   当日方向: ${dayDirection} (始値${dayOpen}→終値${dayClose}, ${dayChangePct}%)`);
    console.log(`   方向性判定: ${directionCorrect ? "✅ 正しい" : "❌ 逆方向"} (EODまで保有した場合: ${eodPnlIfHeld >= 0 ? '+' : ''}${eodPnlIfHeld.toFixed(2)}%)`);
    console.log(`   MFE(最大順行): +${mfe.toFixed(2)}% @${mfeTime}`);
    console.log(`   MAE(最大逆行): -${mae.toFixed(2)}% @${maeTime}`);
    if (price30) {
      const pnl30 = e.side === "long"
        ? (price30.close - e.entryPrice) / e.entryPrice * 100
        : (e.entryPrice - price30.close) / e.entryPrice * 100;
      console.log(`   30分後: ${pnl30 >= 0 ? '+' : ''}${pnl30.toFixed(2)}% @${price30.time} (${price30.close})`);
    }
    if (price60) {
      const pnl60 = e.side === "long"
        ? (price60.close - e.entryPrice) / e.entryPrice * 100
        : (e.entryPrice - price60.close) / e.entryPrice * 100;
      console.log(`   60分後: ${pnl60 >= 0 ? '+' : ''}${pnl60.toFixed(2)}% @${price60.time} (${price60.close})`);
    }
    console.log(`   EOD: ${eodPnlIfHeld >= 0 ? '+' : ''}${eodPnlIfHeld.toFixed(2)}% @${priceEOD.time} (${priceEOD.close})`);

    // エントリー前後5本の値動き
    const contextStart = Math.max(0, entryIdx - 3);
    const contextEnd = Math.min(symbolCandles.length, entryIdx + 8);
    console.log(`   前後の値動き:`);
    for (let j = contextStart; j < contextEnd; j++) {
      const c = symbolCandles[j];
      const marker = j === entryIdx ? " ← ENTRY" : "";
      console.log(`     ${c.time} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}${marker}`);
    }
  }

  // Summary
  console.log(`\n\n${"=".repeat(100)}`);
  console.log("方向性サマリー");
  console.log("=".repeat(100));
  let correctCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const symbolCandles = candlesBySymbol.get(e.symbol) || [];
    const priceEOD = symbolCandles[symbolCandles.length - 1];
    const eodPnlIfHeld = e.side === "long"
      ? (priceEOD.close - e.entryPrice) / e.entryPrice * 100
      : (e.entryPrice - priceEOD.close) / e.entryPrice * 100;
    const correct = eodPnlIfHeld > 0;
    if (correct) correctCount++;
    console.log(`  #${i + 1} ${e.symbol} ${e.symbolName} ${e.side.toUpperCase()} ${e.entryTime}: ${correct ? "✅" : "❌"} EOD${eodPnlIfHeld >= 0 ? '+' : ''}${eodPnlIfHeld.toFixed(2)}% | MFE+${entries[i] ? "" : ""}...`);
  }
  console.log(`\n  方向性正解率: ${correctCount}/${entries.length} (${(correctCount / entries.length * 100).toFixed(0)}%)`);

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
