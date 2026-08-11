/**
 * 現在のロジックで30日間のシミュレーション
 * rt_candlesデータを使用し、realtimeSimEngineのロジックを再現
 */
import mysql from "mysql2/promise";

// --- 現在のエンジン設定を再現 ---
const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.008,  // 東京エレクトロン
  "6857": 0.006,  // アドバンテスト
  "6976": 0.005,  // 太陽誘電
  "6526": 0.009,  // ソシオネクスト
  "5803": 0.005,  // フジクラ
  "6981": 0.009,  // 村田製作所
  "285A": 0.008,  // キオクシアHD
  "6146": 0.008,  // ディスコ
  "6594": 0.005,  // ニデック
  "8316": 0.005,  // 三井住友FG
};

const ACTIVE_SYMBOLS = Object.keys(SYMBOL_SL_MAP);

const CONFIRM_BARS = 4;
const TP_PERCENT = 0.015;
const DAILY_LOSS_LIMIT = -100000;
const LOT_AMOUNT = 3_000_000;

// MA計算
function calcMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// RSI計算
function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

// 大台レベル計算
function getRoundLevel(price: number): number {
  if (price >= 50000) return 1000;
  if (price >= 10000) return 500;
  if (price >= 5000) return 100;
  if (price >= 1000) return 50;
  return 10;
}

interface Candle {
  time: string; // "HH:MM" format
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  entryTime: string;
  exitPrice?: number;
  exitTime?: string;
  pnl?: number;
  reason?: string;
  signal?: string;
}

function simulateDay(symbol: string, candles: Candle[], slPercent: number): Trade[] {
  const trades: Trade[] = [];
  const closes: number[] = [];
  let position: Trade | null = null;
  let dailyPnl = 0;
  
  // 大台確認用ステート
  let roundConfirmState: { direction: "SHORT"; targetLevel: number; barsBelow: number } | null = null;
  
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    closes.push(c.close);
    
    // 日次損失上限チェック
    if (dailyPnl <= DAILY_LOSS_LIMIT) break;
    
    // 9:01以前、15:00以降はスキップ
    if (c.time < "09:01" || c.time >= "15:00") continue;
    
    // ポジション管理
    if (position) {
      const shares = Math.floor(LOT_AMOUNT / position.entryPrice);
      let pnl = 0;
      let exitReason = "";
      
      if (position.direction === "LONG") {
        const drawdown = (c.low - position.entryPrice) / position.entryPrice;
        const gain = (c.high - position.entryPrice) / position.entryPrice;
        
        if (drawdown <= -slPercent) {
          pnl = -slPercent * position.entryPrice * shares;
          exitReason = "SL";
        } else if (gain >= TP_PERCENT) {
          pnl = TP_PERCENT * position.entryPrice * shares;
          exitReason = "TP";
        } else if (c.time >= "14:55") {
          pnl = (c.close - position.entryPrice) * shares;
          exitReason = "EOD";
        }
      } else {
        const drawup = (c.high - position.entryPrice) / position.entryPrice;
        const gain = (position.entryPrice - c.low) / position.entryPrice;
        
        if (drawup >= slPercent) {
          pnl = -slPercent * position.entryPrice * shares;
          exitReason = "SL";
        } else if (gain >= TP_PERCENT) {
          pnl = TP_PERCENT * position.entryPrice * shares;
          exitReason = "TP";
        } else if (c.time >= "14:55") {
          pnl = (position.entryPrice - c.close) * shares;
          exitReason = "EOD";
        }
      }
      
      if (exitReason) {
        position.exitPrice = c.close;
        position.exitTime = c.time;
        position.pnl = Math.round(pnl);
        position.reason = exitReason;
        trades.push(position);
        dailyPnl += Math.round(pnl);
        position = null;
      }
      continue; // ポジション保有中は新規エントリーしない
    }
    
    // エントリー判定（ポジションなし時のみ）
    if (closes.length < 26) continue; // MA20+バッファ
    
    const ma5 = calcMA(closes, 5);
    const ma20 = calcMA(closes, 20);
    const rsi = calcRSI(closes);
    if (!ma5 || !ma20 || rsi === null) continue;
    
    // --- 大台確認SHORT（大台割れ） ---
    const roundLevel = getRoundLevel(c.close);
    const nearestRoundBelow = Math.floor(c.close / roundLevel) * roundLevel;
    const nearestRoundAbove = nearestRoundBelow + roundLevel;
    
    // 大台割れ検出（前足が大台以上、今足が大台未満）
    if (i > 0 && closes[i-1] >= nearestRoundAbove && c.close < nearestRoundAbove) {
      roundConfirmState = {
        direction: "SHORT",
        targetLevel: nearestRoundAbove,
        barsBelow: 1,
      };
    } else if (roundConfirmState) {
      // 大台確認ステートマシン継続
      if (c.close < roundConfirmState.targetLevel) {
        roundConfirmState.barsBelow++;
        if (roundConfirmState.barsBelow >= CONFIRM_BARS) {
          // SHORT エントリー確定
          position = {
            symbol,
            direction: "SHORT",
            entryPrice: c.close,
            entryTime: c.time,
            signal: "round_confirm_short",
          };
          roundConfirmState = null;
          continue;
        }
      } else {
        roundConfirmState = null; // 大台を回復したらキャンセル
      }
    }
    
    // --- 大台確認LONG × buy_pressure → 逆張りSHORT ---
    // （大台超えLONGは全面停止。buy_pressure時のみ逆張りSHORTに変換）
    if (i > 0 && closes[i-1] < nearestRoundAbove && c.close >= nearestRoundAbove) {
      // buy_pressure判定（簡易: RSI>65 = 買われすぎ）
      if (rsi > 65) {
        position = {
          symbol,
          direction: "SHORT",
          entryPrice: c.close,
          entryTime: c.time,
          signal: "round_buypress_reverse_short",
        };
        continue;
      }
      // buy_pressureでなければ大台確認LONGは停止（何もしない）
    }
    
    // --- GCシグナル ---
    if (closes.length >= 6) {
      const prevCloses = closes.slice(0, -1);
      const prevMa5 = calcMA(prevCloses, 5);
      const prevMa20 = calcMA(prevCloses, 20);
      if (prevMa5 && prevMa20 && prevMa5 <= prevMa20 && ma5 > ma20) {
        // GC検出 - 品質判定
        const gcQuality = (rsi > 50 && c.close > ma20) ? "strong" : "medium";
        
        // strong は全銘柄許可、太陽誘電(6976)のみmedium許可（close>MA20 + 陽線条件）
        if (gcQuality === "strong" || (symbol === "6976" && c.close > ma20 && c.close > c.open)) {
          position = {
            symbol,
            direction: "LONG",
            entryPrice: c.close,
            entryTime: c.time,
            signal: `gc_${gcQuality}`,
          };
          continue;
        }
      }
    }
    
    // --- DCシグナル（SHORT） ---
    if (closes.length >= 6) {
      const prevCloses = closes.slice(0, -1);
      const prevMa5 = calcMA(prevCloses, 5);
      const prevMa20 = calcMA(prevCloses, 20);
      if (prevMa5 && prevMa20 && prevMa5 >= prevMa20 && ma5 < ma20) {
        if (rsi < 50 && c.close < ma20) {
          position = {
            symbol,
            direction: "SHORT",
            entryPrice: c.close,
            entryTime: c.time,
            signal: "dc_short",
          };
          continue;
        }
      }
    }
    
    // --- ダウ理論（直近高値更新 → LONG は大台確認LONG停止のため省略） ---
    
    // --- ダウ理論（直近安値更新 SHORT） ---
    if (closes.length >= 20) {
      const recent20Low = Math.min(...closes.slice(-20));
      if (c.close <= recent20Low && c.close < ma20 && rsi < 50 && rsi > 20) {
        position = {
          symbol,
          direction: "SHORT",
          entryPrice: c.close,
          entryTime: c.time,
          signal: "dow_low_short",
        };
        continue;
      }
    }
  }
  
  // 未決済ポジションをEODで決済
  if (position && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const shares = Math.floor(LOT_AMOUNT / position.entryPrice);
    let pnl = 0;
    if (position.direction === "LONG") {
      pnl = (lastCandle.close - position.entryPrice) * shares;
    } else {
      pnl = (position.entryPrice - lastCandle.close) * shares;
    }
    position.exitPrice = lastCandle.close;
    position.exitTime = lastCandle.time;
    position.pnl = Math.round(pnl);
    position.reason = "EOD";
    trades.push(position);
  }
  
  return trades;
}

async function main() {
  const dbUrl = new URL(process.env.DATABASE_URL!.replace(/\?ssl=.*$/, ""));
  const conn = await mysql.createConnection({
    host: dbUrl.hostname,
    port: parseInt(dbUrl.port || "4000"),
    user: decodeURIComponent(dbUrl.username),
    password: decodeURIComponent(dbUrl.password),
    database: dbUrl.pathname.slice(1),
    ssl: { rejectUnauthorized: true },
  });

  // 直近30営業日を取得
  const [dateRows] = await conn.query(
    `SELECT DISTINCT tradeDate FROM rt_candles 
     WHERE symbol IN (${ACTIVE_SYMBOLS.map(s => `'${s}'`).join(",")})
     ORDER BY tradeDate DESC LIMIT 30`
  );
  
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  console.log(`\n=== 30日間シミュレーション（現在のロジック） ===`);
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]}`);
  console.log(`対象銘柄: ${ACTIVE_SYMBOLS.join(", ")}`);
  console.log(`CONFIRM_BARS=${CONFIRM_BARS}, TP=1.5%, 銘柄別SL, 大台確認LONG停止\n`);
  
  let totalPnl = 0;
  let totalTrades = 0;
  let totalWins = 0;
  const dailyResults: { date: string; pnl: number; trades: number; wins: number }[] = [];
  
  for (const date of dates) {
    let dayPnl = 0;
    let dayTrades = 0;
    let dayWins = 0;
    
    for (const symbol of ACTIVE_SYMBOLS) {
      const [rows] = await conn.query(
        `SELECT candleTime as time, open, high, low, close, volume 
         FROM rt_candles 
         WHERE symbol = ? AND tradeDate = ? 
         ORDER BY candleTime ASC`,
        [symbol, date]
      );
      
      const rawRows = rows as any[];
      if (rawRows.length < 30) continue;
      
      const candles: Candle[] = rawRows.map((r: any) => ({
        time: r.time,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      }));
      
      const sl = SYMBOL_SL_MAP[symbol] || 0.005;
      const trades = simulateDay(symbol, candles, sl);
      
      for (const t of trades) {
        dayPnl += t.pnl || 0;
        dayTrades++;
        if ((t.pnl || 0) > 0) dayWins++;
      }
    }
    
    dailyResults.push({ date, pnl: dayPnl, trades: dayTrades, wins: dayWins });
    totalPnl += dayPnl;
    totalTrades += dayTrades;
    totalWins += dayWins;
  }
  
  // 日別結果表示
  console.log("日付        | 損益        | 取引数 | 勝率");
  console.log("------------|------------|--------|------");
  for (const d of dailyResults) {
    const pnlStr = (d.pnl >= 0 ? "+" : "") + d.pnl.toLocaleString() + "円";
    const winRate = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(0) + "%" : "-";
    console.log(`${d.date} | ${pnlStr.padStart(10)} | ${String(d.trades).padStart(6)} | ${winRate}`);
  }
  
  // サマリー
  const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : "0";
  const winDays = dailyResults.filter(d => d.pnl > 0).length;
  const lossDays = dailyResults.filter(d => d.pnl < 0).length;
  const zeroDays = dailyResults.filter(d => d.pnl === 0 && d.trades === 0).length;
  const grossProfit = dailyResults.filter(d => d.pnl > 0).reduce((s, d) => s + d.pnl, 0);
  const grossLoss = Math.abs(dailyResults.filter(d => d.pnl < 0).reduce((s, d) => s + d.pnl, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
  
  console.log(`\n=== サマリー ===`);
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]}（${dates.length}営業日）`);
  console.log(`総損益: ${(totalPnl >= 0 ? "+" : "")}${totalPnl.toLocaleString()}円`);
  console.log(`取引数: ${totalTrades}件`);
  console.log(`勝率: ${winRate}%（${totalWins}勝 ${totalTrades - totalWins}敗）`);
  console.log(`勝ち日: ${winDays}日 / 負け日: ${lossDays}日 / 取引なし: ${zeroDays}日`);
  console.log(`PF: ${pf}（総利益 +${grossProfit.toLocaleString()}円 / 総損失 -${grossLoss.toLocaleString()}円）`);
  console.log(`日平均損益: ${(totalPnl / dates.length >= 0 ? "+" : "")}${Math.round(totalPnl / dates.length).toLocaleString()}円`);
  
  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
