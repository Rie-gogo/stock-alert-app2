import { useState, useEffect, useRef } from 'react';
import { Stock, CandleData, BoardData, TradeTick, MarketState, BoardItem, AlertLog } from '../types';
import { enrichCandlesWithTechnicals } from '../lib/technicals';

// 監視対象のデモ銘柄
export const DEMO_STOCKS: Stock[] = [
  { symbol: '6526', name: 'ソシオネクスト', basePrice: 3250 },
  { symbol: '6920', name: 'レーザーテック', basePrice: 22400 },
  { symbol: '9984', name: 'ソフトバンクグループ', basePrice: 8420 },
  { symbol: '7203', name: 'トヨタ自動車', basePrice: 2650 },
  { symbol: '8035', name: '東京エレクトロン', basePrice: 24800 },
];

interface UseRealtimeMarketDataProps {
  selectedStock: Stock;
  rsiThresholdUpper: number;
  rsiThresholdLower: number;
  largeTradeVolume: number;
  soundEnabled: boolean;
  onAlert: (alert: AlertLog) => void;
}

export function useRealtimeMarketData({
  selectedStock,
  rsiThresholdUpper,
  rsiThresholdLower,
  largeTradeVolume,
  soundEnabled,
  onAlert,
}: UseRealtimeMarketDataProps) {
  const [marketState, setMarketState] = useState<MarketState | null>(null);
  const [isPaused, setIsEnabled] = useState<boolean>(false); // 停止/再開

  // 音声再生用シンセサイザー (Web Audio API)
  const audioContextRef = useRef<AudioContext | null>(null);

  const playBeep = (type: 'buy' | 'sell' | 'warning') => {
    if (!soundEnabled) return;
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'buy') {
        // 高いピコーン音
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
        osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.15); // E6
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.2);
      } else if (type === 'sell') {
        // 低いピコーン音、下降
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587, ctx.currentTime); // D5
        osc.frequency.exponentialRampToValueAtTime(392, ctx.currentTime + 0.15); // G4
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.2);
      } else if (type === 'warning') {
        // ブブーという警告音
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(120, ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.35);
      }
    } catch (e) {
      console.error('Audio beep failed', e);
    }
  };

  // 1分足生成用の現在のローソク足一時変数
  const currentCandleRef = useRef<Partial<CandleData> | null>(null);
  const lastPriceRef = useRef<number>(selectedStock.basePrice);

  // 銘柄切り替え時の初期データ生成
  useEffect(() => {
    const base = selectedStock.basePrice;
    lastPriceRef.current = base;

    // 過去50個の1分足を生成
    const now = new Date();
    const tempCandles: CandleData[] = [];
    let tempPrice = base - 50;

    for (let i = 50; i >= 1; i--) {
      const candleTime = new Date(now.getTime() - i * 60000);
      const timeStr = `${String(candleTime.getHours()).padStart(2, '0')}:${String(candleTime.getMinutes()).padStart(2, '0')}`;
      
      const open = tempPrice + (Math.random() - 0.5) * 10;
      const close = open + (Math.random() - 0.48) * 12; // 緩やかな上昇傾向
      const high = Math.max(open, close) + Math.random() * 5;
      const low = Math.min(open, close) - Math.random() * 5;
      const volume = Math.floor(Math.random() * 5000) + 1000;

      tempCandles.push({
        time: timeStr,
        timestamp: Math.floor(candleTime.getTime() / 1000),
        open: Number(open.toFixed(2)),
        high: Number(high.toFixed(2)),
        low: Number(low.toFixed(2)),
        close: Number(close.toFixed(2)),
        volume,
      });

      tempPrice = close;
    }

    // テクニカル指標を付与
    const enriched = enrichCandlesWithTechnicals(tempCandles);
    lastPriceRef.current = enriched[enriched.length - 1].close;

    // 初期板情報生成
    const initialBoard = generateInitialBoard(lastPriceRef.current);

    // 初期歩み値
    const initialTrades = generateInitialTrades(lastPriceRef.current);

    setMarketState({
      currentPrice: lastPriceRef.current,
      priceChange: lastPriceRef.current - base,
      priceChangePercent: Number(((lastPriceRef.current - base) / base * 100).toFixed(2)),
      volume: enriched.reduce((acc, c) => acc + c.volume, 0),
      candles: enriched,
      board: initialBoard,
      trades: initialTrades,
    });

    // 1分足作成用の現在ステート初期化
    const currentMin = now.getMinutes();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`;
    currentCandleRef.current = {
      time: timeStr,
      timestamp: Math.floor(now.setSeconds(0, 0) / 1000),
      open: lastPriceRef.current,
      high: lastPriceRef.current,
      low: lastPriceRef.current,
      close: lastPriceRef.current,
      volume: 0,
    };
  }, [selectedStock]);

  // リアルタイムアップデートのループ (1秒ごと)
  useEffect(() => {
    if (isPaused || !marketState) return;

    const interval = setInterval(() => {
      setMarketState((prev) => {
        if (!prev) return null;

        const basePrice = selectedStock.basePrice;
        const currentPrice = prev.currentPrice;

        // 1. 次の取引価格を決定 (ランダムウォーク + 大口の揺さぶりシミュレーション)
        // 5%の確率で少し大きな値動き、95%は通常の微小変動
        const isBigMove = Math.random() < 0.05;
        const volatility = isBigMove ? 15 : 3;
        const change = (Math.random() - 0.49) * volatility; // 微妙に買いが強いバイアス
        const nextPrice = Math.max(1, Number((currentPrice + change).toFixed(2)));

        // 2. 歩み値（約定）の生成
        const tickCount = Math.floor(Math.random() * 3) + 1; // 1秒間に1〜3回の約定
        const newTicks: TradeTick[] = [];
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        
        let totalTickVolume = 0;

        for (let i = 0; i < tickCount; i++) {
          // 出来高のランダム生成
          let tickVol = Math.floor(Math.random() * 800) + 100;
          
          // 低確率で大口・超大口のシミュレーション
          const rand = Math.random();
          if (rand < 0.03) {
            // 超大口 (10,000株以上)
            tickVol = Math.floor(Math.random() * 5000) + 10000;
          } else if (rand < 0.08) {
            // 大口 (8,000株以上)
            tickVol = Math.floor(Math.random() * 3000) + 8000;
          }

          const tickPrice = Number((nextPrice + (Math.random() - 0.5) * 1).toFixed(2));
          const changeType = tickPrice > currentPrice ? 'up' : tickPrice < currentPrice ? 'down' : 'flat';
          
          let sizeType: 'normal' | 'large' | 'huge' = 'normal';
          if (tickVol >= 10000) {
            sizeType = 'huge';
          } else if (tickVol >= 8000) {
            sizeType = 'large';
          }

          newTicks.push({
            id: Math.random().toString(36).substring(2, 9),
            time: timeStr,
            timestamp: Date.now(),
            price: tickPrice,
            volume: tickVol,
            changeType,
            sizeType,
          });

          totalTickVolume += tickVol;
        }

        const latestPrice = newTicks[newTicks.length - 1].price;

        // 3. アラート検知（大口監視）
        // ⚠️ 超大口の売り崩し
        const hugeSell = newTicks.find(t => t.sizeType === 'huge' && t.changeType === 'down');
        if (hugeSell) {
          const alert: AlertLog = {
            id: Math.random().toString(36).substring(2, 9),
            time: timeStr,
            symbol: selectedStock.symbol,
            type: 'volume_sell_off',
            signal: 'W',
            title: '⚠️超大口の売り崩しを検知！',
            message: `1回で ${hugeSell.volume.toLocaleString()} 株の超巨大売り約定が発生！急落の恐れあり、即時損切りを推奨。`,
            price: hugeSell.price,
            timestamp: Date.now(),
          };
          playBeep('warning');
          onAlert(alert);
        }

        // 🚀 大口の買い上がり (8,000株以上の買いが複数連続)
        const largeBuys = newTicks.filter(t => t.sizeType === 'large' || t.sizeType === 'huge');
        const buyUpTicks = largeBuys.filter(t => t.changeType === 'up');
        if (buyUpTicks.length >= 2) {
          const alert: AlertLog = {
            id: Math.random().toString(36).substring(2, 9),
            time: timeStr,
            symbol: selectedStock.symbol,
            type: 'volume_buy_up',
            signal: 'B',
            title: '🚀大口の買い上がりを検知！',
            message: `大口（${largeBuys[0].volume.toLocaleString()}株〜）の連続買いを検知。ブレイクアウト（急騰）の兆候、追随買いを推奨。`,
            price: latestPrice,
            timestamp: Date.now(),
          };
          playBeep('buy');
          onAlert(alert);
        }

        // 4. 板情報の更新 (現在値に合わせて気配値をピコピコ動かす)
        const updatedBoard = updateBoard(prev.board, latestPrice);

        // 5. ローソク足の更新 (1分足の更新)
        const updatedCandles = [...prev.candles];
        const lastCandleIdx = updatedCandles.length - 1;
        const lastCandle = updatedCandles[lastCandleIdx];
        
        const currentMinStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        
        let newCandles = [...prev.candles];

        if (lastCandle && lastCandle.time === currentMinStr) {
          // 同じ1分の中なので、最後のローソク足を更新
          const updatedLastCandle = {
            ...lastCandle,
            high: Math.max(lastCandle.high, latestPrice),
            low: Math.min(lastCandle.low, latestPrice),
            close: latestPrice,
            volume: lastCandle.volume + totalTickVolume,
          };
          newCandles[lastCandleIdx] = updatedLastCandle;
        } else {
          // 新しい1分に入ったので、新規ローソク足を追加
          const newCandle: CandleData = {
            time: currentMinStr,
            timestamp: Math.floor(now.setSeconds(0, 0) / 1000),
            open: latestPrice,
            high: latestPrice,
            low: latestPrice,
            close: latestPrice,
            volume: totalTickVolume,
          };
          newCandles.push(newCandle);
          // 画面に収まるよう最大100本に制限
          if (newCandles.length > 100) {
            newCandles.shift();
          }
        }

        // テクニカル指標を再計算
        const enrichedCandles = enrichCandlesWithTechnicals(newCandles);
        const currentEnrichedCandle = enrichedCandles[enrichedCandles.length - 1];
        const prevEnrichedCandle = enrichedCandles[enrichedCandles.length - 2];

        // 6. テクニカル分析シグナルの検知
        if (prevEnrichedCandle && currentEnrichedCandle) {
          const { ma5: p5, ma25: p25, rsi: pRsi } = prevEnrichedCandle;
          const { ma5: c5, ma25: c25, rsi: cRsi, bbUpper: cBbu, bbLower: cBbl, close: cClose } = currentEnrichedCandle;

          if (c5 !== undefined && c25 !== undefined && p5 !== undefined && p25 !== undefined && cRsi !== undefined && cBbu !== undefined && cBbl !== undefined) {
            
            // トレンド・需給・大口動向を組み込んだ超厳格化判定
            const isUpTrend = c5 > c25;
            const isDownTrend = c5 < c25;
            const isStrongDownTrend = isDownTrend && cClose < c5;
            const isStrongUpTrend = isUpTrend && cClose >= c5;

            // 直近15件の大口取引のネット出来高を計算
            const recentTradesList = [...newTicks, ...prev.trades].slice(0, 15);
            let netLargeVol = 0;
            recentTradesList.forEach(t => {
              if (t.sizeType === 'large' || t.sizeType === 'huge') {
                if (t.changeType === 'up') netLargeVol += t.volume;
                else if (t.changeType === 'down') netLargeVol -= t.volume;
              }
            });

            // 板需給比率
            const askTotal = updatedBoard.totalAskVolume;
            const bidTotal = updatedBoard.totalBidVolume;
            const askRatio = askTotal / (askTotal + bidTotal);

            // 🌟 【絶好の買いタイミング (B)】
            // 1. 強い下降トレンド（落ちてくるナイフ）中は絶対に買わない
            // 2. 売り板が圧倒的に厚い（売り板が60%以上）時は買わない
            // 3. 条件：(ゴールデンクロス発生) または (RSI売られすぎかつボリバン下限にタッチ)
            // 4. さらに、大口の売り崩しが発生していないこと
            const isBuyGC = p5 <= p25 && c5 > c25;
            const isBuyOversoldAndBottom = cRsi <= rsiThresholdLower && cClose <= cBbl;
            
            if (!isStrongDownTrend && askRatio < 0.6 && netLargeVol >= -2000) {
              if (isBuyGC || isBuyOversoldAndBottom) {
                const alert: AlertLog = {
                  id: Math.random().toString(36).substring(2, 9),
                  time: timeStr,
                  symbol: selectedStock.symbol,
                  type: 'ma_cross',
                  signal: 'B',
                  title: '🌟 【絶好の買い場】高勝率シグナル合致！',
                  message: isBuyGC 
                    ? `トレンド転換のゴールデンクロスを検知。板需給も良好で安全な買い場です。`
                    : `RSI売られすぎ(${cRsi.toFixed(0)}%)とボリバン下限タッチが合致。反発期待値が極めて高いタイミングです。`,
                  price: latestPrice,
                  timestamp: Date.now(),
                };
                playBeep('buy');
                onAlert(alert);
                addSignalToCandle(currentEnrichedCandle, 'buy', isBuyGC ? 'トレンド転換' : '反発買い');
              }
            }

            // 🌟 【絶好の売りタイミング (S)】
            // 1. 強い上昇トレンド（バンドウォーク）中は、RSIが高くても売らずに利益を伸ばす（ホールド）
            // 2. 条件：(デッドクロス発生) または (RSI買われすぎかつボリバン上限タッチ)
            // 3. または、大口の超大口売り崩しを検知した時
            const isSellDC = p5 >= p25 && c5 < c25;
            const isSellOverboughtAndTop = cRsi >= rsiThresholdUpper && cClose >= cBbu;

            if (isSellDC) {
              const alert: AlertLog = {
                id: Math.random().toString(36).substring(2, 9),
                time: timeStr,
                symbol: selectedStock.symbol,
                type: 'ma_cross',
                signal: 'S',
                title: '📉 【絶好の売り場】デッドクロス発生！',
                message: `短期線が長期線を下抜け。上昇トレンド終了、即時利益確定または損切りを推奨。`,
                price: latestPrice,
                timestamp: Date.now(),
              };
              playBeep('sell');
              onAlert(alert);
              addSignalToCandle(currentEnrichedCandle, 'sell', 'デッドクロス');
            } else if (isSellOverboughtAndTop && !isStrongUpTrend) {
              // 強い上昇トレンド中でない場合のみ、ボリバン上限での売りシグナルを発生
              const alert: AlertLog = {
                id: Math.random().toString(36).substring(2, 9),
                time: timeStr,
                symbol: selectedStock.symbol,
                type: 'bollinger',
                signal: 'S',
                title: '🎯 【絶好の売り場】買われすぎ＆ボリバン上限！',
                message: `RSI買われすぎ(${cRsi.toFixed(0)}%)かつボリバン上限に到達。トレンドの天井圏を検知。`,
                price: latestPrice,
                timestamp: Date.now(),
              };
              playBeep('sell');
              onAlert(alert);
              addSignalToCandle(currentEnrichedCandle, 'sell', '天井圏売り');
            }
          }
        }

        // 歩み値履歴を最新15件に維持
        const updatedTrades = [...newTicks, ...prev.trades].slice(0, 25);

        return {
          currentPrice: latestPrice,
          priceChange: latestPrice - basePrice,
          priceChangePercent: Number(((latestPrice - basePrice) / basePrice * 100).toFixed(2)),
          volume: prev.volume + totalTickVolume,
          candles: enrichedCandles,
          board: updatedBoard,
          trades: updatedTrades,
        };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isPaused, selectedStock, rsiThresholdUpper, rsiThresholdLower, largeTradeVolume, soundEnabled, marketState]);

  return {
    marketState,
    isPaused,
    setIsEnabled,
  };
}

// ヘルパー: ローソク足に売買シグナルマークを追加
function addSignalToCandle(candle: CandleData, type: 'buy' | 'sell', reason: string) {
  if (!candle.signals) {
    candle.signals = [];
  }
  // 同じ理由のシグナルが重複して登録されないようにする
  if (!candle.signals.some(s => s.reason === reason)) {
    candle.signals.push({ type, reason });
  }
}

// ヘルパー: 初期板情報の生成
function generateInitialBoard(price: number): BoardData {
  const asks: BoardItem[] = [];
  const bids: BoardItem[] = [];

  for (let i = 10; i >= 1; i--) {
    asks.push({
      price: Number((price + i * 1).toFixed(2)),
      volume: Math.floor(Math.random() * 4000) + 500,
      type: 'ask',
      isBest: i === 1,
    });
  }

  for (let i = 1; i <= 10; i++) {
    bids.push({
      price: Number((price - i * 1).toFixed(2)),
      volume: Math.floor(Math.random() * 4000) + 500,
      type: 'bid',
      isBest: i === 1,
    });
  }

  return {
    asks,
    bids,
    totalAskVolume: asks.reduce((acc, x) => acc + x.volume, 0),
    totalBidVolume: bids.reduce((acc, x) => acc + x.volume, 0),
  };
}

// ヘルパー: 初期歩み値の生成
function generateInitialTrades(price: number): TradeTick[] {
  const trades: TradeTick[] = [];
  const now = new Date();
  
  for (let i = 0; i < 15; i++) {
    const tradeTime = new Date(now.getTime() - i * 2000);
    const timeStr = `${String(tradeTime.getHours()).padStart(2, '0')}:${String(tradeTime.getMinutes()).padStart(2, '0')}:${String(tradeTime.getSeconds()).padStart(2, '0')}`;
    const tPrice = Number((price + (Math.random() - 0.5) * 4).toFixed(2));
    const volume = Math.floor(Math.random() * 1500) + 100;
    
    let sizeType: 'normal' | 'large' | 'huge' = 'normal';
    if (volume >= 10000) sizeType = 'huge';
    else if (volume >= 8000) sizeType = 'large';

    trades.push({
      id: Math.random().toString(36).substring(2, 9),
      time: timeStr,
      timestamp: tradeTime.getTime(),
      price: tPrice,
      volume,
      changeType: Math.random() > 0.5 ? 'up' : 'down',
      sizeType,
    });
  }
  return trades;
}

// ヘルパー: 板情報のリアルタイム更新
function updateBoard(currentBoard: BoardData, price: number): BoardData {
  // 基準価格（現在値）から、上下10本の気配値を再生成・微調整する
  const asks: BoardItem[] = [];
  const bids: BoardItem[] = [];

  for (let i = 10; i >= 1; i--) {
    const targetPrice = Number((price + i * 1).toFixed(2));
    // 既存の板情報から近い価格の出来高を引き継ぐ、または微調整
    const existing = currentBoard.asks.find(a => Math.abs(a.price - targetPrice) < 0.5);
    const baseVol = existing ? existing.volume : Math.floor(Math.random() * 3000) + 500;
    const volChange = (Math.random() - 0.5) * 300; // 板が動くピコピコ感
    const nextVol = Math.max(100, Math.floor(baseVol + volChange));

    asks.push({
      price: targetPrice,
      volume: nextVol,
      type: 'ask',
      isBest: i === 1,
    });
  }

  for (let i = 1; i <= 10; i++) {
    const targetPrice = Number((price - i * 1).toFixed(2));
    const existing = currentBoard.bids.find(b => Math.abs(b.price - targetPrice) < 0.5);
    const baseVol = existing ? existing.volume : Math.floor(Math.random() * 3000) + 500;
    const volChange = (Math.random() - 0.5) * 300;
    const nextVol = Math.max(100, Math.floor(baseVol + volChange));

    bids.push({
      price: targetPrice,
      volume: nextVol,
      type: 'bid',
      isBest: i === 1,
    });
  }

  return {
    asks,
    bids,
    totalAskVolume: asks.reduce((acc, x) => acc + x.volume, 0),
    totalBidVolume: bids.reduce((acc, x) => acc + x.volume, 0),
  };
}
