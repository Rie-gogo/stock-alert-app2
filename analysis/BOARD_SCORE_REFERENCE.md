# 本番 boardReadingScore 7要素ロジック（完全版）

## 入力
- symbol: string
- side: "long" | "short"  
- snapshot: BoardSnapshot | null (DBのboardSnapshotカラムと同一)

## snapshot構造（DBに保存済み）
```json
{
  "askCancelDetected": boolean,
  "bidCancelDetected": boolean,
  "buyPressureRatio": number,  // = totalBidQty / totalAskQty
  "icebergAskDetected": boolean,
  "icebergBidDetected": boolean,
  "largeAskWallPrice": number | null,
  "largeAskWallRatio": number,
  "largeBidWallPrice": number | null,
  "largeBidWallRatio": number,
  "largeBuyWall": boolean,
  "largeSellWall": boolean,
  "marketOrderDirection": "buy" | "sell" | "neutral",
  "marketOrderRatio": number,
  "nearAskWallPct": number | null,
  "nearBidWallPct": number | null,
  "signal": "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "market_surge" | "neutral",
  "totalAskQty": number,
  "totalBidQty": number
}
```

## 要素A: アグレッシブ注文検出 (±2)
```
if (marketOrderRatio >= 0.08):
  long + bpr > 1.0 → +2
  long + bpr < 1.0 → -2
  short + bpr < 1.0 → +2
  short + bpr > 1.0 → -2
```

## 要素B: 厚い板のアノマリー (±1)
```
long:
  largeSellWall → +1 (売り壁突破の勢い)
  largeBuyWall → -1 (買い壁がサポート→過信)
short:
  largeBuyWall → +1 (買い壁突破の勢い)
  largeSellWall → -1 (売り壁がサポート→過信)
```

## 要素C: 板圧力トレンド (±1)
```
bprHistory (直近5本) の oldest vs newest:
delta = newest - oldest
long + delta >= 0.15 → +1
long + delta <= -0.15 → -1
short + delta <= -0.15 → +1
short + delta >= 0.15 → -1
```

## 要素D: 相場モード判定 (+1/-2)
```
cancelDetected (askCancelDetected || bidCancelDetected) → mode = "trap"
else:
  quiet: history全て0.85-1.15 かつ bpr 0.85-1.15
  active: bpr > 1.2 or bpr < 0.8
  building: |newest - oldest| >= 0.1
  else: trap

active/building → +1
trap/quiet → -2
```

## 要素E: 板圧力の強さ (±1)
```
long + bpr >= 1.4 → +1
long + bpr <= 0.65 → -1
short + bpr <= 0.65 → +1
short + bpr >= 1.4 → -1
```

## 要素F: 歩み値方向推定 (±2)
```
estimateTickDirection:
  marketOrderDirection == "buy" → uptick
  marketOrderDirection == "sell" → downtick
  else: bprHistory trend:
    trend >= 0.2 → uptick
    trend <= -0.2 → downtick
    last >= 1.3 → uptick
    last <= 0.7 → downtick
    else → neutral

uptick + long → +2, uptick + short → -2
downtick + short → +2, downtick + long → -2
```

## 要素G: アイスバーグ検出 (±1)
```
icebergAskDetected → icebergSide = "buy" (売り板食われ→買い方向)
icebergBidDetected → icebergSide = "sell" (買い板食われ→売り方向)

long + icebergSide=="buy" → +1
short + icebergSide=="sell" → +1
long + icebergSide=="sell" → -1
short + icebergSide=="buy" → -1
```

## 閾値
BOARD_SCORE_THRESHOLD = 1 (スコア >= 1 でエントリー許可)

## 板情報なし時
snapshot === null → return 1 (中立、シグナルを通す)

## shouldBoardEarlyExit
- BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05 (0.05%以上の含み益)
- long保有中: signal === "sell_pressure" || signal === "large_sell_wall" → 早期利確
- short保有中: signal === "buy_pressure" || signal === "large_buy_wall" → 早期利確
