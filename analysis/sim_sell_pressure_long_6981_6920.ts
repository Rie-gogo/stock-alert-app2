/**
 * sell_pressure時LONG許可シミュレーション
 * 対象: 6981(村田製作所), 6920(レーザーテック)
 * 条件: strong + 大台超え + close > VWAP + 直近3本陽線優勢
 * 
 * 全期間(データがある日全て)で検証
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { eq, and, inArray } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import { evaluateConfirmation } from "../server/signalConfirmation";

// ============================================================
// 設定
// ============================================================
const TARGET_SYMBOLS = ["6981", "6920"];
const TP_PERCENT = 0.015; // +1.5%
const SL_PERCENT = 0.005; // -0.5%
const BE_TRIGGER = 0.005; // +0.5%でBE移動
const LOT_YEN = 1_000_000; // 100万円分

interface SimTrade {
  date: string;
  time: string;
  symbol: string;
  signalType: string;
  entry: number;
  exit: number;
  exitReason: string;
  pnl: number;
  mfe: number; // 最大含み益率
  mae: number; // 最大含み損率
  boardSignal: string;
  confidence: string;
}

async function main() {
  const db = await getDb();

  // 全データ取得
  const allCandles = await db.select().from(rtCandles)
    .where(inArray(rtCandles.symbol, TARGET_SYMBOLS));

  console.log(`取得データ: ${allCandles.length}本`);

  // 日付別・銘柄別に整理
  const dateSymbolMap = new Map<string, Map<string, any[]>>();
  for (const c of allCandles) {
    const date = c.tradeDate;
    if (!dateSymbolMap.has(date)) dateSymbolMap.set(date, new Map());
    const symMap = dateSymbolMap.get(date)!;
    if (!symMap.has(c.symbol)) symMap.set(c.symbol, []);
    symMap.get(c.symbol)!.push(c);
  }

  // 日付ソート
  const dates = [...dateSymbolMap.keys()].sort();
  console.log(`対象日数: ${dates.length}日 (${dates[0]} 〜 ${dates[dates.length - 1]})`);
  console.log(`${"=".repeat(80)}\n`);

  const allTrades: SimTrade[] = [];
  const dailySummary: { date: string; trades: number; pnl: number; allowed: number; blocked: number }[] = [];

  for (const date of dates) {
    const symMap = dateSymbolMap.get(date)!;
    let dayTrades: SimTrade[] = [];
    let dayAllowed = 0;
    let dayBlocked = 0;

    for (const symbol of TARGET_SYMBOLS) {
      const candles = symMap.get(symbol);
      if (!candles || candles.length < 30) continue;

      // 時系列ソート
      candles.sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));

      // テクニカル指標計算
      const closes = candles.map((c: any) => Number(c.close));
      const highs = candles.map((c: any) => Number(c.high));
      const lows = candles.map((c: any) => Number(c.low));
      const vwapCandles = candles.map((c: any) => ({
        open: Number(c.open), high: Number(c.high), low: Number(c.low),
        close: Number(c.close), volume: Number(c.volume),
      }));
      const vwapArr = calcVWAP(vwapCandles);
      const bb = calcBollinger(closes, 20, 2);
      const atrArr = calcATR(highs, lows, closes, 14);

      // MA計算
      const ma5: (number | null)[] = closes.map((_, i) => {
        if (i < 4) return null;
        return (closes[i] + closes[i-1] + closes[i-2] + closes[i-3] + closes[i-4]) / 5;
      });
      const ma25: (number | null)[] = closes.map((_, i) => {
        if (i < 24) return null;
        let sum = 0;
        for (let j = 0; j < 25; j++) sum += closes[i - j];
        return sum / 25;
      });

      // detectSignals用バッファ構築
      const buffer = candles.map((c: any, i: number) => ({
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
        time: c.candleTime,
        ma5: ma5[i],
        ma25: ma25[i],
        bbUpper: bb.upper[i] ?? null,
        bbLower: bb.lower[i] ?? null,
        bbMiddle: bb.middle[i] ?? null,
        vwap: vwapArr[i] ?? null,
        atr: atrArr[i] ?? null,
        dayKey: date,
      }));

      // シグナル検出
      const signals = detectSignals(buffer as any);

      // 各シグナルをフィルタリング
      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i];
        if (!sig) continue;
        if (sig.side !== "BUY") continue;

        // 条件1: strong
        const confirmation = evaluateConfirmation(sig, buffer as any, i);
        if (confirmation.confidence !== "strong") continue;

        // 条件2: 大台超えシグナルのみ
        if (!sig.reason.includes("大台超え")) continue;

        // 条件3: close > VWAP
        const close = Number(candles[i].close);
        const vwap = vwapArr[i];
        if (vwap === null || close <= vwap) {
          dayBlocked++;
          continue;
        }

        // 条件4: 直近3本陽線優勢
        if (i < 2) { dayBlocked++; continue; }
        const recent3 = candles.slice(i - 2, i + 1);
        const bullishCount = recent3.filter((c: any) => Number(c.close) > Number(c.open)).length;
        if (bullishCount < 2) {
          dayBlocked++;
          continue;
        }

        // 板データ確認（sell_pressure時のみ対象）
        const boardSnapshot = (candles[i] as any).boardSnapshot;
        const board = boardSnapshot ? (typeof boardSnapshot === 'string' ? JSON.parse(boardSnapshot) : boardSnapshot) : null;
        const boardSignal = board?.signal || "unknown";

        // sell_pressure以外の時はそもそもブロックされないので対象外
        // ここではsell_pressure時もneutral時も全てシミュレーション
        dayAllowed++;

        // エントリー価格
        const entryPrice = close;
        const tp = entryPrice * (1 + TP_PERCENT);
        const sl = entryPrice * (1 - SL_PERCENT);
        let beActive = false;
        let currentSl = sl;

        // 以降のローソク足で損益シミュレーション
        let exitPrice = 0;
        let exitReason = "";
        let mfe = 0;
        let mae = 0;

        for (let j = i + 1; j < candles.length; j++) {
          const cj = candles[j];
          const high = Number(cj.high);
          const low = Number(cj.low);
          const closeJ = Number(cj.close);

          // MFE/MAE更新
          const profitRate = (high - entryPrice) / entryPrice;
          const lossRate = (low - entryPrice) / entryPrice;
          if (profitRate > mfe) mfe = profitRate;
          if (lossRate < mae) mae = lossRate;

          // BE発動チェック
          if (!beActive && high >= entryPrice * (1 + BE_TRIGGER)) {
            beActive = true;
            currentSl = entryPrice;
          }

          // SL/BE判定（先に判定）
          if (low <= currentSl) {
            exitPrice = currentSl;
            exitReason = beActive ? "be_exit" : "stop_loss";
            break;
          }

          // TP判定
          if (high >= tp) {
            exitPrice = tp;
            exitReason = "take_profit";
            break;
          }

          // 引け決済
          if (j === candles.length - 1) {
            exitPrice = closeJ;
            exitReason = "market_close";
            break;
          }
        }

        if (exitPrice === 0) continue;

        const lots = Math.floor(LOT_YEN / entryPrice);
        const pnl = Math.round((exitPrice - entryPrice) * lots);

        const trade: SimTrade = {
          date,
          time: candles[i].candleTime,
          symbol,
          signalType: sig.reason,
          entry: entryPrice,
          exit: exitPrice,
          exitReason,
          pnl,
          mfe: mfe * 100,
          mae: mae * 100,
          boardSignal,
          confidence: "strong",
        };

        dayTrades.push(trade);
        allTrades.push(trade);
      }
    }

    const dayPnl = dayTrades.reduce((sum, t) => sum + t.pnl, 0);
    dailySummary.push({ date, trades: dayTrades.length, pnl: dayPnl, allowed: dayAllowed, blocked: dayBlocked });
  }

  // ============================================================
  // 結果出力
  // ============================================================
  console.log("════════════════════════════════════════════════════════════════");
  console.log("【結果】sell_pressure時LONG許可シミュレーション");
  console.log("  対象: 6981(村田製作所), 6920(レーザーテック)");
  console.log("  条件: strong + 大台超え + close>VWAP + 直近3本陽線優勢");
  console.log("════════════════════════════════════════════════════════════════\n");

  // 全体サマリー
  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl < 0);
  const bes = allTrades.filter(t => t.pnl === 0);
  const totalPnl = allTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;

  console.log("■ 全体サマリー:");
  console.log(`  取引数: ${allTrades.length}件`);
  console.log(`  勝ち: ${wins.length}件 (平均+${wins.length > 0 ? Math.round(wins.reduce((s, t) => s + t.pnl, 0) / wins.length) : 0}円)`);
  console.log(`  負け: ${losses.length}件 (平均${losses.length > 0 ? Math.round(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0}円)`);
  console.log(`  BE: ${bes.length}件`);
  console.log(`  勝率: ${allTrades.length > 0 ? (wins.length / allTrades.length * 100).toFixed(1) : 0}%`);
  console.log(`  総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  console.log(`  PF: ${pf === Infinity ? '∞' : pf.toFixed(2)}`);
  console.log(`  期待値: ${allTrades.length > 0 ? Math.round(totalPnl / allTrades.length).toLocaleString() : 0}円/回`);
  console.log(`  平均MFE: +${(allTrades.reduce((s, t) => s + t.mfe, 0) / allTrades.length).toFixed(2)}%`);
  console.log(`  平均MAE: ${(allTrades.reduce((s, t) => s + t.mae, 0) / allTrades.length).toFixed(2)}%`);

  // 決済理由別
  console.log("\n■ 決済理由別:");
  const byReason = new Map<string, { count: number; pnl: number }>();
  for (const t of allTrades) {
    const r = byReason.get(t.exitReason) || { count: 0, pnl: 0 };
    r.count++;
    r.pnl += t.pnl;
    byReason.set(t.exitReason, r);
  }
  for (const [reason, data] of byReason) {
    console.log(`  ${reason}: ${data.count}件, ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円`);
  }

  // 銘柄別
  console.log("\n■ 銘柄別:");
  for (const sym of TARGET_SYMBOLS) {
    const symTrades = allTrades.filter(t => t.symbol === sym);
    const symPnl = symTrades.reduce((s, t) => s + t.pnl, 0);
    const symWins = symTrades.filter(t => t.pnl > 0).length;
    console.log(`  ${sym}: ${symTrades.length}件, 勝率${symTrades.length > 0 ? (symWins / symTrades.length * 100).toFixed(0) : 0}%, ${symPnl >= 0 ? '+' : ''}${symPnl.toLocaleString()}円`);
  }

  // 板シグナル別
  console.log("\n■ 板シグナル別:");
  const byBoard = new Map<string, { count: number; pnl: number; wins: number }>();
  for (const t of allTrades) {
    const r = byBoard.get(t.boardSignal) || { count: 0, pnl: 0, wins: 0 };
    r.count++;
    r.pnl += t.pnl;
    if (t.pnl > 0) r.wins++;
    byBoard.set(t.boardSignal, r);
  }
  for (const [signal, data] of byBoard) {
    console.log(`  ${signal}: ${data.count}件, 勝率${(data.wins / data.count * 100).toFixed(0)}%, ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円`);
  }

  // 日別詳細
  console.log("\n■ 日別詳細:");
  console.log("  日付       | 取引 | 許可 | 条件不足 | 損益");
  console.log("  -----------|------|------|---------|--------");
  for (const d of dailySummary) {
    if (d.trades > 0 || d.allowed > 0 || d.blocked > 0) {
      console.log(`  ${d.date} | ${String(d.trades).padStart(4)} | ${String(d.allowed).padStart(4)} | ${String(d.blocked).padStart(7)} | ${d.pnl >= 0 ? '+' : ''}${d.pnl.toLocaleString()}円`);
    }
  }

  // 全トレード詳細
  console.log("\n■ 全トレード詳細:");
  for (const t of allTrades) {
    const symName = t.symbol === "6981" ? "村田製作所" : "レーザーテック";
    console.log(`  ${t.date} ${t.time.slice(0, 5)} ${symName} | ${t.signalType.slice(0, 30)}`);
    console.log(`    板:${t.boardSignal} | Entry:${t.entry} → Exit:${t.exit.toFixed(1)}(${t.exitReason})`);
    console.log(`    PnL:${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString()}円 | MFE:+${t.mfe.toFixed(2)}% | MAE:${t.mae.toFixed(2)}%`);
  }

  // 下落日の安全性チェック
  console.log("\n■ 安全性チェック（下落日にエントリーしていないか）:");
  const downDays = dailySummary.filter(d => d.trades > 0);
  for (const d of downDays) {
    const dayTrades = allTrades.filter(t => t.date === d.date);
    const dayLoss = dayTrades.filter(t => t.pnl < 0);
    if (dayLoss.length > 0) {
      console.log(`  ⚠ ${d.date}: ${dayLoss.length}件損失 (合計${dayLoss.reduce((s, t) => s + t.pnl, 0).toLocaleString()}円)`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
