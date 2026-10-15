# AI適応予測shadow v6 — 08:30 Codex定期taskプロンプト

> **履歴専用**: 2026-10-15から新規受付はAI v6です。この文書とv5 snapshotは監査・学習読取のために保持し、v5 payloadを新規に生成・ingestしません。新規作業は[v6朝AIプロンプト](./ai-daily-forecast-codex-prompt-v6.md)を参照してください。

> **用途**: 平日08:30に、前営業日までに確定済みの保存データだけから、10銘柄のAI適応予測shadow v5の朝planを生成・ingestします。監視専用であり、通常取引・OrderBridge・Executor・実注文には接続しません。

## 実行前

```bash
cd /home/ubuntu/stock-alert-app
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/fetch-ai-daily-forecast-input.mjs YYYY-MM-DD \
  --out /secure/path/ai-daily-input.json
```

1. `inputQuality="invalid"` の場合は、出力を作成・ingestしない。
2. 参照できるのは input の `dataCutoffDate` 以前に確定したデータだけである。当日の足・板・当日trade・将来情報を使わない。
3. inputに含まれない価格、板、ニュース、ダミー値を補完しない。

## v6判断規約

- input内の過去AI shadow成績、寄り付き分類、gap、銘柄固有傾向、市場環境、類似事例を総合して、各銘柄を `long` / `short` / `no_trade` と判断する。
- 寄り付きは一律禁止しない。過去の寄り付き成功・失敗を根拠にし、entry windowが09:00〜09:29を含むか、`no_trade`とするかを判断する。
- 同一銘柄の再entryは、朝planでは決め打ちしない。場中の新しいimmutable decision/planと当日台帳に基づく。朝planは当日最初の条件だけを定義する。
- 判断が弱い、必要データが不足、またはtarget/stop/entry条件を因果的に定義できない場合は `no_trade` にする。アプリは無効または期限切れのplanから独自entryを作らない。
- `forceExitTime` は15:20以下とし、target・stop・entry zone・confirmationを矛盾なく設定する。

## 出力・ingest

- 全10銘柄について一意のcontrolを返す。
- `candidate-<symbol>-ai-adaptive-forecast-v6` の監視用planのみを対象にする。
- ダミー予測・ダミー市場データ・ダミー取引を保存しない。
- `AI_DAILY_FORECAST_INGEST_KEY` はプロンプト、出力JSON、ログ、画面に出さない。

```bash
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/ingest-ai-daily-forecast.mjs /secure/path/ai-daily-forecast.json
```

場中の09:15以降の判断は、[v6場中AIプロンプト](./ai-intraday-forecast-codex-prompt-v5.md)を使い、当日の `signal_quality` 台帳と保有状態を必ず確認します。

## 保有管理・ナレッジ

新規保有については [保有管理契約](ai-position-management-checkpoint-contract.md) を併用する。管理命令は `aiFinalForecast.managementPlans`、保有開始時の保護ラインは各forecastの `protectiveStop`、参照ナレッジは `knowledgeIds` に出力する。
