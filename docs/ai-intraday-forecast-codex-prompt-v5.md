# AI適応予測shadow v5 — 場中Codex定期taskプロンプト

> **用途**: 08:30の朝予測を保存済みのまま維持し、`09:30 / 10:00 / 10:30 / 11:00 / 11:30 / 12:35 / 13:00 / 13:30 / 14:00 / 14:30 / 15:00` の各checkpointで、外部Codexが次のimmutable AI場中予測を生成するための指示です。通常売買・OrderBridge・Executor・実注文には接続しません。

## 実行前

1. `scripts/fetch-ai-intraday-forecast-input.mjs` で、対象日時・checkpointのread-only inputを取得する。
2. `inputQuality="invalid"` の場合は**生成・ingestしない**。独自の代替計画・価格・取引を作らない。
3. inputに含まれる数値、保存済みsnapshot、event、trade以外の価格・板・ニュース・将来情報を使わない。

```bash
cd /home/ubuntu/stock-alert-app
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/fetch-ai-intraday-forecast-input.mjs YYYY-MM-DD HH:MM \
  --out /secure/path/ai-intraday-input.json
```

## v5判断規約

- `aiSessionStrategyJournal` の `signal_quality` は、方向・entry・exitの**唯一の戦略学習事例**です。同じplan／市場機会の `capital_constrained` を別の勝敗・市場事例として二重加算してはいけません。
- `aiSessionExecutionAuditJournal` の `capital_constrained` は、板深度、資金、株数の実行可能性の監査にだけ利用します。戦略判断の市場事例として独立加算しません。
- `aiSessionTradeJournal`、`aiCurrentStrategyPositions`、`aiCurrentExecutionAuditPositions` を確認し、当日のentry/exit、direction、entry/exit価格、損益、realized R、MFE/MAE、MFE/MAE品質、exit reason、decision/plan ID、初回／再entry、寄り付き分類、保有状態を判断に反映します。
- `entryKind="initial"|"reentry"` と `entryOrdinal` は、その日の取引順を表します。**09:00〜09:29の実entry時刻**は寄り付き取引です。寄り付きは一律禁止せず、過去事例・gap・市場環境・当日価格推移を総合して取引／見送りを判断します。
- 損失があったからといって必ず方向転換しません。`maintained`、`adjusted`、`disabled` のいずれを選んでも、`changeReason`に当日台帳と価格推移を確認した理由を明記します。
- 保有中の新規ポジションは作りません。既存保有に対しては `openPositionAction`（`keep` / `tighten_only` / `exit_next_event_if_direction_changed`）のみを判断します。
- 決済済みなら、**新しい**immutable decision/planだけが再entryを判断できます。同じplan IDを再利用した重複entry、保有中の重複entry、exitと同一source eventでの即時再entryを提案しません。
- `no_trade`、判断未着、invalid、期限切れでは、アプリは独自entryを作りません。無効化・見送りの場合は`disabled`を使います。

## 必須evidence

各symbolについて、`generationContract.requiredLearningEvidenceBySymbol[symbol]` にentryがある場合、同symbolのcontrolの `learningEvidenceUsed` に**その全て**を入れます。

```text
session_trade:signal_quality:<entrySourceEventId>
```

入力に示されるevidenceを引用しないcontrolはアプリ側validatorでinvalidになります。`capital_constrained`のevidenceは補助監査としてのみ引用でき、signal_qualityと同じ市場事例を二重に数えません。

## 出力とingest

- 全10銘柄について一意のcontrolを出す。
- 価格、entry window、force exit、方向・target・stopの整合性を維持する。
- `forceExitTime` は15:20以下とする。
- `learningEvidenceUsed` は最大500件だが、入力にある当日signal_quality evidenceは省略しない。
- ダミー予測・ダミー市場データ・ダミー取引を生成／保存しない。

```bash
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/ingest-ai-intraday-forecast.mjs /secure/path/ai-intraday-forecast.json
```

`AI_DAILY_FORECAST_INGEST_KEY` は引数・JSON・ログ・出力に出さないでください。
