import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const r0 = await db.execute(
    sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate`
  );
  const dates = (r0 as any)[0].map((d: any) => d.tradeDate);

  const configs = [
    { drop: 2.0, sl: 0.005, tp: 0.005, amOnly: true, label: "落2%/SL0.5%/TP0.5%/前場" },
    { drop: 2.0, sl: 0.006, tp: 0.005, amOnly: true, label: "落2%/SL0.6%/TP0.5%/前場" },
    { drop: 2.0, sl: 0.005, tp: 0.005, amOnly: false, label: "落2%/SL0.5%/TP0.5%/全日" },
    { drop: 2.0, sl: 0.006, tp: 0.005, amOnly: false, label: "落2%/SL0.6%/TP0.5%/全日" },
    { drop: 3.0, sl: 0.005, tp: 0.005, amOnly: true, label: "落3%/SL0.5%/TP0.5%/前場" },
    { drop: 3.0, sl: 0.006, tp: 0.005, amOnly: true, label: "落3%/SL0.6%/TP0.5%/前場" },
    { drop: 3.0, sl: 0.008, tp: 0.005, amOnly: true, label: "落3%/SL0.8%/TP0.5%/前場" },
    { drop: 3.0, sl: 0.005, tp: 0.008, amOnly: true, label: "落3%/SL0.5%/TP0.8%/前場" },
    { drop: 3.0, sl: 0.006, tp: 0.008, amOnly: true, label: "落3%/SL0.6%/TP0.8%/前場" },
    { drop: 3.0, sl: 0.005, tp: 0.005, amOnly: false, label: "落3%/SL0.5%/TP0.5%/全日" },
    { drop: 3.0, sl: 0.006, tp: 0.005, amOnly: false, label: "落3%/SL0.6%/TP0.5%/全日" },
    { drop: 4.0, sl: 0.005, tp: 0.005, amOnly: true, label: "落4%/SL0.5%/TP0.5%/前場" },
    { drop: 4.0, sl: 0.006, tp: 0.005, amOnly: true, label: "落4%/SL0.6%/TP0.5%/前場" },
    { drop: 4.0, sl: 0.005, tp: 0.005, amOnly: false, label: "落4%/SL0.5%/TP0.5%/全日" },
    { drop: 4.0, sl: 0.006, tp: 0.005, amOnly: false, label: "落4%/SL0.6%/TP0.5%/全日" },
    { drop: 5.0, sl: 0.005, tp: 0.005, amOnly: true, label: "落5%/SL0.5%/TP0.5%/前場" },
    { drop: 5.0, sl: 0.005, tp: 0.005, amOnly: false, label: "落5%/SL0.5%/TP0.5%/全日" },
  ];

  console.log("=== 285A 反転LONGパラメータスイープ ===");
  console.log("条件: 当日高値からX%以上下落 → MA8上向き → 直近10本高値更新 → LONG");
  console.log("");

  for (const cfg of configs) {
    let totalTrades = 0, totalWins = 0, totalPnl = 0;

    for (const date of dates) {
      const r = await db.execute(sql`
        SELECT candleTime, open, high, low, close, volume
        FROM rt_candles WHERE symbol = '285A' AND tradeDate = ${date} ORDER BY candleTime
      `);
      const candles = (r as any)[0] as any[];
      if (candles.length < 30) continue;

      const closes: number[] = [];
      let dayHigh = 0;
      let entryDone = false;

      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const cl = Number(c.close);
        const hi = Number(c.high);
        closes.push(cl);
        if (hi > dayHigh) dayHigh = hi;

        // 時間フィルター
        if (c.candleTime < "09:30") continue;
        if (cfg.amOnly && c.candleTime > "11:27") continue;
        // 後場序盤禁止
        if (c.candleTime >= "12:30" && c.candleTime <= "12:50") continue;
        if (entryDone) continue;

        // 条件1: 当日高値からX%以上下落
        const dropFromHigh = (dayHigh - cl) / dayHigh * 100;
        if (dropFromHigh < cfg.drop) continue;

        // 条件2: MA8上向き
        if (closes.length < 9) continue;
        const ma8 = closes.slice(-8).reduce((a, b) => a + b, 0) / 8;
        const prevMA8 = closes.slice(-9, -1).reduce((a, b) => a + b, 0) / 8;
        if (ma8 <= prevMA8) continue;

        // 条件3: 直近10本の高値を更新
        const recent10 = candles.slice(Math.max(0, i - 10), i).map((x: any) => Number(x.high));
        if (recent10.length > 0 && hi <= Math.max(...recent10)) continue;

        // エントリー
        const entryPrice = cl;
        const tp = entryPrice * (1 + cfg.tp);
        const sl = entryPrice * (1 - cfg.sl);

        let pnl = 0;
        for (let j = i + 1; j < candles.length; j++) {
          const fc = candles[j];
          if (Number(fc.high) >= tp) { pnl = Math.round(entryPrice * cfg.tp * 100); break; }
          if (Number(fc.low) <= sl) { pnl = -Math.round(entryPrice * cfg.sl * 100); break; }
          if (fc.candleTime === "11:27" && cfg.amOnly) {
            pnl = Math.round((Number(fc.close) - entryPrice) * 100);
            break;
          }
          if (fc.candleTime >= "11:30" && fc.candleTime < "12:30") continue;
          if (j === candles.length - 1) {
            pnl = Math.round((Number(fc.close) - entryPrice) * 100);
          }
        }

        totalTrades++;
        if (pnl > 0) totalWins++;
        totalPnl += pnl;
        entryDone = true;
      }
    }

    const wr = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : "0";
    const pf = totalWins > 0 && totalTrades > totalWins
      ? (totalPnl > 0 ? "PF+" : "PF-")
      : "";
    console.log(
      `${cfg.label}: ${totalTrades}件 ${totalWins}勝${totalTrades - totalWins}敗 勝率${wr}% ${totalPnl > 0 ? "+" : ""}${totalPnl}円`
    );
  }

  // 最良設定で個別取引を表示
  console.log("\n=== 最良設定（落3%/SL0.5%/TP0.5%/全日）の個別取引 ===");
  const bestCfg = { drop: 3.0, sl: 0.005, tp: 0.005 };

  for (const date of dates) {
    const r = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume
      FROM rt_candles WHERE symbol = '285A' AND tradeDate = ${date} ORDER BY candleTime
    `);
    const candles = (r as any)[0] as any[];
    if (candles.length < 30) continue;

    const closes: number[] = [];
    let dayHigh = 0;
    let entryDone = false;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const cl = Number(c.close);
      const hi = Number(c.high);
      closes.push(cl);
      if (hi > dayHigh) dayHigh = hi;

      if (c.candleTime < "09:30") continue;
      if (c.candleTime >= "12:30" && c.candleTime <= "12:50") continue;
      if (entryDone) continue;

      const dropFromHigh = (dayHigh - cl) / dayHigh * 100;
      if (dropFromHigh < bestCfg.drop) continue;

      if (closes.length < 9) continue;
      const ma8 = closes.slice(-8).reduce((a, b) => a + b, 0) / 8;
      const prevMA8 = closes.slice(-9, -1).reduce((a, b) => a + b, 0) / 8;
      if (ma8 <= prevMA8) continue;

      const recent10 = candles.slice(Math.max(0, i - 10), i).map((x: any) => Number(x.high));
      if (recent10.length > 0 && hi <= Math.max(...recent10)) continue;

      const entryPrice = cl;
      const tp = entryPrice * (1 + bestCfg.tp);
      const sl = entryPrice * (1 - bestCfg.sl);

      let pnl = 0;
      let result = "大引け";
      for (let j = i + 1; j < candles.length; j++) {
        const fc = candles[j];
        if (Number(fc.high) >= tp) { pnl = Math.round(entryPrice * bestCfg.tp * 100); result = "利確"; break; }
        if (Number(fc.low) <= sl) { pnl = -Math.round(entryPrice * bestCfg.sl * 100); result = "損切り"; break; }
        if (fc.candleTime >= "11:30" && fc.candleTime < "12:30") continue;
        if (j === candles.length - 1) { pnl = Math.round((Number(fc.close) - entryPrice) * 100); result = "大引け"; }
      }

      const mark = pnl > 0 ? "✓" : "✗";
      console.log(
        `${mark} ${date} ${c.candleTime} LONG @${entryPrice} 落:${dropFromHigh.toFixed(1)}% → ${result} ${pnl > 0 ? "+" : ""}${pnl}円`
      );
      entryDone = true;
    }
  }

  process.exit(0);
}

main();
