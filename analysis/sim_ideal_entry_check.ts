import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

// ユーザー指定の理想エントリータイミングで、シグナルが発火できたか調査
// LONG: 8035 9:30-9:40, 6146 9:30-9:50, 6857 9:30-9:50, 6981 9:40-10:05
// SHORT: 6981 10:44-12:56, 5803 10:09-12:35, 285A 10:10-13:00, 6146 10:10-11:05

const IS_BULLISH_MA_PERIOD = 8;

async function main() {
  const db = await getDb();
  const date = "2026-08-19";
  
  const targets = [
    { sym: "8035", side: "long", start: "09:30", end: "09:40", desc: "東京エレクトロン LONG" },
    { sym: "6146", side: "long", start: "09:30", end: "09:50", desc: "ディスコ LONG" },
    { sym: "6857", side: "long", start: "09:30", end: "09:50", desc: "アドバンテスト LONG" },
    { sym: "6981", side: "long", start: "09:40", end: "10:05", desc: "村田製作所 LONG" },
    { sym: "6981", side: "short", start: "10:44", end: "12:56", desc: "村田製作所 SHORT" },
    { sym: "5803", side: "short", start: "10:09", end: "12:35", desc: "フジクラ SHORT" },
    { sym: "285A", side: "short", start: "10:10", end: "13:00", desc: "キオクシア SHORT" },
    { sym: "6146", side: "short", start: "10:10", end: "11:05", desc: "ディスコ SHORT" },
  ];
  
  for (const t of targets) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`【${t.desc}】 理想エントリー: ${t.start}〜${t.end}`);
    console.log(`${"=".repeat(60)}`);
    
    // この時間帯のローソク足を取得
    const [rows] = await db.execute(sql`SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol=${t.sym} AND tradeDate=${date} AND candleTime >= ${t.start} AND candleTime <= ${t.end} ORDER BY candleTime`);
    const candles = (rows as any[]).map(r => ({...r, open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume:+r.volume}));
    
    // バッファ（この時間帯以前のデータ）
    const [bufRows] = await db.execute(sql`SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol=${t.sym} AND tradeDate=${date} AND candleTime < ${t.end} ORDER BY candleTime`);
    const allCandles = (bufRows as any[]).map(r => ({...r, open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume:+r.volume}));
    
    console.log(`  値動き: ${candles[0]?.close}円 → ${candles[candles.length-1]?.close}円 (${((candles[candles.length-1]?.close - candles[0]?.close)/candles[0]?.close*100).toFixed(2)}%)`);
    
    // 各足でシグナル条件を確認
    console.log(`\n  --- 各足でのシグナル条件チェック ---`);
    
    for (const c of candles) {
      const idx = allCandles.findIndex(ac => ac.candleTime === c.candleTime);
      if (idx < 20) continue;
      
      const buffer = allCandles.slice(0, idx + 1);
      
      // isBullish計算
      let isBullish = false;
      let maSlope = 0;
      if (buffer.length >= IS_BULLISH_MA_PERIOD + 1) {
        const ma = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s, b) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
        const prevMa = buffer.slice(-IS_BULLISH_MA_PERIOD - 1, -1).reduce((s, b) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
        maSlope = (ma - prevMa) / prevMa * 100;
        isBullish = maSlope > 0;
      }
      
      // 大台超え/割れ検出
      const prev = buffer[buffer.length - 2];
      let roundSignal = "";
      for (const rl of [100, 500, 1000, 5000, 10000]) {
        if (t.side === "long") {
          const near = Math.ceil(c.close / rl) * rl;
          if (prev.close < near && c.close >= near) roundSignal = `大台超え(${near}円)`;
        } else {
          const near = Math.floor(prev.close / rl) * rl;
          if (prev.close >= near && c.close < near) roundSignal = `大台割れ(${near}円)`;
        }
      }
      
      // ダウ理論（直近高値/安値更新）
      let dowSignal = "";
      if (buffer.length >= 21) {
        const recent20 = buffer.slice(-21, -1);
        if (t.side === "long") {
          const maxHigh = Math.max(...recent20.map(b => b.high));
          if (c.close > maxHigh) dowSignal = `直近高値更新(${maxHigh.toFixed(0)}円突破)`;
        } else {
          const minLow = Math.min(...recent20.map(b => b.low));
          if (c.close < minLow) dowSignal = `直近安値更新(${minLow.toFixed(0)}円割れ)`;
        }
      }
      
      // 静かな上昇バイパス条件
      let quietRise = "";
      if (t.side === "long" && buffer.length >= IS_BULLISH_MA_PERIOD) {
        const ma = buffer.slice(-IS_BULLISH_MA_PERIOD).reduce((s, b) => s + b.close, 0) / IS_BULLISH_MA_PERIOD;
        const maDeviation = Math.abs((c.close - ma) / ma * 100);
        const barBody = Math.abs((c.close - c.open) / c.open * 100);
        const bearBars = buffer.slice(-10).filter(b => b.close < b.open).length;
        quietRise = `MA乖離${maDeviation.toFixed(3)}% 実体${barBody.toFixed(3)}% 陰線${bearBars}本`;
        if (maDeviation < 0.5 && barBody < 0.2 && bearBars <= 4) quietRise += " ✓バイパス可";
      }
      
      // 出来高
      const vol20 = buffer.length >= 21 ? buffer.slice(-21, -1).reduce((s, b) => s + b.volume, 0) / 20 : 0;
      const volRatio = vol20 > 0 ? (c.volume / vol20).toFixed(1) : "N/A";
      
      // ブロック理由
      let blockReasons: string[] = [];
      if (t.side === "long" && !isBullish) blockReasons.push(`isBullish=false(MA8傾き${maSlope.toFixed(4)}%)→LONGバイパス不可`);
      if (t.side === "short" && isBullish) blockReasons.push(`isBullish=true(MA8傾き${maSlope.toFixed(4)}%)→SHORT禁止`);
      if (t.side === "long" && roundSignal) blockReasons.push(`大台超えLONG停止中`);
      
      // シグナルが出ている足のみ表示
      if (roundSignal || dowSignal || (c.candleTime === candles[0].candleTime) || (c.candleTime === candles[candles.length-1].candleTime)) {
        console.log(`  ${c.candleTime} @${c.close} | isBullish=${isBullish}(${maSlope.toFixed(4)}%) vol=${volRatio}x`);
        if (roundSignal) console.log(`    シグナル: ${roundSignal}`);
        if (dowSignal) console.log(`    シグナル: ${dowSignal}`);
        if (quietRise) console.log(`    バイパス: ${quietRise}`);
        if (blockReasons.length) console.log(`    ★ブロック: ${blockReasons.join(", ")}`);
      }
    }
    
    // この時間帯でエントリーできていたら損益はどうだったか
    if (candles.length > 0) {
      const entryPrice = candles[0].close;
      // 時間帯終了時の価格
      const exitPrice = candles[candles.length - 1].close;
      const lots = {"8035":100,"6857":100,"285A":100,"6146":100,"6976":200,"6981":300,"8316":400,"5803":400,"6526":1400,"6594":1000}[t.sym] || 100;
      const pnl = t.side === "long" ? (exitPrice - entryPrice) * lots : (entryPrice - exitPrice) * lots;
      // 最大含み益
      const maxFav = t.side === "long" 
        ? Math.max(...candles.map(c => c.high)) - entryPrice
        : entryPrice - Math.min(...candles.map(c => c.low));
      console.log(`\n  ★ 理想エントリー結果: @${entryPrice}→@${exitPrice} ${pnl>0?"+":""}${Math.round(pnl).toLocaleString()}円 (最大含み益: +${(maxFav/entryPrice*100).toFixed(2)}%)`);
    }
  }
  
  process.exit(0);
}
main();
