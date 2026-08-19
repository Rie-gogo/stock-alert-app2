import mysql from "mysql2/promise";
async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  const blocks = [
    {symbol:"6857", time:"11:05", price:35830, result:"TP +53,745円", win:true, sig:"大台割れ"},
    {symbol:"6146", time:"11:06", price:60550, result:"EOD +52,000円", win:true, sig:"ダウ理論"},
    {symbol:"6857", time:"13:39", price:35160, result:"SL -21,096円", win:false, sig:"ダウ理論"},
    {symbol:"6857", time:"13:40", price:35060, result:"SL -21,036円", win:false, sig:"ダウ理論"},
  ];
  console.log("=== ブロック4件 プラス/マイナス共通点分析 ===\n");
  for (const b of blocks) {
    const [rows] = await conn.query(
      "SELECT candleTime as t, open as o, high as h, low as l, close as c, volume as v FROM rt_candles WHERE tradeDate='2026-08-19' AND symbol=? AND candleTime <= ? ORDER BY candleTime",
      [b.symbol, b.time]
    ) as any[];
    const candles = rows as any[];
    const last20 = candles.slice(-20);
    const entryCandle = candles[candles.length - 1];
    const prev10 = candles.slice(-11, -1);
    const avgVol = prev10.reduce((s:number,c:any) => s + Number(c.v), 0) / prev10.length;
    const bearBars = prev10.filter((c:any) => Number(c.c) < Number(c.o)).length;
    const priceChange = prev10.length > 1 ? ((Number(entryCandle.c) - Number(prev10[0].o)) / Number(prev10[0].o) * 100).toFixed(3) : "?";
    // MA8計算
    const last8 = candles.slice(-9, -1).map((c:any) => Number(c.c));
    const last9 = candles.slice(-10, -2).map((c:any) => Number(c.c));
    const ma8 = last8.reduce((s,v) => s+v, 0) / 8;
    const prevMa8 = last9.reduce((s,v) => s+v, 0) / 8;
    const ma8Slope = ((ma8 - prevMa8) / prevMa8 * 100).toFixed(4);
    // 当日始値からの変化率
    const dayOpen = candles.length > 0 ? Number(candles[0].o) : 0;
    const fromOpen = ((Number(entryCandle.c) - dayOpen) / dayOpen * 100).toFixed(2);
    
    console.log((b.win ? "★WIN" : "✗LOSE") + " | " + b.symbol + " " + b.time + " | " + b.sig + " | " + b.result);
    console.log("  価格: @" + b.price + "円 | 始値比: " + fromOpen + "% | MA8傾き: " + ma8Slope + "%");
    console.log("  直前10本: 陰線" + bearBars + "/10本 | 出来高倍率: " + (Number(entryCandle.v) / avgVol).toFixed(2) + "倍 | 10本変化率: " + priceChange + "%");
    console.log("  時刻: " + b.time + " (" + (b.time < "12:00" ? "前場" : "後場") + ")");
    console.log("");
  }
  
  console.log("=== 共通点まとめ ===\n");
  console.log("プラス取引(11:05, 11:06): 前場・下落トレンド初動");
  console.log("マイナス取引(13:39, 13:40): 後場・既に大幅下落後の反発局面");
  
  await conn.end();
}
main();
