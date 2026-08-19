import mysql from "mysql2/promise";
async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);

  console.log("=== ② 逆三尊LONG検証 ===\n");

  // #4: 6976 14:05 @9791 LONG SL0.6%
  const [rows1] = await conn.query(`
    SELECT candleTime as t, high as h, low as l, close as c 
    FROM rt_candles WHERE tradeDate='2026-08-19' AND symbol='6976' AND candleTime >= '14:05' AND candleTime <= '15:25'
    ORDER BY candleTime
  `) as any[];
  const entry1 = 9791;
  let minLow1 = 99999, maxHigh1 = 0;
  for (const r of rows1 as any[]) { if (Number(r.l) < minLow1) minLow1 = Number(r.l); if (Number(r.h) > maxHigh1) maxHigh1 = Number(r.h); }
  const tp1 = entry1 * 1.015;
  console.log("#4 太陽誘電 14:05 @9,791円 LONG:");
  console.log("  最安値: " + minLow1 + " (乖離: -" + ((entry1-minLow1)/entry1*100).toFixed(2) + "%)");
  console.log("  最高値: " + maxHigh1 + " (乖離: +" + ((maxHigh1-entry1)/entry1*100).toFixed(2) + "%)");
  console.log("  TP(+" + tp1.toFixed(0) + "円)到達: " + (maxHigh1 >= tp1 ? "YES" : "NO"));
  for (const slPct of [0.4, 0.5, 0.6, 0.8, 1.0]) {
    const slP = entry1 * (1 - slPct/100);
    const hit = (rows1 as any[]).find((r:any) => Number(r.l) <= slP);
    console.log("  SL" + slPct + "%(" + slP.toFixed(0) + "円): " + (hit ? "到達@" + hit.t : "到達せず"));
  }
  const last1 = (rows1 as any[])[(rows1 as any[]).length - 1];
  console.log("  大引け: " + (last1 ? Number(last1.c) + "円 → PnL " + Math.round((Number(last1.c)-entry1)*200) + "円" : "N/A"));
  console.log("");

  // #5: 8035 14:30 @54560 LONG SL0.5%
  const [rows2] = await conn.query(`
    SELECT candleTime as t, high as h, low as l, close as c 
    FROM rt_candles WHERE tradeDate='2026-08-19' AND symbol='8035' AND candleTime >= '14:30' AND candleTime <= '15:25'
    ORDER BY candleTime
  `) as any[];
  const entry2 = 54560;
  let minLow2 = 999999, maxHigh2 = 0;
  for (const r of rows2 as any[]) { if (Number(r.l) < minLow2) minLow2 = Number(r.l); if (Number(r.h) > maxHigh2) maxHigh2 = Number(r.h); }
  const tp2 = entry2 * 1.015;
  console.log("#5 東京エレクトロン 14:30 @54,560円 LONG:");
  console.log("  最安値: " + minLow2 + " (乖離: -" + ((entry2-minLow2)/entry2*100).toFixed(2) + "%)");
  console.log("  最高値: " + maxHigh2 + " (乖離: +" + ((maxHigh2-entry2)/entry2*100).toFixed(2) + "%)");
  console.log("  TP(+" + tp2.toFixed(0) + "円)到達: " + (maxHigh2 >= tp2 ? "YES" : "NO"));
  for (const slPct of [0.3, 0.4, 0.5, 0.8, 1.0]) {
    const slP = entry2 * (1 - slPct/100);
    const hit = (rows2 as any[]).find((r:any) => Number(r.l) <= slP);
    console.log("  SL" + slPct + "%(" + slP.toFixed(0) + "円): " + (hit ? "到達@" + hit.t : "到達せず"));
  }
  const last2 = (rows2 as any[])[(rows2 as any[]).length - 1];
  console.log("  大引け: " + (last2 ? Number(last2.c) + "円 → PnL " + Math.round((Number(last2.c)-entry2)*100) + "円" : "N/A"));
  console.log("");

  // ③ ブロックされた4件の仮想損益
  console.log("=== ③ ブロックシグナルの仮想損益 ===\n");
  const blocks = [
    {symbol:"6857", time:"11:05", price:35830, sl:0.6, name:"アドバンテスト"},
    {symbol:"6146", time:"11:06", price:60550, sl:0.8, name:"ディスコ"},
    {symbol:"6857", time:"13:39", price:35160, sl:0.6, name:"アドバンテスト"},
    {symbol:"6857", time:"13:40", price:35060, sl:0.6, name:"アドバンテスト"},
  ];
  let totalBlockPnl = 0;
  for (const b of blocks) {
    const [rows] = await conn.query(`
      SELECT candleTime as t, high as h, low as l, close as c 
      FROM rt_candles WHERE tradeDate='2026-08-19' AND symbol='${b.symbol}' AND candleTime >= '${b.time}' AND candleTime <= '15:25'
      ORDER BY candleTime
    `) as any[];
    const slPrice = b.price * (1 + b.sl/100);
    const tpPrice = b.price * (1 - 1.5/100);
    const shares = Math.floor(3000000 / b.price / 100) * 100 || 100;
    let result = "EOD"; let pnl = 0; let exitTime = "15:25";
    for (const r of rows as any[]) {
      if (Number(r.h) >= slPrice) { result = "SL"; pnl = Math.round((b.price - slPrice) * shares); exitTime = r.t; break; }
      if (Number(r.l) <= tpPrice) { result = "TP"; pnl = Math.round((b.price - tpPrice) * shares); exitTime = r.t; break; }
    }
    if (result === "EOD") {
      const last = (rows as any[])[(rows as any[]).length - 1];
      pnl = last ? Math.round((b.price - Number(last.c)) * shares) : 0;
    }
    totalBlockPnl += pnl;
    console.log(b.name + "(" + b.symbol + ") " + b.time + " SHORT @" + b.price.toLocaleString() + "円 ×" + shares + "株 → " + result + "(" + exitTime + ") " + (pnl>=0?"+":"") + pnl.toLocaleString() + "円");
  }
  console.log("\nブロック4件合計: " + (totalBlockPnl>=0?"+":"") + totalBlockPnl.toLocaleString() + "円");
  console.log("本日実績(-8,349円) + ブロック分 = " + (totalBlockPnl - 8349 >= 0 ? "+" : "") + (totalBlockPnl - 8349).toLocaleString() + "円");

  await conn.end();
}
main();
