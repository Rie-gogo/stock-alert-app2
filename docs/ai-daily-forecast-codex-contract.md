# AI日次予測（10銘柄）— 既存08:30 Codexタスク連携契約

> **役割分離**: 予測主体は既存の平日08:30 Codex定期タスクです。Stock Alert AppはLLMを呼び出しません。アプリはD-1 inputのread-only返却、外部生成JSONの検証・immutable保存、場中shadow固定参照、UI表示だけを担当します。

## 対象・安全境界

- 対象は `285A, 3436, 5803, 6146, 6526, 6857, 6976, 6981, 8035, 9984` の**10銘柄すべて**です。
- 通常の1分足受信、`rt_trades`、通常engine、OrderBridge、Executor、注文instruction、formal Gateへは接続しません。
- `eligibleForAdoption=false`、`automaticAdoption=false`、`orderInstructionConnection=false` を固定します。
- 外部sender認証にだけ `AI_DAILY_FORECAST_INGEST_KEY` を使います。出力、Git、ログ、チャット、JSONファイルに値を含めません。

## 1. Read-only inputの取得

既存Codexタスクは、08:30 JSTの①〜③市場環境snapshot成功後、次を実行します。

```bash
cd /home/ubuntu/stock-alert-app
node scripts/fetch-ai-daily-forecast-input.mjs YYYY-MM-DD --out /secure/path/ai-input.json
```

取得APIは `trading.getAiDailyForecastInput` です。返却値には次を含みます。

- `tradeDate` と `dataCutoffDate`（前JPX営業日）
- ①〜③の**保存済み**pre-open snapshot（存在時）
- 各銘柄の直近日足集約、セッション品質、除外理由
- アプリがD-1のみで決定的に計算した `symbols[].baseline`（ATR5、傾き、予測帯、zone、target、stop参照、呼値丸め前後を含む）
- `inputHash`（hash対象は因果的な入力だけ。取得時刻は除外）

入力が `invalid` のときは生成もingestも行わず、Codexタスクは `no_trade` と記録します。`degraded` は理由を添えて予測可能ですが、アプリ表示では品質低下として明示されます。

## 2. Codexの生成責務

Codexは取得したinput以外の価格情報を混ぜず、全10銘柄について次を生成します。

- `quantBaseline`: **返却inputの10件のbaselineを改変せず**そのまま送る。
- `aiFinalForecast`: `forecasts` を必ず10件（各symbol一意）含める。
- `direction`: `strong_up | up | range | down | strong_down | insufficient | stale`
- 方向ありの場合だけ、`forecastLow < zoneLow <= zoneHigh < forecastHigh`、`confirmPrice`、`firstTarget`、`stretchTarget` を一貫した価格で入れる。
- LONGは `firstTarget > confirmPrice`、SHORTは `firstTarget < confirmPrice`。
- range / insufficient / stale は全ての価格を `null`、`zoneType="none"` とする。
- baselineからAIが調整する場合は `baselineDecision="adjusted"`、理由、根拠、`exceptionReason` を保存する。ATR5の0.75倍超の差は例外理由なしではアプリがrejectします。
- 根拠はD-1日足特徴と①〜③snapshotだけとし、勝率・収益・約定の捏造をしません。

## 3. ingest payloadと送信

Codexは以下のJSONを安全な一時パスへ作ります。`ingestKey` は**書かない**でください。

```json
{
  "sourceSnapshotId": "ai-daily-forecast:YYYY-MM-DD:codex-0830-v1",
  "tradeDate": "YYYY-MM-DD",
  "capturedAtMs": 0,
  "sourceMode": "scheduled_ai_forecast",
  "inputHash": "64桁sha256",
  "quantBaseline": ["read-only inputのsymbols[].baseline 10件"],
  "aiFinalForecast": {
    "forecasts": ["10銘柄のforecast object"],
    "marketSummary": "D-1と①〜③だけに基づく短い説明",
    "globalReasonCodes": ["d1_and_macro_snapshot_only"]
  },
  "generatorId": "codex-scheduled-task",
  "promptVersion": "codex-ai-daily-forecast-prompt-v1",
  "generatorMetadata": {"model": "使用モデルID", "generationMode": "external_codex"}
}
```

- `capturedAtMs` は**08:30〜08:59 JST**である必要があります。
- `sourceSnapshotId` は同じpayloadなら再送しても安全です。IDが同じでhashが違う場合はrejectします。
- 送信は次です。

```bash
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/ingest-ai-daily-forecast.mjs /secure/path/ai-forecast.json
```

アプリは input hash、quant baseline完全一致、10銘柄一意性、価格順、方向整合、0.75 ATR例外理由、source IDの冪等性を検証します。失敗時は**保存しません**。

## 4. 場中shadowと④revision

保存に成功した `aiFinalForecast` だけを、同日・銘柄ごとの独立shadowが固定参照します。

1. zoneに触れる
2. **別イベント**で `confirmPrice` を確認
3. そのイベント時点の因果的・方向別depth VWAP（板観測→relay組立が0〜5秒）で仮想entry
4. `firstTarget`、forecast boundary + 0.15 ATRによるSL、SL優先、15:20日次決済を記録

`signal_quality`（100株）と`capital_constrained`は別state・別event・別tradeとして保存します。影響が不利な④日経225mini checkpointは `09:05 / 09:15 / 10:00 / 12:35 / 13:30` にrevisionとして追記するだけで、朝snapshotは更新しません。

## 5. スケジュール

このリリースでは**Manusのscheduleを新設・変更しません**。既存の平日08:30 Codexタスクは、endpoint公開と手動受入が終わった後に利用者側でこの契約へ更新します。
