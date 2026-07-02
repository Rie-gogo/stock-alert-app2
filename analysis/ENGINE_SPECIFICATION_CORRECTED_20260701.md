# リアルタイム取引シミュレーションエンジン 正確仕様書

**文書バージョン**: v7.0（修正確定版）  
**作成日**: 2026-07-01  
**対象ファイル**: `server/realtimeSimEngine.ts`, `server/routers/stockData.ts`, `server/signalConfirmation.ts`, `shared/stocks.ts`, `server/kabuStation.ts`, `server/vwap.ts`

---

## 1. 概要

本エンジンは、kabu STATION APIから受信した1分足OHLCVデータに基づき、テクニカルシグナルを検出して架空取引（ペーパートレード）を実行するリアルタイムシミュレーションシステムである。Windows中継スクリプトが1分ごとに送信する足データを逐次処理し、エントリー条件を満たした場合にポジションを建て、損切り・利確・大引け強制決済によりポジションをクローズする。

動作フロー:
1. Windows中継スクリプトから1分足OHLCVを受信
2. 受信した足をメモリ上の蓄積バッファに追加
3. `detectSignals()`でシグナルを判定
4. 買い/売りシグナルが出たら架空取引をDBに記録
5. 大引け（15:30）後に全ポジションを強制決済

---

## 2. 対象銘柄（10銘柄）

2026-07-01よりパターンC+10銘柄方式に移行。バックテスト（6/17-6/30, 10日間）で17銘柄方式に対し+72万円の改善が確認されたため、損失要因となった7銘柄を除外。

| コード | 銘柄名 | セクター |
|--------|--------|----------|
| 6920 | レーザーテック | 半導体 |
| 8035 | 東京エレクトロン | 半導体 |
| 6857 | アドバンテスト | 半導体 |
| 6976 | 太陽誘電 | 電子部品 |
| 6526 | ソシオネクスト | 半導体 |
| 9984 | ソフトバンクグループ | 通信・投資 |
| 8316 | 三井住友FG | 銀行 |
| 7011 | 三菱重工業 | 機械 |
| 5803 | フジクラ | 電線 |
| 6981 | 村田製作所 | 電子部品 |

**ポートフォリオ制約**（`shared/stocks.ts`定義）:
- 最大同時保有ポジション: **3**（`MAX_CONCURRENT_POSITIONS`）
- 同一セクター最大: **2**（`MAX_PER_SECTOR`）

---

## 3. 定数・パラメータ一覧

### 3.1 ポジションサイジング

| パラメータ | 変数名 | 値 | 説明 |
|-----------|--------|-----|------|
| 1銘柄あたり元金 | INITIAL_CAPITAL_PER_STOCK | 3,000,000円 | 5銘柄×300万円 |
| ロット使用率 | LOT_RATIO | 0.9 | 元金の90%を1トレードに使用 |
| **有効ポジションサイズ** | — | **2,700,000円** | 3,000,000 × 0.9 |
| 証拠金（現物元金） | MARGIN_CAPITAL | 3,000,000円 | — |
| 信用倍率 | MARGIN_MULTIPLIER | 3.3 | — |
| 最大使用率 | MARGIN_USAGE_LIMIT | 0.9 | 90% |
| **最大投資可能額** | MAX_TOTAL_EXPOSURE | **8,910,000円** | 3,000,000 × 3.3 × 0.9 |

**株数計算式**: `Math.max(100, Math.floor(Math.floor(2,700,000 / 株価) / 100) * 100)`（100株単位切り捨て、最低100株）

### 3.2 損切り・利確・BEストップ

| パラメータ | 変数名 | 値 | 説明 |
|-----------|--------|-----|------|
| 損切り率 | STOP_LOSS_PERCENT | **0.5%** | エントリー価格比 |
| 利確率 | TAKE_PROFIT_PERCENT | **1.5%** | エントリー価格比 |
| BEトリガー率 | BE_TRIGGER_PERCENT | **0.5%** | 含み益がこの%に到達でSLを建値に移動 |

### 3.3 時間帯フィルター

| パラメータ | 変数名 | 値 | 説明 |
|-----------|--------|-----|------|
| 寄り付き禁止 | NO_ENTRY_BEFORE | **"09:30"** | 09:30以前エントリー禁止 |
| 昼休み前禁止開始 | NO_ENTRY_PRE_LUNCH_START | **"11:00"** | — |
| 昼休み前禁止終了 | NO_ENTRY_PRE_LUNCH_END | **"11:30"** | — |
| 後場序盤禁止開始 | NO_ENTRY_POST_LUNCH_START | **"12:30"** | — |
| 後場序盤禁止終了 | NO_ENTRY_POST_LUNCH_END | **"13:00"** | — |
| 午後エントリー禁止 | NO_ENTRY_AFTER | **"15:15"** | 15:15以降新規エントリー禁止 |
| 大引け強制決済 | MARKET_CLOSE_TIME | **"15:30"** | 全ポジション強制決済 |

**昼休みスキップ**: candleTimeが "11:30" 以上 "12:30" 未満の足は処理自体をスキップ（DB保存もしない）。

### 3.4 後場BPRフィルター

| パラメータ | 変数名 | 値 | 説明 |
|-----------|--------|-----|------|
| BPRブロック閾値 | PM_BPR_BLOCK_THRESHOLD | **0.65** | この値以上でSHORTブロック |
| フィルター開始時刻 | PM_BPR_FILTER_START | **"13:00"** | — |

### 3.5 VWAPクロス下抜けSHORT急落フィルター

| パラメータ | 変数名 | 値 | 説明 |
|-----------|--------|-----|------|
| 5本下落率閾値 | VWAP_DROP_FILTER_5BARS | **-0.8%** | 直近5本の下落率がこの値以下でブロック |
| 3本下落率閾値 | VWAP_DROP_FILTER_3BARS | **-0.6%** | 直近3本の下落率がこの値以下でブロック |

### 3.6 板読みスコア・ATR・押し目深さ

| パラメータ | 変数名 | 値 | 説明 |
|-----------|--------|-----|------|
| 板読みスコア閾値 | BOARD_SCORE_THRESHOLD | **1** | スコアがこの値以上でエントリー許可 |
| ATR計算期間 | ATR_FILTER_PERIOD | **7** | 直近7本 |
| ATR率閾値 | ATR_FILTER_THRESHOLD | **0.0012** | 0.12%未満でブロック |
| 押し目深さルックバック | PULLBACK_DEPTH_LOOKBACK | **20** | 直近20本のスイング高値/安値を参照 |
| 押し目深さ最小 | PULLBACK_DEPTH_MIN | **0.30** | 30%未満でブロック（浅すぎ） |
| 押し目深さ最大 | PULLBACK_DEPTH_MAX | **0.70** | 70%超でブロック（深すぎ） |

### 3.7 ステートマシン待機パラメータ

| パラメータ | 変数名 | 値 | 説明 |
|-----------|--------|-----|------|
| ダウ理論押し目最大待機 | PULLBACK_MAX_WAIT | **5** | 5本超過でキャンセル |
| 大台確認必要本数 | ROUND_LEVEL_CONFIRM_BARS | **5** | 5本連続維持で確認完了 |
| 大台押し目最大待機 | ROUND_PULLBACK_MAX_WAIT | **5** | 5本超過で強トレンドエントリー |

### 3.8 応急フィルター（出来高取得不可時）

| パラメータ | 変数名 | 値 | 説明 |
|-----------|--------|-----|------|
| 出来高不可判定比率 | VOLUME_UNAVAILABLE_RATIO | **0.9** | 直近20本中90%以上がvolume=0で判定 |
| 再エントリー禁止期間 | NO_REENTRY_AFTER_STOPLOSS_MIN | **30分** | 損切り後30分間同一銘柄禁止 |
| 12時台禁止開始 | NO_ENTRY_LUNCH_START | **"12:00"** | — |
| 12時台禁止終了 | NO_ENTRY_LUNCH_END | **"12:59"** | — |

### 3.9 板読み早期利確

| パラメータ | 変数名 | 値 | 説明 |
|-----------|--------|-----|------|
| 最低利益率 | BOARD_EARLY_EXIT_MIN_PROFIT_PCT | **0.05%** | この利益率以上で早期利確可能 |

### 3.10 シグナル検出

| パラメータ | 変数名 | 値 | 説明 |
|-----------|--------|-----|------|
| ウォームアップ最低足数 | MIN_CANDLES_FOR_SIGNAL | **30** | 30本未満はシグナル判定しない |

---

## 4. B2方式（市場方向性判定）

### 4.1 判定タイミング

candleTime >= "09:30" の足が到着し、かつ最低3銘柄のバッファデータが揃った時点で1回のみ判定。以降は当日中変更しない。

### 4.2 判定ロジック

全銘柄のバッファから、各銘柄の「最初の足のopen」と「最新の足のclose」の変動率を計算し、その平均値（`avgChange`）で判定する。

```
各銘柄の変動率 = (最新close - 最初のopen) / 最初のopen × 100 (%)
avgChange = 全銘柄の変動率合計 / 銘柄数
```

| 条件 | 判定結果 |
|------|----------|
| avgChange >= +0.2% | **bullish** |
| avgChange <= -0.2% | **bearish** |
| それ以外 | **neutral** |

### 4.3 適用ルール

| 判定 | 前場SHORT medium | 後場SHORT medium | BUY medium直接エントリー |
|------|-----------------|-----------------|------------------------|
| bullish | **ブロック** | 許可 | ブロック（B2に関わらず常時） |
| neutral | 許可 | 許可 | ブロック（B2に関わらず常時） |
| bearish | 許可 | 許可 | ブロック（B2に関わらず常時） |

**前場の定義**: `candleTime < "11:30"`（コード上の`isAMSession`変数）

**重要な注意点**:
- BUY medium直接エントリーはB2方向性に**関わらず常時ブロック**される（コード1126行）
- SHORT mediumは**前場かつbullish判定時のみ**ブロック、それ以外は全て許可（コード1224-1231行）
- ステートマシン経由（ダウ理論押し目確認・大台確認後）のエントリーはmediumでもブロックされない

---

## 5. シグナル検出（detectSignals）

`detectSignals()`関数は1分足バッファ全体に対してテクニカル指標を計算し、各足にシグナル候補を付与する。シグナル候補は`evaluateConfirmation()`による信頼度判定を経て、weak（裏付け0-1個）は除外され、medium以上のみがシグナルとして確定する。

### 5.1 事前計算される指標

- ADX（14期間、平均方向性指数）
- VWAP（当日累積出来高加重平均価格）
- ダウ理論スイング高値/安値（20本ルックバック）
- VWAP反発パターン
- ダブルトップ/ダブルボトム（40本ルックバック）
- 三尊/逆三尊（60本ルックバック）

### 5.2 レジーム（大局トレンド）判定

各足について、MA25の傾きと当日寄りからの騰落率で大局トレンドを分類する。

- **up**: MA25傾き上昇 かつ/または 当日騰落率がプラス
- **down**: MA25傾き下降 かつ/または 当日騰落率がマイナス
- **neutral**: それ以外

レジームに逆らうシグナル（down相場のBUY、up相場のSELL）は抑制される。

### 5.3 BUYシグナル候補

以下の条件は優先順位順に評価され、最初にマッチしたものが候補となる。`isStrongDown`（MA5 < MA25 かつ close < MA5）が真の場合は全BUYシグナルが抑制される。

| # | シグナル名 | 条件 | 追加フィルター |
|---|-----------|------|--------------|
| 1 | ゴールデンクロス | 前足MA5<=MA25 かつ 現足MA5>MA25 かつ MA乖離率>=0.1% | — |
| 2 | RSI売られすぎ+BB下限 | RSI<=30 かつ close<=BB下限 | — |
| 3 | VWAPクロス上抜け | 前足close<VWAP かつ 現足close>=VWAP | regime≠down、出来高確認 |
| 4 | ダウ理論:直近高値更新 | swingHighBreak かつ MA5>MA25 | regime≠down |
| 5 | 長い下ヒゲ | 下ヒゲ判定 かつ RSI<=45 | regime≠down |
| 6 | 強気はらみ線 | bullishHarami判定 かつ RSI<=45 | — |
| 7 | 大台超え | roundLevelBreakUp | regime≠down |
| 8 | VWAP反発（押し目買い） | vwapBullishBounce | regime≠down、出来高確認 |
| 9 | ダブルボトム | isDoubleBottom かつ ネックライン突破 | regime≠down |
| 10 | 逆三尊（インバースH&S） | isIHS かつ ネックライン上抜け | regime≠down |

### 5.4 SELLシグナル候補

BUY候補がない場合のみ評価される。

| # | シグナル名 | 条件 | 追加フィルター |
|---|-----------|------|--------------|
| 1 | デッドクロス | 前足MA5>=MA25 かつ 現足MA5<MA25 かつ MA乖離率>=0.1% | — |
| 2 | RSI買われすぎ+BB上限 | RSI>=70 かつ close>=BB上限 | isStrongUp=false、GCプロテクション=false |
| 3 | 下落相場の戻り売り | regime=down かつ RSI>=50 かつ close<=MA25 | — |
| 4 | VWAPクロス下抜け | 前足close>VWAP かつ 現足close<=VWAP | regime≠up、出来高確認 |
| 5 | ダウ理論:直近安値更新 | swingLowBreak かつ MA5<MA25 | regime≠up |
| 6 | 長い上ヒゲ | 上ヒゲ判定 かつ RSI>=55 | GCプロテクション=false |
| 7 | 弱気はらみ線 | bearishHarami判定 かつ RSI>=55 | GCプロテクション=false |
| 8 | 大台割れ | roundLevelBreak | regime≠up |
| 9 | VWAP反落（戻り売り） | vwapBearishBounce | regime≠up、出来高確認 |
| 10 | ダブルトップ | isDoubleTop かつ ネックライン割れ | regime≠up |
| 11 | 三尊（ヘッド&ショルダー） | isHS かつ ネックライン下抜け | regime≠up |

### 5.5 GCプロテクション

直近5本以内にゴールデンクロスがあった場合、以下の売りシグナルを抑制する:
- RSI買われすぎ+BB上限
- 長い上ヒゲ
- 弱気はらみ線

### 5.6 共通フィルター（detectSignals内で順次適用）

1. **レジームフィルター**: 下落相場のBUY、上昇相場のSELLを抑制
2. **ADXフィルター**: ADX<20の横ばい相場ではMAクロス系・戻り売りシグナルを抑制（`reason.includes("クロス") || reason.includes("戻り売り")`）
3. **確認バーフィルター**: GC後にclose<MA5 → 抑制、DC後にclose>MA5 → 抑制
4. **信頼度フィルター**: `evaluateConfirmation()`でweak判定のシグナルは除外（`shouldNotify=false`）

---

## 6. 信頼度判定（evaluateConfirmation）

3つの独立した裏付け要素をスコアリングし、合計スコアで信頼度を決定する。

### 6.1 裏付け要素

| 要素 | 条件 | スコア |
|------|------|--------|
| 出来高確認 | volume >= trailingAvgVolume(直近10本) × **1.2** | +1 |
| トレンド一致 | regime指定時: regime方向とシグナル方向の一致。未指定時: BUY→MA5>=MA25 / SELL→MA5<=MA25 | +1 |
| モメンタム一致 | BUY→momentum>0 / SELL→momentum<0（momentum = 現close - **3本前**close） | +1 |

### 6.2 スコア→信頼度変換

| 合計スコア | 信頼度 | shouldNotify | エンジンでの扱い |
|-----------|--------|-------------|----------------|
| 3 | **strong** | true | 直接エントリー可 |
| 2 | **medium** | true | エンジン側でmediumブロック対象（後述） |
| 0-1 | **weak** | false | detectSignals内で除外（シグナル付与されない） |

### 6.3 レジーム指定時のトレンド一致判定

`regime`パラメータが指定された場合、超短期MA(MA5 vs MA25)ではなく大局トレンドとの一致で評価する:
- `regime === "down"` → SELLのみトレンド一致
- `regime === "up"` → BUYのみトレンド一致

これにより、下落相場の戻り売り（一時的にMA5>MA25）でも正しくトレンド一致と判定される。

---

## 7. processCandle メインフロー

以下の順序で処理が実行される:

```
1. 昼休みスキップ（11:30-12:29 → 即return）
2. 除外銘柄チェック（TARGET_STOCKS外 → 即return）
3. 日付変更チェック → 全状態リセット
4. 板情報取得（getBoardSnapshot） → BPR履歴更新（直近5本保持）
5. DB保存（insertRtCandle）
6. バッファ追加 → MA5/MA25/RSI/BB計算
7. 足数カウンター更新 → 日次サマリー更新
8. ウォームアップチェック（30本未満 → return）
9. 既存ポジションのイグジット判定（checkExitConditions）
10. 大引け強制決済チェック（15:30以降）
11. 時間帯フィルター（09:30前、11:00-11:30、12:30-13:00、15:15以降）
12. 既存ポジションチェック（保有中 → return）
13. シグナル検出（detectSignals適用）
14. B2方式判定（未確定かつ09:30以降 → 判定実行）
15. ステートマシン処理（ダウ理論押し目 → 大台確認 → 大台押し目）
16. BUYエントリー判定
17. SELLエントリー判定
```

---

## 8. エントリーフィルター（処理順序）

### 8.1 BUYエントリー判定フロー

processCandle内でBUYシグナル検出後、以下の順序で処理される:

1. **VWAPクロス上抜け無効化**: `sig.reason.includes("VWAPクロス上抜け")` → 無条件ブロック
2. **sell_pressure禁止**: `boardSnapshot.signal === "sell_pressure"` → LONGブロック
3. **板読みスコアフィルター**: `boardReadingScore(symbol, "long", boardSnapshot) < 1` → ブロック
4. **ダウ理論シグナル → ステートマシン登録**:
   - 5分足上位足フィルター（`getHigherTfTrend` ≠ "up" → ブロック）
   - 押し目深さフィルター（30-70%範囲外 → ブロック）
   - 通過 → pullbackStatesに登録して待機（エントリーしない）
5. **大台超えシグナル → ステートマシン登録**: roundLevelPendingStatesに登録して待機
6. **BUY medium全ブロック**: `sig.confidence === "medium"` → ブロック（ステートマシン登録後のため、ダウ理論・大台超えはmediumでも登録される）
7. **enterPosition呼び出し**（strongのみ到達）

### 8.2 SELLエントリー判定フロー

processCandle内でSELLシグナル検出後、以下の順序で処理される:

1. **buy_pressure禁止**: `boardSnapshot.signal === "buy_pressure"` → SHORTブロック
2. **VWAP急落フィルター**: VWAPクロス下抜けSHORT時のみ適用
   - 直近5本の下落率 <= -0.8% → ブロック
   - 直近3本の下落率 <= -0.6% → ブロック
3. **板読みスコアフィルター**: `boardReadingScore(symbol, "short", boardSnapshot) < 1` → ブロック
4. **ダウ理論SHORTシグナル**:
   - 5分足上位足フィルター（`getHigherTfTrend` ≠ "down" → ブロック）
   - 押し目深さフィルター（30-70%範囲外 → ブロック）
   - （ダウ理論SHORTはステートマシン登録せず、フィルター通過後に直接enterPosition）
5. **大台割れシグナル → ステートマシン登録**: roundLevelPendingStatesに登録して待機
6. **B2方式 SHORT mediumブロック**: `sig.confidence === "medium"` かつ `isAMSession && b2MarketDirection === "bullish"` → ブロック。それ以外のmediumは許可
7. **enterPosition呼び出し**

### 8.3 enterPosition内フィルター

enterPosition関数内で追加のフィルターが適用される:

1. **応急フィルター（出来高取得不可時）**:
   - 直近20本中90%以上がvolume=0 → 出来高取得不可判定
   - 12:00-12:59のエントリー禁止
   - 損切り後30分以内の同一銘柄再エントリー禁止
2. **ATRフィルター**: `ATR(7) / price < 0.0012` → ブロック
3. **後場BPRフィルター**: 13:00以降のSHORTで `BPR >= 0.65` → ブロック
4. **証拠金使用率制限**: `現在のオープンポジション合計額 + 今回の投資額 > 8,910,000円` → ブロック

---

## 9. ステートマシン（確認待機）

### 9.1 ダウ理論 押し目確認ステートマシン

**トリガー**: ダウ理論「直近高値更新」BUYシグナル検出時（5分足フィルター・押し目深さフィルター通過後）

**処理フロー**:

1. シグナル検出 → pullbackStatesに登録（signalPrice=現close、recentSwingLow=シグナルのswingLow）
2. 毎足: waitCount++
3. 安値割れ判定: `candle.low < recentSwingLow` → **キャンセル**
4. タイムアウト: `waitCount > 5` → **キャンセル**（エントリーしない）
5. 押し確認: `close < signalPrice` → pulledBack = true
6. 再上昇確認: `pulledBack && close > signalPrice` → 板圧力チェック → 板読みスコアチェック → **エントリー**

**重要**: タイムアウト時はキャンセル（エントリーしない）。ダウ理論SHORTはステートマシンを使用しない。

### 9.2 大台確認ステートマシン

**トリガー**: 大台超え/大台割れシグナル検出時

**処理フロー**:

1. シグナル検出 → roundLevelPendingStatesに登録（confirmCount=0）
2. 毎足: キリ番の上/下を維持しているか確認
   - BUY: `candle.close >= level` → 維持
   - SELL: `candle.close <= level` → 維持
3. 維持: confirmCount++
4. 確認完了: `confirmCount >= 5` → **押し目待ちステートに移行**（即エントリーしない）
5. キリ番割れ/上抜け → **キャンセル**

### 9.3 大台確認後 押し目待ちステートマシン

**トリガー**: 大台確認ステートマシンで5本維持確認完了時

**処理フロー**:

1. 確認完了 → roundPullbackStatesに登録（signalPrice=確認完了時close、waitCount=0）
2. 毎足: waitCount++
3. キリ番割り込み（BUY: close < level / SELL: close > level）→ **キャンセル**
4. **タイムアウト（waitCount > 5）**: 押し目なし＝強トレンド → 板圧力チェック → 板読みスコアチェック → **エントリー**
5. 押し確認（BUY: close < signalPrice / SELL: close > signalPrice）→ pulledBack = true
6. 再反転確認（BUY: close > signalPrice / SELL: close < signalPrice）→ 板圧力チェック → 板読みスコアチェック → **エントリー**

**重要**: 大台押し目待ちのタイムアウトは「強トレンド」としてエントリーする（ダウ理論のタイムアウトとは異なる動作）。

### 9.4 ステートマシン内の追加フィルター

全ステートマシン経由のエントリーに以下が適用される:
- **板圧力チェック**: LONG時に`sell_pressure` → ブロック、SHORT時に`buy_pressure` → ブロック
- **板読みスコアチェック**: スコア < 1 → ブロック

---

## 10. 板読みスコア（boardReadingScore）

### 10.1 基本仕様

板情報がない場合（`snapshot === null`）はスコア **1** を返す（中立、エントリー許可）。板情報がある場合は7要素の加減算でスコアを計算する。初期スコアは **0**。

### 10.2 スコア計算（7要素）

| 要素 | 条件 | LONG時 | SHORT時 |
|------|------|--------|---------|
| **A: アグレッシブ注文** (±2) | marketOrderRatio >= 0.08 | BPR>1.0→+2 / BPR<1.0→-2 | BPR<1.0→+2 / BPR>1.0→-2 |
| **B: 厚い板アノマリー** (±1) | largeSellWall/largeBuyWall | sellWall→+1 / buyWall→-1 | buyWall→+1 / sellWall→-1 |
| **C: 板圧力トレンド** (±1) | BPR履歴(3本以上)のdelta | delta>=0.15→+1 / delta<=-0.15→-1 | delta<=-0.15→+1 / delta>=0.15→-1 |
| **D: 相場モード** (+1/-2) | detectMarketMode結果 | active/building→+1 | trap/quiet→-2 |
| **E: 板圧力の強さ** (±1) | BPR絶対値 | BPR>=1.4→+1 / BPR<=0.65→-1 | BPR<=0.65→+1 / BPR>=1.4→-1 |
| **F: 歩み値方向推定** (±2) | estimateTickDirection結果 | uptick→+2 / downtick→-2 | downtick→+2 / uptick→-2 |
| **G: アイスバーグ検出** (±1) | detectFakeOrder結果 | icebergSide="buy"→+1 / "sell"→-1 | icebergSide="sell"→+1 / "buy"→-1 |

### 10.3 相場モード判定（detectMarketMode）

| モード | 条件 |
|--------|------|
| **quiet** | BPR履歴(3本以上)が全て0.85-1.15の範囲内 かつ 現BPRも0.85-1.15 |
| **active** | BPR > 1.2 または BPR < 0.8 |
| **building** | BPR履歴(3本以上)のdelta(abs) >= 0.1 |
| **trap** | 上記いずれにも該当しない |

判定順序: quiet → active → building → trap

### 10.4 歩み値方向推定（estimateTickDirection）

判定優先順位:
1. `marketOrderDirection === "buy"` → uptick / `"sell"` → downtick
2. BPR履歴(3本以上)のトレンド: trend >= 0.2 → uptick / trend <= -0.2 → downtick
3. BPR絶対値: last >= 1.3 → uptick / last <= 0.7 → downtick
4. いずれにも該当しない → neutral

### 10.5 見せ板検出（detectFakeOrder）

- **キャンセル検出**: `askCancelDetected || bidCancelDetected` → cancelDetected=true → 相場モードを**trap強制**
- **アイスバーグ検出**: `icebergAskDetected` → icebergSide="buy" / `icebergBidDetected` → icebergSide="sell"

### 10.6 閾値

`score < 1` → エントリーブロック

---

## 11. 板情報生成（BoardSnapshot）

### 11.1 analyzeOrderBook（kabuStation.ts）

| シグナル種別 | 条件 |
|-------------|------|
| board_buy_pressure | 買い板合計/売り板合計 >= **1.5** |
| board_sell_pressure | 買い板合計/売り板合計 <= **0.67** |
| large_bid_wall | 特定価格帯に平均の**5倍**以上の買い注文 |
| large_ask_wall | 特定価格帯に平均の**5倍**以上の売り注文 |
| market_order_surge | 成行注文が板全体の**10%**超 |

### 11.2 getBoardSnapshot（realtimeSimEngine.ts）

analyzeOrderBookの結果を以下の優先順位でsignalフィールドに変換:
1. board_buy_pressure → `"buy_pressure"`
2. board_sell_pressure → `"sell_pressure"`
3. large_bid_wall → `"large_buy_wall"`
4. large_ask_wall → `"large_sell_wall"`
5. market_order_surge → `"market_surge"`
6. いずれにも該当しない → `"neutral"`

### 11.3 calcExtendedBoardFields（kabuStation.ts）

| フィールド | 説明 |
|-----------|------|
| marketOrderDirection | 買い成行>売り成行×1.5→"buy" / 逆→"sell" / それ以外→"neutral" |
| askCancelDetected | 前回比で売り板が**70%以上**減少（大口壁のみ対象） |
| bidCancelDetected | 前回比で買い板が**70%以上**減少（大口壁のみ対象） |
| icebergAskDetected | 前回比で売り板が**50-70%**減少（部分約定＝氷山注文） |
| icebergBidDetected | 前回比で買い板が**50-70%**減少（部分約定＝氷山注文） |

---

## 12. 板読み早期利確（shouldBoardEarlyExit）

### 12.1 発動条件

ポジション保有中に以下の**全て**を満たす場合、現在値で早期利確する:

1. 含み益率 >= **0.05%**（`BOARD_EARLY_EXIT_MIN_PROFIT_PCT`）
   - LONG: `(currentPrice - entryPrice) / entryPrice × 100 >= 0.05`
   - SHORT: `(entryPrice - currentPrice) / entryPrice × 100 >= 0.05`
2. 逆方向の強い板シグナルを検出:
   - LONG保有中: `signal === "sell_pressure"` **または** `signal === "large_sell_wall"`
   - SHORT保有中: `signal === "buy_pressure"` **または** `signal === "large_buy_wall"`

---

## 13. イグジット条件

### 13.1 BEストップトリガー

含み益がBE_TRIGGER_PERCENT（0.5%）に到達した場合、SLを建値に移動する。

| 方向 | トリガー条件 |
|------|-------------|
| LONG | `high >= entryPrice × 1.005` |
| SHORT | `low <= entryPrice × 0.995` |

発動後: `pos.beTriggered = true`、以降のSLラインが建値に変更される。

### 13.2 損切り（Stop Loss）

| 方向 | BE未発動時 | BE発動済み時 |
|------|-----------|-------------|
| LONG | `low <= entryPrice × 0.995` → 損切り | `low <= entryPrice` → 建値決済 |
| SHORT | `high >= entryPrice × 1.005` → 損切り | `high >= entryPrice` → 建値決済 |

### 13.3 利確（Take Profit）

| 方向 | 条件 | 備考 |
|------|------|------|
| LONG | `high >= entryPrice × 1.015` | exitPrice = tpLine |
| SHORT | `low <= entryPrice × 0.985` | exitPrice = tpLine |

**同一足でSLとTPが同時にヒットした場合、SL（損切り/BE）が優先される**（先に判定されるため）。

### 13.4 シグナル反転決済

バッファの最新足にシグナルが付与されている場合:
- LONG保有中にSELLシグナル → close価格で決済
- SHORT保有中にBUYシグナル → close価格で決済

### 13.5 板読み早期利確

第12章の条件を満たした場合、close価格で決済（action = "take_profit"）。

### 13.6 大引け強制決済

`candleTime >= "15:30"` の足が到着した時点で、全オープンポジションをclose価格で強制決済する。

### 13.7 イグジット判定の優先順位

```
SL/BE → TP → シグナル反転 → 板読み早期利確 → 大引け強制決済
```

---

## 14. 5分足上位足フィルター

### 14.1 仕組み

`getHigherTfTrend(buffer, currentIdx, 5)`で1分足バッファから5分足を合成し、SMA5 vs SMA25でトレンドを判定する。

### 14.2 制約

- 5分足が25本未満（= 1分足125本未満）の場合は`"neutral"`を返す
- 合成には現在進行中の不完全な5分足も含まれる

### 14.3 適用対象

| シグナル | 必要なトレンド |
|---------|--------------|
| ダウ理論LONG（直近高値更新） | `"up"` |
| ダウ理論SHORT（直近安値更新） | `"down"` |

`"neutral"`の場合もブロックされる（明確なトレンド確認が必要）。

---

## 15. 状態管理

### 15.1 メモリ上の状態変数

| 変数名 | 型 | 説明 |
|--------|-----|------|
| candleBuffers | Map<string, CandleWithSignal[]> | 銘柄ごとの当日1分足バッファ |
| openPositions | Map<string, OpenPosition> | 銘柄ごとのオープンポジション（1銘柄1ポジション） |
| pullbackStates | Map<string, PullbackState> | ダウ理論押し目確認待ちステート |
| roundLevelPendingStates | Map<string, RoundLevelPendingState> | 大台確認待ちステート |
| roundPullbackStates | Map<string, RoundPullbackState> | 大台確認後押し目待ちステート |
| bprHistory | Map<string, number[]> | 銘柄ごとのBPR履歴（直近5本） |
| symbolPnlMap | Map<string, number> | 銘柄ごとの当日確定損益 |
| lastStopLossTime | Map<string, string> | 銘柄ごとの最終損切り時刻 |
| candleCounters | Map<string, number> | 銘柄ごとの受信足数カウンター |
| signalHistory | Array (max 200) | 当日の全シグナル履歴 |
| b2MarketDirection | "bullish"/"bearish"/"neutral" | B2方式の市場方向性判定結果 |
| b2DirectionDetermined | boolean | B2判定が確定したか |
| currentTradeDate | string | 当日の日付 |
| lastCandleReceivedAt | string/null | 最後に足を受信した時刻（ISO文字列） |

### 15.2 日次リセット

日付が変わった場合（`tradeDate !== currentTradeDate`）、以下の全状態変数がクリアされる:

- candleBuffers.clear()
- openPositions.clear()
- candleCounters.clear()
- pullbackStates.clear()
- roundLevelPendingStates.clear()
- roundPullbackStates.clear()
- symbolPnlMap.clear()
- signalHistory.length = 0
- bprHistory.clear()
- lastStopLossTime.clear()
- b2MarketDirection = "neutral"
- b2DirectionDetermined = false

### 15.3 サーバー再起動時の復元（restoreBuffersFromDb）

1. 当日分の1分足をDBから読み込み
2. 銘柄ごとにバッファを再構築（MA/RSI/BB/シグナルを再計算）
3. 未決済レコードからオープンポジションを復元
4. 当日全取引レコードからシグナル履歴を復元

---

## 16. 損益計算

| 方向 | 計算式 |
|------|--------|
| LONG | `Math.round((exitPrice - entryPrice) × shares)` |
| SHORT | `Math.round((entryPrice - exitPrice) × shares)` |

---

## 17. 旧仕様書からの主要修正点

以下は旧仕様書（同日付の誤り版）で記載されていた値と、実際のコードの値の対照表である。

| 項目 | 旧仕様書（誤り） | 実際のコード（正） |
|------|-----------------|------------------|
| LOT_SIZE_AMOUNT | 1,000,000円 | INITIAL_CAPITAL_PER_STOCK × LOT_RATIO = 2,700,000円 |
| MAX_TOTAL_EXPOSURE | 3,300,000円 | 8,910,000円 |
| NO_ENTRY開始 | "09:00"-"09:04" | "09:30"以前 |
| 昼休み禁止 | "12:25"-"12:35" | 昼スキップ11:30-12:29 + 禁止11:00-11:30, 12:30-13:00 |
| 大引け強制決済 | "15:20" | "15:30" |
| BOARD_SCORE_THRESHOLD | 2 | 1 |
| VWAP_DROP_FILTER_5BARS | -0.5% | -0.8% |
| VWAP_DROP_FILTER_3BARS | -0.4% | -0.6% |
| ATR_FILTER_PERIOD | 14 | 7 |
| ATR_FILTER_THRESHOLD | 0.05% | 0.12% (0.0012) |
| ROUND_LEVEL_CONFIRM_BARS | 2 | 5 |
| ROUND_PULLBACK_MAX_WAIT | 3 | 5 |
| B2判定ロジック | 銘柄数カウント方式 | 平均変動率方式 |
| ダウ理論タイムアウト | 強トレンドエントリー | キャンセル（エントリーしない） |
| 板情報なし時スコア | 2 | 1 |
| 9984セクター | IT | 通信・投資 |
| 8316セクター | 金融 | 銀行 |
| 7011セクター | 重工 | 機械 |
| 板読み早期利確条件 | pnl > 0 かつ BPR < 0.35 | 利益率 >= 0.05% かつ signal判定 |

---

*本文書は `server/realtimeSimEngine.ts`（1793行）、`server/routers/stockData.ts`（detectSignals関数）、`server/signalConfirmation.ts`（evaluateConfirmation関数）、`shared/stocks.ts`（TARGET_STOCKS定義）、`server/kabuStation.ts`（analyzeOrderBook/calcExtendedBoardFields）、`server/vwap.ts`（getHigherTfTrend）のソースコードから直接抽出した正確な仕様である。*
