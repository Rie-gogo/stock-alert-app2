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
- `aiSessionTradeJournal`：checkpoint以前に発生した**全**AI entry/exit。方向、entry/exit価格、損益、realized R、MFE・MAE、MFE/MAE品質・欠損分、exit理由、decision ID、plan ID、entry/exit時刻、初回／再entry、寄り付き分類、保有状態を含む
- `aiSessionStrategyJournal`：`signal_quality`のみの戦略学習台帳。**同一市場機会をここだけで1件として数える**
- `aiSessionExecutionAuditJournal`：`capital_constrained`の資金・板深度・株数の実行可能性監査。戦略の勝敗・市場事例として二重加算してはならない
- `aiCurrentStrategyPositions` と `aiCurrentExecutionAuditPositions`：mode別の保有状態。保有中は新規entryを重ねず、既存ポジションに対する `openPositionAction` だけを判断する
- `generationContract.requiredLearningEvidenceBySymbol`：そのcheckpoint以前の `signal_quality`取引について、各銘柄のcontrolが必ず引用すべき一意のevidence ID

AIは「今すぐ注文するか」ではなく、次のcheckpointまでの方向、entry帯、確認価格、目標、損切り参照、entry有効時間、強制決済時刻を10銘柄ごとに更新します。出力は `forecast` と10件の `controls` を持ち、`planDecision=maintained|adjusted|disabled`、`changeReason`、`openPositionAction` を必須とします。

### v5の同日判断規約

1. `signal_quality`台帳を、その日の方向・entry・exitの**唯一の戦略学習事例**として用いる。`capital_constrained`は同一市場機会の別事例として加算せず、板深度・資金制約・株数の執行監査だけに使う。
2. `generationContract.requiredLearningEvidenceBySymbol[symbol]` にentryがある場合、該当controlの`learningEvidenceUsed`に**全て**の `session_trade:signal_quality:<entrySourceEventId>` を入れる。アプリは欠けたoutputをinvalidとして保存しない。
3. 損失があっても自動で方向転換してはならない。台帳・価格推移・日経225mini・過去類似事例を確認したうえで、維持、調整、無効化を`changeReason`に明示する。
4. `entryKind=initial|reentry`、`isOpeningTrade`、`entryOrdinal`を確認する。09:00〜09:29の**実際のentry時刻**は寄り付き取引であり、一律禁止しない。AIが見送りたい場合だけ`no_trade`／`disabled`を返す。
5. 決済後の再entryは、新しいimmutable plan/decisionだけで判断する。同じplan IDを再利用した重複entry、保有中の重複entry、exitと同一source eventでの即時再entryは許可しない。
6. AI判断が未着、無効、期限切れ、または`no_trade`なら、アプリは独自の計画・再entryを作らない（fail-closed）。

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

08:30のCodex定期taskは、[v5朝AIプロンプト](./ai-daily-forecast-codex-prompt-v5.md)を使用し、D-1までのinputだけを使い、当日台帳を参照しません。場中のCodex定期taskは、[v5場中AIプロンプト](./ai-intraday-forecast-codex-prompt-v5.md)を使用し、当日台帳・mode分離・必須evidenceの規約を守ります。

この実装はscheduleそのものを勝手に作成・変更しません。endpoint公開、migration、手動受入が成功した後に、平日08:30と上記11 checkpointのCodexタスクを利用者確認のうえで登録します。Windows relayや通常10銘柄の受信処理からAIを呼び出してはいけません。



## 6. 閉場後Codex学習review（v1）

> **役割分離**: 閉場後の失敗分析・改善仮説・review JSONを作成する主体はCodexです。Stock Alert AppはLLMを呼び出さず、通常の1分足受信、source event、shadow dispatch、通常engine、OrderBridge、Executor、`rt_trades` を変更しません。Manus側でCodex schedule/task/sessionを作成・変更しません。

### 6.1 finality-gated input

対象日は東証現物株式の営業日だけです。`2026-10-12` のような東証現物休場日は必ずno-opです。入力は、既存の次をすべて満たす場合だけ返ります。

- `rt_audit_trade_date_finality.status = closed`
- 現在のsource / candidate / shadow queue watermark hashがfinality保存値と一致する
- source・candidate outbox・shadow outbox・gapが既存のclosed watermark条件をすべて満たす
- 既存 `ai_forecast_learning_snapshot` materializationが `complete`
- 08:30 snapshotが全10銘柄で揃う。欠落・invalid・休場日・finality未完了はfail-closedであり、推測inputを返さない

取得は既存の送信者認証だけを使います。Secret値は引数、URL、JSON、ログ、画面、Gitに書きません。

```bash
cd /home/ubuntu/stock-alert-app
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/fetch-ai-postmarket-learning-input.mjs YYYY-MM-DD \
  --out /secure/path/ai-postmarket-learning-input.json
```

返却inputは決定的な `inputHash` を含み、以下を **causalFeatures** と **results** に明確に分けます。

- 08:30と全保存済み場中checkpointのimmutable snapshot（input hash・有効時間を含む）
- v5の10銘柄・両evaluation modeのAI shadow取引。`signal_quality` は戦略学習の唯一の主事例、`capital_constrained` は同一市場機会を二重計上しない執行監査
- entry時点までの1分／完成5分足、SMA、BB、RSI、出来高、gap、板鮮度、日経225mini、保存済みplan、品質状態
- exit、PnL、R、MFE/MAEと発生時刻、1/3/5/15/30分後return、TP未達反転、SL後の順行などの**結果診断**
- 保存されている`entry_rejected`だけを「取得可能な見送り候補」として返す。存在しない候補理由を補完しない
- 直近60 closed JPX日・最大500件の同一形式例。cold-start、small sample、missingは明示し、価格や結果を推測補完しない

`inputQuality="invalid"` はscriptもreview ingestも行わない契約です。

### 6.2 Codex review payload

review identityは固定です。

```text
reviewId = ai-learning-review:YYYY-MM-DD:codex-v1
```

Codexは入力の`inputHash`を変更せずに引用し、以下を含むJSONを作ります。

- `tradeDate`, `inputHash`, `generatedAtMs`, `generatorId`, `promptVersion`, `model`, `status`
- 10銘柄それぞれの良かった点、failure tag、event / entry-trade evidence ID、再現性、confidence
- 仮説ごとのscope（symbol / side / time / regime）、事前条件、提案、悪化リスク、根拠
- walk-forwardの学習・検証期間、closed trades、検証営業日、baseline、通常約定、**0.10%不利約定**のPnL / Total R / 勝率 / 最大DD
- `policyAdvice`と禁止事項

送信時にSecretはpayloadへ入れません。

```bash
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/ingest-ai-postmarket-learning-review.mjs \
  /secure/path/ai-postmarket-learning-review.json
```

同じ`reviewId`かつ同じcanonical payload hashは`duplicate`（no-op）です。同じIDでhashが異なるpayloadはrejectし、既存reviewを更新しません。evidence IDは対象symbolの保存済みevent / entry tradeに属する必要があります。

### 6.3 status gateと翌日への扱い

- `observation_only` / `candidate`は、Codexへの**注意情報**としてのみ返します。アプリ側の数値閾値、強制block、戦略コードを変更しません。
- `validated`でも、policyAdviceを読めるのは翌営業日以降の外部Codex inputだけです。アプリはforecast JSON以外からentry条件、TP/SL、threshold、order instructionを変更しません。
- `rejected`は翌日入力の候補にしません。
- `validated`には、同日review禁止、walk-forward、10 closed trades以上、3 JPX営業日以上、verified dataのみ、通常約定と0.10%不利約定の両方でbaseline対比PnL / Total R非劣化、最大DD非悪化が必要です。不足またはdegraded / invalid混入はvalidatedとして保存できません。
- 特定symbolの仮説・policyAdviceは、そのsymbol scopeのまま保存し、他銘柄の一般ルールへ昇格させません。

08:30 inputと場中inputは`latestLearningReview`を含め、review dateがforecast trade dateより**厳密に前**の場合だけ参照します。reviewがない・古い・advisory-onlyの場合も、既存のimmutable baselineとno-trade/fail-closed境界を維持して安全に継続し、理由コードを返します。review identity/hashは両inputの`inputHash`へ含まれます。

画面の「閉場後学習」は、最新日・status・対象件数・主因・walk-forward検証・翌日policyAdvice適格性を監査表示します。勝率予測や自動採用の表示ではありません。
