# Stock Alert App - TODO

## Phase 1: データベーススキーマ設計と移行
- [x] drizzle/schema.ts に daily_reports テーブルを追加
- [x] drizzle/schema.ts に stock_reports テーブルを追加
- [x] drizzle/schema.ts に algorithm_improvements テーブルを追加
- [x] drizzle/schema.ts に algorithm_config テーブルを追加
- [x] pnpm db:push でマイグレーション実行

## Phase 2: サーバーサイドAPI（tRPCルーター）の実装
- [x] server/simulation.ts - シミュレーションエンジン実装（RSI/MA/BB計算、決定論的シード）
- [x] server/db.ts - DB ヘルパー関数（saveDailyReport, getAlgorithmConfig, etc.）
- [x] server/routers/trading.ts - tRPC ルーター（レポート保存・取得・アルゴリズム管理）
- [x] server/routers.ts - trading ルーターを統合

## Phase 3: フロントエンドの復元と新機能ページの実装
- [x] client/src/pages/Home.tsx - 元のダッシュボードUIを復元（チャート・板情報・歩み値・アラートログ）
- [x] client/src/pages/ReportHistory.tsx - レポート履歴ページ（過去の成績一覧・詳細表示）
- [x] client/src/pages/AlgorithmPage.tsx - アルゴリズム設定・改善履歴ページ
- [x] client/src/App.tsx - /reports と /algorithm ルートを追加
- [x] Home.tsx ヘッダーに「レポート履歴」「アルゴリズム」ナビゲーションリンクを追加

## Phase 4: 毎平日自動レポート生成スケジューラーの設定
- [x] server/scheduledHandlers.ts - 毎平日シミュレーション実行ハンドラー
- [x] server/_core/index.ts - /api/scheduled/daily-simulation エンドポイント登録
- [x] デプロイ後に manus-heartbeat create で平日9時(JST=UTC+9→0時UTC)スケジュール登録 (task_uid: DbUxCsDA4RZyZy8v4PhQ77, 次回実行: 2026-06-02T00:00:00Z)

## Phase 5: テスト・チェックポイント保存
- [x] server/simulation.test.ts - シミュレーションエンジンのユニットテスト（11テスト全通過）
- [x] チェックポイント保存

## Phase 6: 本物のAI分析エンジン実装
- [x] server/routers/aiAnalysis.ts - LLMを使ったリアルタイムAI市場分析ルーター
- [x] チャート・板情報・歩み値をテキスト化してLLMに渡す変換関数
- [x] 過去のシミュレーション成績・改善提案をコンテキストとしてLLMに渡す
- [x] client/src/components/AIAdvisorPanel.tsx - 新しいAIアドバイザーパネル（LLM搭載）
- [x] Home.tsxのAdvisorPanelをAIAdvisorPanelに置換
- [x] ルールベース診断（既存）とLLM分析を並列表示

## 今後の改善予定
- [ ] 実際のデイトレ開始（7月中旬）に向けた最終パラメータ調整
- [ ] 週次アルゴリズム改善の精度向上（金曜日の自動改善ロジック）
- [ ] 目標勝率80〜90%達成に向けたシミュレーション精度向上

## Phase 7: AI分析UI改善・取引ポイント明確化
- [x] AI分析の結論を「買い/売り/様子見」の一言＋理由3行以内に簡潔化（サーバー側プロンプト改修）
- [x] AI分析の応答速度を改善（max_tokens削減・thinking budget削減）
- [x] AIAdvisorPanelを「結論バッジ」を最上部に大きく表示するUIに改修
- [x] テクニカル指標スコアの「買うべき」表示を廃止し、シンプルなメーター表示のみに
- [x] ChartComponentの取引ポイントマーカー（B/S/W）を視認性高く改善
- [x] 取引ポイントの価格・時刻・理由をホバーで表示
- [x] ChartComponentとtypes.tsにWarn（警告）マーカー型を追加（buy|sell|warn）
- [x] 超大口売り崩し時にWマーカーをローソク足に自動付与
- [x] useRealtimeMarketData.tsのaddSignalToCandle関数をwarnに対応

## Phase 8: 実際の株価データ読み込み・チャート表示
- [x] server/routers/stockData.ts - Yahoo Finance APIから分足データを取得するtRPCエンドポイント
- [x] テクニカル指標（MA5/MA25/RSI/BB）をサーバー側で計算してシグナル付きで返す
- [x] Home.tsx - 「実際のチャート」ボタンをヘッダーに追加
- [x] 実際データモード時はYahoo Financeから取得したローソク足をChartComponentに表示
- [x] 実際データモード時はB/S/Wシグナルマーカーをチャート上に自動表示
- [x] 銀柄コード入力欄（デフォルト: 9984.T）と日付選択（デフォルト: 今日）
- [x] 板情報・歩み値はシミュレーションのまま（実際データは取得不可のため）

## Phase 9: 実際のYahoo Financeデータでレポート生成
- [x] server/realSimulation.ts - Yahoo Finance実データを使ったシミュレーションエンジン実装
- [x] 対象10銘柄のYahoo Financeティッカーシンボルマッピング（例: 9984 → 9984.T）
- [x] 実データ取得失敗時のフォールバック（架空データで代替）
- [x] scheduledHandlers.ts - 実データシミュレーションを呼び出すよう更新
- [x] レポート履歴ページに「実データ/架空データ」の区別をバッジで明示表示（一覧・詳細両方）
- [x] レポートに「実際の株価データを使用」と明記

## Phase 10: 実データシミュレーション確実動作（バグ修正）
- [x] 原因調査：6月1日レポートが架空データになった理由を特定（includeAdjustedClose:true のboolean型がAPIエラーを引き起こしていた）
- [x] realSimulation.ts のYahoo Finance API呼び出しロジックを修正・強化（includeAdjustedCloseパラメータを除去）
- [x] scheduledHandlers.ts のフォールバック条件を厳格化（実データ取得成否の詳細ログ追加）
- [x] drizzle/schema.ts に isRealData フィールドを追加してDB管理（dataSource文字列でDB保存）
- [x] 手動テスト：本日の実データで10銘柄シミュレーション実行・確認（7/10銘柄実データ、DB保存ID:1）
- [x] テスト更新・チェックポイント保存（11テスト全通過）

## Phase 11: 実際のチャートページのローソク足表示バグ修正
- [x] チャートコンポーネントのコードを調査してローソク足が描画されない原因を特定（RechartsのBarコンポーネントがheightをカスタムshapeに渡さないため）
- [x] ローソク足描画ロジックを修正してチャートを正常表示させる（Canvas APIベースの独自実装に書き換え）
- [x] テスト・チェックポイント保存

## Phase 12: デイリー検証レポートに買い/売りシグナル一覧を追加
- [ ] DBスキーマ・API・フロントエンドの現状を調査して必要な変更箇所を特定
- [ ] シミュレーション結果にシグナル一覧（時刻・価格・種別・理由）を保存するようにDB/APIを拡張
- [ ] レポート詳細ページで各銘柄の買い/売りタイミングを実際のチャートと同様の形式で表示
- [ ] テスト・チェックポイント保存
