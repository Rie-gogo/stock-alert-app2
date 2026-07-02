# リアルタイムシミュレーションエンジン 仕様書

**バージョン:** v7.0（パターンC+10銘柄方式）  
**最終更新:** 2026-07-01  
**ファイル:** `server/realtimeSimEngine.ts`

---

## 1. 概要

本エンジンは、kabu STATION APIから取得した1分足リアルタイムデータに基づき、日本株のデイトレード売買シグナルを生成・管理するシミュレーションエンジンである。シグナル検出、板情報分析、ポジション管理、損益計算を統合的に処理する。

---

## 2. 対象銘柄（10銘柄）

| コード | 銘柄名 | セクター |
|--------|--------|----------|
| 6920 | レーザーテック | 半導体 |
| 8035 | 東京エレクトロン | 半導体 |
| 6857 | アドバンテスト | 半導体 |
| 6976 | 太陽誘電 | 電子部品 |
| 6526 | ソシオネクスト | 半導体 |
| 9984 | ソフトバンクグループ | IT |
| 8316 | 三井住友FG | 金融 |
| 7011 | 三菱重工業 | 重工 |
| 5803 | フジクラ | 電線 |
| 6981 | 村田製作所 | 電子部品 |

**ポートフォリオ制約:**
- 最大同時保有ポジション: 3
- 同一セクター最大: 2

---

## 3. 定数・パラメータ一覧

### 3.1 損益管理

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| STOP_LOSS_PERCENT | 0.5% | 損切りライン |
| TAKE_PROFIT_PERCENT | 1.5% | 利確ライン |
| BE_TRIGGER_PERCENT | 0.5% | BEストップ発動閾値（含み益がこの値に到達でSL→建値移動） |
| LOT_SIZE_AMOUNT | 1,000,000円 | 1ポジションの投資額 |
| MAX_TOTAL_EXPOSURE | 3,300,000円 | 証拠金使用上限 |

### 3.2 時間帯フィルター

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| NO_ENTRY_START | "09:00" | エントリー禁止開始 |
| NO_ENTRY_END | "09:04" | エントリー禁止終了 |
| NO_ENTRY_LUNCH_START | "12:25" | 昼休みエントリー禁止開始 |
| NO_ENTRY_LUNCH_END | "12:35" | 昼休みエントリー禁止終了 |
| FORCE_CLOSE_TIME | "15:20" | 大引け強制決済時刻 |
| PM_BPR_FILTER_START | "13:00" | 後場BPRフィルター適用開始 |

### 3.3 板読みスコア

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| BOARD_SCORE_THRESHOLD | 2 | エントリー許可に必要な最低板読みスコア |
| PM_BPR_BLOCK_THRESHOLD | 0.65 | 後場SHORT BPRブロック閾値 |

### 3.4 VWAP急落フィルター

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| VWAP_DROP_FILTER_5BARS | -0.5% | 直近5本の下落率閾値 |
| VWAP_DROP_FILTER_3BARS | -0.4% | 直近3本の下落率閾値 |

### 3.5 ATRフィルター

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| ATR_FILTER_PERIOD | 14 | ATR計算期間 |
| ATR_FILTER_THRESHOLD | 0.05% | 最低ATR率（これ未満はエントリー禁止） |

### 3.6 押し目深さフィルター

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| PULLBACK_DEPTH_LOOKBACK | 20 | スイング計算ルックバック期間（本） |
| PULLBACK_DEPTH_MIN | 0.30 | 最小押し目深さ（30%） |
| PULLBACK_DEPTH_MAX | 0.70 | 最大押し目深さ（70%） |

### 3.7 ステートマシン

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| PULLBACK_MAX_WAIT | 5 | ダウ理論押し目待ち最大バー数 |
| ROUND_PULLBACK_MAX_WAIT | 3 | 大台押し目待ち最大バー数 |
| ROUND_LEVEL_CONFIRM_BARS | 2 | 大台確認必要バー数 |

### 3.8 応急フィルター（出来高取得不可時）

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| NO_REENTRY_AFTER_STOPLOSS_MIN | 30 | 損切り後再エントリー禁止時間（分） |

---

## 4. B2方式（市場方向性判定）

### 4.1 判定タイミング

9:30（寄り付き直後）に1回のみ判定。以降は当日中変更しない。

### 4.2 判定ロジック

10銘柄全ての9:30時点の価格を前日終値（始値で代用）と比較し、上昇/下落を集計する。

```
bullishCount = 価格 > 始値 × 1.002 の銘柄数
bearishCount = 価格 < 始値 × 0.998 の銘柄数

bullish: bullishCount >= 6（10銘柄中6銘柄以上が+0.2%超）
bearish: bearishCount >= 6（10銘柄中6銘柄以上が-0.2%超）
neutral: それ以外
```

### 4.3 適用ルール

| 判定 | 前場SHORT medium | 後場SHORT medium | 前場LONG medium |
|------|-----------------|-----------------|-----------------|
| bullish | **ブロック** | 許可 | ブロック（全BUY medium全ブロック） |
| neutral | 許可 | 許可 | ブロック（全BUY medium全ブロック） |
| bearish | 許可 | 許可 | ブロック（全BUY medium全ブロック） |

> **重要:** BUY mediumは方向性に関わらず常時ブロック。SHORT mediumは前場bullish時のみブロック。後場は常に許可。

---

## 5. シグナル検出（detectSignals）

### 5.1 BUYシグナル

| シグナル名 | 条件 | 信頼度 |
|-----------|------|--------|
| VWAP反発（押し目買い） | close > VWAP かつ 前足がVWAP下 かつ 陽線 | medium |
| ダウ理論: 直近高値更新 | 直近スイング高値を上抜け | medium/strong |
| 大台超え | キリ番（100円/1000円単位）を上抜け | medium |
| VWAPクロス上抜け | **無効化済み**（5日間検証で0勝4敗のため除外） | - |

### 5.2 SELLシグナル

| シグナル名 | 条件 | 信頼度 |
|-----------|------|--------|
| VWAPクロス下抜け | close < VWAP かつ 前足がVWAP上 かつ 陰線 | medium |
| ダウ理論: 直近安値更新 | 直近スイング安値を下抜け | medium/strong |
| 大台割れ | キリ番（100円/1000円単位）を下抜け | medium |
| 三尊（H&S） | ヘッド&ショルダーパターン検出 | strong |
| ダブルトップ | ダブルトップパターン検出 | strong |

### 5.3 信頼度（confidence）判定

`evaluateConfirmation`関数で以下の要素をスコアリングし、合計スコアで判定:

| 要素 | 条件 | スコア |
|------|------|--------|
| 出来高確認 | volume > avgVolume × 1.2 | +1 |
| MA方向一致 | BUY: MA5 > MA25 / SELL: MA5 < MA25 | +1 |
| モメンタム | BUY: momentum > 0 / SELL: momentum < 0 | +1 |

| 合計スコア | 信頼度 |
|-----------|--------|
| 3 | strong |
| 2 | medium |
| 0-1 | weak（エントリー不可） |

---

## 6. エントリーフィルター（処理順序）

エントリー判定は以下の順序で適用される。いずれかでブロックされた場合、エントリーは行われない。

### 6.1 時間帯フィルター

1. 09:00-09:04 → 全エントリー禁止
2. 12:25-12:35 → 全エントリー禁止（出来高取得不可時）
3. 15:20以降 → 新規エントリー禁止（強制決済のみ）

### 6.2 板圧力フィルター

| 条件 | アクション |
|------|-----------|
| BUYシグナル + sell_pressure | LONG禁止 |
| SELLシグナル + buy_pressure | SHORT禁止 |

### 6.3 板読みスコアフィルター

全エントリーに対して`boardReadingScore`を計算し、スコア < 2 でブロック。

### 6.4 VWAPクロス上抜け無効化

`sig.reason.includes("VWAPクロス上抜け")` → 無条件ブロック

### 6.5 VWAP急落フィルター（SHORT専用）

VWAPクロス下抜けSHORT時、直近の下落率をチェック:
- 直近5本の下落率 <= -0.5% → ブロック
- 直近3本の下落率 <= -0.4% → ブロック

### 6.6 5分足上位足フィルター（ダウ理論専用）

- ダウ理論LONG: 5分足MA5 > MA25（上昇トレンド）のみ許可
- ダウ理論SHORT: 5分足MA5 < MA25（下降トレンド）のみ許可

### 6.7 押し目深さフィルター（ダウ理論専用）

直近20本のスイング高値/安値を基準に押し目深さを計算:
- LONG: (swingHigh - close) / (swingHigh - swingLow) が30-70%の範囲内のみ許可
- SHORT: (close - swingLow) / (swingHigh - swingLow) が30-70%の範囲内のみ許可

### 6.8 BUY medium全ブロック

BUYシグナルでconfidence = "medium"の場合、ステートマシン経由以外は全てブロック。

### 6.9 B2方式 SHORT mediumブロック

前場（09:00-11:30）かつ B2判定 = bullish の場合のみ、SHORT mediumをブロック。
それ以外（後場、neutral、bearish）は許可。

### 6.10 ATRフィルター（enterPosition内）

ATR(14) / price < 0.05% → エントリーブロック（低ボラティリティ）

### 6.11 後場BPRフィルター（enterPosition内）

13:00以降のSHORTエントリーで、boardSnapshot.buyPressureRatio >= 0.65 → ブロック

### 6.12 応急フィルター（出来高取得不可時）

出来高データが取得できない状態の場合:
- 12時台のエントリー禁止
- 損切り後30分以内の同一銘柄再エントリー禁止

### 6.13 証拠金使用率制限

現在の全ポジション合計額 + 新規ポジション額 > 3,300,000円 → ブロック

---

## 7. ステートマシン（確認待機）

### 7.1 ダウ理論 押し目待ちステートマシン

**トリガー:** ダウ理論シグナル（直近高値/安値更新）検出時

**処理フロー:**
1. シグナル検出 → 押し目待機状態に登録（最大5バー待機）
2. 押し目確認: BUY → 一度下がって再上昇 / SELL → 一度上がって再下落
3. 押し目確認後 → 板読みスコアチェック → エントリー
4. タイムアウト（5バー経過）→ 強トレンドとしてそのままエントリー

### 7.2 大台確認ステートマシン

**トリガー:** 大台超え/大台割れシグナル検出時

**処理フロー:**
1. シグナル検出 → 確認待機状態に登録
2. 連続2バーでキリ番の上/下を維持 → 確認完了
3. 確認完了 → 押し目待ちステートマシンに移行（最大3バー待機）
4. キリ番を割り込み → キャンセル

### 7.3 ステートマシン内の追加フィルター

ステートマシン経由のエントリーにも以下が適用される:
- 板圧力チェック（sell_pressure時LONG禁止、buy_pressure時SHORT禁止）
- 板読みスコアチェック（スコア < 2 でブロック）

---

## 8. 板読みスコア（boardReadingScore）

### 8.1 スコア計算

基本スコア = 2（板情報なしの場合のデフォルト）

板情報がある場合、以下の要素で加減算:

| 条件 | スコア変動 |
|------|-----------|
| BPR > 0.6（LONG時）/ BPR < 0.4（SHORT時） | +1 |
| BPR < 0.4（LONG時）/ BPR > 0.6（SHORT時） | -1 |
| 大口買い壁あり（LONG時）/ 大口売り壁あり（SHORT時） | +1 |
| 大口売り壁あり（LONG時）/ 大口買い壁あり（SHORT時） | -1 |
| 成行注文比率 > 5%（順方向） | +1 |
| 見せ玉検出（逆方向） | +1 |
| 氷山注文検出（順方向） | +1 |

### 8.2 閾値

スコア < 2 → エントリーブロック

---

## 9. 板読み早期利確（shouldBoardEarlyExit）

### 9.1 発動条件

ポジション保有中に以下の全てを満たす場合、現在値で早期利確:

1. 含み益が存在する（pnl > 0）
2. 板情報で逆方向の圧力を検出:
   - LONG保有中: BPR < 0.35 または signal = "sell_pressure"
   - SHORT保有中: BPR > 0.65 または signal = "buy_pressure"

---

## 10. エグジット条件（処理優先順位）

### 10.1 損切り / BEストップ

| 条件 | LONG | SHORT |
|------|------|-------|
| 通常SL | low <= entryPrice × (1 - 0.5%) | high >= entryPrice × (1 + 0.5%) |
| BE発動後 | low <= entryPrice（建値） | high >= entryPrice（建値） |

**BEストップ発動条件:**
- LONG: high >= entryPrice × (1 + 0.5%)
- SHORT: low <= entryPrice × (1 - 0.5%)

発動後、SLラインが建値に移動する。

### 10.2 利確

| 条件 | LONG | SHORT |
|------|------|-------|
| TP | high >= entryPrice × (1 + 1.5%) | low <= entryPrice × (1 - 1.5%) |

### 10.3 シグナル反転決済

保有中に逆方向のシグナルが検出された場合、現在値で決済。

### 10.4 板読み早期利確

セクション9の条件を満たした場合、現在値で利確。

### 10.5 大引け強制決済

15:20に全オープンポジションを現在値で強制決済。

### 10.6 優先順位

```
SL/BE → TP → シグナル反転 → 板読み早期利確 → 大引け強制決済
```

同一バーでSLとTPが同時にヒットした場合、SL（損切り/BE）が優先される。

---

## 11. 見せ玉検出（detectFakeOrder）

### 11.1 検出条件

前回の板情報スナップショットと比較し、以下を検出:

- **売り見せ玉:** 大口売り壁が存在 → 次のスナップショットで消失（askCancelDetected）
- **買い見せ玉:** 大口買い壁が存在 → 次のスナップショットで消失（bidCancelDetected）

### 11.2 板読みスコアへの影響

見せ玉が検出された場合、逆方向のエントリーに+1スコア（見せ玉の裏の真意を読む）。

---

## 12. データフロー

```
kabu STATION API → 1分足データ取得
         ↓
    candleBuffers（銘柄別バッファ）
         ↓
    detectSignals（シグナル検出）
         ↓
    processCandle（メインループ）
    ├── B2方向性判定（9:30のみ）
    ├── エグジットチェック（保有中）
    ├── ステートマシン処理
    ├── エントリーフィルター適用
    └── enterPosition（ポジション開始）
         ↓
    checkExitConditions（毎分チェック）
         ↓
    closePosition（決済・DB記録）
```

---

## 13. 状態管理

| 状態変数 | 型 | 説明 |
|---------|-----|------|
| openPositions | Map<symbol, OpenPosition> | 現在保有中のポジション |
| candleBuffers | Map<symbol, RtCandle1Min[]> | 銘柄別の1分足バッファ |
| pullbackStates | Map<symbol, PullbackState> | ダウ理論押し目待ち状態 |
| roundLevelPendingStates | Map<symbol, RoundLevelPendingState> | 大台確認待ち状態 |
| roundPullbackStates | Map<symbol, RoundPullbackState> | 大台押し目待ち状態 |
| lastStopLossTime | Map<symbol, string> | 銘柄別最終損切り時刻 |
| symbolPnlMap | Map<symbol, number> | 銘柄別累積損益 |
| b2MarketDirection | "bullish" / "bearish" / "neutral" | B2方式の当日方向性判定 |
| b2DirectionDetermined | boolean | B2判定済みフラグ |
| signalHistory | SignalHistoryEntry[] | シグナル履歴（最大100件） |

---

## 14. 日次リセット

毎営業日の最初のキャンドル到着時（`resetIfNewDay`）に以下をリセット:

- openPositions（全クリア）
- pullbackStates（全クリア）
- roundLevelPendingStates（全クリア）
- roundPullbackStates（全クリア）
- lastStopLossTime（全クリア）
- symbolPnlMap（全クリア）
- b2MarketDirection → "neutral"
- b2DirectionDetermined → false
- candleBuffers（全クリア）

---

## 15. 板情報スナップショット（BoardSnapshot）

### 15.1 基本フィールド

| フィールド | 型 | 説明 |
|-----------|-----|------|
| buyPressureRatio | number | 買い圧力比率（0-1、0.5が均衡） |
| largeBuyWall | boolean | 大口買い壁の有無 |
| largeSellWall | boolean | 大口売り壁の有無 |
| marketOrderRatio | number | 成行注文比率 |
| signal | string | "buy_pressure" / "sell_pressure" / "neutral" / "large_buy_wall" / "large_sell_wall" |

### 15.2 拡張フィールド（v5）

| フィールド | 型 | 説明 |
|-----------|-----|------|
| largeAskWallRatio | number | 大口売り壁比率 |
| largeBidWallRatio | number | 大口買い壁比率 |
| marketOrderDirection | "buy" / "sell" / null | 成行注文の方向 |
| askCancelDetected | boolean | 売り板キャンセル検出（見せ玉疑い） |
| bidCancelDetected | boolean | 買い板キャンセル検出（見せ玉疑い） |
| icebergAskDetected | boolean | 売り氷山注文検出 |
| icebergBidDetected | boolean | 買い氷山注文検出 |

---

## 16. 変更履歴

| バージョン | 日付 | 変更内容 |
|-----------|------|----------|
| v7.0 | 2026-07-01 | パターンC+10銘柄方式実装（isBullish廃止→B2方式、SHORT medium条件付き許可、対象17→10銘柄） |
| v6b | 2026-06中旬 | 板圧力フィルター追加、見せ玉検出、板読み早期利確 |
| v6 | 2026-06上旬 | 板読みスコア統合判定、BPRフィルター |
| v5.5 | 2026-06上旬 | 応急フィルター（出来高不可時対応） |
| v5 | 2026-05末 | ATRフィルター、押し目深さフィルター |

---

## 17. バックテスト実績（10日間: 6/17-6/30）

| 指標 | 値 |
|------|-----|
| 取引数 | 483件 |
| 勝率 | 24.2% |
| 総損益 | +513,026円 |
| PF | 1.24 |
| 最大DD | 214,225円 |
| 期待値 | +1,062円/回 |
| SHORT PF | 1.20 |
| LONG PF | 1.34 |
| 後場PF | 1.54 |

---
