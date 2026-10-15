# checkpoint保有管理契約・定期タスク更新案

この文書は承認済みの本番契約を記録する。

## 適用範囲

新規に開いたshadow保有に `managementVersion=checkpoint_v1` を保存する。既存stateにこの識別子がなければ決済まで旧処理を継続する。既存保有の自動移行はしない。新方式ではfirstTargetは到達記録だけ、stretchTargetは参考価格だけであり、自動全決済・自動トレール・自動ライン更新を行わない。旧保有の3本トレールは互換処理として残る。

entryと保有管理を分離し、二重保有・同一イベント再entry・同一entry計画の再利用・遡りentryを禁止する。flatのままfirstTarget到達済みentry計画の消費も維持する。`manage_only` を維持する。

## 新規entry出力

各forecastに任意の `protectiveStop` と `knowledgeIds` を追加できる。保護ラインは保有開始時から有効。hard stopは従来のstopPriceとして別保持する。LONGでは保護ラインがhard stop以上かつentry価格未満、SHORTではhard stop以下かつentry価格超である必要がある。不適切な初期ラインはentryを拒否する。未指定ならhard stopのみが有効。

初回管理期限はentry計画の `forceExitTime`。各checkpointでholdを継続するなら独立した管理計画を必ず出力する。entry計画の更新だけでは新方式の保有期限・stop・保護ラインを更新しない。

## checkpoint定期タスク用プロンプト案

以下を既存の入力取得・署名付きinput保存・ローカル検証手順に追加する。

> `managementPositions` と `aiCurrentPositions` を照合し、新方式の保有ごとに `hold` / `take_profit` / `exit` を判断する。`managementDecisionEvents` にあるcutoff以前の同銘柄イベントを根拠にし、`aiFinalForecast.managementPlans` にentryとは独立した計画を出す。`positionId` は入力のIDをそのまま使う。異なるevaluationModeで同じentryイベントの保有は同じpositionIdとなり、各modeで一度ずつ適用される。
>
> 利確・保持・決済の閾値や判断時刻を固定規則にしない。firstTarget到達、当日の支持抵抗・出来高・値動き・市場環境、関連ナレッジの事実と反例を材料にその場で判断する。部分利確はしない。`take_profit` は利確理由の全株決済、`exit` はそれ以外の理由の全株決済である。
>
> `planId` は不変かつ新しいID、`basedOnEventId` は入力に存在する観測イベントIDとする。LONGのstop/保護ラインを下げず、SHORTでは上げない。既存の保護ラインを取り消さない。`validUntil` は判断して指定し、最遅15:20とする。`reason` に判断根拠、`knowledgeIds` に実際に参照した入力ナレッジIDを残す。参照しなければ空配列。候補・棄却ナレッジも状態と反例を読み、確定ルールとして扱わない。

例（ID・数値・期限は実データから判断する）：

```json
{
  "managementPlans": [
    {
      "planId": "management:2026-10-16:8035:1015:1",
      "positionId": "8035:long:ENTRY_EVENT_ID",
      "symbol": "8035",
      "side": "long",
      "basedOnEventId": "OBSERVED_EVENT_ID",
      "action": "hold",
      "protectiveStop": 105,
      "validUntil": "10:30",
      "reason": "観測事実を根拠に保持。反例と不確実性も検討済み",
      "knowledgeIds": []
    }
  ]
}
```

`managementPlans` は `aiFinalForecast` の直下。任意の `hardStop` はhard stopを安全側へ変更する場合だけ指定する。株数フィールドは受け付けない。スキーマは `server/aiPositionManagement.ts`、CLI検証は `scripts/ai-intraday-preflight.mjs`。

受理境界は既存のengineSequenceによるingest後境界を使用する。新管理命令は同一source eventへ遡って適用せず、新鮮な板と全株分の反対売買深度がある最初のイベントで適用する。利確・exit・到着時に割れている新保護ラインの決済価格はそのイベントの板VWAP。新ラインを到着イベントより前のOHLCへ遡及させない。保持中のstop接触は完成足の高安でも検知し、板で決済できなければ退出を予約して次の実行可能イベントを待つ。

緩和指示・既に期限切れの指示を拒否し、旧計画の期限を維持する。同一positionへの同じplanIdは拒否も含め一度だけ処理する。失効後は後継checkpointの `validUntil` まで後継を待つ。待機中は新規entry禁止、stop緩和禁止とし、hard stopと保護ラインは維持する。期限境界では後継を受理せず `ai_management_successor_missing_exit` で退出する。板欠損でも失効状態を保存し、その後の遅着計画で復活させない。15:20で待機を打ち切る。

## 閉場後レビュー定期タスク用プロンプト案

> 閉場・データ確定後、既存レビューの `knowledge` 配列へ判断事例を追加する。判断時点の事実、判断理由、実際の結果、教訓候補、反例、不確実性、状態を分けて記録する。判断時点で知らなかった結果を事実欄へ混ぜない。意思決定と結果の証拠イベントはそれぞれ明記する。初期状態はcandidateとし、既存のvalidatedレビュー検証ゲートを満たす場合のみvalidatedにする。棄却はrejectedとして残す。教訓を固定閾値・自動設定へ変換しない。

```json
{
  "knowledge": [
    {
      "knowledgeId": "knowledge:2026-10-16:8035:1",
      "symbol": "8035",
      "side": "long",
      "decisionFacts": {
        "asOf": "2026-10-16T10:00:00+09:00",
        "eventIds": ["DECISION_EVENT_ID"],
        "facts": ["判断時点で観測済みの事実"]
      },
      "decisionReason": "保持または全株決済を選んだ理由",
      "actualOutcome": {
        "observedAt": "2026-10-16T10:30:00+09:00",
        "eventIds": ["OUTCOME_EVENT_ID"],
        "result": "後に確定した結果"
      },
      "lessonCandidate": "次回の注意材料",
      "counterexamples": [],
      "uncertainty": ["サンプル不足など"],
      "status": "candidate"
    }
  ]
}
```

既存レビューJSONに保存するため新しいDBテーブルは不要。直近60閉場日以内の最大60レビューからknowledgeIdごとの最新状態を取り出し、最大300件を `latestLearningReview.review.knowledge` として翌日・checkpoint入力へ渡す。rejectedも反例として残す。レビュー自体は対象営業日より前だけを選ぶ。同日の将来結果は渡さない。

## 検証・リスク・反映前承認

単体テストは新方式の適用時点、stop緩和拒否、到着時既割れ、後継checkpointのvalidUntil境界、板欠損中の失効ラッチ、板深度不足、全株決済、一度だけの実行、旧保有互換、targetでの非決済、ナレッジの事実・結果分離を検証する。

過去の計画には新しい保護ライン指定がないため、過去リプレイから新方式の損益改善を評価することはできない。今回は収益比較リプレイを行わず、前向きのshadow運用で判断品質・執行価格・ナレッジ品質を評価する必要がある。板やイベントが来なければ後継checkpointのvalidUntilちょうどに約定できず、次の実行可能イベントまで退出予約を維持する。実売買やOrderBridgeには接続しない。

本番反映はユーザー承認済み。新規保有からのみ切替え、既存保有は旧方式のまま決済まで継続する。

## 今回変更したファイル一覧・検証結果

作業開始時から存在した未コミット差分は維持した。以下は今回触れたファイルだけの一覧。

- `server/aiPositionManagement.ts`：管理計画スキーマとpositionId。
- `server/aiDecisionKnowledge.ts`：事実・理由・結果・教訓・反例・不確実性・状態のスキーマ。
- `server/aiDailyForecastShadowEngine.ts`：新規保有への方式固定、独立管理、二重実行防止、実行可能板価格、失効ラッチ。
- `server/aiDailyForecastService.ts`：初期保護ライン・ナレッジ参照の入出力検証。
- `server/aiIntradayForecastService.ts`：管理計画の入出力・因果参照検証・受理時刻監査・保有状態入力。
- `server/aiPostmarketLearningService.ts`：構造化ナレッジ保存・証拠検証・過去レビューからの入力引渡し。
- `scripts/ai-intraday-preflight.mjs`：送信前ローカル検証の新スキーマ対応。
- `server/aiPositionManagement.test.ts`：新方式・ナレッジの境界条件テスト。
- `server/aiDailyForecast.test.ts`：新規保有のtarget非決済・初期保護ライン・再entry検証。
- `server/aiIntradayForecast.test.ts`：独立管理計画の往復・根拠ID検証。
- `server/aiIntradayPreflight.test.ts`：CLI入力保持・管理計画検証。
- `server/aiPostmarketLearningService.test.ts`：ナレッジ保存形式・状態・証拠所有検証。
- `docs/ai-daily-forecast-codex-contract.md`：新方式の契約更新案。
- `docs/ai-daily-forecast-codex-prompt-v5.md`：朝プロンプト更新案への接続。
- `docs/ai-intraday-forecast-codex-prompt-v5.md`：checkpointプロンプト更新案への接続。
- `docs/ai-position-management-checkpoint-contract.md`：本書、閉場後を含むプロンプト案と実装報告。

検証結果：関連11テストファイル、116テスト成功。`node node_modules/typescript/bin/tsc --noEmit` 成功。対象変更の `git diff --check` 成功。

別途試行した `server/aiDailyForecastSecret.test.ts` 1件は、ローカル環境の `AI_DAILY_FORECAST_INGEST_KEY` 未設定のため冒頭の環境条件確認で失敗した。HTTP通信には進んでおらず、認証エンドポイントとの疎通は未検証。テストを通すための秘密値設定・外部接続・サーバー起動は行っていない。

commit / push、Manus送信、公開、本番DB・APIへの書込み、`~/.codex/automations` の変更は実施していない。
