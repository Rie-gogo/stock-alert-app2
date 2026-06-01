/**
 * RealDataChart.tsx
 * Yahoo Finance APIから実際の株価データを取得してチャートと取引シグナルを表示するページ
 */
import { useState, useMemo, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Search,
  BarChart2,
  AlertTriangle,
  ArrowLeft,
} from "lucide-react";
import { Link } from "wouter";
import ChartComponent from "@/components/ChartComponent";
import type { CandleData } from "@/types";

// ---- 型定義 ----
interface SignalSummary {
  time: string;
  timestamp: number;
  type: "buy" | "sell" | "warn";
  reason: string;
  price: number;
  rsi: number | null;
  ma5: number | null;
  ma25: number | null;
}

// ---- サーバーのキャンドルデータをフロントエンド型に変換 ----
function toFrontendCandle(c: {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5: number | null;
  ma25: number | null;
  rsi: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  signal?: { type: "buy" | "sell" | "warn"; reason: string };
}): CandleData {
  return {
    time: c.time,
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    ma5: c.ma5 ?? undefined,
    ma25: c.ma25 ?? undefined,
    rsi: c.rsi ?? undefined,
    bbUpper: c.bbUpper ?? undefined,
    bbMiddle: c.bbMiddle ?? undefined,
    bbLower: c.bbLower ?? undefined,
    // CandleData uses signals[] array
    signals: c.signal
      ? [{ type: c.signal.type, reason: c.signal.reason }]
      : undefined,
  };
}

// ---- 人気銘柄リスト ----
const POPULAR_STOCKS = [
  { symbol: "9984.T", name: "ソフトバンクグループ" },
  { symbol: "7203.T", name: "トヨタ自動車" },
  { symbol: "6758.T", name: "ソニーグループ" },
  { symbol: "6861.T", name: "キーエンス" },
  { symbol: "9432.T", name: "NTT" },
  { symbol: "8306.T", name: "三菱UFJ" },
  { symbol: "9983.T", name: "ファーストリテイリング" },
  { symbol: "8035.T", name: "東京エレクトロン" },
  { symbol: "7974.T", name: "任天堂" },
  { symbol: "6367.T", name: "ダイキン工業" },
];

export default function RealDataChart() {
  const [symbol, setSymbol] = useState("9984.T");
  const [inputSymbol, setInputSymbol] = useState("9984.T");
  const [range, setRange] = useState<"1d" | "5d" | "1mo">("1d");
  const [interval, setInterval] = useState<"1m" | "5m" | "15m" | "1d">("1m");
  const [selectedCandle, setSelectedCandle] = useState<CandleData | null>(null);

  // データ取得
  const { data, isLoading, error, refetch } = trpc.stockData.getStockChart.useQuery(
    { symbol, range, interval },
    { staleTime: 60_000, retry: 1 }
  );

  // CandleData型に変換
  const candles = useMemo<CandleData[]>(() => {
    if (!data?.candles) return [];
    return data.candles.map(toFrontendCandle);
  }, [data]);

  // シグナルのみ抽出
  const signals = useMemo<SignalSummary[]>(() => {
    if (!data?.signals) return [];
    return data.signals as SignalSummary[];
  }, [data]);

  const handleSearch = useCallback(() => {
    const trimmed = inputSymbol.trim().toUpperCase();
    if (!trimmed) return;
    // .Tが付いていない場合は自動付与
    const sym = trimmed.includes(".") ? trimmed : `${trimmed}.T`;
    setSymbol(sym);
  }, [inputSymbol]);

  const isPriceUp = (data?.priceChange ?? 0) >= 0;

  // 取引ペアを計算（買い→売りのペア）
  const tradePairs = useMemo(() => {
    const pairs: Array<{
      buySignal: SignalSummary;
      sellSignal: SignalSummary | null;
      pnl: number | null;
    }> = [];
    let currentBuy: SignalSummary | null = null;

    for (const sig of signals) {
      if (sig.type === "buy" && !currentBuy) {
        currentBuy = sig;
      } else if (sig.type === "sell" && currentBuy) {
        pairs.push({
          buySignal: currentBuy,
          sellSignal: sig,
          pnl: Math.round((sig.price - currentBuy.price) * 100), // 1単元=100株
        });
        currentBuy = null;
      }
    }
    // 未決済ポジション
    if (currentBuy) {
      pairs.push({ buySignal: currentBuy, sellSignal: null, pnl: null });
    }
    return pairs;
  }, [signals]);

  const totalPnl = tradePairs
    .filter(p => p.pnl !== null)
    .reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const wins = tradePairs.filter(p => (p.pnl ?? 0) > 0).length;
  const completedTrades = tradePairs.filter(p => p.pnl !== null).length;
  const winRate = completedTrades > 0 ? Math.round((wins / completedTrades) * 100) : 0;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      {/* ヘッダー */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-40 px-4 py-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" />
              <span className="text-xs">ダッシュボードへ</span>
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <BarChart2 className="w-5 h-5 text-primary" />
            <h1 className="text-sm font-bold">実際の株価チャート分析</h1>
            <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">
              Yahoo Finance
            </Badge>
          </div>
        </div>

        {/* コントロール */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* 銘柄入力 */}
          <div className="flex items-center gap-1">
            <Input
              value={inputSymbol}
              onChange={e => setInputSymbol(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSearch()}
              placeholder="例: 9984.T"
              className="w-28 h-7 text-xs font-mono"
            />
            <Button size="sm" variant="outline" onClick={handleSearch} className="h-7 px-2">
              <Search className="w-3.5 h-3.5" />
            </Button>
          </div>

          {/* 人気銘柄クイック選択 */}
          <Select
            value={symbol}
            onValueChange={v => { setSymbol(v); setInputSymbol(v); }}
          >
            <SelectTrigger className="h-7 text-xs w-44">
              <SelectValue placeholder="銘柄を選択" />
            </SelectTrigger>
            <SelectContent>
              {POPULAR_STOCKS.map(s => (
                <SelectItem key={s.symbol} value={s.symbol} className="text-xs">
                  {s.symbol} - {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* 期間選択 */}
          <Select value={range} onValueChange={v => setRange(v as "1d" | "5d" | "1mo")}>
            <SelectTrigger className="h-7 text-xs w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1d" className="text-xs">本日</SelectItem>
              <SelectItem value="5d" className="text-xs">5日間</SelectItem>
              <SelectItem value="1mo" className="text-xs">1ヶ月</SelectItem>
            </SelectContent>
          </Select>

          {/* 時間足選択 */}
          <Select value={interval} onValueChange={v => setInterval(v as "1m" | "5m" | "15m" | "1d")}>
            <SelectTrigger className="h-7 text-xs w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1m" className="text-xs">1分足</SelectItem>
              <SelectItem value="5m" className="text-xs">5分足</SelectItem>
              <SelectItem value="15m" className="text-xs">15分足</SelectItem>
              <SelectItem value="1d" className="text-xs">日足</SelectItem>
            </SelectContent>
          </Select>

          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isLoading}
            className="h-7 px-2 gap-1 text-xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            更新
          </Button>
        </div>
      </header>

      <main className="flex-1 p-4 space-y-4">
        {/* 板情報・歩み値の注意書き */}
        <div className="bg-secondary/30 border border-border/50 rounded-lg px-4 py-2 text-[11px] text-muted-foreground flex items-center gap-2">
          <span className="text-yellow-400">⚠</span>
          <span>このページでは実際の株価チャートとシグナルを表示します。板情報・歩み値はリアルタイムAPIが非公開のため表示できません（シミュレーションはダッシュボードで確認できます）。</span>
        </div>

        {/* エラー表示 */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm text-destructive flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error.message}</span>
          </div>
        )}

        {/* ローディング */}
        {isLoading && (
          <div className="flex items-center justify-center h-64 text-muted-foreground text-sm gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span>{symbol} のデータを取得中...</span>
          </div>
        )}

        {data && !isLoading && (
          <>
            {/* 株価サマリー */}
            <div className="flex flex-wrap items-center gap-4 bg-card border border-border rounded-lg px-4 py-3">
              <div>
                <p className="text-[10px] text-muted-foreground">{data.symbol}</p>
                <p className="text-sm font-bold text-foreground">{data.name}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">現在値</p>
                <p className={`text-xl font-extrabold font-mono ${isPriceUp ? "text-destructive" : "text-emerald-400"}`}>
                  {data.currentPrice.toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {isPriceUp ? (
                  <TrendingUp className="w-4 h-4 text-destructive" />
                ) : (
                  <TrendingDown className="w-4 h-4 text-emerald-400" />
                )}
                <span className={`text-sm font-bold font-mono ${isPriceUp ? "text-destructive" : "text-emerald-400"}`}>
                  {data.priceChange >= 0 ? "+" : ""}{data.priceChange} ({data.priceChangePercent >= 0 ? "+" : ""}{data.priceChangePercent}%)
                </span>
              </div>
              <div className="text-xs text-muted-foreground font-mono">
                <span>高値: <span className="text-foreground font-bold">{data.dayHigh.toLocaleString()}</span></span>
                <span className="mx-2">|</span>
                <span>安値: <span className="text-foreground font-bold">{data.dayLow.toLocaleString()}</span></span>
                <span className="mx-2">|</span>
                <span>出来高: <span className="text-foreground font-bold">{data.volume.toLocaleString()}</span></span>
              </div>
              <div className="ml-auto text-[10px] text-muted-foreground">
                {data.candleCount}本のローソク足
              </div>
            </div>

            {/* チャートと取引シグナル */}
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
              {/* チャート */}
              <div className="xl:col-span-8 bg-card border border-border rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-xs font-bold flex items-center gap-2">
                    <BarChart2 className="w-4 h-4 text-primary" />
                    {data.name} — {range === "1d" ? "本日" : range === "5d" ? "5日間" : "1ヶ月"} ({interval}足)
                  </h2>
                  {selectedCandle && (
                    <div className="text-[10px] font-mono text-muted-foreground bg-secondary/50 px-2 py-0.5 rounded">
                      {selectedCandle.time} | 終値: <span className="text-foreground font-bold">{selectedCandle.close.toFixed(1)}</span>
                    </div>
                  )}
                </div>
                <div className="min-h-[420px]">
                  {candles.length > 0 ? (
                    <ChartComponent
                      data={candles}
                      selectedCandle={selectedCandle}
                      onSelectCandle={setSelectedCandle}
                    />
                  ) : (
                    <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
                      チャートデータなし
                    </div>
                  )}
                </div>
              </div>

              {/* 取引シグナル一覧 */}
              <div className="xl:col-span-4 flex flex-col gap-4">
                {/* 成績サマリー */}
                <Card className="border-border bg-card/60">
                  <CardHeader className="py-2 border-b border-border/50">
                    <CardTitle className="text-xs font-bold flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-primary" />
                      仮想取引成績（1単元=100株）
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="py-3">
                    {completedTrades === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-2">
                        シグナルがまだありません
                      </p>
                    ) : (
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div>
                          <p className="text-[10px] text-muted-foreground">合計損益</p>
                          <p className={`text-sm font-bold font-mono ${totalPnl >= 0 ? "text-destructive" : "text-emerald-400"}`}>
                            {totalPnl >= 0 ? "+" : ""}{totalPnl.toLocaleString()}円
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] text-muted-foreground">勝率</p>
                          <p className={`text-sm font-bold ${winRate >= 60 ? "text-emerald-400" : winRate >= 50 ? "text-yellow-400" : "text-destructive"}`}>
                            {winRate}%
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] text-muted-foreground">取引回数</p>
                          <p className="text-sm font-bold text-foreground">
                            {wins}勝{completedTrades - wins}敗
                          </p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* 取引ペア一覧 */}
                <Card className="border-border bg-card/60 flex-1">
                  <CardHeader className="py-2 border-b border-border/50">
                    <CardTitle className="text-xs font-bold">取引ポイント詳細</CardTitle>
                  </CardHeader>
                  <CardContent className="py-2 overflow-y-auto max-h-[380px]">
                    {tradePairs.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4">
                        シグナルなし
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {tradePairs.map((pair, idx) => (
                          <div
                            key={idx}
                            className={`rounded border p-2 text-[11px] space-y-1 ${
                              pair.pnl === null
                                ? "border-yellow-500/30 bg-yellow-500/5"
                                : pair.pnl > 0
                                ? "border-emerald-500/30 bg-emerald-500/5"
                                : "border-destructive/30 bg-destructive/5"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-foreground">#{idx + 1}</span>
                              {pair.pnl !== null ? (
                                <span className={`font-bold font-mono ${pair.pnl > 0 ? "text-emerald-400" : "text-destructive"}`}>
                                  {pair.pnl > 0 ? "+" : ""}{pair.pnl.toLocaleString()}円
                                </span>
                              ) : (
                                <span className="text-yellow-400 font-bold">保有中</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="bg-destructive/20 text-destructive px-1.5 py-0.5 rounded text-[10px] font-bold">
                                ▲BUY {pair.buySignal.time}
                              </span>
                              <span className="font-mono text-foreground">{pair.buySignal.price.toLocaleString()}</span>
                            </div>
                            <p className="text-muted-foreground text-[10px]">{pair.buySignal.reason}</p>
                            {pair.sellSignal && (
                              <>
                                <div className="flex items-center gap-2">
                                  <span className="bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded text-[10px] font-bold">
                                    ▼SELL {pair.sellSignal.time}
                                  </span>
                                  <span className="font-mono text-foreground">{pair.sellSignal.price.toLocaleString()}</span>
                                </div>
                                <p className="text-muted-foreground text-[10px]">{pair.sellSignal.reason}</p>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* 全シグナルリスト */}
            {signals.length > 0 && (
              <Card className="border-border bg-card/60">
                <CardHeader className="py-2 border-b border-border/50">
                  <CardTitle className="text-xs font-bold flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-yellow-400" />
                    全シグナル一覧（{signals.length}件）
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-2">
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border/50">
                          <th className="text-left py-1 pr-3">時刻</th>
                          <th className="text-left py-1 pr-3">種別</th>
                          <th className="text-right py-1 pr-3">価格</th>
                          <th className="text-right py-1 pr-3">MA5</th>
                          <th className="text-right py-1 pr-3">MA25</th>
                          <th className="text-right py-1 pr-3">RSI</th>
                          <th className="text-left py-1">理由</th>
                        </tr>
                      </thead>
                      <tbody>
                        {signals.map((sig, idx) => (
                          <tr key={idx} className="border-b border-border/20 hover:bg-secondary/20">
                            <td className="py-1 pr-3 font-mono text-foreground">{sig.time}</td>
                            <td className="py-1 pr-3">
                              {sig.type === "buy" ? (
                                <span className="bg-destructive/20 text-destructive px-1.5 py-0.5 rounded font-bold">▲BUY</span>
                              ) : sig.type === "sell" ? (
                                <span className="bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-bold">▼SELL</span>
                              ) : (
                                <span className="bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded font-bold">◆WARN</span>
                              )}
                            </td>
                            <td className="py-1 pr-3 text-right font-mono text-foreground font-bold">{sig.price.toLocaleString()}</td>
                            <td className="py-1 pr-3 text-right font-mono text-muted-foreground">{sig.ma5?.toFixed(1) ?? "—"}</td>
                            <td className="py-1 pr-3 text-right font-mono text-muted-foreground">{sig.ma25?.toFixed(1) ?? "—"}</td>
                            <td className="py-1 pr-3 text-right font-mono text-muted-foreground">{sig.rsi?.toFixed(1) ?? "—"}</td>
                            <td className="py-1 text-muted-foreground">{sig.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </main>
    </div>
  );
}
