# AI適応予測shadow v6 — 場中Codex定期taskプロンプト

> **履歴専用**: 2026-10-15から新規受付はAI v6です。この文書とv5 snapshotは監査・学習読取のために保持し、v5 payloadを新規に生成・ingestしません。新規作業は[v6場中AIプロンプト](./ai-intraday-forecast-codex-prompt-v6.md)を参照してください。

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

## v6判断規約

- `aiSessionStrategyJournal` の `signal_quality` は、方向・entry・exitの**唯一の戦略学習事例**です。同じplan／市場機会の `capital_constrained` を別の勝敗・市場事例として二重加算してはいけません。
- `aiSessionExecutionAuditJournal` の `capital_constrained` は、板深度、資金、株数の実行可能性の監査にだけ利用します。戦略判断の市場事例として独立加算しません。
- `aiSessionTradeJournal`、`aiCurrentStrategyPositions`、`aiCurrentExecutionAuditPositions` を確認し、当日のentry/exit、direction、entry/exit価格、損益、realized R、MFE/MAE、MFE/MAE品質、exit reason、decision/plan ID、初回／再entry、寄り付き分類、保有状態を判断に反映します。
- `entryKind="initial"|"reentry"` と `entryOrdinal` は、その日の取引順を表します。**09:00〜09:29の実entry時刻**は寄り付き取引です。寄り付きは一律禁止せず、過去事例・gap・市場環境・当日価格推移を総合して取引／見送りを判断します。
- 損失があったからといって必ず方向転換しません。`maintained`、`adjusted`、`disabled` のいずれを選んでも、`changeReason`に当日台帳と価格推移を確認した理由を明記します。
- 新規保有の管理はentry計画から分離した `managementPlans` で判断する。`openPositionAction` は既存保有の互換用。保有中の新規entryは禁止し、entryを行わない計画は `entryPolicy=manage_only` にする。
- 決済済みなら、**新しい**immutable decision/planだけが再entryを判断できます。同じplan IDを再利用した重複entry、保有中の重複entry、exitと同一source eventでの即時再entryを提案しません。
- `no_trade`、判断未着、invalid、期限切れでは、アプリは独自entryを作りません。無効化・見送りの場合は`disabled`を使います。
- `11:30` は既存ポジション管理専用です。11:29は入力cutoffの下限、11:30は管理checkpointであり、checkpoint自体を11:29へ移しません。flat銘柄は `planDecision=disabled` とし、新規entryを提案しません。schema上のentry windowは `12:30〜12:34` に限定しますが、新規entry権限には使いません。保有銘柄は、同方向の勢いが継続している場合だけ `tighten_only` とし、stopを緩めず、後場12:30以後の最初のsource eventから次checkpointまでの退出期限を設定できます。方向変更は `exit_next_event_if_direction_changed`、disabledは退出です。
- 新規保有は管理計画の `validUntil` 失効後、後継checkpointの `validUntil` まで後継を待つ。待機中は新規entry禁止、stop緩和禁止とし、hard stopと保護stopを維持する。期限未着なら次の実行可能イベントで全株決済し、失効済み保有を遅着計画で延命しない。15:20を最終期限とする。
- 新規保有の `firstTarget` は到達記録・判断材料のみ。自動決済・自動トレール・自動ライン更新はしない。`stretchTarget` でも自動決済しない。保有管理は独立した `managementPlans` に従う。既存保有は決済まで旧ルールを維持する。
- entry時と保有中のSMA20逆行連続数などはアプリが前向き観測します。2分連続を含む固定閾値は未確定であり、アプリの自動entry拒否・自動決済にはしません。ただし翌営業日以降のCodexは、前営業日までの失敗・改善仮説を注意材料として、checkpoint cutoff以前の当日1分足・完成5分足・SMA/BB/RSI・支持抵抗・出来高・日経225miniと照合し、銘柄ごとにentry、方向、継続、tighten_only、退出を定性的に判断します。SMA20逆行だけで変更せず、当日市場構造の独立した裏付けをchangeReason/evidenceUsed/confidenceBasisへ具体的に残します。

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

## entryと保有管理の分離

- 各controlに `entryPolicy: "entry_allowed" | "manage_only"` を明示します。管理専用なら `manage_only` とし、台帳反映遅れでflatに見えても新規entryを許可しません。`tighten_only` は保有更新の方法で、entry許可とは独立します。過去payloadの省略時は互換性のため `entry_allowed` と扱います。
- flatのままfirstTarget到達を観測した計画IDは消費済みとし、その計画では後からentryしません。

## 保有管理・ナレッジ

新規保有については [保有管理契約](ai-position-management-checkpoint-contract.md) を併用する。管理命令は `aiFinalForecast.managementPlans`、保有開始時の保護ラインは各forecastの `protectiveStop`、参照ナレッジは `knowledgeIds` に出力する。
## 遅延起動時のcutoff

入力cutoffの表記は下限です。prepareが返す署名付きcutoff以前だけを使います。固定cutoff以上・validUntil未満・現在分未満でsource processedとshadow dispatch完了済みの最新足をprepareでfreezeします。14:10起動でqueueが14:07まで完了なら14:07を使い、14:08以後は使いません。固定cutoffまで未完了なら503です。分析中にinput/tokenを更新しません。

checkpointとvalidUntilは延長しません。cutoffMode・delayMinutes・remainingMinutesを確認し、残り時間でentryするかはAIが固定閾値を設けず判断します。遅延計画はdelayed_latest_processedとして保存します。checkpointから到着までのfirstTarget到達済みはmissed_move_no_entryとし、新計画は到着後のactivation境界を越えたsource eventから適用します。

定期taskの「cutoffは固定値」は上記へ置き換えます。~/.codex/automationsのtomlは別途承認後に更新します。
