import { AlertCircle, BrainCircuit, CheckCircle2, Clock3 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function yen(value: unknown) { const number = Number(value); return Number.isFinite(number) ? `${number.toLocaleString()}円` : "—"; }
function directionLabel(direction: unknown) {
  if (direction === "strong_up" || direction === "up") return { label: direction === "strong_up" ? "強上昇" : "上昇", className: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" };
  if (direction === "strong_down" || direction === "down") return { label: direction === "strong_down" ? "強下降" : "下降", className: "text-rose-300 border-rose-500/40 bg-rose-500/10" };
  return { label: direction === "range" ? "レンジ" : direction === "insufficient" ? "不足" : direction === "stale" ? "古い" : "待機", className: "text-muted-foreground border-border bg-muted/20" };
}

export default function AiDailyForecastShadowSection({ tradeDate }: { tradeDate: string }) {
  const query = trpc.trading.getAiDailyForecastDashboard.useQuery({ tradeDate }, { staleTime: 30_000 });
  const intradayQuery = trpc.trading.getAiIntradayForecastDashboard.useQuery({ tradeDate }, { staleTime: 30_000, retry: false });
  const snapshot = query.data?.snapshot;
  if (query.isLoading) return <Card className="bg-card border-border"><CardContent className="py-5 text-sm text-muted-foreground">AI適応予測shadowを読み込み中…</CardContent></Card>;
  if (!snapshot) return <Card className="bg-card border-border"><CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><BrainCircuit className="w-4 h-4 text-violet-300" />10銘柄 AI適応予測shadow（監視専用）</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground flex gap-2"><AlertCircle className="w-4 h-4" />{tradeDate}の08:30予測snapshotは未生成です。入力不足時はno_tradeのまま生成しません。</CardContent></Card>;
  const intradaySnapshots = intradayQuery.data?.intradaySnapshots ?? []; const latestIntraday = intradaySnapshots.at(-1);
  const payload = asRecord(snapshot.forecastJson); const morningForecasts = asRecord(payload.aiFinalForecast).forecasts;
  const intradayPayload = latestIntraday ? asRecord(latestIntraday.forecastJson) : {}; const intradayFinal = asRecord(intradayPayload.aiFinalForecast); const activeForecasts = latestIntraday ? asRecord(intradayFinal.forecast).forecasts : morningForecasts;
  const rows = Array.isArray(activeForecasts) ? activeForecasts.map(asRecord) : [];
  const validation = asRecord(snapshot.validationJson); const revisions = query.data?.revisions ?? [];
  return <Card className="bg-card border-violet-500/20">
    <CardHeader className="pb-2"><CardTitle className="text-sm flex flex-wrap items-center gap-2"><BrainCircuit className="w-4 h-4 text-violet-300" />10銘柄 AI適応予測shadow（08:30＋30分更新・監視専用）<Badge variant="outline" className="text-[10px] border-violet-400/40 text-violet-200">注文非接続・自動採用なし</Badge><Badge variant="outline" className="text-[10px]">{String(snapshot.qualityStatus)}</Badge></CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs text-muted-foreground"><span>対象日: <b className="text-foreground font-mono">{snapshot.tradeDate}</b></span><span>有効計画: <b className="text-foreground font-mono">{latestIntraday ? `${latestIntraday.checkpoint}更新` : "08:30朝計画"}</b></span><span>model: <b className="text-foreground">{latestIntraday?.aiModelId ?? snapshot.aiModelId ?? "—"}</b></span><span>計画ID: <b className="text-foreground font-mono break-all">{latestIntraday?.sourceRevisionId ?? snapshot.sourceSnapshotId}</b></span></div>
      <div className="rounded-md bg-muted/20 p-2 text-xs text-muted-foreground">品質: {Array.isArray(validation.inputReasons) ? validation.inputReasons.join(", ") || "verified" : "—"} ／ AI検証: {validation.outputValid === true ? <span className="text-emerald-300">合格</span> : <span className="text-rose-300">invalid / reference-only</span>}</div>
      <div className="overflow-x-auto"><Table><TableHeader><TableRow className="border-border hover:bg-transparent"><TableHead>銘柄</TableHead><TableHead>方向</TableHead><TableHead>予測安値〜高値</TableHead><TableHead>押し目／戻り帯</TableHead><TableHead>確認価格</TableHead><TableHead>第一目標</TableHead><TableHead>baseline</TableHead><TableHead>根拠</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => { const direction = directionLabel(row.direction); return <TableRow key={String(row.symbol)} className="border-border"><TableCell className="font-mono font-medium">{String(row.symbol)}</TableCell><TableCell><Badge variant="outline" className={`text-[10px] ${direction.className}`}>{direction.label}</Badge></TableCell><TableCell className="font-mono text-xs">{yen(row.forecastLow)}〜{yen(row.forecastHigh)}</TableCell><TableCell className="font-mono text-xs">{yen(row.zoneLow)}〜{yen(row.zoneHigh)}</TableCell><TableCell className="font-mono text-xs">{yen(row.confirmPrice)}</TableCell><TableCell className="font-mono text-xs">{yen(row.firstTarget)}</TableCell><TableCell className="text-xs">{String(row.baselineDecision ?? "—")}</TableCell><TableCell className="text-xs text-muted-foreground max-w-[300px] whitespace-normal">{String(row.rationale ?? "—")}</TableCell></TableRow>; })}</TableBody></Table></div>
      <div className="text-xs text-muted-foreground flex items-center gap-2"><Clock3 className="w-3 h-3" />④日経225mini revision: {revisions.length === 0 ? "未記録" : `${revisions.length}件`} {revisions.some(item => item.revisionStatus === "market_context_invalidated") ? <Badge variant="destructive">未entry新規シグナル停止</Badge> : <Badge variant="outline" className="text-emerald-300 border-emerald-500/40"><CheckCircle2 className="w-3 h-3 mr-1" />snapshot不変</Badge>}</div>
      <div className="text-xs text-muted-foreground flex items-center gap-2"><BrainCircuit className="w-3 h-3" />30分AI再判断: {intradaySnapshots.length === 0 ? "まだありません（朝計画を使用）" : `${intradaySnapshots.length}回／最新 ${latestIntraday?.checkpoint}（入力cutoff ${latestIntraday?.cutoffCandleTime}）`}。場中計画は追記保存され、過去計画は上書きしません。</div>
    </CardContent>
  </Card>;
}
