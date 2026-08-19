/**
 * 前場ブーストで発火するBUYシグナルの内訳を調べる
 * ダウ理論高値更新が押し目ステートマシンに流れてしまう問題の影響を確認
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 全BUYシグナルの種類を分類
const SIGNAL_CATEGORIES = {
  "ダウ理論高値更新": "押し目ステートマシン行き",
  "大台超え": "確認バーステートマシン行き（逆張りSHORT用）",
  "ゴールデンクロス": "直接エントリー可能",
  "逆三尊": "バイパス除外（!isInverseHS）",
  "インバースH&S": "バイパス除外（!isInverseHS）",
  "VWAPクロス上抜け": "無効化済み（ブロック）",
  "VWAP反発": "直接エントリー可能",
  "ダブルボトム": "直接エントリー可能",
  "RSI売られすぎ": "直接エントリー可能",
  "強気はらみ": "直接エントリー可能",
  "長い下ヒゲ": "直接エントリー可能",
};

// 10銘柄のデータを読み込み
const SYMBOLS = ["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6146", "6594", "8316"];
const IS_BULLISH_MA_PERIOD = 8;
const IS_BULLISH_SLOPE_THRESHOLD = 0;

// シグナル検出関数をインポート
const { detectSignals } = require("../server/routers/stockData");

let totalBuySignals = 0;
let amBuySignals = 0;
let signalBreakdown: Record<string, { total: number; am: number; amBoosted: number }> = {};

// 前場ブースト条件チェック
function checkAMBoost(buffer: any[], candle: any, isBullish: boolean): { boost: boolean; volBreak: boolean; reason: string } {
  const ma = buffer.length >= IS_BULLISH_MA_PERIOD
    ? buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD).reduce((s: number, c: any) => s + c.close, 0) / IS_BULLISH_MA_PERIOD
    : 0;
  const maDeviation = ma > 0 ? (candle.close - ma) / ma * 100 : 999;
  const barBody = Math.abs(candle.close - candle.open) / candle.open * 100;
  const recentBearBars = buffer.length >= 10
    ? buffer.slice(buffer.length - 10).filter((c: any) => c.close < c.open).length
    : 999;
  
  const isInverseHS = false; // シグナル名で判定するので後で
  
  // 静かな上昇バイパス
  const quietRise = isBullish && maDeviation < 0.5 && barBody < 0.2 && recentBearBars <= 4;
  // 前場ブースト
  const amBoost = isBullish && maDeviation < 1.0 && barBody < 0.5 && recentBearBars <= 5;
  // 出来高ブレイク
  let volBreak = false;
  if (isBullish && buffer.length >= 21) {
    const volLookback = buffer.slice(buffer.length - 21, buffer.length - 1);
    const avgVol = volLookback.reduce((s: number, c: any) => s + c.volume, 0) / 20;
    const volRatio = avgVol > 0 ? candle.volume / avgVol : 0;
    if (volRatio >= 1.5) volBreak = true;
  }
  
  return {
    boost: amBoost || quietRise,
    volBreak,
    reason: quietRise ? "静かな上昇" : amBoost ? "前場ブースト" : volBreak ? "出来高ブレイク" : "なし"
  };
}

async function main() {
  // 20営業日分のデータを読み込み
  const tradingDays: string[] = [];
  
  for (const sym of SYMBOLS) {
    const dataPath = `${__dirname}/jq_data/${sym}.json`;
    if (!fs.existsSync(dataPath)) continue;
    const rawData = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
    
    // 日付ごとにグループ化
    const byDate: Record<string, any[]> = {};
    for (const c of rawData) {
      const d = c.date || c.Date || c.d;
      if (!d) continue;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(c);
    }
    
    const dates = Object.keys(byDate).sort().slice(-20);
    
    for (const date of dates) {
      const candles = byDate[date].sort((a: any, b: any) => (a.time || a.Time || "").localeCompare(b.time || b.Time || ""));
      if (candles.length < 30) continue;
      
      // バッファ構築
      const buffer: any[] = [];
      for (const raw of candles) {
        const time = raw.time || raw.Time || raw.t || "";
        if (time < "09:00" || time > "15:30") continue;

        buffer.push({
          symbol: sym,
          open: raw.open || raw.Open || raw.O,
          high: raw.high || raw.High || raw.H,
          low: raw.low || raw.Low || raw.L,
          close: raw.close || raw.Close || raw.C,
          volume: raw.volume || raw.Volume || raw.Vo || 0,
          time,
        });
        
        if (buffer.length < 30) continue;
        
        // シグナル検出
        const withSignals = detectSignals(buffer);
        const latest = withSignals[withSignals.length - 1];
        if (!latest.signal || latest.signal.type !== "buy") continue;
        
        const sigReason = latest.signal.reason;
        totalBuySignals++;
        
        // 前場判定
        const isAM = time < "11:28";
        if (isAM) amBuySignals++;
        
        // シグナル分類
        let category = "その他";
        for (const [key, _] of Object.entries(SIGNAL_CATEGORIES)) {
          if (sigReason.includes(key)) {
            category = key;
            break;
          }
        }
        
        if (!signalBreakdown[category]) {
          signalBreakdown[category] = { total: 0, am: 0, amBoosted: 0 };
        }
        signalBreakdown[category].total++;
        if (isAM) {
          signalBreakdown[category].am++;
          
          // isBullish計算
          let isBullish = false;
          if (buffer.length >= IS_BULLISH_MA_PERIOD + 1) {
            const currentSlice = buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD).map((c: any) => c.close);
            const currentMA = currentSlice.reduce((a: number, b: number) => a + b, 0) / IS_BULLISH_MA_PERIOD;
            const prevSlice = buffer.slice(buffer.length - IS_BULLISH_MA_PERIOD - 1, buffer.length - 1).map((c: any) => c.close);
            const prevMA = prevSlice.reduce((a: number, b: number) => a + b, 0) / IS_BULLISH_MA_PERIOD;
            const slope = (currentMA - prevMA) / prevMA * 100;
            isBullish = slope > IS_BULLISH_SLOPE_THRESHOLD;
          }
          
          const candle = buffer[buffer.length - 1];
          const boost = checkAMBoost(buffer, candle, isBullish);
          if (boost.boost || boost.volBreak) {
            signalBreakdown[category].amBoosted++;
          }
        }
      }
    }
  }
  
  console.log("=== 前場BUYシグナルの内訳（20営業日） ===\n");
  console.log(`全BUYシグナル: ${totalBuySignals}件`);
  console.log(`前場BUYシグナル: ${amBuySignals}件\n`);
  
  console.log("| シグナル | 全体 | 前場 | 前場ブースト対象 | 処理先 |");
  console.log("|----------|:---:|:---:|:---:|------|");
  
  const sorted = Object.entries(signalBreakdown).sort((a, b) => b[1].am - a[1].am);
  for (const [cat, data] of sorted) {
    const dest = (SIGNAL_CATEGORIES as any)[cat] || "直接エントリー可能";
    console.log(`| ${cat} | ${data.total}件 | ${data.am}件 | ${data.amBoosted}件 | ${dest} |`);
  }
  
  // ダウ理論高値更新が前場ブーストの恩恵を受けられない件数
  const dowUp = signalBreakdown["ダウ理論高値更新"];
  const roundUp = signalBreakdown["大台超え"];
  const vwapUp = signalBreakdown["VWAPクロス上抜け"];
  const invHS = signalBreakdown["逆三尊"] || { total: 0, am: 0, amBoosted: 0 };
  const invHS2 = signalBreakdown["インバースH&S"] || { total: 0, am: 0, amBoosted: 0 };
  
  const blockedByStateMachine = (dowUp?.am || 0) + (roundUp?.am || 0);
  const blockedByInvalid = (vwapUp?.am || 0) + (invHS?.am || 0) + (invHS2?.am || 0);
  const directEntry = amBuySignals - blockedByStateMachine - blockedByInvalid;
  
  console.log(`\n=== 前場ブーストの実効性 ===`);
  console.log(`前場BUYシグナル合計: ${amBuySignals}件`);
  console.log(`  ├── ステートマシン行き（直接エントリー不可）: ${blockedByStateMachine}件 (${(blockedByStateMachine/amBuySignals*100).toFixed(1)}%)`);
  console.log(`  │   ├── ダウ理論高値更新 → 押し目待機: ${dowUp?.am || 0}件`);
  console.log(`  │   └── 大台超え → 確認バー（逆張りSHORT用）: ${roundUp?.am || 0}件`);
  console.log(`  ├── 無効化/除外: ${blockedByInvalid}件`);
  console.log(`  │   ├── VWAPクロス上抜け無効化: ${vwapUp?.am || 0}件`);
  console.log(`  │   └── 逆三尊（バイパス除外）: ${(invHS?.am || 0) + (invHS2?.am || 0)}件`);
  console.log(`  └── 直接エントリー可能: ${directEntry}件 (${(directEntry/amBuySignals*100).toFixed(1)}%)`);
}

main().catch(console.error);
