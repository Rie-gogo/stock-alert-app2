import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { invokeLLM } from "../_core/llm";
import { getRecentStats, getDailyReportList } from "../db";
import { ENV } from "../_core/env";

// ローソク足データのスキーマ
const CandleSchema = z.object({
  time: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  ma5: z.number().optional(),
  ma25: z.number().optional(),
  rsi: z.number().optional(),
  bbUpper: z.number().optional(),
  bbMiddle: z.number().optional(),
  bbLower: z.number().optional(),
});

// 板情報のスキーマ
const BoardItemSchema = z.object({
  price: z.number(),
  volume: z.number(),
  type: z.enum(["ask", "bid"]),
});

const BoardDataSchema = z.object({
  asks: z.array(BoardItemSchema),
  bids: z.array(BoardItemSchema),
  totalAskVolume: z.number(),
  totalBidVolume: z.number(),
});

// 歩み値のスキーマ
const TradeTickSchema = z.object({
  time: z.string(),
  price: z.number(),
  volume: z.number(),
  changeType: z.enum(["up", "down", "flat"]),
  sizeType: z.enum(["normal", "large", "huge"]),
});

/**
 * ローソク足データをテキスト形式に変換（LLMへの入力用）
 */
function formatCandlesForLLM(candles: z.infer<typeof CandleSchema>[]): string {
  const recent = candles.slice(-15); // 直近15本のみ（高速化）
  const lines = recent.map((c) => {
    const rsiStr = c.rsi !== undefined ? ` RSI:${c.rsi.toFixed(0)}` : "";
    const maStr =
      c.ma5 !== undefined && c.ma25 !== undefined
        ? ` 5MA:${c.ma5.toFixed(0)} 25MA:${c.ma25.toFixed(0)}`
        : "";
    const candleType = c.close > c.open ? "陽" : c.close < c.open ? "陰" : "同";
    return `${c.time}[${candleType}]終${c.close.toFixed(0)} 量${c.volume.toLocaleString()}${maStr}${rsiStr}`;
  });
  return lines.join("\n");
}

/**
 * 板情報をテキスト形式に変換
 */
function formatBoardForLLM(board: z.infer<typeof BoardDataSchema>): string {
  const topAsks = board.asks.slice(0, 3);
  const topBids = board.bids.slice(0, 3);
  const askRatio = board.totalAskVolume / (board.totalAskVolume + board.totalBidVolume);

  const askLines = topAsks.map((a) => `売${a.price.toFixed(0)}:${a.volume.toLocaleString()}`).join(" ");
  const bidLines = topBids.map((b) => `買${b.price.toFixed(0)}:${b.volume.toLocaleString()}`).join(" ");

  return `${askLines} | ${bidLines} | 売比率${(askRatio * 100).toFixed(0)}%`;
}

/**
 * 歩み値をテキスト形式に変換
 */
function formatTradesForLLM(trades: z.infer<typeof TradeTickSchema>[]): string {
  const recent = trades.slice(0, 10);
  let netLargeVolume = 0;
  recent.filter((t) => t.sizeType !== "normal").forEach((t) => {
    if (t.changeType === "up") netLargeVolume += t.volume;
    else if (t.changeType === "down") netLargeVolume -= t.volume;
  });

  const lines = recent.slice(0, 6).map((t) => {
    const sizeLabel = t.sizeType === "huge" ? "超大口" : t.sizeType === "large" ? "大口" : "";
    const dirLabel = t.changeType === "up" ? "↑" : t.changeType === "down" ? "↓" : "→";
    return `${dirLabel}${t.price.toFixed(0)}(${t.volume.toLocaleString()}${sizeLabel})`;
  }).join(" ");

  const netLabel = netLargeVolume > 0 ? `大口純買+${netLargeVolume.toLocaleString()}` : `大口純売${netLargeVolume.toLocaleString()}`;
  return `${lines} [${netLabel}]`;
}

export const aiAnalysisRouter = router({
  /**
   * リアルタイム市場データをLLMに送り、構造化されたAI分析を取得する
   * 結論（verdict）を必ず返す構造化JSON形式
   */
  analyzeMarket: publicProcedure
    .input(
      z.object({
        symbol: z.string(),
        stockName: z.string(),
        currentPrice: z.number(),
        priceChange: z.number(),
        priceChangePercent: z.number(),
        volume: z.number(),
        candles: z.array(CandleSchema),
        board: BoardDataSchema,
        trades: z.array(TradeTickSchema),
        rsiUpper: z.number().default(70),
        rsiLower: z.number().default(30),
      })
    )
    .mutation(async ({ input }) => {
      // 過去の成績データを取得（失敗パターンの参照用）
      let pastPerformanceContext = "";
      try {
        const stats = await getRecentStats(14);
        if (stats.totalDays > 0) {
          pastPerformanceContext = `\n過去${stats.totalDays}日成績: 勝率${(stats.avgWinRate * 100).toFixed(0)}% 損益率${(stats.avgProfitRate * 100).toFixed(1)}%`;
        }
      } catch {
        // 初回実行時など、過去データなしは無視
      }

      const candlesText = formatCandlesForLLM(input.candles);
      const boardText = formatBoardForLLM(input.board);
      const tradesText = formatTradesForLLM(input.trades);

      const latestCandle = input.candles[input.candles.length - 1];
      const currentRsi = latestCandle?.rsi;
      const currentMa5 = latestCandle?.ma5;
      const currentMa25 = latestCandle?.ma25;

      const systemPrompt = `あなたは日本株デイトレードの専門AIアナリストです。
市場データを分析し、必ず以下のJSON形式のみで回答してください。他のテキストは不要です。

{
  "verdict": "BUY" | "SELL" | "WAIT",
  "confidence": 1〜5の整数（確信度）,
  "entry_price": 推奨エントリー価格（数値）または null,
  "stop_loss": 損切り価格（数値）または null,
  "take_profit": 利確目標価格（数値）または null,
  "reason": "判断理由を1〜2文で簡潔に",
  "warning": "注意点があれば1文で" または null
}

BUY=今すぐ買い, SELL=今すぐ売り/空売り, WAIT=様子見`;

      const userPrompt = `【${input.stockName}(${input.symbol})】現在値:${input.currentPrice.toFixed(0)} 前日比:${input.priceChange >= 0 ? "+" : ""}${input.priceChange.toFixed(0)}(${input.priceChangePercent.toFixed(1)}%) RSI:${currentRsi?.toFixed(0) ?? "?"} 5MA:${currentMa5?.toFixed(0) ?? "?"} 25MA:${currentMa25?.toFixed(0) ?? "?"}
RSI閾値: 買われすぎ${input.rsiUpper} 売られすぎ${input.rsiLower}${pastPerformanceContext}

【チャート直近15本】
${candlesText}

【板】${boardText}
【歩み値】${tradesText}`;

      const response = await invokeLLM({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 512,
      });

      const rawContent = response.choices[0]?.message?.content;
      const contentStr = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);

      // JSONパース
      let parsed: {
        verdict: "BUY" | "SELL" | "WAIT";
        confidence: number;
        entry_price: number | null;
        stop_loss: number | null;
        take_profit: number | null;
        reason: string;
        warning: string | null;
      };

      try {
        parsed = JSON.parse(contentStr);
        // verdictのバリデーション
        if (!["BUY", "SELL", "WAIT"].includes(parsed.verdict)) {
          parsed.verdict = "WAIT";
        }
        parsed.confidence = Math.max(1, Math.min(5, Math.round(parsed.confidence ?? 3)));
      } catch {
        parsed = {
          verdict: "WAIT",
          confidence: 1,
          entry_price: null,
          stop_loss: null,
          take_profit: null,
          reason: "分析データの解析に失敗しました。",
          warning: "再度お試しください。",
        };
      }

      return {
        ...parsed,
        timestamp: Date.now(),
        symbol: input.symbol,
        currentPrice: input.currentPrice,
      };
    }),
});
