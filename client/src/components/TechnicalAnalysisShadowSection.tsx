import { Activity, ChevronDown } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Props = { tradeDate: string; autoRefresh: boolean };

function number(value: unknown, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("ja-JP", { maximumFractionDigits: digits }) : "—";
}

function label(value: unknown) {
  const map: Record<string, string> = {
    up: "上昇", down: "下降", range: "レンジ", hold: "判定保留", unavailable: "未取得",
    long: "買い", short: "売り", confirmed: "確認", candidate: "候補", cancelled: "取消",
    trend_pullback: "押し目", trend_retracement: "戻り", ma21_turn: "SMA21転換",
    support_resistance_breakout: "支持抵抗ブレイク", macd_turn: "MACD反転",
    range_reversal: "レンジ反転", pattern_candidate: "チャートパターン",
  };
  return map[String(value)] ?? String(value ?? "—");
}

export default function TechnicalAnalysisShadowSection({ tradeDate, autoRefresh }: Props) {
  const query = trpc.trading.getTechnicalRegimeShadowDashboard.useQuery(
    { tradeDate },
    { refetchInterval: autoRefresh ? 60_000 : false, staleTime: 30_000 },
  );
  return (
    <Card className="bg-card border-cyan-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          10銘柄 テクニカル分析シャドー v2
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          確定1分足・確定5分足・D-1日足の最新状態です。条件充足率は予測勝率ではありません。表示・シャドー検証専用です。
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {query.isLoading ? <div className="text-sm text-muted-foreground py-4">読み込み中...</div>
          : query.isError ? <div className="text-sm text-red-400 py-4">分析状態を取得できませんでした</div>
            : (query.data?.rows ?? []).map(row => {
              const analysis = row.analysis as any;
              const timeframes = analysis?.timeframes ?? {};
              const indicators = timeframes?.oneMinute?.indicators ?? {};
              const signals = Array.isArray(analysis?.signals) ? analysis.signals
                .filter((signal: any) => signal.status === "confirmed" || Number(signal.confidenceCompleteness) >= 0.5)
                .sort((a: any, b: any) => Number(b.confidenceCompleteness) - Number(a.confidenceCompleteness))
                .slice(0, 6) : [];
              const patterns = Array.isArray(analysis?.patterns) ? analysis.patterns : [];
              return (
                <details key={row.symbol} className="rounded-md border border-border bg-background/30 group">
                  <summary className="list-none cursor-pointer px-3 py-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-semibold">{row.symbol}</span>
                      <Badge variant="outline" className="text-[10px]">{analysis ? label(analysis.combinedState) : "待機"}</Badge>
                      {analysis?.selectedExecutableSignalId ? <Badge className="text-[10px] bg-emerald-500/20 text-emerald-300">発火候補あり</Badge> : null}
                      <span className="text-[10px] text-muted-foreground">最終 {analysis?.asOfTime ?? "—"}</span>
                    </div>
                    <ChevronDown className="w-4 h-4 text-muted-foreground group-open:rotate-180 transition-transform" />
                  </summary>
                  <div className="border-t border-border px-3 py-3 space-y-3 text-xs">
                    {!analysis ? <p className="text-muted-foreground">{row.status === "waiting_first_event" ? "公開後の最初の対象イベントを待っています。" : "選択日に対応するstateがありません。"}</p> : <>
                      <div className="grid grid-cols-3 gap-2">
                        <div><span className="text-muted-foreground">1分足</span><div>{label(timeframes?.oneMinute?.state)}</div></div>
                        <div><span className="text-muted-foreground">5分足</span><div>{label(timeframes?.fiveMinute?.state)}</div></div>
                        <div><span className="text-muted-foreground">日足</span><div>{label(timeframes?.daily?.state)}</div></div>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                        <div>終値 {number(indicators.close)}</div><div>SMA21 {number(indicators.sma21)}</div>
                        <div>MACD {number(indicators.macd, 3)}</div><div>RSI {number(indicators.rsi14, 1)}</div>
                        <div>ATR {number(indicators.atr14)}</div><div>出来高倍率 {number(indicators.volumeRatio20, 2)}</div>
                        <div>Stoch %K {number(indicators.stochasticK, 1)}</div><div>RCI短期 {number(indicators.rciShort, 1)}</div>
                      </div>
                      <div>
                        <div className="font-medium mb-1">シグナル候補（最大6件）</div>
                        {signals.length === 0 ? <p className="text-muted-foreground">条件充足率50%以上の候補はありません。</p> : <div className="space-y-2">
                          {signals.map((signal: any) => (
                            <div key={signal.id} className="rounded border border-border p-2 space-y-1">
                              <div className="flex gap-2 flex-wrap items-center">
                                <Badge variant={signal.side === "long" ? "default" : "destructive"} className="text-[10px]">{label(signal.side)}</Badge>
                                <span className="font-medium">{label(signal.type)}</span>
                                <span>{label(signal.status)}</span>
                                <span className="text-muted-foreground">条件充足 {number(Number(signal.confidenceCompleteness) * 100, 0)}%</span>
                                {!signal.executableInShadow && <span className="text-amber-300">表示のみ</span>}
                              </div>
                              <div>入口 {number(signal.entryCandidate)} / SL {number(signal.stopCandidate)} / TP候補 {(signal.targetCandidates ?? []).slice(0, 3).map((v: unknown) => number(v)).join("・") || "—"}</div>
                              <div className="text-emerald-300">成立: {(signal.metConditions ?? []).map((item: any) => item.label).join("、") || "なし"}</div>
                              <div className="text-muted-foreground">未成立: {(signal.unmetConditions ?? []).map((item: any) => item.label).join("、") || "なし"}</div>
                            </div>
                          ))}
                        </div>}
                      </div>
                      <div><span className="font-medium">パターン候補（表示のみ）: </span>{patterns.map((pattern: any) => `${label(pattern.type)} ${label(pattern.status)}`).join("、") || "なし"}</div>
                    </>}
                  </div>
                </details>
              );
            })}
      </CardContent>
    </Card>
  );
}
