# AI適応予測shadow v6 — 場中Codex checkpointプロンプト

> **対象開始日**: 2026-10-15（JPX営業日）。v5のimmutable snapshot・event・tradeは更新せず、履歴／学習読取専用として残す。  
> **役割分離**: Codexが分析・判断を行い、Stock Alert Appは因果的inputの返却、同一validatorによる検証、immutable保存、shadow参照だけを行う。通常engine、OrderBridge、Executor、実注文、`rt_trades`には接続しない。

## v6 checkpoint

| セッション | checkpoint | 入力cutoff | 有効期間 |
|---|---:|---:|---:|
| 前場 | 09:15 | 09:14 | 09:15–09:29 |
| 前場 | 09:30 | 09:29 | 09:30–09:44 |
| 前場 | 09:45 | 09:44 | 09:45–09:59 |
| 前場 | 10:00 | 09:59 | 10:00–10:14 |
| 前場 | 10:15 | 10:14 | 10:15–10:29 |
| 前場 | 10:30 | 10:29 | 10:30–10:44 |
| 前場 | 10:45 | 10:44 | 10:45–10:59 |
| 前場 | 11:00 | 10:59 | 11:00–11:14 |
| 前場 | 11:15 | 11:14 | 11:15–11:29 |
| bridge | 11:30 | 11:29 | **新規entryは12:30–12:34だけ** |
| 後場 | 12:35 | 12:34 | 12:35–12:59 |
| 後場 | 13:00 | 12:59 | 13:00–13:29 |
| 後場 | 13:30 | 13:29 | 13:30–13:59 |
| 後場 | 14:00 | 13:59 | 14:00–14:29 |
| 後場 | 14:30 | 14:29 | 14:30–14:59 |
| 後場 | 15:00 | 14:59 | 15:00–15:19 |

- 12:00、12:30、15:30はcheckpointではない。新規planを生成・ingestしない。
- **11:30はbridge専用**: 前場の未決済positionを方向矛盾・損切り・force exitの観点で最終確認するが、前場の新規entryを作らない。各controlの`entryWindowStart`/`entryWindowEnd`は**12:30–12:34の範囲内だけ**が有効であり、範囲外はserver validatorとpreflightの双方でrejectされる。12:35には後場最初の完成済み5分足で再判断する。
- `cutoffCandleTime`より後の足、板、市場環境、結果を取得・利用・表示しない。
- JPX東証現物株式が休場なら取得・生成・ingestはすべてno-opとする。

## 実行前

```bash
cd /home/ubuntu/stock-alert-app
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/fetch-ai-intraday-forecast-input.mjs YYYY-MM-DD HH:MM \
  --out /secure/path/ai-intraday-input.json
```

1. `inputQuality="invalid"`なら生成・ingestしない。価格、plan、取引を推測補完しない。
2. 08:30のimmutable snapshotがない、invalid、またはv6 input hashが得られない場合はfail-closedとする。
3. input外の価格・板・ニュース・将来の高安終値を使わない。
4. Secretの値をCLI引数、JSON、ログ、画面、Git、成果物に出さない。

## 判断規約

- 各checkpointで10銘柄すべてに一意のcontrolを作る。`planDecision`は`maintained`、`adjusted`、`disabled`のみ。
- controlのentry windowは表の有効期間内、`forceExitTime`はentry window以上かつ15:20以下とする。
- `aiSessionStrategyJournal`の`signal_quality`だけが戦略学習事例である。`capital_constrained`は板深度・資金・株数の執行監査だけに用い、同じ市場機会を二重に学習しない。
- 同一日で決済後に再entryする場合、**新しいimmutable `sourceRevisionId`のみ**が判断できる。同一planの重複entry、保有中の重複entry、exitと同一source eventでの即時再entryを提案しない。
- `generationContract.requiredLearningEvidenceBySymbol`にある当日`signal_quality` evidenceは対応controlの`learningEvidenceUsed`へすべて入れる。欠ける出力はvalidatorでrejectされる。
- `no_trade`、未着、invalid、期限切れではアプリ側が独自entryを作らない。保有中は`openPositionAction`だけで扱い、新しいポジションを重ねない。
- entryはzone touch後の**別source event** confirm、観測からrelay組立まで0–5秒の因果的方向別depth VWAP、板不足時fail-closed、SL優先、firstTarget、最遅15:20決済というアプリ固定契約に従う。これらを弱めない。

## 生成・preflight・immutable ingest

1. `sourceRevisionId`を次の形式で作る。

```text
ai-intraday-forecast:YYYY-MM-DD:HHMM:<一意suffix>
```

2. `morningSourceSnapshotId`とinputの`inputHash`を変えずにJSONを保存する。
3. 次のscriptは永続化前に**同一サーバーvalidatorのnon-persisting preflight**を実行する。preflightが無効またはinput hash不一致なら保存しない。

```bash
AI_DAILY_FORECAST_INGEST_KEY="$AI_DAILY_FORECAST_INGEST_KEY" \
node scripts/ingest-ai-intraday-forecast.mjs \
  /secure/path/ai-intraday-forecast.json
```

- 同じ`sourceRevisionId`かつ同一payloadはduplicate/no-op、同じIDで異なるpayloadはreject。
- 同じ朝snapshot・同じcheckpointは最初のimmutable snapshotだけを受理し、後から上書きしない。
- AppはLLMを呼ばず、戦略コード・閾値を自動変更しない。reviewの`validated policyAdvice`も外部Codexの次回forecast入力としてのみ参照可能であり、アプリ規則を変えない。
