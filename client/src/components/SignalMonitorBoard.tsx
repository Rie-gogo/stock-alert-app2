import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { toast } from 'sonner';
import {
  Radar,
  ArrowUpCircle,
  ArrowDownCircle,
  AlertTriangle,
  Loader2,
  Eye,
  Wallet,
  Bell,
  BellOff,
} from 'lucide-react';

interface SignalMonitorBoardProps {
  /** 監視対象の銘柄コード（".T" なし）リスト。推奨銘柄＋選択中銘柄など。 */
  symbols: string[];
  /** 現在選択中の銘柄コード（".T" なし）。ハイライト用 */
  activeSymbol?: string;
  /** RSIしきい値（上限） */
  rsiUpper: number;
  /** RSIしきい値（下限） */
  rsiLower: number;
  /** アラート音の有効/無効（ヘッダーの設定と連動） */
  soundEnabled: boolean;
  /** カードの「切替」クリック時。監視銘柄を切り替える */
  onPickSymbol: (symbol: string) => void;
  /** カードの「仮売買」クリック時。指定銘柄で仮売買ダイアログを開く */
  onTrade: (symbol: string) => void;
}

type SignalType = 'buy' | 'sell' | 'warn';
type SignalConfidence = 'strong' | 'medium' | 'weak';

const CONFIDENCE_META: Record<SignalConfidence, { label: string; cls: string }> = {
  strong: { label: '強', cls: 'text-amber-200 bg-amber-500/20 border-amber-400/50' },
  medium: { label: '中', cls: 'text-sky-200 bg-sky-500/15 border-sky-400/40' },
  weak: { label: '弱', cls: 'text-muted-foreground bg-muted border-border/50' },
};

interface ScanItem {
  symbol: string;
  name: string;
  sector: string;
  currentPrice: number;
  priceChange: number;
  priceChangePercent: number;
  rsi: number | null;
  ma5: number | null;
  ma25: number | null;
  latestSignal: { type: SignalType; reason: string; confidence?: SignalConfidence } | null;
  latestSignalTime: string | null;
  error: boolean;
}

const SIGNAL_META: Record<
  SignalType,
  { label: string; cls: string; cardCls: string; icon: typeof ArrowUpCircle; beepFreq: number }
> = {
  buy: {
    label: '買いシグナル',
    cls: 'text-red-300 bg-red-500/15 border-red-500/40',
    cardCls: 'border-red-500/50 bg-red-500/[0.06]',
    icon: ArrowUpCircle,
    beepFreq: 880,
  },
  sell: {
    label: '売りシグナル',
    cls: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/40',
    cardCls: 'border-emerald-500/50 bg-emerald-500/[0.06]',
    icon: ArrowDownCircle,
    beepFreq: 440,
  },
  warn: {
    label: '注意',
    cls: 'text-yellow-300 bg-yellow-500/15 border-yellow-500/40',
    cardCls: 'border-yellow-500/40 bg-yellow-500/[0.05]',
    icon: AlertTriangle,
    beepFreq: 660,
  },
};

export default function SignalMonitorBoard({
  symbols,
  activeSymbol,
  rsiUpper,
  rsiLower,
  soundEnabled,
  onPickSymbol,
  onTrade,
}: SignalMonitorBoardProps) {
  const [notifyEnabled, setNotifyEnabled] = useState<boolean>(true);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // 既に通知済みのシグナル（symbol + time + type）を記録し、同一シグナルの重複通知を防ぐ
  const notifiedRef = useRef<Set<string>>(new Set());

  // 入力配列の参照を安定させる（重複除去＋ソート）
  const stableSymbols = useMemo(() => {
    return Array.from(new Set(symbols)).sort();
  }, [symbols]);

  const { data, isLoading, isFetching, error, dataUpdatedAt } =
    trpc.stockData.getSignalScan.useQuery(
      { symbols: stableSymbols, rsiUpper, rsiLower },
      {
        enabled: stableSymbols.length > 0,
        refetchInterval: 60_000, // 1分ごとにバックグラウンドスキャン
        staleTime: 30_000,
        retry: 1,
      }
    );

  const items: ScanItem[] = useMemo(() => {
    const list = (data?.results ?? []) as ScanItem[];
    // シグナルあり（buy/sell優先）→選択中→コード順 で並べる
    const rank = (it: ScanItem) =>
      it.latestSignal ? (it.latestSignal.type === 'warn' ? 1 : 0) : 2;
    return [...list].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      if (a.symbol === activeSymbol) return -1;
      if (b.symbol === activeSymbol) return 1;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [data, activeSymbol]);

  const playBeep = (freq: number) => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch {
      // 音声再生失敗は無視
    }
  };

  // 新しいシグナルを検知したら通知（トースト＋音）
  useEffect(() => {
    if (!notifyEnabled) return;
    if (!data?.results) return;

    (data.results as ScanItem[]).forEach((it) => {
      if (!it.latestSignal || it.latestSignal.type === 'warn') return;
      const key = `${it.symbol}:${it.latestSignalTime ?? ''}:${it.latestSignal.type}`;
      if (notifiedRef.current.has(key)) return;
      notifiedRef.current.add(key);

      const meta = SIGNAL_META[it.latestSignal.type];
      const conf = it.latestSignal.confidence ?? 'medium';
      if (soundEnabled) playBeep(meta.beepFreq);
      const confTag = conf === 'strong' ? '【信頼度強】' : conf === 'medium' ? '【信頼度中】' : '';
      toast(`${confTag}${meta.label}: ${it.name}`, {
        description: `${it.latestSignalTime ?? ''} ${it.latestSignal.reason}（現在値 ${it.currentPrice.toFixed(1)}円）`,
        duration: 4000,
        className:
          it.latestSignal.type === 'buy'
            ? 'border-red-500/50 bg-red-950/90 text-red-200 font-sans'
            : 'border-emerald-500/50 bg-emerald-950/90 text-emerald-200 font-sans',
        action: {
          label: '仮売買',
          onClick: () => onTrade(it.symbol),
        },
      });
    });
    // notifiedRef のサイズが膨らみすぎないよう、ある程度で初期化
    if (notifiedRef.current.size > 200) {
      notifiedRef.current = new Set(Array.from(notifiedRef.current).slice(-100));
    }
  }, [data, notifyEnabled, soundEnabled, onTrade]);

  const signalCount = items.filter(
    (it) => it.latestSignal && it.latestSignal.type !== 'warn'
  ).length;

  const lastScanStr = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--';

  return (
    <div className="bg-card border border-border rounded-lg p-3">
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-2.5 select-none">
        <div className="flex items-center space-x-2">
          <Radar className={`w-4 h-4 text-primary ${isFetching ? 'animate-pulse' : ''}`} />
          <h2 className="text-xs font-bold text-foreground">
            シグナル監視ボード
            <span className="ml-2 text-[9px] text-emerald-400 font-mono">全銘柄バックグラウンド監視</span>
          </h2>
          {signalCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-extrabold animate-pulse">
              {signalCount}
            </span>
          )}
        </div>
        <div className="flex items-center space-x-2">
          <span className="text-[9px] text-muted-foreground font-mono hidden sm:flex items-center">
            {isFetching ? (
              <>
                <Loader2 className="w-2.5 h-2.5 animate-spin mr-1" />スキャン中
              </>
            ) : (
              <>最終 {lastScanStr}</>
            )}
          </span>
          <button
            onClick={() => setNotifyEnabled((v) => !v)}
            className={`p-1 rounded border transition-colors ${
              notifyEnabled
                ? 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20'
                : 'bg-muted text-muted-foreground border-border hover:bg-muted/80'
            }`}
            title={notifyEnabled ? 'シグナル通知: ON' : 'シグナル通知: OFF'}
          >
            {notifyEnabled ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* 本体 */}
      {isLoading ? (
        <div className="flex items-center justify-center py-6 text-muted-foreground text-xs font-mono space-x-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>監視銘柄をスキャン中...</span>
        </div>
      ) : error ? (
        <div className="text-[10px] text-destructive font-mono py-4 text-center">
          シグナルスキャンに失敗しました（しばらくすると自動で再試行します）
        </div>
      ) : items.length === 0 ? (
        <div className="text-[10px] text-muted-foreground py-4 text-center">監視対象の銘柄がありません</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {items.map((it) => {
            const sig = it.latestSignal;
            const meta = sig ? SIGNAL_META[sig.type] : null;
            const isActive = it.symbol === activeSymbol;
            const isUp = it.priceChange >= 0;
            return (
              <div
                key={it.symbol}
                className={`rounded-lg border p-2.5 transition-all duration-200 ${
                  meta ? meta.cardCls : 'border-border/60 bg-secondary/20'
                } ${isActive ? 'ring-1 ring-primary' : ''}`}
              >
                {/* 銘柄名＋シグナルバッジ */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-foreground leading-tight truncate">
                      {it.name}
                    </div>
                    <div className="text-[9px] text-muted-foreground font-mono">
                      {it.symbol} ・ {it.sector}
                    </div>
                  </div>
                  {meta ? (
                    <div className="flex items-center gap-1 whitespace-nowrap">
                      {sig!.confidence && sig!.type !== 'warn' && (
                        <span
                          className={`text-[9px] font-bold px-1 py-0.5 rounded border ${CONFIDENCE_META[sig!.confidence].cls}`}
                          title={`信頼度：${CONFIDENCE_META[sig!.confidence].label}（裏付け指標の一致数）`}
                        >
                          {CONFIDENCE_META[sig!.confidence].label}
                        </span>
                      )}
                      <span
                        className={`flex items-center space-x-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded border ${meta.cls}`}
                      >
                        <meta.icon className="w-3 h-3" />
                        <span>{sig!.type === 'buy' ? '買い' : sig!.type === 'sell' ? '売り' : '注意'}</span>
                      </span>
                    </div>
                  ) : (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-border/50 text-muted-foreground whitespace-nowrap">
                      様子見
                    </span>
                  )}
                </div>

                {/* 現在値・前日比・RSI */}
                <div className="flex items-center justify-between mt-1.5 font-mono">
                  {it.error ? (
                    <span className="text-[10px] text-muted-foreground">データ取得失敗</span>
                  ) : (
                    <>
                      <span className={`text-sm font-extrabold ${isUp ? 'text-destructive' : 'text-emerald-500'}`}>
                        {it.currentPrice.toFixed(1)}
                      </span>
                      <span className={`text-[10px] font-bold ${isUp ? 'text-destructive' : 'text-emerald-500'}`}>
                        {isUp ? '+' : ''}
                        {it.priceChangePercent}%
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        RSI {it.rsi != null ? it.rsi.toFixed(0) : '--'}
                      </span>
                    </>
                  )}
                </div>

                {/* シグナル理由 */}
                {sig && (
                  <div className="mt-1 text-[9px] text-muted-foreground leading-snug line-clamp-2">
                    {it.latestSignalTime ? `${it.latestSignalTime} ` : ''}
                    {sig.reason}
                  </div>
                )}

                {/* アクション */}
                <div className="flex items-center gap-1.5 mt-2">
                  <button
                    onClick={() => onPickSymbol(it.symbol)}
                    disabled={isActive}
                    className={`flex-1 flex items-center justify-center space-x-1 px-2 py-1 rounded text-[10px] font-bold border transition-all duration-200 active:scale-[0.97] ${
                      isActive
                        ? 'bg-primary/15 text-primary border-primary/30 cursor-default'
                        : 'bg-secondary/50 text-muted-foreground border-border/50 hover:bg-secondary hover:text-foreground'
                    }`}
                  >
                    <Eye className="w-3 h-3" />
                    <span>{isActive ? '表示中' : '切替'}</span>
                  </button>
                  <button
                    onClick={() => onTrade(it.symbol)}
                    className="flex-1 flex items-center justify-center space-x-1 px-2 py-1 rounded text-[10px] font-bold border bg-yellow-500/10 text-yellow-300 border-yellow-500/30 hover:bg-yellow-500/20 transition-all duration-200 active:scale-[0.97]"
                  >
                    <Wallet className="w-3 h-3" />
                    <span>仮売買</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
