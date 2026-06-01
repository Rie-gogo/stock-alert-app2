import React, { useState, useCallback } from 'react';
import { Link } from 'wouter';
import { useRealtimeMarketData, DEMO_STOCKS } from '../hooks/useRealtimeMarketData';
import { Stock, AlertLog, CandleData } from '../types';
import ChartComponent from '../components/ChartComponent';
import BoardComponent from '../components/BoardComponent';
import TradeHistoryComponent from '../components/TradeHistoryComponent';
import AlertHistoryComponent from '../components/AlertHistoryComponent';
import BacktestModal from '../components/BacktestModal';
import AIAdvisorPanel from '../components/AIAdvisorPanel';
import DailyReportModal from '../components/DailyReportModal';
import { diagnoseMarket } from '../lib/advisor';
import { toast } from 'sonner';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  TrendingUp,
  TrendingDown,
  Sliders,
  Settings2,
  Info,
  LineChart,
  Grid3X3,
  History,
  Activity,
  BarChart2,
  AlertTriangle,
  Zap,
} from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Home() {
  // The userAuth hooks provides authentication state
  // To implement login/logout functionality, simply call logout() or redirect to getLoginUrl()
  // アプリケーション設定ステート
  const [selectedStock, setSelectedStock] = useState<Stock>(DEMO_STOCKS[0]);
  const [rsiUpper, setRsiUpper] = useState<number>(70);
  const [rsiLower, setRsiLower] = useState<number>(30);
  const [largeVolume, setLargeVolume] = useState<number>(8000);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  
  // アラート履歴ログステート
  const [alerts, setAlerts] = useState<AlertLog[]>([]);
  
  // チャート上の特定ローソク足ホバー/選択状態
  const [selectedCandle, setSelectedCandle] = useState<CandleData | null>(null);

  // 新規アラート発生時のコールバック
  const handleAlert = useCallback((alert: AlertLog) => {
    // 1. アラート履歴の先頭に追加
    setAlerts((prev) => [alert, ...prev].slice(0, 100)); // 最大100件保存

    // 2. トースト通知の表示
    const isWarning = alert.signal === 'W';
    const isBuy = alert.signal === 'B';

    toast(alert.title, {
      description: alert.message,
      duration: 2500,
      className: isWarning 
        ? 'border-yellow-500/50 bg-yellow-950/90 text-yellow-200 font-sans'
        : isBuy
        ? 'border-destructive/50 bg-red-950/90 text-red-200 font-sans'
        : 'border-emerald-500/50 bg-emerald-950/90 text-emerald-200 font-sans',
    });
  }, []);

  // リアルタイムデータカスタムフックの呼び出し
  const { marketState, isPaused, setIsEnabled } = useRealtimeMarketData({
    selectedStock,
    rsiThresholdUpper: rsiUpper,
    rsiThresholdLower: rsiLower,
    largeTradeVolume: largeVolume,
    soundEnabled,
    onAlert: handleAlert,
  });

  // アラート履歴ログクリック時のアクション (該当箇所にジャンプなど)
  const handleSelectAlert = (alert: AlertLog) => {
    toast.info(`アラート参照`, {
      description: `${alert.time} [${alert.symbol}] ${alert.title} (価格: ${alert.price.toFixed(1)})`,
    });
  };

  // 1分足最新データの終値や前日比の表示スタイル
  const isPriceUp = marketState ? marketState.priceChange >= 0 : true;
  const priceColorClass = isPriceUp ? 'text-destructive' : 'text-emerald-500';
  const priceBgClass = isPriceUp ? 'bg-destructive/10 border-destructive/20' : 'bg-emerald-500/10 border-emerald-500/20';

  // リアルタイム売買シグナル診断の計算
  const marketDiagnosis = marketState
    ? diagnoseMarket(
        marketState.candles,
        marketState.trades,
        rsiUpper,
        rsiLower,
        marketState.board.totalAskVolume,
        marketState.board.totalBidVolume
      )
    : null;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-primary/20">
      {/* 1. ヘッダーパネル */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-40 px-4 py-2 flex flex-wrap items-center justify-between gap-4">
        {/* 左側：ロゴ ＆ 銘柄選択 */}
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <div className="w-7 h-7 bg-destructive rounded flex items-center justify-center font-bold text-white text-sm tracking-wider animate-pulse">
              SBI
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-foreground flex items-center">
                リアルタイム株価アラート ＆ 分析
                <span className="text-[9px] bg-primary/20 text-primary px-1.5 py-0.2 rounded ml-2 font-mono border border-primary/30">PRO</span>
              </h1>
              <p className="text-[10px] text-muted-foreground">秒単位リアルタイム計算 ＆ シグナル検知</p>
            </div>
          </div>

          {/* 銘柄セレクター */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[10px] text-muted-foreground font-bold">監視銘柄:</span>
            <select
              value={selectedStock.symbol}
              onChange={(e) => {
                const stock = DEMO_STOCKS.find((s) => s.symbol === e.target.value);
                if (stock) {
                  setSelectedStock(stock);
                  setAlerts([]); // 銘柄切り替え時にアラートをリセット
                }
              }}
              className="bg-secondary/80 border border-border text-xs rounded px-2.5 py-1 font-bold text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {DEMO_STOCKS.map((stock) => (
                <option key={stock.symbol} value={stock.symbol}>
                  {stock.symbol} - {stock.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 中央：現在値簡易ボード */}
        {marketState && (
          <div className="flex items-center space-x-6 bg-secondary/30 border border-border/50 px-4 py-1 rounded font-mono">
            <div className="flex flex-col">
              <span className="text-[9px] text-muted-foreground font-bold">現在値</span>
              <span className={`text-base font-extrabold tracking-tight ${priceColorClass}`}>
                {marketState.currentPrice.toFixed(1)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] text-muted-foreground font-bold">前日比</span>
              <span className={`text-xs font-bold flex items-center ${priceColorClass}`}>
                {isPriceUp ? '+' : ''}
                {marketState.priceChange.toFixed(1)} ({isPriceUp ? '+' : ''}
                {marketState.priceChangePercent}%)
              </span>
            </div>
            <div className="flex flex-col hidden sm:flex">
              <span className="text-[9px] text-muted-foreground font-bold">累計出来高</span>
              <span className="text-xs font-bold text-yellow-500/90">
                {marketState.volume.toLocaleString()} 株
              </span>
            </div>
            <div className="flex flex-col hidden md:flex">
              <span className="text-[9px] text-muted-foreground font-bold">ステータス</span>
              <span className="text-[10px] text-emerald-400 font-bold flex items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping mr-1.5" />
                市場接続中
              </span>
            </div>
          </div>
        )}

        {/* 右側：コントロール */}
        <div className="flex items-center space-x-3">
          {/* デイリー検証レポート */}
          <DailyReportModal rsiUpper={rsiUpper} rsiLower={rsiLower} />

          {/* レポート履歴ページへのリンク */}
          <Link href="/reports">
            <button className="flex items-center space-x-1 px-3 py-1 rounded text-xs font-bold transition-all duration-200 border bg-secondary/50 text-muted-foreground border-border/50 hover:bg-secondary hover:text-foreground">
              <History className="w-3.5 h-3.5" />
              <span>レポート履歴</span>
            </button>
          </Link>

          {/* アルゴリズム設定ページへのリンク */}
          <Link href="/algorithm">
            <button className="flex items-center space-x-1 px-3 py-1 rounded text-xs font-bold transition-all duration-200 border bg-secondary/50 text-muted-foreground border-border/50 hover:bg-secondary hover:text-foreground">
              <Settings2 className="w-3.5 h-3.5" />
              <span>アルゴリズム</span>
            </button>
          </Link>

          {/* 実際の株価チャートページへのリンク */}
          <Link href="/chart">
            <button className="flex items-center space-x-1 px-3 py-1 rounded text-xs font-bold transition-all duration-200 border bg-primary/10 text-primary border-primary/30 hover:bg-primary/20">
              <BarChart2 className="w-3.5 h-3.5" />
              <span>実際のチャート</span>
            </button>
          </Link>

          {/* バックテストモーダル */}
          {marketState && (
            <BacktestModal
              candles={marketState.candles}
              rsiUpper={rsiUpper}
              rsiLower={rsiLower}
            />
          )}

          {/* 一時停止/再開 */}
          <button
            onClick={() => setIsEnabled(!isPaused)}
            className={`flex items-center space-x-1 px-3 py-1 rounded text-xs font-bold transition-all duration-200 border ${
              isPaused
                ? 'bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/20'
                : 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20'
            }`}
          >
            {isPaused ? (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>配信再開</span>
              </>
            ) : (
              <>
                <Pause className="w-3.5 h-3.5 fill-current" />
                <span>配信停止</span>
              </>
            )}
          </button>

          {/* 音声 ON/OFF */}
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`p-1.5 rounded border transition-colors ${
              soundEnabled
                ? 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20'
                : 'bg-muted text-muted-foreground border-border hover:bg-muted/80'
            }`}
            title={soundEnabled ? 'アラート音: ON' : 'アラート音: OFF'}
          >
            {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* 2. メインダッシュボードレイアウト */}
      <main className="flex-1 p-4 grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* 左側＆中央：チャート、板情報、歩み値 (10カラム分) */}
        <div className="xl:col-span-9 flex flex-col space-y-4">
          {/* AI売買シグナル診断AIアドバイザーパネル（LLM搭載） */}
          <div className="w-full">
            <AIAdvisorPanel
              marketState={marketState}
              selectedStock={selectedStock}
              rsiUpper={rsiUpper}
              rsiLower={rsiLower}
              ruleBasedDiagnosis={marketDiagnosis}
            />
          </div>

          {/* 上部3カラム構成：チャート(60%) ＋ 板情報(20%) ＋ 歩み値(20%) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* チャートコンポーネント (6/12) */}
            <div className="lg:col-span-6 flex flex-col bg-card border border-border rounded-lg p-3 relative overflow-hidden">
              <div className="flex items-center justify-between mb-2 select-none">
                <div className="flex items-center space-x-2">
                  <LineChart className="w-4 h-4 text-primary" />
                  <h2 className="text-xs font-bold text-foreground">リアルタイムチャート (1分足)</h2>
                </div>
                {selectedCandle && (
                  <div className="text-[10px] font-mono text-muted-foreground bg-secondary/50 px-2 py-0.5 rounded">
                    選択中: <span className="text-foreground font-bold">{selectedCandle.time}</span> | 終値: <span className="text-foreground font-bold">{selectedCandle.close.toFixed(1)}</span>
                  </div>
                )}
              </div>
              
              <div className="flex-1 min-h-[400px]">
                {marketState ? (
                  <ChartComponent
                    data={marketState.candles}
                    selectedCandle={selectedCandle}
                    onSelectCandle={setSelectedCandle}
                  />
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-xs font-mono">
                    チャート初期化中...
                  </div>
                )}
              </div>
            </div>

            {/* 板情報 (気配値) (3/12) */}
            <div className="lg:col-span-3 flex flex-col bg-card border border-border rounded-lg p-3 overflow-hidden">
              <div className="flex items-center space-x-2 mb-2 select-none">
                <Grid3X3 className="w-4 h-4 text-emerald-400" />
                <h2 className="text-xs font-bold text-foreground">リアルタイム板情報</h2>
              </div>
              <div className="flex-1">
                {marketState ? (
                  <BoardComponent data={marketState.board} currentPrice={marketState.currentPrice} />
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-xs font-mono">
                    板情報ロード中...
                  </div>
                )}
              </div>
            </div>

            {/* 歩み値 (タイム＆セールス) (3/12) */}
            <div className="lg:col-span-3 flex flex-col bg-card border border-border rounded-lg p-3 overflow-hidden">
              <div className="flex items-center space-x-2 mb-2 select-none">
                <Activity className="w-4 h-4 text-destructive" />
                <h2 className="text-xs font-bold text-foreground">リアルタイム歩み値</h2>
              </div>
              <div className="flex-1">
                {marketState ? (
                  <TradeHistoryComponent trades={marketState.trades} />
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-xs font-mono">
                    歩み値ロード中...
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 下部：アラートログパネル */}
          <div className="flex-1">
            <AlertHistoryComponent alerts={alerts} onSelectAlert={handleSelectAlert} />
          </div>
        </div>

        {/* 右側：アラート設定 ＆ パラメータチューニング (3カラム分) */}
        <div className="xl:col-span-3 flex flex-col space-y-4">
          <Card className="border-border bg-card/60 backdrop-blur-sm h-full">
            <CardHeader className="py-3 border-b border-border/50">
              <CardTitle className="text-xs font-extrabold flex items-center space-x-2">
                <Sliders className="w-4 h-4 text-primary" />
                <span>アラート感度 ＆ パラメータ設定</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="py-4 space-y-6">
              {/* RSI 設定 */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-muted-foreground flex items-center space-x-1.5">
                    <TrendingUp className="w-3.5 h-3.5 text-purple-400" />
                    <span>RSI 買われすぎ閾値</span>
                  </label>
                  <span className="text-xs font-mono font-bold text-purple-400">{rsiUpper}% 以上</span>
                </div>
                <Slider
                  defaultValue={[rsiUpper]}
                  max={90}
                  min={65}
                  step={1}
                  onValueChange={(val) => setRsiUpper(val[0])}
                  className="py-1"
                />
                <p className="text-[10px] text-muted-foreground">
                  RSIがこの数値を超えると、高値警戒として**売り(S)シグナル**を検知します。
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-muted-foreground flex items-center space-x-1.5">
                    <TrendingDown className="w-3.5 h-3.5 text-emerald-400" />
                    <span>RSI 売られすぎ閾値</span>
                  </label>
                  <span className="text-xs font-mono font-bold text-emerald-400">{rsiLower}% 以下</span>
                </div>
                <Slider
                  defaultValue={[rsiLower]}
                  max={35}
                  min={10}
                  step={1}
                  onValueChange={(val) => setRsiLower(val[0])}
                  className="py-1"
                />
                <p className="text-[10px] text-muted-foreground">
                  RSIがこの数値を下回ると、底値反発狙いとして**買い(B)シグナル**を検知します。
                </p>
              </div>

              <hr className="border-border/50" />

              {/* 大口監視設定 */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-muted-foreground flex items-center space-x-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-pink-400" />
                    <span>大口判定の基準出来高</span>
                  </label>
                  <span className="text-xs font-mono font-bold text-pink-400">
                    {largeVolume.toLocaleString()} 株以上
                  </span>
                </div>
                <Slider
                  defaultValue={[largeVolume]}
                  max={15000}
                  min={5000}
                  step={500}
                  onValueChange={(val) => setLargeVolume(val[0])}
                  className="py-1"
                />
                <p className="text-[10px] text-muted-foreground">
                  1取引あたりの出来高がこの基準を超えると、歩み値上で**大口(ピンク)**、さらに1.25倍以上で**超大口(ゴールド)**としてマークされます。
                </p>
              </div>

              <hr className="border-border/50" />

              {/* シグナルロジックの説明 */}
              <div className="bg-secondary/20 border border-border/50 rounded p-3 space-y-2">
                <h4 className="text-[10px] font-bold text-foreground flex items-center">
                  <Info className="w-3.5 h-3.5 mr-1.5 text-primary" />
                  自動売買シグナル検知ルール
                </h4>
                <ul className="text-[9px] text-muted-foreground space-y-1.5 list-disc pl-3">
                  <li>
                    <strong className="text-foreground">MAクロス</strong>: 短期5MAが長期25MAをゴールデンクロスで買い(B)、デッドクロスで売り(S)。
                  </li>
                  <li>
                    <strong className="text-foreground">ボリンジャーバンド</strong>: ±2σバンドタッチ時に逆張りの売買シグナルを自動プロット。
                  </li>
                  <li>
                    <strong className="text-foreground">超大口売り崩し</strong>: 10,000株以上の売り約定が発生し、買い板が薄い場合に急落警告(WARN)。
                  </li>
                  <li>
                    <strong className="text-foreground">大口買い上がり</strong>: 8,000株以上の買い約定が連続発生した場合に急騰期待(BUY)。
                  </li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>

      {/* 3. フッターステータス */}
      <footer className="border-t border-border bg-card/30 px-4 py-2 flex items-center justify-between text-[10px] text-muted-foreground font-mono select-none">
        <div>
          <span>PRO-TERMINAL v1.4.0</span>
          <span className="mx-2">|</span>
          <span>データソース: 精巧シミュレーションエンジン (毎秒同期)</span>
        </div>
        <div className="flex items-center space-x-4">
          <span className="flex items-center">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse" />
            CPU負荷: 低
          </span>
          <span>LATENCY: 12ms</span>
        </div>
      </footer>
    </div>
  );
}
