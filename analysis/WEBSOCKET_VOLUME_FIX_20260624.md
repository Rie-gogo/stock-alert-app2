# WebSocket出来高データ復旧 — 修正レポート

**作成日:** 2026-06-24  
**対象:** kabu_board_relay_v5.4 → v5.5

---

## 1. 問題の根本原因

v5.4では、WebSocketティックから蓄積した1分足OHLCVデータが**送信前に上書き消失**していた。

### 発生メカニズム

```
[時系列]
09:30:00  WebSocketティック受信 → candle_accum["6526"] に蓄積開始
09:30:45  candle_accum["6526"] = {open:1000, high:1010, low:995, close:1005, volume:1500}
09:31:00  新ティック受信 → 分が切り替わり candle_accum["6526"] を新分で上書き ★ここで前分データ消失
09:31:15  candle_polling_loop が candle_accum["6526"] を参照 → 既に新分のデータしかない
          → RESTフォールバックに切り替え → volume=0 の足を送信
```

**根本原因:** `update_candle_accum()` が分切り替え時に前分データを退避せず、即座に新分で上書きしていた。`candle_polling_loop()` は15秒後に前分データを取得しようとするが、既に消失済み。

### 副次的問題

1. `ws_connected` フラグが `on_open`/`on_close` で正しく管理されていない
2. RESTフォールバック時に `TradingVolume`（累計出来高）を取得していない
3. WebSocket接続状態の診断ログがない

---

## 2. v5.5の修正内容

### 修正①: 2バッファ方式（致命バグ修正）

```python
# v5.4（バグあり）
candle_accum = {}  # 1バッファのみ

def update_candle_accum(symbol, price, trading_volume=0):
    if accum["minute"] != current_minute:
        # ★ここで前分データが消失
        candle_accum[symbol] = {"open": price, ...}  # 上書き

# v5.5（修正後）
candle_accum      = {}  # 現在分
prev_candle_accum = {}  # 前分（退避用）

def update_candle_accum(symbol, price, trading_volume=0):
    if accum["minute"] != current_minute:
        # ★前分データを退避してから新分を開始
        prev_candle_accum[symbol] = {
            "open": accum["open"], "high": accum["high"],
            "low": accum["low"], "close": accum["close"],
            "volume": accum["volume"], "minute": accum["minute"],
        }
        candle_accum[symbol] = {"open": price, ...}  # 新分開始
```

### 修正②: WebSocket接続状態の正しい管理

```python
# v5.5: on_open/on_close/on_errorでフラグを確実に更新
def on_open(ws):
    global ws_connected
    with ws_connected_lock:
        ws_connected = True

def on_close(ws, code, msg):
    global ws_connected
    with ws_connected_lock:
        ws_connected = False
```

### 修正③: REST出来高補完（WebSocket切断時）

```python
def estimate_volume_from_rest(symbol, board_raw):
    """REST APIのTradingVolume（累計）から1分間の出来高を推定"""
    trading_volume = board_raw.get("tradingVolume", 0)
    prev_tv = rest_trading_volume.get(symbol, 0)
    rest_trading_volume[symbol] = trading_volume
    if prev_tv > 0 and trading_volume >= prev_tv:
        return trading_volume - prev_tv
    return 0
```

### 修正④: 診断ログ

1分ごとに以下を出力:
```
[診断] 09:31 WS=接続中 WS受信=847件/分 WS蓄積使用=17件 RESTフォールバック=0件
```

---

## 3. candle_polling_loopの改善フロー

```
candle_polling_loop (毎分:15秒時点で実行)
│
├─ prev_candle_accum[symbol] に前分データあり？
│   ├─ YES → WebSocket蓄積データを使用（出来高あり）
│   └─ NO  → candle_accum[symbol] に前分データが残っている？
│       ├─ YES → そのデータを使用（ティック頻度が低い銘柄）
│       └─ NO  → RESTフォールバック
│           └─ TradingVolume差分で出来高を推定
```

---

## 4. 期待される効果

| 状態 | v5.4（修正前） | v5.5（修正後） |
|------|---------------|---------------|
| WS接続中 | volume=0（前分データ消失） | volume=実値（2バッファで退避） |
| WS切断中 | volume=0（補完なし） | volume=推定値（REST差分） |
| 信頼度判定 | 全て「中」（出来高確認不可） | 「強」到達可能（出来高確認あり） |
| VWAPシグナル | 発火しない（volume=0でVWAP計算不可） | 正常に発火（出来高あり） |
| 応急フィルター | 常時発動 | WS復旧で自動無効化 |

---

## 5. デプロイ手順

1. Windows PC上の `kabu_board_relay_v5_4.py` を `kabu_board_relay_v5_5.py` に置き換え
2. 依存パッケージ確認: `pip install websocket-client requests`
3. kabuステーション®を起動し、APIパスワードを確認
4. `python kabu_board_relay_v5_5.py` で起動
5. 診断ログで `WS=接続中` `WS蓄積使用=17件` を確認

### 動作確認チェックリスト

- [ ] 起動後、`WebSocket接続確立` ログが出る
- [ ] 診断ログで `WS受信=xxx件/分` が0でない
- [ ] 診断ログで `WS蓄積使用=17件` が出る（RESTフォールバック=0件）
- [ ] クラウド側で `volume > 0` の足が入っている
- [ ] 信頼度「強」のシグナルが発生する

---

## 6. 応急フィルター（realtimeSimEngine側）

WebSocket出来高が復旧するまでの間、以下の応急フィルターがrealtimeSimEngine内で自動的に発動:

1. **出来高取得不可判定:** 直近20本中90%以上がvolume=0 → 「出来高取得不可」
2. **12時台エントリー禁止:** 出来高取得不可時、12:00〜12:59のエントリーをブロック
3. **損切り後30分再エントリー禁止:** 出来高取得不可時、同一銘柄の損切り後30分以内の再エントリーをブロック

**自動無効化:** WebSocket出来高が復旧し、直近20本中volume>0が10%以上になれば、応急フィルターは自動的に無効化される。

---

## 7. 残課題

1. **VWAP計算の改善:** 現在のcalcVWAP関数はvolume=0の足を無視するため、WebSocket復旧後もVWAPの精度を検証する必要がある
2. **出来高データの品質マーカー:** サーバー側で「WS蓄積」vs「REST推定」を区別するフィールドの追加を検討
3. **WebSocket切断の根本対策:** kabuステーション®のアイドル切断（10054エラー）に対するTCP keepaliveの効果を検証
