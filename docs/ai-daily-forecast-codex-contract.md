# AI日次予測（10銘柄）— 既存08:30 Codexタスク連携契約

> **役割分離**: 予測主体は平日08:30および場中のv6 checkpoint（前場15分・後場30分）のCodex定期タスクです。Stock Alert AppはLLMを呼び出しません。アプリは因果的inputの返却、外部生成JSONの検証・immutable保存、shadow参照、UI表示だけを担当します。

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
  "sourceSnapshotId": "ai-daily-forecast:YYYY-MM-DD:codex-0830-v6",
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
  "promptVersion": "codex-ai-daily-forecast-prompt-v6",
  "generatorMetadata": {
    "model": "使用モデルID",
    "generationMode": "external_codex"
  }
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

## 4. 場中shadowとv6 AI revision（前場15分・後場30分）

2026-10-15からv6は、前場に`09:15 / 09:30 / 09:45 / 10:00 / 10:15 / 10:30 / 10:45 / 11:00 / 11:15 / 11:30`、後場に`12:35 / 13:00 / 13:30 / 14:00 / 14:30 / 15:00`で再判断します。各cutoffはcheckpointの1分前（12:35は12:34）であり、前場は15分、後場は30分の有効期間だけを持ちます。12:00、12:30、15:30は実行しません。

定期taskは原則checkpointの3分後に起動します。実行が遅れても`cutoffCandleTime`はcheckpointSpecの固定値を使います。たとえば13:00計画を13:03以後に生成してもcutoffは12:59であり、13:00以後の足をAI入力へ混ぜません。prepareはcutoff以前のsource eventとAI shadow materializationが一致するまで最大2分間だけ待機し、完了した固定inputへHMAC署名を付けます。ingestは同じ固定inputだけを受理します。

`11:30`は前場の新規entryを作らないbridge checkpointです。controlのentry windowは**12:30–12:34内だけ**が許され、範囲外はlocal preflightとサーバーvalidatorがfail-closedでrejectします。12:35には後場最初の完成済み5分足で必ず再判断します。

各checkpointでは次を取得します。SecretはPOST bodyだけで送り、URL・ログ・JSONへ残しません。

```bash
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/fetch-ai-intraday-forecast-input.mjs YYYY-MM-DD HH:MM --out /secure/path/ai-intraday-input.json
```

- 定期taskは原則checkpointの3分後に起動する。実行がcheckpointより後でも、`cutoffCandleTime`はcheckpointSpecの固定値を使う。たとえば13:00計画を13:03以後に生成してもcutoffは12:59であり、13:00以後の足をAI入力へ混ぜない
- prepareはcutoff以前のsource eventとforward-shadow dispatchを照合し、source処理済み、queue件数一致、pending/processing/errorなしになるまでinputを返さない
- queueが未完了ならHTTP 503 `ai_intraday_materialization_pending`とし、取得scriptは次の分析時間を残せる範囲で15秒間隔・最大2分だけ再確認する。追い付かなければ`ai_intraday_materialization_timeout`として生成を開始しない
- queueにterminal errorがあればHTTP 412 `ai_intraday_materialization_terminal`として再試行せずfail-closedにする
- prepare中にwatermarkが変化した場合もinputを返さず再確認させる。completeで安定したwatermarkは`materializationWatermark`としてinput hashへ含める
- prepareは固定inputへ`inputSnapshotToken`を付ける。tokenは鍵そのものではなく、tradeDate・checkpoint・cutoff・capturedAtMs・morning snapshot・input hashをサーバー側HMACで結んだ改変検知値である
- ingest時点のdispatch `engineSequence`をactivation境界として保存し、新計画はその境界より後のsource eventだけに適用する。到着前の未処理足へ遡ってentry・exitを作らない
- checkpointからactivation境界までにfirstTargetへ到達済みの銘柄は`missed_move_no_entry`とし、その計画からの新規entryを終日ではなく当該plan IDについてだけ禁止する。保有中ポジションの旧stopは新計画到着まで維持し、到着後のポジション管理は次source eventからだけ適用する
- cutoffは必ずcheckpointの1分前
- 当日1分足、欠損状況、完全な5分足、SMA・RSI・Bollinger
- その時点までの日経225mini
- 08:30計画と直前の場中計画
- 前営業日までに決済済みの当AI shadow成績、直近損失、exit理由
- `aiSessionTradeJournal`：checkpoint以前に発生した**全**AI entry/exit。方向、entry/exit価格、損益、realized R、MFE・MAE、MFE/MAE品質・欠損分、exit理由、decision ID、plan ID、entry/exit時刻、初回／再entry、寄り付き分類、保有状態を含む
- `aiSessionStrategyJournal`：`signal_quality`のみの戦略学習台帳。**同一市場機会をここだけで1件として数える**
- `aiSessionExecutionAuditJournal`：`capital_constrained`の資金・板深度・株数の実行可能性監査。戦略の勝敗・市場事例として二重加算してはならない
- `aiCurrentStrategyPositions` と `aiCurrentExecutionAuditPositions`：mode別の保有状態。保有中は新規entryを重ねず、既存ポジションに対する `openPositionAction` だけを判断する
- `generationContract.requiredLearningEvidenceBySymbol`：そのcheckpoint以前の `signal_quality`取引について、各銘柄のcontrolが必ず引用すべき一意のevidence ID
- `generationContract.lunchCheckpointPolicy=position_management_only_no_new_entry`：11:30計画は既存ポジション管理だけに使い、flat銘柄を新規建てしない
- `generationContract.openPositionContinuationPolicy=same_direction_tighten_only_with_successor_wait_until_valid_until`：この旧互換フィールドは既存保有のみに適用する。新規保有は独立managementPlansで期限を指定し、後継待機は後継checkpointの`validUntil`までとする

AIは「今すぐ注文するか」ではなく、次のcheckpointまでの方向、entry帯、確認価格、目標、損切り参照、entry有効時間、強制決済時刻を10銘柄ごとに更新します。出力は `forecast` と10件の `controls` を持ち、`planDecision=maintained|adjusted|disabled`、`changeReason`、`openPositionAction` を必須とします。

### v6の同日判断規約

1. `signal_quality`台帳を、その日の方向・entry・exitの**唯一の戦略学習事例**として用いる。`capital_constrained`は同一市場機会の別事例として加算せず、板深度・資金制約・株数の執行監査だけに使う。
2. `generationContract.requiredLearningEvidenceBySymbol[symbol]` にentryがある場合、該当controlの`learningEvidenceUsed`に**全て**の `session_trade:signal_quality:<entrySourceEventId>` を入れる。アプリは欠けたoutputをinvalidとして保存しない。
3. 損失があっても自動で方向転換してはならない。台帳・価格推移・日経225mini・過去類似事例を確認したうえで、維持、調整、無効化を`changeReason`に明示する。
4. `entryKind=initial|reentry`、`isOpeningTrade`、`entryOrdinal`を確認する。09:00〜09:29の**実際のentry時刻**は寄り付き取引であり、一律禁止しない。AIが見送りたい場合だけ`no_trade`／`disabled`を返す。
5. 決済後の再entryは、新しいimmutable plan/decisionだけで判断する。同じplan IDを再利用した重複entry、保有中の重複entry、exitと同一source eventでの即時再entryは許可しない。
6. AI判断が未着、無効、期限切れ、または`no_trade`なら、アプリは独自の計画・再entryを作らない（fail-closed）。
7. `11:30` は前場終了後の既存ポジション管理専用とする。時刻を11:29へ変更するものではない。11:29は入力に含められる最後の完成1分足、11:30はその足までをcutoffにする管理checkpointである。flat銘柄のcontrolは `planDecision=disabled` とし、schema上のentry windowは `12:30〜12:34` を置くが新規entry権限には使わない。新規保有の継続・利確・退出は独立managementPlansで判断する。既存保有のtighten_onlyは旧互換処理として維持する。後場は12:30から始まり、11:30管理計画は12:30以後の最初のsource eventで適用される。`12:35` 以降は後場最初の完成5分足で再評価する。
8. entry時と保有中の各1分足で、plan経過時間、confirmPriceとの差、直近20終値のSMA20、方向に不利なSMA20側の連続本数を記録する。アプリ側の固定閾値、自動entry拒否、自動損切りには使わず、2分連続のSMA20逆行も単独の自動決済条件にはしない。一方、翌営業日以降のCodexは、前営業日までの失敗・改善仮説を注意材料として、checkpoint cutoff以前の当日1分足・完成5分足・SMA/BB/RSI・支持抵抗・出来高・日経225miniと照合し、銘柄ごとにentry、方向、継続、tighten_only、退出を定性的に判断する。固定本数・固定乖離率は置かず、SMA20逆行だけで変更せず、当日市場構造の独立した裏付けをchangeReason/evidenceUsed/confidenceBasisへ具体的に残す。

- 新規保有の `firstTarget` は到達記録・判断材料のみ。自動決済・自動トレール・自動ライン更新はしない。`stretchTarget` でも自動決済しない。保有管理は独立した `managementPlans` に従う。既存保有は決済まで旧ルールを維持する。
- 新規保有は管理計画の `validUntil` 失効後、後継checkpointの `validUntil` まで後継を待つ。待機中は新規entry禁止、stop緩和禁止とし、hard stopと保護stopを維持する。期限未着なら次の実行可能イベントで全株決済し、失効済み保有を遅着計画で延命しない。15:20を最終期限とする。

過去の損失は次回判断の根拠に含めますが、1件の損失だけで閾値を自動変更しません。AIは調整理由を明示し、アプリは前向きshadowとして保存します。自動採用、実注文接続、通常ロジックの書換えは行いません。

生成JSONは、送信前にサーバーと同じ決定的条件をローカルで検査します。価格順序・方向別目標価格・10銘柄一意性・checkpoint時間帯・input hash対応・当日`signal_quality`取引の必須evidence IDを確認し、不合格なら外部送信を開始しません。修正後に再検査し、合格した同一payloadだけを送ります。

```bash
node scripts/ai-intraday-preflight.mjs \
  /secure/path/ai-intraday-forecast.json \
  --input /secure/path/ai-intraday-input.json
```

送信スクリプト自身も同じpreflightを必ず実行するため、検査を省略した送信はできません。

```bash
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/ingest-ai-intraday-forecast.mjs \
  /secure/path/ai-intraday-forecast.json \
  --input /secure/path/ai-intraday-input.json
```

通常運用では、取得時に保存した入力を`--input /secure/path/ai-intraday-input.json`で同時に渡します。

`sourceRevisionId` は `ai-intraday-forecast:YYYY-MM-DD:HHMM:<一意suffix>` とします。同じ朝snapshot・同じcheckpointは最初の1件だけを凍結し、後から上書きできません。

保存に成功した有効計画だけを、同日・銘柄ごとの独立shadowが参照します。

ingest時点のdispatch `engineSequence`をactivation境界として保存し、新計画はその境界より後のsource eventだけに適用します。到着前の未処理足へ遡ってentry・exitを作りません。checkpointからactivation境界までに`firstTarget`へ到達済みの銘柄は`missed_move_no_entry`とし、そのplan IDからの新規entryだけを禁止します。保有中ポジションは新計画到着まで旧計画のstopで管理し、到着後の管理変更は次source eventから適用します。

1. zoneに触れる
2. **別イベント**で `confirmPrice` を確認
3. そのイベント時点の因果的・方向別depth VWAP（板観測→relay組立が0〜5秒）で仮想entry

- 新規保有の `firstTarget` は到達記録・判断材料のみ。自動決済・自動トレール・自動ライン更新はしない。`stretchTarget` でも自動決済しない。保有管理は独立した `managementPlans` に従う。既存保有は決済まで旧ルールを維持する。

新計画で未entryの方向・価格帯が変わった場合、旧touchは破棄して新計画から再判定します。新規保有はmanagementPlansの明示判断と独立stopで管理します。既存保有のtighten_only・方向転換指示は旧互換処理です。毎分の再検証観測は同じshadow state遷移の固定長計算で行い、追加のDB query、外部通信、AI呼び出し、通常engineへの書込みは行いません。

`signal_quality`（100株）と`capital_constrained`は別state・別event・別tradeとして保存します。旧④日経225mini revisionは最初の09:15 AI計画までの補助安全判定として残し、AI場中計画が生成された後は、その計画内の日経225mini評価が優先されます。朝snapshotも過去の場中計画も更新しません。

## 5. スケジュール

v6の08:30 Codex作業は、[v6朝AIプロンプト](./ai-daily-forecast-codex-prompt-v6.md)を使用し、D-1までのinputだけを使い、当日台帳を参照しません。v6場中作業は、[v6場中AIプロンプト](./ai-intraday-forecast-codex-prompt-v6.md)を使用し、前場15分・後場30分のcheckpoint、当日台帳・mode分離・必須evidenceの規約を守ります。

この実装はCodex schedule/task/sessionを作成・変更しません。外部Codex側は、endpoint受入確認後に平日08:30と上記16 checkpointを管理します。Windows relayや通常10銘柄の受信処理からAIを呼び出してはいけません。

この実装はscheduleそのものを勝手に作成・変更しません。endpoint公開、migration、手動受入が成功した後に、平日08:30と上記16 checkpointのCodexタスクを利用者確認のうえで登録します。Windows relayや通常10銘柄の受信処理からAIを呼び出してはいけません。

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
- v5/v6の10銘柄・両evaluation modeのAI shadow取引。v5はimmutableな履歴・学習読取専用、v6だけが新規dispatch対象。`signal_quality` は戦略学習の唯一の主事例、`capital_constrained` は同一市場機会を二重計上しない執行監査
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

## 保有管理・ナレッジ更新案（本番適用は別途承認）

新規保有については [保有管理契約](ai-position-management-checkpoint-contract.md) を併用する。管理命令は `aiFinalForecast.managementPlans`、保有開始時の保護ラインは各forecastの `protectiveStop`、参照ナレッジは `knowledgeIds` に出力する。
