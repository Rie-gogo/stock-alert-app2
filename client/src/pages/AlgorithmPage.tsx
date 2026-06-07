import React, { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { Link } from 'wouter';
import {
  ArrowLeft,
  Settings2,
  History,
  Bot,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Save,
  Target,
  Sliders,
  Calendar,
  Bell,
  BellOff,
  CheckCircle2,
  AlertTriangle,
  Clock,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { toast } from 'sonner';

export default function AlgorithmPage() {
  const { data: config, refetch: refetchConfig } = trpc.trading.getConfig.useQuery();
  const { data: improvements, isLoading: improvementsLoading } = trpc.trading.getImprovements.useQuery({ limit: 30 });
  const { data: stats } = trpc.trading.getStats.useQuery({ days: 30 });
  const { data: kabuPlan, refetch: refetchKabuPlan } = trpc.trading.getKabuPlanSettings.useQuery();

  // kabuプラン設定のローカル状態
  const [kabuPlanType, setKabuPlanType] = useState<string>('');
  const [kabuPlanExpires, setKabuPlanExpires] = useState<string>('');
  const [kabuPlanNote, setKabuPlanNote] = useState<string>('');
  const [kabuPlanEditing, setKabuPlanEditing] = useState(false);

  // kabuプラン設定を取得したらローカル状態を初期化
  useEffect(() => {
    if (kabuPlan && !kabuPlanEditing) {
      setKabuPlanType(kabuPlan.planType);
      setKabuPlanExpires(kabuPlan.planExpiresAt);
      setKabuPlanNote(kabuPlan.note ?? '');
    }
  }, [kabuPlan, kabuPlanEditing]);

  const updateKabuPlanMutation = trpc.trading.updateKabuPlanSettings.useMutation({
    onSuccess: () => {
      toast.success('kabuプラン設定を更新しました');
      refetchKabuPlan();
      setKabuPlanEditing(false);
    },
    onError: (e) => toast.error(`更新エラー: ${e.message}`),
  });

  const handleKabuPlanSave = () => {
    if (!kabuPlanExpires.match(/^\d{4}-\d{2}-\d{2}$/)) {
      toast.error('YYYY-MM-DD形式で入力してください');
      return;
    }
    updateKabuPlanMutation.mutate({
      planType: kabuPlanType as 'normal' | 'professional' | 'premium',
      planExpiresAt: kabuPlanExpires,
      note: kabuPlanNote || undefined,
    });
  };

  // 期限までの日数を計算
  const daysUntilExpiry = kabuPlan
    ? Math.ceil((new Date(kabuPlan.planExpiresAt + 'T00:00:00Z').getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  const [localRsiUpper, setLocalRsiUpper] = useState<number | null>(null);
  const [localRsiLower, setLocalRsiLower] = useState<number | null>(null);
  const [localStopLoss, setLocalStopLoss] = useState<number | null>(null);

  const updateConfigMutation = trpc.trading.updateConfig.useMutation({
    onSuccess: () => {
      toast.success('パラメータを更新しました');
      refetchConfig();
      setLocalRsiUpper(null);
      setLocalRsiLower(null);
      setLocalStopLoss(null);
    },
    onError: (e) => toast.error(`更新エラー: ${e.message}`),
  });

  const rsiUpper = localRsiUpper ?? config?.rsiUpper ?? 70;
  const rsiLower = localRsiLower ?? config?.rsiLower ?? 30;
  const stopLoss = localStopLoss ?? parseFloat(String(config?.stopLossPercent ?? '1.5'));

  const hasChanges =
    localRsiUpper !== null || localRsiLower !== null || localStopLoss !== null;

  const handleSave = () => {
    updateConfigMutation.mutate({
      rsiUpper: localRsiUpper ?? undefined,
      rsiLower: localRsiLower ?? undefined,
      stopLossPercent: localStopLoss ?? undefined,
    });
  };

  const currentWinRate = stats?.avgWinRate ?? 0;
  const targetWinRate = 0.8;
  const progressPercent = Math.min(100, (currentWinRate / targetWinRate) * 100);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* ヘッダー */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-40 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <Link href="/">
            <button className="flex items-center space-x-1.5 text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
              <span className="text-xs">ダッシュボードに戻る</span>
            </button>
          </Link>
          <div className="w-px h-4 bg-border" />
          <div className="flex items-center space-x-2">
            <Settings2 className="w-4 h-4 text-primary" />
            <h1 className="text-sm font-bold">アルゴリズム設定 & 改善履歴</h1>
          </div>
        </div>
      </header>

      <div className="p-4 grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* 左側: 目標進捗 + パラメータ設定 */}
        <div className="xl:col-span-4 space-y-4">
          {/* 目標達成進捗 */}
          <Card className="border-border bg-card/60">
            <CardHeader className="py-2.5 px-3 border-b border-border/50">
              <CardTitle className="text-xs font-bold flex items-center space-x-1.5">
                <Target className="w-3.5 h-3.5 text-primary" />
                <span>目標達成進捗（7月中旬実戦まで）</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="py-4 px-3 space-y-4">
              {/* 勝率ゲージ */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-muted-foreground font-bold">直近30日平均勝率</span>
                  <span className={`text-sm font-mono font-bold ${currentWinRate >= 0.8 ? 'text-destructive' : currentWinRate >= 0.6 ? 'text-yellow-400' : 'text-emerald-400'}`}>
                    {(currentWinRate * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="h-3 bg-secondary rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      currentWinRate >= 0.8 ? 'bg-destructive' : currentWinRate >= 0.6 ? 'bg-yellow-400' : 'bg-emerald-400'
                    }`}
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[9px] text-muted-foreground">0%</span>
                  <span className="text-[9px] text-muted-foreground">目標: 80〜90%</span>
                  <span className="text-[9px] text-muted-foreground">100%</span>
                </div>
              </div>

              {/* マイルストーン */}
              <div className="space-y-2">
                {[
                  { label: '初期段階', threshold: 0.5, desc: 'ランダム以上' },
                  { label: '改善段階', threshold: 0.6, desc: '安定した利益' },
                  { label: '良好段階', threshold: 0.7, desc: '実戦準備中' },
                  { label: '目標達成', threshold: 0.8, desc: '実戦開始可能' },
                  { label: '最終目標', threshold: 0.9, desc: '高勝率達成' },
                ].map((milestone) => (
                  <div key={milestone.threshold} className={`flex items-center space-x-2 p-1.5 rounded ${currentWinRate >= milestone.threshold ? 'bg-primary/10' : 'bg-secondary/20'}`}>
                    <div className={`w-2 h-2 rounded-full ${currentWinRate >= milestone.threshold ? 'bg-primary' : 'bg-muted-foreground/30'}`} />
                    <div className="flex-1">
                      <span className={`text-[10px] font-bold ${currentWinRate >= milestone.threshold ? 'text-primary' : 'text-muted-foreground'}`}>
                        {milestone.label}
                      </span>
                      <span className="text-[9px] text-muted-foreground ml-2">({(milestone.threshold * 100).toFixed(0)}%以上)</span>
                    </div>
                    <span className="text-[9px] text-muted-foreground">{milestone.desc}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* パラメータ設定 */}
          <Card className="border-border bg-card/60">
            <CardHeader className="py-2.5 px-3 border-b border-border/50">
              <CardTitle className="text-xs font-bold flex items-center space-x-1.5">
                <Sliders className="w-3.5 h-3.5 text-primary" />
                <span>現在のアルゴリズムパラメータ</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="py-4 px-3 space-y-5">
              {/* RSI上限 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-muted-foreground flex items-center space-x-1.5">
                    <TrendingUp className="w-3.5 h-3.5 text-purple-400" />
                    <span>RSI 買われすぎ閾値</span>
                  </label>
                  <span className="text-xs font-mono font-bold text-purple-400">{rsiUpper}% 以上</span>
                </div>
                <Slider
                  value={[rsiUpper]}
                  max={90}
                  min={55}
                  step={1}
                  onValueChange={(val) => setLocalRsiUpper(val[0])}
                  className="py-1"
                />
                <p className="text-[10px] text-muted-foreground">
                  RSIがこの値を超えると売りシグナルを検知します
                </p>
              </div>

              {/* RSI下限 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-muted-foreground flex items-center space-x-1.5">
                    <TrendingDown className="w-3.5 h-3.5 text-emerald-400" />
                    <span>RSI 売られすぎ閾値</span>
                  </label>
                  <span className="text-xs font-mono font-bold text-emerald-400">{rsiLower}% 以下</span>
                </div>
                <Slider
                  value={[rsiLower]}
                  max={45}
                  min={10}
                  step={1}
                  onValueChange={(val) => setLocalRsiLower(val[0])}
                  className="py-1"
                />
                <p className="text-[10px] text-muted-foreground">
                  RSIがこの値を下回ると買いシグナルを検知します
                </p>
              </div>

              {/* 損切り率 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-muted-foreground flex items-center space-x-1.5">
                    <Target className="w-3.5 h-3.5 text-red-400" />
                    <span>損切り率</span>
                  </label>
                  <span className="text-xs font-mono font-bold text-red-400">{stopLoss.toFixed(1)}%</span>
                </div>
                <Slider
                  value={[stopLoss * 10]}
                  max={50}
                  min={5}
                  step={1}
                  onValueChange={(val) => setLocalStopLoss(val[0] / 10)}
                  className="py-1"
                />
                <p className="text-[10px] text-muted-foreground">
                  買値からこの割合下落したら強制損切りします
                </p>
              </div>

              {hasChanges && (
                <Button size="sm" onClick={handleSave} disabled={updateConfigMutation.isPending} className="w-full text-xs">
                  {updateConfigMutation.isPending ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1" />
                  ) : (
                    <Save className="w-3.5 h-3.5 mr-1" />
                  )}
                  変更を保存
                </Button>
              )}
            </CardContent>
          </Card>
        </div>

        {/* kabuステーション® プラン期限管理 */}
        <div className="xl:col-span-4">
          <Card className="border-border bg-card/60">
            <CardHeader className="py-2.5 px-3 border-b border-border/50">
              <CardTitle className="text-xs font-bold flex items-center space-x-1.5">
                <Calendar className="w-3.5 h-3.5 text-primary" />
                <span>kabuステーション® プラン管理</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 space-y-3">
              {/* 現在のプラン状態表示 */}
              {kabuPlan ? (
                <div className={`rounded-lg p-3 border ${
                  daysUntilExpiry !== null && daysUntilExpiry <= 0
                    ? 'bg-destructive/10 border-destructive/30'
                    : daysUntilExpiry !== null && daysUntilExpiry <= 7
                    ? 'bg-yellow-500/10 border-yellow-500/30'
                    : 'bg-green-500/10 border-green-500/30'
                }`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-1.5">
                      {daysUntilExpiry !== null && daysUntilExpiry <= 0 ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                      ) : daysUntilExpiry !== null && daysUntilExpiry <= 7 ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                      )}
                      <span className="text-[11px] font-bold">
                        {kabuPlan.planType === 'premium' ? 'Premiumプラン' :
                         kabuPlan.planType === 'professional' ? 'Professionalプラン' : '通常プラン'}
                      </span>
                    </div>
                    <span className={`text-[10px] font-mono font-bold ${
                      daysUntilExpiry !== null && daysUntilExpiry <= 0 ? 'text-destructive' :
                      daysUntilExpiry !== null && daysUntilExpiry <= 7 ? 'text-yellow-500' : 'text-green-500'
                    }`}>
                      {daysUntilExpiry !== null && daysUntilExpiry <= 0 ? '期限切れ' : `残り${daysUntilExpiry}日`}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center space-x-1.5">
                      <Clock className="w-3 h-3 text-muted-foreground" />
                      <span className="text-[10px] text-muted-foreground">有効期限: {kabuPlan.planExpiresAt}</span>
                    </div>
                    <div className="flex items-center space-x-1.5">
                      {kabuPlan.reminderSent ? (
                        <><Bell className="w-3 h-3 text-primary" /><span className="text-[10px] text-primary">リマインド送信済み ({new Date(kabuPlan.reminderSentAt!).toLocaleDateString('ja-JP')})</span></>
                      ) : (
                        <><BellOff className="w-3 h-3 text-muted-foreground" /><span className="text-[10px] text-muted-foreground">期限７日前にメール通知</span></>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-4 text-xs text-muted-foreground">
                  <Calendar className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p>プラン設定が未登録です</p>
                </div>
              )}

              {/* 編集フォーム */}
              <div className="space-y-2">
                <p className="text-[10px] font-semibold text-muted-foreground">プラン設定を更新</p>
                <Select value={kabuPlanType} onValueChange={(v) => { setKabuPlanType(v); setKabuPlanEditing(true); }}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue placeholder="プランを選択" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="premium">Premiumプラン</SelectItem>
                    <SelectItem value="professional">Professionalプラン</SelectItem>
                    <SelectItem value="normal">通常プラン</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="date"
                  value={kabuPlanExpires}
                  onChange={(e) => { setKabuPlanExpires(e.target.value); setKabuPlanEditing(true); }}
                  className="h-7 text-xs"
                  placeholder="YYYY-MM-DD"
                />
                <Input
                  type="text"
                  value={kabuPlanNote}
                  onChange={(e) => { setKabuPlanNote(e.target.value); setKabuPlanEditing(true); }}
                  className="h-7 text-xs"
                  placeholder="メモ（任意）"
                />
                <Button
                  size="sm"
                  onClick={handleKabuPlanSave}
                  disabled={updateKabuPlanMutation.isPending || !kabuPlanType || !kabuPlanExpires}
                  className="w-full text-xs h-7"
                >
                  {updateKabuPlanMutation.isPending ? (
                    <RefreshCw className="w-3 h-3 animate-spin mr-1" />
                  ) : (
                    <Save className="w-3 h-3 mr-1" />
                  )}
                  保存
                </Button>
              </div>

              {/* Premiumプラン継続条件 */}
              <div className="bg-secondary/20 rounded-lg p-2.5 space-y-1.5">
                <p className="text-[10px] font-bold text-foreground">Premiumプラン継続条件（いずれか1つ）</p>
                {[
                  '信用取引「大口優遇シルバー」以上適用',
                  '前月の先物・オプション手数料が11万円以上',
                  '前月の米国株手数料が11万円以上',
                  '前月の預り資産が5,000万円以上',
                ].map((cond, i) => (
                  <div key={i} className="flex items-start space-x-1.5">
                    <span className="text-[9px] text-primary mt-0.5">●</span>
                    <span className="text-[9px] text-muted-foreground leading-relaxed">{cond}</span>
                  </div>
                ))}
                <p className="text-[9px] text-muted-foreground pt-1 border-t border-border/30">
                  条件未達成の場合、翌営業日よるProfessionalプランに自動降格（API引き続き利用可）
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 右側: 改善履歴 */}
        <div className="xl:col-span-8">
          <Card className="border-border bg-card/60 h-full">
            <CardHeader className="py-2.5 px-3 border-b border-border/50">
              <CardTitle className="text-xs font-bold flex items-center space-x-1.5">
                <History className="w-3.5 h-3.5 text-primary" />
                <span>AIアルゴリズム改善履歴</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3">
              {improvementsLoading ? (
                <div className="text-center py-8 text-xs text-muted-foreground">読み込み中...</div>
              ) : !improvements || improvements.length === 0 ? (
                <div className="text-center py-12 space-y-3">
                  <Bot className="w-10 h-10 text-muted-foreground mx-auto" />
                  <p className="text-sm text-muted-foreground">まだ改善履歴がありません</p>
                  <p className="text-xs text-muted-foreground">
                    レポート詳細ページで「AIでアルゴリズムを改善する」ボタンを押すと、<br />
                    AIが自動的にパラメータを最適化します
                  </p>
                </div>
              ) : (
                <div className="space-y-3 max-h-[600px] overflow-y-auto">
                  {improvements.map((imp, idx) => {
                    const rsiUpperChanged = imp.newRsiUpper !== imp.prevRsiUpper;
                    const rsiLowerChanged = imp.newRsiLower !== imp.prevRsiLower;
                    const stopLossChanged = imp.newStopLossPercent !== imp.prevStopLossPercent;
                    const hasAnyChange = rsiUpperChanged || rsiLowerChanged || stopLossChanged;

                    return (
                      <div key={imp.id} className="border border-border/60 rounded-lg p-3 bg-card/40 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <Bot className="w-3.5 h-3.5 text-primary" />
                            <span className="text-[10px] font-bold text-foreground">
                              改善 #{improvements.length - idx}
                            </span>
                            {!hasAnyChange && (
                              <span className="text-[8px] bg-secondary text-muted-foreground px-1.5 py-0.5 rounded">変更なし</span>
                            )}
                          </div>
                          <span className="text-[9px] text-muted-foreground font-mono">
                            {new Date(imp.appliedAt).toLocaleString('ja-JP')}
                          </span>
                        </div>

                        {/* パラメータ変更 */}
                        <div className="grid grid-cols-3 gap-2">
                          {[
                            { label: 'RSI上限', prev: imp.prevRsiUpper, next: imp.newRsiUpper, unit: '%', changed: rsiUpperChanged },
                            { label: 'RSI下限', prev: imp.prevRsiLower, next: imp.newRsiLower, unit: '%', changed: rsiLowerChanged },
                            { label: '損切り', prev: imp.prevStopLossPercent, next: imp.newStopLossPercent, unit: '%', changed: stopLossChanged },
                          ].map((param) => (
                            <div key={param.label} className={`p-2 rounded text-center ${param.changed ? 'bg-primary/10 border border-primary/20' : 'bg-secondary/20'}`}>
                              <span className="text-[9px] text-muted-foreground block">{param.label}</span>
                              <div className="flex items-center justify-center space-x-1 mt-0.5">
                                <span className="text-[10px] font-mono text-muted-foreground">{param.prev}{param.unit}</span>
                                {param.changed && (
                                  <>
                                    <span className="text-[8px] text-muted-foreground">→</span>
                                    <span className="text-[10px] font-mono font-bold text-primary">{param.next}{param.unit}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* 改善理由 */}
                        <p className="text-[10px] text-foreground leading-relaxed bg-secondary/20 p-2 rounded">
                          {imp.improvementReason}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
