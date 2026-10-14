# AI適応予測shadow v6 — 08:30 Codex朝forecastプロンプト

> **対象開始日**: 2026-10-15（JPX営業日）。v5のimmutable履歴は変更せず、学習参照だけを継続する。  
> **安全境界**: 監視専用。`DRY_RUN=true`、`LIVE=false`、`eligibleForAdoption=false`、`automaticAdoption=false`、`orderInstructionConnection=false`。通常1分足受信、relay、通常engine、OrderBridge、Executor、実注文、`rt_trades`は変更しない。

## 朝input

```bash
cd /home/ubuntu/stock-alert-app
node scripts/fetch-ai-daily-forecast-input.mjs YYYY-MM-DD \
  --out /secure/path/ai-v6-daily-input.json
```

- 08:30–08:59 JSTに、`dataCutoffDate`（前JPX営業日）以前の確定済みデータだけを用いる。
- ①〜③のpre-open snapshot、D-1日足特徴、過去v5/v6の確定済み学習snapshot・closed reviewを入力に含める。後付けの価格・ニュース・市場データ・結果を補完しない。
- `inputQuality="invalid"`なら生成・ingestしない。休場日はすべてno-op。
- 10銘柄すべてについて、方向、entry帯、confirm、target、stop、強制決済時刻を含む一意のforecastを作る。方向なしは`no_trade`相当のrange/insufficient/staleとして価格をnullにする。

## v6利用規約

- 朝snapshotはその日の前場15分・後場30分のcheckpointが参照するimmutable baselineである。朝snapshot自体は更新しない。
- 寄り付きは一律禁止しない。ただし当日planがなければアプリは独自entryを作らない。
- 再entryは朝planでは固定せず、決済後の新しい場中immutable planだけが判断する。
- `signal_quality`は戦略学習の主事例、`capital_constrained`は実行監査であり二重計上禁止。
- reviewの`observation_only`/`candidate`は助言のみ。`validated policyAdvice`も、アプリの戦略条件を自動変更せず、外部Codexが次回forecastを作る際の入力としてのみ利用できる。

## immutable ingest

`sourceSnapshotId`は次を使用する。

```text
ai-daily-forecast:YYYY-MM-DD:codex-0830-v6
```

JSONには`tradeDate`、08:30–08:59の`capturedAtMs`、inputから変更しない`inputHash`、10件の`quantBaseline`、10件一意の`aiFinalForecast.forecasts`、`generatorId`、`promptVersion`を含める。SecretはJSONに入れない。

```bash
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/ingest-ai-daily-forecast.mjs /secure/path/ai-v6-daily-forecast.json
```

同じsnapshot ID・同じpayloadは再送no-op、同じID・異payloadはreject。Appはinput hash、baseline完全一致、10銘柄一意性、価格順、方向整合、ATR例外理由を検証し、失敗payloadを保存しない。

場中は [v6場中プロンプト](./ai-intraday-forecast-codex-prompt-v6.md) の16 checkpointだけを使用する。Manus側ではCodex schedule/task/sessionを作成・変更しない。
