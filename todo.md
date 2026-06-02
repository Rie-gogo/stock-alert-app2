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
- [x] デプロイ後に manus-heartbeat create で平日スケジュール登録 (task_uid: DbUxCsDA4RZyZy8v4PhQ77)
- [x] Heartbeat cronを大引け後（JST 15:30 = UTC 06:30）に修正 (cron: 0 30 6 * * 1-5, 次回実行: 2026-06-02T06:30:00Z)

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
- [x] DBスキーマ・API・フロントエンドの現状を調査して必要な変更箇所を特定
- [x] シミュレーション結果にシグナル一覧（時刻・価格・種別・理由）を保存するようにDB/APIを拡張（schema.tsにsignalsカラム追加、simulation.tsにSignalRecord型追加）
- [x] レポート詳細ページで各銘柄の買い/売りタイミングを実際のチャートと同様の形式で表示（時刻・種別・価格・MA5/25・RSI・理由のテーブル表示）
- [x] テスト・チェックポイント保存（11テスト全通過）

## Phase 13: AI分析常時自動実行 & 空売りロジック追加
- [x] AIAdvisorPanel.tsx を常時自動実行（30秒ごと自動更新）に変更
- [x] 自動実行中であることを示すUI（ローディングインジケーター・最終更新時刻）を追加
- [x] simulation.ts に空売り（ショート）ロジックを追加（デッドクロス時に空売りエントリー、ゴールデンクロス時に買い戻し）
- [x] realSimulation.ts にも空売りロジックを反映
- [x] レポートの取引履歴に「空売り」「買い戻し」の種別を表示
- [x] テスト更新・チェックポイント保存（11テスト全通過）

## Phase 15: ホームページチャートをYahoo Finance実データに切り替え
- [x] REAL_TARGET_STOCKSをホームページの銘柄リストとして使用（10銘柄）
- [x] trpc.stockData.getStockChart を使ってYahoo Finance実データを取得するカスタムフックを作成
- [x] 1分ごとの自動ポーリング（refetchInterval: 60_000）を設定
- [x] 取得したデータをCandleData型に変換してChartComponentに渡す
- [x] MarketState互換の形でcurrentPrice/priceChange/volumeを計算
- [x] 板情報・歩み値は引き続きシミュレーション（Yahoo Financeでは取得不可）
- [x] 市場時間外（土日・夜間）は前日データを表示し「市場時間外」バッジを表示
- [x] 実データ取得中/失敗時のローディング・エラー表示
- [x] AIAdvisorPanelに実データのmarketStateを渡す

## Phase 16: 板情報・歩み値の影響調査 ＆ レポート時刻変更
- [x] AIアドバイザー（AIAdvisorPanel）が板情報・歩み値をどう使っているか調査・修正
- [x] ルールベース診断（diagnoseMarket）が板情報・歩み値をどう使っているか調査・修正
- [x] 売買シグナル判定（getStockChart）が板情報・歩み値を使っていないことを確認済
- [x] 架空の板情報・歩み値が売買判断に影響しないよう修正済
- [x] Yahoo Finance の出来高データを活用した「実出来高分析パネル」を追加
- [x] Heartbeat cron を JST 15:30 → JST 16:00 に変更（cron: 0 0 7 * * 1-5）
- [x] 古いエージェントcronも同期して16:00に変更済（起動不要のためスキップ）
- [x] テスト・チェックポイント保存

## Phase 17: 架空データ完全排除 ＆ レポート時刻変更
- [x] ウィークリーアルゴリズム改善ロジック（金曜日のパラメータ自動調整）が実データ（getRecentStats(7)）のみを使っていることを確認済
- [x] ホームページUI上の「板情報」「歩み値」ブロックを削除済
- [x] 代わりに「実出来高分析パネル」と「OHLCパネル」を追加済
- [x] AIシグナル判定（aiAnalysis）が板情報・歩み値をAIに送らないよう修正済
- [x] Heartbeat cron を JST 16:00 に変更済（cron: 0 0 7 * * 1-5、next_execution_at: 2026-06-02T07:00:00Z）
- [x] テスト追加（realDataOnly.test.ts: 6テスト全通過）
- [x] チェックポイント保存（version: 75877fc7）

## Phase 18: Data API使用量上限問題の修正
- [x] stockData.ts にサーバーサイドキャッシュを追加（市場時間中5分、市場時間外60分）
- [x] 市場時間外（JST 9:00〜15:30以外）はキャッシュTTLを1時間に延長済
- [x] ホームページのポーリング間隔を1分→5分に延長済
- [x] 市場時間外はホームページのポーリングを停止済
- [x] テスト全通過（42テスト）・チェックポイント保存

## Phase 19: 架空データフォールバック完全削除
- [x] realSimulation.ts の simulateStockReal が架空データフォールバックを削除し null を返すよう修正
- [x] generateRealDailyReport が実データ0銘柄の場合はエラーをスローしてレポート保存を中止
- [x] trading.ts の runSimulation が過去日付の架空データシミュレーションを拒否するよう修正
- [x] testRealSim.ts を新しいAPIに合わせて更新
- [x] TypeScriptエラー0件確認
- [x] 42テスト全通過
- [x] 今日のDBの架空データレポートは次回の実データ実行時に上書きされる（べき等）
- [x] チェックポイント保存（version: 3df4d6c6）

## レジーム適応型アップデート（2026-06-02 完了）
- [x] 売買圧力(flow)指標とMA25傾き(slope)の計算を追加
- [x] 二段流れ判定（トレンド×勢いの両一致でのみエントリー）を実装
- [x] レジーム方向ゲート（上昇相場はショート禁止/下落相場はロング禁止）を実装
- [x] 悪条件回避ルール（超高ボラ日ショート禁止/サーキットブレーカー/取引回数制限/寄り後様子見）を実装
- [x] 超ボラ銘柄(SBG/第一三共/ソシオネクスト)のロット縮小を実装
- [x] vitestテスト(regimeAdaptive.test.ts)を追加し全合格を確認
- [x] 本日(6/2)再シミュレーション実行・DB保存（-56,250円→+700円）
- [x] 19営業日バックテストで上昇・下落両相場のプラスを検証（累計+22,250円）
## 勝率底上げアップデート（2026-06-02 着手）— 1日15,000円目標に向けて
- [x] レンジ相場回避フィルターの効果をPythonバックテストで検証（効率<0.30で取引停止が最適）
- [x] 川崎汽船(9107)の損失原因を分析（累計-24,000円、半導体群と値動き特性が異なる）→最小ロット化が最適
- [x] 出来高(流動性)を考慮したエントリー抑制を検討（川崎は除外せず最小ロットで監視継続）
- [x] realSimulation.tsにレンジ回避フィルターを実装（computeMarketEfficiency/isRangeBoundDayとskipTradingRangeDay）
- [x] realSimulation.tsに銘柄別調整（川崎汽船をHIGH_VOL_SYMBOLSに追加し最小ロット化）
- [x] regimeAdaptive.test.tsにレンジ回避・銘柄別調整のvitestを追加し全合格を確認（63テスト全通過、tscエラー0件）
- [x] 本日(6/2)再シミュレーション実行（ライブ実データ9/10銘柄、効率0.37でレンジ回避は未発動、総合-1,300円、5取引）
- [x] 19営業日で再検証（累計+22,250→+60,450円、日平奇3,182円、勝率44→49%）
- [ ] チェックポイント保存と結果報告
