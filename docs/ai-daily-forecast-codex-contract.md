# AI日次予測（10銘柄）— 既存08:30 Codexタスク連携契約

> **役割分離**: 予測主体は平日08:30および場中30分ごとのCodex定期タスクです。Stock Alert AppはLLMを呼び出しません。アプリは因果的inputの返却、外部生成JSONの検証・immutable保存、shadow参照、UI表示だけを担当します。

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

## 4. 場中shadowと30分AI revision

08:30計画の保存後、`09:30 / 10:00 / 10:30 / 11:00 / 11:30 / 12:35 / 13:00 / 13:30 / 14:00 / 14:30 / 15:00` にAIが再判断します。12:30ではなく12:35なのは、後場最初の確定5分足を入力に含めるためです。

各checkpointでは次を取得します。SecretはPOST bodyだけで送り、URL・ログ・JSONへ残しません。

```bash
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/fetch-ai-intraday-forecast-input.mjs YYYY-MM-DD HH:MM --out /secure/path/ai-intraday-input.json
```

- cutoffは必ずcheckpointの1分前（12:35だけ12:34）
- 当日1分足、欠損状況、完全な5分足、SMA・RSI・Bollinger
- その時点までの日経225mini
- 08:30計画と直前の場中計画
- 前営業日までに決済済みの当AI shadow成績、直近損失、exit理由

AIは「今すぐ注文するか」ではなく、次のcheckpointまでの方向、entry帯、確認価格、目標、損切り参照、entry有効時間、強制決済時刻を10銘柄ごとに更新します。出力は `forecast` と10件の `controls` を持ち、`planDecision=maintained|adjusted|disabled`、`changeReason`、`openPositionAction` を必須とします。

過去の損失は次回判断の根拠に含めますが、1件の損失だけで閾値を自動変更しません。AIは調整理由を明示し、アプリは前向きshadowとして保存します。自動採用、実注文接続、通常ロジックの書換えは行いません。

生成JSONは次で送ります。

```bash
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/ingest-ai-intraday-forecast.mjs /secure/path/ai-intraday-forecast.json
```

`sourceRevisionId` は `ai-intraday-forecast:YYYY-MM-DD:HHMM:<一意suffix>` とします。同じ朝snapshot・同じcheckpointは最初の1件だけを凍結し、後から上書きできません。

保存に成功した有効計画だけを、同日・銘柄ごとの独立shadowが参照します。

1. zoneに触れる
2. **別イベント**で `confirmPrice` を確認
3. そのイベント時点の因果的・方向別depth VWAP（板観測→relay組立が0〜5秒）で仮想entry
4. `firstTarget`、forecast boundary + 0.15 ATRによるSL、SL優先、指定時刻（最遅15:20）決済を記録

新計画で未entryの方向・価格帯が変わった場合、旧touchは破棄して新計画から再判定します。保有中は、損切りを緩めず、同方向かつ `tighten_only` の場合だけ価格を安全側へ更新します。方向転換時の決済は、AIが `exit_next_event_if_direction_changed` を明示した場合だけ、次のsource eventで仮想決済します。

`signal_quality`（100株）と`capital_constrained`は別state・別event・別tradeとして保存します。旧④日経225mini revisionは最初の09:30 AI計画までの補助安全判定として残し、AI場中計画が生成された後は、その計画内の日経225mini評価が優先されます。朝snapshotも過去の場中計画も更新しません。

## 5. スケジュール

この実装はscheduleそのものを勝手に作成・変更しません。endpoint公開、migration、手動受入が成功した後に、平日08:30と上記11 checkpointのCodexタスクを利用者確認のうえで登録します。Windows relayや通常10銘柄の受信処理からAIを呼び出してはいけません。
