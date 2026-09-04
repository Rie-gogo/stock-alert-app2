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
- [x] チェックポイント保存（version: d3fea361）と結果報告

## 銘柄拡大アップデート（2026-06-02 着手）— 10→20銘柄で取引機会を分散
- [x] 出来高(売買代金)上位の追加候補10銘柄を選定（業種分散: 半導体/電子部品/銀行/自動車/非鉄）
- [x] 候補10銘柄のYahoo Finance分足データ取得可能性を検証（10/10成功、各約320本）
- [x] shared/stocks.tsを20銘柄に拡張（ログ文言の/10も修正）
- [x] 共通5営業日で比較（10銘柄日平均+7,980円→、20銘柄+32,080円）し、低相性追加5銘柄（6723/5803/8316/7203/5016）を最小ロット化→日平均+44,900円に最適化
- [x] 関連テスト（realMarketData.test.ts）を共有定義参照に更新し全合格確認（64テスト全通過、tscエラー0件）
- [x] 20銘柄で本日再シミュレーション実行（最適化後+10,000円、最小ロット化が損失を抑制）・66テスト全通過
- [x] チェックポイント保存（version: 38e94239）と結果報告

## ハイブリッド運用アップデート（2026-06-02 着手）— 同時保有3銘柄制限＋業種分散
- [x] shared/stocks.ts に各銘柄の業種(sector)を定義（MAX_CONCURRENT=3, MAX_PER_SECTOR=2も追加）
- [x] portfolio.ts を新設し同時保有上限(3)と業種分散上限(同業種最大2)を実装（applyPortfolioRules）
- [x] 「本日の推奨銘柄トップ3」を算出するロジックを追加（rankRecommendedSymbolsをgenerateRealDailyReportに組込）
- [x] 推奨銘柄を「過去レポート（直近の調子・勝率）」で事前算出する方式に作り直し（recommendForNextDay）
- [x] 過去レポート集計関数 getSymbolPerformanceHistory を db.ts に追加（excludeDateで後知恵回避）
- [x] 事前推奨トップ3を tRPC trading.getRecommendations で返す（フロント表示は次）
- [x] portfolio.test.ts（applyPortfolioRules/rankRecommendedSymbols/recommendForNextDay）の vitest を追加し全合格（77テスト・tsc 0件）
- [x] RecommendationPanel.tsxを作成しHome.tsx右サイドバーに「本日の推奨銘柄トップ3」を表示（クリックで監視銘柄切替）
- [x] 全テスト再実行（77テスト全通過、tscエラー0件）
- [x] チェックポイント保存（version: acc9d361）・推奨銘柄パネルのブラウザ動作確認済
- [x] 明日のリアルタイム実践シミュレーション手順を案内
## 仮想売買（ペーパートレード）機能（2026-06-02 着手）
- [x] drizzle/schema.ts に paperTrades テーブルを追加
- [x] pnpm db:push でマイグレーション実行（paper_tradesテーブル作成確認済）
- [x] server/db.ts に createPaperTrade / closePaperTrade / getPaperTrades / getOpenPaperTradeCount / deletePaperTrade ヘルパーを追加
- [x] server/routers/trading.ts に openPaperTrade / closePaperTrade / getPaperTrades / deletePaperTrade 手続きを追加（同時保有3銘柄制限をサーバー側でも検証）
- [x] Home.tsx に「仮買い／仮売り」ボタンを追加（現在の監視銘柄・現在値を自動取得）
- [x] PaperTradePanel.tsx を作成（オープン中ポジション + 決済済み履歴 + 累計損益）
- [x] 同時保有3銘柄制限のUIフィードバック
- [x] paperTrade の vitest を追加して全通過（8ファイル84テスト pass）
- [x] チェックポイント保存・ユーザー案内
- [x] 仮想売買ボタンをヘッダー右上に設置（ダイアログで開く・保有件数バッジ付き、右サイドバーの旧パネルは撤去）

## 全銘柄バックグラウンド監視＋シグナル通知（案1）
- [x] server/routers/stockData.ts に複数銘柄一括スキャン手続き getSignalScan を追加
- [x] extractLatestSignal 純粋関数と scanSymbol ヘルパーを追加（既存 detectSignals を再利用）
- [x] フロントに SignalMonitorBoard コンポーネントを追加（推奨3銘柄＋選択銘柄の現在シグナル・現在値・RSIを常時表示）
- [x] シグナル発生時に通知（トースト・音・件数バッジ）を表示、通知ON/OFF切替付き
- [x] 通知/ボードから1クリックで銘柄切替＋仮売買ダイアログを開く導線
- [x] extractLatestSignal の vitest を追加（7テスト、合計91テスト pass）
- [x] 動作確認・チェックポイント保存・ユーザー報告

## 寄り付き後チャート未更新バグ修正（2026-06-03）
- [x] cacheTtlFor を追加し、寄り付き前後（8:50〜9:15）は10秒TTLに短縮
- [x] 市場時間外キャッシュを60分→15分、場中を5分→ログと1分に短縮（フロントポーリングも5分→01分、寄付帯は20秒）
- [x] getCachedOrFetch 経由で getStockChart とスキャン両方に反映、staleTimeも4分→15秒に短縮
- [x] cacheTtlFor のユニットテストを追加（12テスト、合計103テスト pass）
- [x] 動作確認・チェックポイント保存・報告

## 寄り付き直後 nullローソク足エラー修正（2026-06-03）
- [x] buildCandlesFromQuotes 共通関数を作成し、close=nullでもopen/前足closeで補完して足を残す
- [x] getStockChart と scanSymbol 両方を共通関数に置き換え
- [x] 補完ロジックの vitest を追加（寄り付き直後の薄いデータでもエラーにならない）
- [x] 全テスト pass・動作確認・チェックポイント保存・報告

## チャート全滅 真因修正: 1分足→5分足（2026-06-03）
- [x] データAPIは interval=1m を返さない（全range 0件）。interval=5m / range=5d なら取得可と判明
- [x] フロント useRealMarketData の取得interval/rangeを 5m/5d に変更
- [x] getStockChart デフォルトrangeを5dに、scanSymbolも5m/5dに変更
- [x] UIの「1分足」表記を「5分足」に修正
- [x] スキャンのレート制限対策（並列度を1に低減、銘柄間に350msディレイ＋最大2回リトライ）
- [x] 関連テスト更新・全テストpass・動作確認・チェックポイント保存・報告

## 1分足取得へ再切替（2026-06-03 ユーザー要望）
- [x] データAPIの interval=1m を再検証 → 1m/1d=15本, 1m/5d=1577本で取得可能と確認（前回は寄付直後の空データで誤判定）
- [x] getStockChart デフォルトを 1m/5d に変更、scanSymbol も 1m/5d に変更
- [x] フロント useRealMarketData を 1m/5d に変更
- [x] UIの「5分足」表記を「1分足」に戻す
- [x] 型チェック・全109テストpass・動作確認・チェックポイント保存

## シグナル判定ロジックの精度向上（2026-06-03 ユーザー要望: 誤シグナル抑制・多指標確認）
- [x] 共通の確認フィルタ関数を作成（下記「完了」セクションで実装済）
- [x] 画面のシグナル監視ボード（detectSignals）に確認フィルタを適用し、流れに逆らう弱いシグナルを抑制（実装済）
- [x] シグナルに信頼度（strong / medium / weak）を付与（実装済）
- [x] 出来高急増（直近平均比）を確認条件に追加（実装済）
- [x] 確認フィルタの vitest を追加（21テスト、実装済）
- [x] フロントUIで信頼度バッジを表示（実装済）
- [x] 全テスト pass・型エラー0・動作確認・チェックポイント保存・報告（完了済）


## シグナル判定ロジックの精度向上（2026-06-03 完了）

- [x] 確認フィルタの共通純粋関数 server/signalConfirmation.ts を作成（出来高裏付け・トレンド方向一致・モメンタム一致）
- [x] シグナルに信頼度（strong/medium/weak）を付与、weakは通知抑制
- [x] 画面側 detectSignals に確認フィルタを組み込み（誤シグナル抑制）
- [x] ScannedSignal / extractLatestSignal に confidence を引き継ぎ
- [x] フロント SignalMonitorBoard に信頼度バッジ表示・通知トーストに信頼度反映
- [x] バックテスト realSimulation のロング/ショートエントリーに出来高裏付けゲート追加
- [x] signalConfirmation の vitest を追加（21テスト）
- [x] 型チェック0件・全130テスト通過・ブラウザ確認・チェックポイント保存


## 失敗箇所の調査と対策（2026-06-03 着手）— 1日15,000円以上を目指す

- [x] 直近レポートの取引履歴・シグナルをDBから抽出し、損益を銘柄/時間帯/シグナル種別/レジーム別に集計（analysis/backtestAnalyze.ts、by_symbol/by_reason/by_hour/daily CSV出力）
- [x] 損失パターンを特定（デッドクロス即決済8件全敗-43,200円が主因、損切り設定が1.5%のまま効いていなかった）
- [x] 診断結果に基づく具体的な戦略修正を設計・実装（デッドクロス即決済廃止＋トレイリング利確＋建値ストップ＋押し目買い＋損切り2.0%最適化）
- [x] 複数営業日でバックテスト再検証（5営業日で日平均+15,380円、目標15,000円達成）、テスト更新（strategyImprovement.test.ts 7件、全137通過）
- [x] チェックポイント保存（version: 03f28e8d）・結果報告

## 失敗箇所調査＆損益最適化アップデート（2026-06-03 完了）— 1日15,000円目標
- [x] 5営業日バックテスト解析スクリプト（analysis/backtestAnalyze.ts）で失敗箇所を特定
- [x] 失敗原因1: デッドクロス即決済が8件全敗(-43,200円)・大半が-0.1〜0.3%の微損（横ばい往復ビンタ）
- [x] 対策1: ロングのデッドクロス即決済を廃止し、損切り/同値/トレイリングに委譲
- [x] 押し目買いシグナル追加（上昇トレンド中のRSI低下＋MA25近辺の押し目を拾う）
- [x] トレイリング利確を実装（含み益+1%超でピークから0.5%下落で利確、利を伸ばす）
- [x] 建値ストップを実装（含み益+0.5%超で損切りを建値に引き上げ）
- [x] 失敗原因2: stopLossPercentデフォルトが1.5のままで損切りが意図通り効いていなかった
- [x] 対策2: 損切り幅を一括スイープ（analysis/paramSweep.ts、0.8/1.0/1.2/1.5/2.0%）で最適化
- [x] 結果: 2.0%が最良（5日合計+76,900円、日平均+15,380円、勝率55%）で目標達成
- [x] generateRealDailyReport/simulateStockReal の stopLoss 既定値を 2.0 に統一
- [x] 最大取引回数3→4、ウォームアップ15→10本に調整（取引機会の確保）
- [x] 戦略改善の回帰テスト追加（strategyImprovement.test.ts、7件）→ 全137テスト通過・tscエラー0件
- [x] サーバー正常動作・UI表示確認


## 戦略改善（空売り精度向上＋12時台抑制・2026-06-03）
- [x] 現状の空売り（ショート）エントリー条件・時間帯判定を確認し弱点を特定（デッドクロス単独の往復ビンタ・12時台フィルタ無し）
- [x] 空売りエントリーの精度を上げる（下落トレンド+RSI>=55の戻り+MA25近辺の戻り売り厳選、デッドクロス単独廃止）
- [x] 12時台（昼休み前後）のエントリーを抑制するフィルタを追加（SUPPRESS_ENTRY_HOURS、ロング・ショート両方）
- [x] トレイリング利確をベースに、改善後ロジックでバックテスト再検証（日平均+5,040→+21,860円、勝率57→80%）
- [x] 型チェック0件・vitest追加（6件）・全143テスト通過を確認
- [x] チェックポイント保存・結果報告
- [x] デイリーストップ／調子の良い銘柄への資金配分の進め方を提示（①への回答）


## デイリーストップ＋資金配分＋下落相場検証（2026-06-03 完了）
- [x] 現状のポートフォリオ制御（applyPortfolioRules）・サーキットブレーカー・固定ロット配分を確認
- [x] A: デイリーストップ実装（口座全体の当日確定損益が下限に達したら新規停止／利益目標到達で利益保護停止）
- [x] A検証: 停止ライン（-1万/-1.5万/-2万、利益保護+1.5万/+2万/+3万）を一括スイープし最適値を決定
- [x] B: 調子の良い銘柄への動的資金配分（寄り後の勢い＝出来高・値動きでロットを厚薄）を実装
- [x] B検証: 資金配分ありのバックテストで改善前後を比較
- [x] 下落相場での通用性検証（過去の下落局面データで再検証、ロング/ショート別の損益）
- [x] 型チェック0件・vitest追加・全テスト通過を確認
- [x] チェックポイント保存・結果報告（改善効果＋下落相場耐性）

## 下落相場耐性の検証と空売り改善（2026-06-03 完了）
- [x] サーバービルドエラー（portfolio.ts:247の古いesbuildキャッシュ）を再起動で解消、型0件・本番ビルド成功を確認
- [x] 5分足の過去20営業日から「日中ずっと下げた下落日」を抽出（5/14,5/15,5/19,5/27）
- [x] 本番ロジックを5分足スケールに圧縮した検証シミュレータ（analysis/downDayValidator.ts）を作成
- [x] 下落日で取引ゼロ＝空売りが発火しない問題を発見、条件別診断（analysis/downDayDiag.ts）で原因特定（下落相場はRSIが戻らず戻り売り条件RSI>=55がほぼ不成立）
- [x] 空売りに「下落相場ブレイク売り」経路を追加（mktDown必須＋下落トレンド継続＋MA25割れ＋flow売り優勢＋RSI>35）
- [x] 改善後の下落日検証: 全4日で空売り発火（22〜31件）、5/14+29,449円/5/27+19,726円（採用後）、5/15・5/19はデイリーストップが発動し損失を-2,638/-258円に圧縮
- [x] 上昇相場リグレッション: 直近5営業日 日平均+22,520円・勝率66.7%を維持（ブレイク売りはmktDown限定のため上昇相場では非発火）
- [x] ブレイク売りの回帰テスト4件を追加、全147テスト通過・型0件を確認
- [x] チェックポイント保存・結果報告

## A: デイリーストップ最適化 ＋ B: 動的資金配分（2026-06-03 完了）
- [x] A: 停止ライン(-1万/-1.5万/-2万)×利益保護(なし/+1.5万/+2万/+3万)を上昇・下落両相場でスイープ
- [x] A: 両相場でバランスの良い最適設定を決定し、本番デフォルト(DEFAULT_PORTFOLIO_CONFIG)に適用（-1.5万/利益保護なし）
- [x] A: デイリーストップ設定の回帰テストを追加（4件）
- [x] B: 勢い(実績スコア)ベースで調子の良い銘柄にロットを厚く配分するロジックを実装
- [x] B: 資金配分ありで上昇相場をwalk-forwardバックテストし改善前後を比較（日平均+440円・負け日圧縮）
- [x] 型チェック0件・全テスト通過を確認（156件）
- [x] チェックポイント保存・A/B成果の報告

### A: デイリーストップ最適化（完了 2026-06-03）
- [x] 停止ライン×利益保護を上昇相場(5日)・下落相場(4日)でスイープ（analysis/dailyStopSweepBoth.ts）
- [x] 検証結果: 停止-1.5万/利益保護なし が最適 → 現状設定と一致のため変更不要
- [x] DEFAULT_PORTFOLIO_CONFIG に検証根拠コメントを明記
- [x] デイリーストップ・利益保護の回帰テスト4件追加（portfolio.test.ts）

### B: 動的資金配分（完了 2026-06-03）
- [x] computeLotMultiplier(history) を portfolio.ts に追加（0.5〜1.5倍、実績薄い銘柄は1.0固定）
- [x] simulateStockReal に lotMultiplier 引数を追加（既定1.0で後方互換、上限ロット6割クランプ）
- [x] recommendForNextDay に lotMultiplier フィールド＋推奨理由ラベルを追加
- [x] walk-forward バックテスト（analysis/lotAllocationBacktest.ts）: 上昇相場で日平均 +21,680→+22,120円（+440円）、6/2負け日は -17,800→-16,100円と損失を浅く
- [x] computeLotMultiplier の単体テスト5件追加
- [x] 全156テスト通過・型0エラー・本番ビルド成功


## 本日損益レポート＋毎平日運用（2026-06-03 着手）
- [ ] 本日(6/3)の全銘柄1分足を取得し、本番ロジックで当日損益をシミュレート
- [ ] 当日損益レポート（銘柄別内訳・勝率・デイリーストップ状況・空売り/ロング別）を作成
- [ ] 改善点を検証（負け要因・取りこぼし・レンジ/下落局面の挙動）
- [ ] 本日レポートと改善点をユーザーに報告（毎平日運用の進め方も提示）

## 本日損益レポート＋改善検証（2026-06-03 完了）
- [x] 本日(6/3)の全銘柄1分足を取得し当日損益をシミュレート（+17,600円・勝率100%）
- [x] 当日損益レポート（銘柄別・決済理由別・時間帯別）を作成
- [x] 改善検証: 条件成立は豊富だが取引3件→同時保有枠スイープ(3/4/5/6)を実施
- [x] 結論: 現状の同時3銘柄/同業種2が上昇・下落両相場で最良（枠拡大は無益or有害）と確認
- [x] 最終レポート(analysis/daily/2026-06-03/REPORT_FINAL.md)を作成

## 毎平日自動レポートの検証・修正（2026-06-03）
- [x] cronジョブ登録状況を確認（daily-simulation: 登録済・有効）
- [x] 6/2自動実行が架空データにフォールバックしていた問題を調査（当時の旧コードが原因と特定）
- [x] 現在のデプロイ済み本番が実データを取得できることを確認（公開URLで20/20銘柄 実データ取得成功）
- [x] cron実行時刻を JST16:00 → JST17:00 (UTC08:00) に後ろ倒し（引け15:30から1.5h後で全1分足確定）
- [ ] 引け後(15:30以降)の確定実データで本日6/3レポートを作り直す
- [ ] 確定レポートと自動化の状態をユーザーに報告

## 監視ボードの下落相場ロング誤判定の修正（2026-06-03 緊急・着手）
- [ ] detectSignals が日足レベルの大トレンドを無視し1分足クロスだけで買い/売り判定している問題を確認（完了）
- [x] 大局トレンド（MA25の傾き・当日騰落率）を判定するレジームフィルタを追加（intradayRegime.ts）
- [x] 大局が明確な下落の時はロング（買い）シグナルを抑制し、ショート（戻り売り）を優先
- [x] 大局が明確な上昇の時はショートを抑制（既存方針と整合）
- [x] detectSignals の回帰テストを追加（下落相場でゴールデンクロスが出ても買い表示しない）
- [x] 型チェック0件・全テスト177件通過・ビルド成功を確認
- [x] チェックポイント保存・ユーザー報告

## レジーム修正が勝率に悪影響していないか検証（2026-06-03 着手）
- [x] 監視ボードの修正がバックテスト側(realSimulation)に影響するか切り分け（realSimulationはisVolumeConfirmed/trailingAvgVolumeのみ使用、今回未変更）
- [x] 既存バックテスト(backtest20d.ts)の場所と実行方法を確認
- [x] 修正前後でバックテストを実行比較（同データなら完全一致を実証、差は実データ揺らぎが原因）
- [x] 勝率への悪影響なしを確認、検証用に戻したコードを修正後へ復元し全177テスト再通過
- [ ] 検証結果をユーザーに報告

## J-Quants 1分足60日データで改善分析（2026-06-03）

- [x] J-Quants APIキー検証・1分足エンドポイント確認
- [x] 20銘柄×60営業日(3〜5月)の1分足取得（jq_fetch_minute.ts）
- [x] 既存simulateStockRealで60日バックテスト（jq_backtest.ts）→合計-58,650円・勝率37.2%・15k達成14/60日
- [ ] 売買理由別・時間帯別・銘柄別・地合い別に勝敗要因を分解
- [ ] 負け要因を抑える改善策を設計
- [ ] 同一データでビフォーアフター再検証
- [ ] 有効ならアプリ本体に反映しテスト・チェックポイント保存
- [ ] 改善結果を可視化してユーザーに報告

## Phase 22: cronスケジュール変更 & 10銘柄シミュレーション実装（2026-06-03）
- [x] realSimulation.ts に SIMULATION_STOCKS（10銘柄専用リスト）を追加（shared/stocks.tsは変更しない）
- [x] generateRealDailyReport が SIMULATION_STOCKS の10銘柄のみを使うよう変更
- [x] cronスケジュールを UTC 08:00 → UTC 07:00（JST 16:00）に変更（next_execution_at: 2026-06-04T07:00:00Z）
- [x] テスト更新（銘柄数変更に伴うテスト修正）→既存177テスト全通過
- [x] pnpm vitest run 全通過確認（177テスト）
- [x] pnpm build 成功確認
- [x] チェックポイント保存（version: 13a142e4）

## Phase 23: ショートカバーロジック改善（改善分析）
- [x] GCカバー厳格化: 含み益あり かつ RSI>=40 の場合のみGCでカバー（SHORT_GC_COVER_RSI_MIN=40）
- [x] GCクールダウン: GC後15本はショートエントリー禁止（SHORT_GC_COOLDOWN_BARS=15）
- [x] 最大保有時間: ショート45本（約90分）超過で強制手仕まい（SHORT_MAX_HOLD_BARS=45）
- [x] J-Quants 60営業日バックテストで再検証（総損益: -60,450円 → -57,300円、中央値: -7,600円/日 → -2,900円/日）
- [x] 177テスト全通過確認
- [x] チェックポイント保存（version: 6a56dde2）

## Phase 24: A/B/C改善スイープ & ショート損切り最適化

- [x] SimOverrides インターフェースを realSimulation.ts に追加（shortMaxMaDeviation / shortRequiresMktDown / shortStopLossPercent）
- [x] A/B/C全組み合わせ8パターンをJ-Quants 60営業日でバックテスト（analysis/abcSweep.ts）
  - 結果: 改善A（MA乖離率制限）・改善B（下落相場限定）は効果なし（既存条件と重複）
  - 改善C（損切り縮小）のみ有効: -57,300円 → +2,700円
- [x] ショート損切り幅を0.5%〜3.0%でスイープ（analysis/shortStopSweep.ts）
  - 最良: 0.55% → +122,250円
- [x] ショート損切り幅を0.3%〜0.9%で細かくスイープ（analysis/shortStopFineSweep.ts）
  - 最良確定: 0.55% → +122,250円（日平均+2,038円、最悪日-72,400円）
- [x] SHORT_STOP_LOSS_PERCENT = 0.55 を realSimulation.ts に追加・エクスポート
- [x] generateRealDailyReport でショート専用損切りを適用
- [x] jq_backtest.ts を SHORT_STOP_LOSS_PERCENT 使用に更新
- [x] 最終バックテスト確認: 総損益 +122,250円（改善前 -57,300円、+179,550円改善）
- [x] 177テスト全通過確認
- [x] チェックポイント保存（version: 7425f657）

## Phase 25: 最悪日分析 & 損失軽減改善

- [x] 最悪日（3/9・4/27）のトレード内訳を詳細分析 → 4/27は昕休みギャップダウンが主因
- [x] 改善仮説を立ててバックテストで検証 → 11:20全手仕まいが最良（+246,850円）
- [x] 最良パラメータを realSimulation.ts に反映 → LUNCH_EXIT_ALL_MINUTE="11:20"
- [x] 177テスト全通過確認
- [x] チェックポイント保存（version: b6fe1d35）

## Phase 26: 大損失日分析 & 損切り上限値確認

- [x] 損切り上限値（CIRCUIT_BREAKER等）の現状をコードで確認 → 日次デイリーストップは設定済み、銘柄別損切りは個別設定なし
- [x] 大損失日（3/23・3/30・4/28・4/30）のトレード内訳を詳細分析 → 3/30・4/28・4/30はPhase25改善済み、最悪日は5/19の-55,700円
- [x] 銘柄別損益分析 → 7011(-50,500円)・8306(-42,550円)・6758(-30,800円)が損失超過
- [x] 銘柄別ロットスイープ → 7011+8306+6758全て極小ロットが最良（+370,700円）
- [x] HIGH_VOL_SYMBOLSに7011/8306/6758を追加
- [x] regimeAdaptive.test.tsのテストを更新（1テスト追加）→178テスト全通過
- [x] チェックポイント保存（version: fb1f5ba2）

## Phase 27: ①②③改善案の検証と採用

- [x] 現状コード確認（ショート条件・損切り連発・相場判断）
- [x] ①下落相場限定ショート → 効果なし（regimeAllowShortが既に上昇相場で禁止済み）
- [x] ②ショート損切り連発対策 → 効果なし（損切り後の再エントリー機会自体が少ない）
- [x] ③寄り付きバイアスゲート → 大幅悪化（-194,450円・不採用）
- [x] GCクールダウンの正しい実装（isGoldenCross時にセット）→ +13,500円自然改善
- [x] shortStopCooldownBarsをSimOverridesに追加（将来のスイープ用）
- [x] 178テスト全通過確認
- [x] チェックポイント保存（version: b687d291）

## Phase 28: ロング損切り幅・最悪日分析・午後セッション戦略の検証

- [x] ロング損切り幅を0.3%〜3.0%でスイープ検証（analysis/longStopSweep.ts）
- [x] 最悪日（5/14・3/23・4/24）のトレード内訳を詳細分析
- [x] 午後セッション（12:30〜15:30）再参入戦略の検証（午後再参入は-78,350円悪化で不採用）
- [x] 全改善案の組み合わせを比較し最良パターンを特定（午後エントリー禁止+ショート0.55%+昂休み前11:20全決済）
- [x] 最良パラメータをrealSimulation.tsに反映（SUPPRESS_AFTERNOON_ENTRY=true、LONG_STOP_LOSS_PERCENT=2.0）
- [x] 178テスト全通過確認
- [x] チェックポイント保存（version: f3e3a5f3）

## Phase 29: マイナス取引の全件洗い出しと対策（2026-06-03）

- [x] J-Quants 60営業日の全マイナス取引を抽出・多軸集計（analysis/losingTradesAnalysis.ts）
- [x] 共通パターン特定: 空売り損切り16件/-134,150円、昂休み前強制決済ロング9件/-62,800円、損失幅-0.55%〜-1.0%が最大損失源
- [x] 対策をスイープ検証: ショート損切り0.50%が最良(+9,700円)、時間帯フィルターは逆効果で不採用
- [x] 有効な対策をrealSimulation.tsに反映（SHORT_STOP_LOSS_PERCENT: 0.55% → 0.50%）
- [x] 178テスト全通過確認
- [x] チェックポイント保存

## Phase 30: マイナス取引の銘柄特性分析（2026-06-03）

- [x] マイナス取引の銘柄特性を多軸分析（出来高急増率・ギャップアップ幅・セクター・日中ボラ・損切り種別）
- [x] 共通パターンを特定し対策をスイープ検証（16シナリオ検証）
- [x] 有効な対策をrealSimulation.tsに反映（SIMULATION_STOCKSから太陽誘電を除外、さくらインターネットを追加）
- [x] 178テスト全通過確認
- [x] チェックポイント保存

## Phase 31: 昼休み前・引け値強制決済の損失対策（2026-06-03）

- [x] 昼休み前強制決済（9件/-62,800円）と引け値強制決済の詳細分析（引け値強制決済は午後エントリー禁止により完全解消済みと判明）
- [x] エントリー時刻・保有時間・最大浮き益・銘柄別の内訳を抽出（決済理由別集計を正しく再生成）
- [x] 対策候補をスイープ検証（13シナリオ）：全対策が逆効果または差分ゼロで現状維持
- [x] 有効な対策なし（全対策が逆効果または差分ゼロ）→現状維持
- [x] チェックポイント保存（version: 16f3bc97）

## Phase 32: 空売り損切り17件の詳細分析と回避策（2026-06-03）

- [x] 空売り損切り17件のエントリー直前5〜10本の値動き・出来高・テクニカル指標を全件抽出
- [x] 共通パターンを特定し回避フィルターを設計・スイープ検証（26シナリオ）
- [x] 有効なフィルターをrealSimulation.tsに反映（SHORT_MAX_HOLD_BARS: 45本→60本、+2,700円）
- [x] 178テスト全通過確認
- [x] チェックポイント保存

## Phase 33: 銘柄入れ替えスイープ（2026-06-03）

- [x] 現在のSIMULATION_STOCKS全銘柄の損益・勝率・損失額を再集計し低パフォーマンス銘柄を特定
- [x] TARGET_STOCKSから候補銘柄を選定し入れ替えスイープ検証（全入れ替えが逆効果または差分ゼロ）
- [x] 現在の銘柄構成が最適で変更不要と確認
- [x] チェックポイント保存（version: f350018c）

## Phase 34: 半年バックテスト拡大（2026-06-03）

- [x] J-Quantsから半年分（約130営業日）のデータを取得
- [x] 半年バックテストを実行し60日結果と比較分析
- [x] 銘柄別・月別・決済理由別の詳細集計
- [ ] 総合レポートをユーザーに報告

## Phase 35: チャートシグナルのADXフィルター＋確認バーフィルター追加（2026-06-04）

- [x] server/intradayRegime.ts に calcATR(), calcADX(), isAdxTrending() を追加（ADX_PERIOD=14, ADX_TREND_THRESHOLD=20）
- [x] server/routers/stockData.ts の detectSignals() に ADX フィルターを追加（横ばい相場でMAクロス・戻り売りシグナルを抑制）
- [x] server/routers/stockData.ts の detectSignals() に確認バーフィルターを追加（GC後にclose<MA5、DC後にclose>MA5の場合はダマシとして抑制）
- [x] TypeScript コンパイル 0 エラー確認
- [x] 全 180 テスト通過確認
- [x] チェックポイント保存

## Phase 36: スケジュール修正（JST 8:00 前営業日データ取得）

- [x] scheduledHandlers.ts: getPreviousBusinessDay() ヘルパー追加
- [x] dailySimulationHandler: new Date() → getPreviousBusinessDay() に変更
- [x] dayOfWeek 参照を targetDate.getUTCDay() に修正
- [x] realSimulation.ts: fetchRealCandles/fetchRealCandlesOnce に targetDateStr 引数追加
- [x] generateRealDailyReport: fetchRealCandles に dateStr を渡すよう修正
- [x] 全180テスト通過確認
- [x] チェックポイント保存・デプロイ（version: 760cd965）
- [x] ハートビートスケジュールを UTC 23:00（JST 8:00）に変更（next: 2026-06-05T23:00:00Z）

## Phase 37: デイトレード戦略シグナル追加（VWAP・ダウ理論・ローソク足パターン）

- [ ] 現行ロジックをベースラインとしてファイルに保存
- [ ] VWAP計算ヘルパーを共通モジュール（server/vwap.ts）に実装
- [ ] detectSignals()にVWAPクロス・ダウ理論高値/安値更新・長い上ヒゲ・はらみ線・大台割れシグナルを追加
- [ ] CandleWithSignalインターフェースにvwapフィールドを追加
- [ ] RealCandleインターフェースにvwapフィールドを追加
- [ ] simulateStockReal()にVWAPクロスをエントリー条件として追加
- [ ] 5営業日バックテスト：元データ vs 新ロジックを比較
- [ ] 損益比較レポートを作成
- [ ] テスト全件通過確認
- [x] チェックポイント保存

## Phase 37: デイトレード戦略シグナル追加（VWAP・ローソク足パターン）

- [x] ベースライン保存（server/realSimulation.ts.baseline, server/routers/stockData.ts.baseline）
- [x] VWAP計算ヘルパー作成（server/vwap.ts）
- [x] detectSignals()にVWAPクロス・長い上下ヒゲ・はらみ線シグナルを追加
- [x] simulateStockReal()にVWAPクロス・長い上下ヒゲ・はらみ線エントリー条件を追加
- [x] backtestAnalyze.tsのRealCandle/toCandlesをVWAP対応に更新
- [x] 5営業日バックテスト実施（ベースライン+32,900円 vs 新ロジック+51,500円、+18,600円改善）
- [x] 比較レポート作成（analysis/REPORT_5DAY_NEWLOGIC_20260605.md）
- [x] 全180テスト通過確認

## Phase 38: VWAP反発 + ダブルトップ/ダブルボトム シグナル追加

- [ ] VWAP反発シグナルをdetectSignalsに実装（VWAPまで下落→反発確認→買いシグナル）
- [ ] ダブルトップ/ダブルボトム検出ロジックを実装（過去50本で2つの山/谷を検出）
- [ ] detectSignalsにダブルトップ/ボトムシグナルを追加
- [ ] simulateStockRealにダブルトップ/ボトムエントリー条件を追加
- [ ] 5営業日バックテストで効果検証・レポート作成
- [ ] チェックポイント保存・デプロイ

## Phase 39: 三尊（ヘッド&ショルダー）/逆三尊シグナル追加

- [x] vwap.ts に detectHeadAndShoulders / detectInverseHeadAndShoulders 関数を実装
- [x] detectSignals() に三尊/逆三尊シグナルを追加
- [x] simulateStockReal() に三尊/逆三尊エントリー条件を追加
- [x] 137日バックテストでPhase38と比較検証
- [x] テスト全通過確認（180テスト全通過）
- [x] チェックポイント保存

## Phase 40: kabuステーション® Premiumプラン期限リマインド機能

- [x] Premiumプランの継続条件を調査・記録
- [x] DBにプラン期限管理テーブルを追加（pnpm db:push）
- [x] 期限１週間前にOutlookメールでリマインドするスケジュールジョブを実装
- [x] Web画面にプラン期限表示・更新UIを追加
- [x] チェックポイント保存

## Phase 41: kabu STATION API 板情報統合

- [x] kabu STATION APIパスワードをシークレットに登録
- [x] 板情報キャッシュモジュール (server/kabuStation.ts) を実装
- [x] tRPCエンドポイント (pushOrderBook/getOrderBook/getAllOrderBooks) を実装
- [x] Windows用Python中継スクリプト (scripts/kabu_board_relay.py) を作成
- [x] 板読みシグナル（板圧力・大口注文・成行急増）をanalyzeOrderBook()に実装
- [x] Web画面にリアルタイム板情報パネルを追加 (RealDataChart.tsx)
- [x] チェックポイント保存

## Phase 42: リアルタイム取引シミュレーション（1分足+板情報）

- [x] DBにリアルタイム取引ログテーブルを追加（rt_candles, rt_trades, rt_daily_summaries）
- [x] サーバー側リアルタイムシグナル検出エンジン実装（server/realtimeSimEngine.ts）
- [x] tRPCエンドポイント追加（pushCandle/getRtTrades/getRtDailySummaries/getRtOpenPositions）
- [x] 大引け後レポート生成・notifyOwner送信のスケジュールジョブ実装（/api/scheduled/rt-daily-report）
- [x] Windows中継スクリプト更新（1分足OHLCV集計・送信機能追加）
- [x] Webアプリにリアルタイム取引ログ画面を追加（/realtime）
- [x] realtimeSimEngine.test.ts 7テスト全通過
- [x] チェックポイント保存

## Phase 43: リアルタイムシミュレーション最適化（2026-06-12）

- [x] 損切り率を0.7%→0.5%に変更（realtimeSimEngine.ts STOP_LOSS_PERCENT）
- [x] 板情報キャッシュTTL延長（案A: 5秒→60秒）※板情報取得率80%以上になったら板情報活用を検討
- [ ] 高額株（株価5万円超）除外フィルター実装（案D: キオクシアHD/東京エレクトロン）
- [x] 証拠金300万円（信用3.3倍=990万円）に合わせた最大同時ポジション数制限の実装
- [x] 案C Step1: サーバー側にpushCandleWithBoardエンドポイント追加（既存pushCandleは変更なし）
- [x] 案C Step2: Windows側kabu_board_relay_v4.py作成（1分足確定時に板情報REST取得して同時送信）
- [ ] 案C Step3: 並行稼働確認（1分足取得継続確認）
- [ ] 案C Step4: 旧エンドポイントへの送信山止（Step3完了後）
- [x] 証拠金使用率制限の実装（MARGIN_CAPITAL=990万円×90%=891万円上限でエントリー停止）
- [x] 案C Step2（上記と同内容・重複エントリー）

## 大引け決済バグ修正・エントリー禁止時刻変更（2026-06-14）
- [x] realtimeSimEngine.ts: NO_ENTRY_AFTER を "15:15" → "14:30" に変更
- [x] realtimeSimEngine.ts: 大引け強制決済バグ修正（スケジューラー側でメモリ消失時にエントリー価格で決済されPnL=0になる問題）→ DBからオープンポジションを復元して正しい価格で決済するよう修正
- [ ] チェックポイント保存

## ダウ理論（上昇）押し目確認実装（2026-06-14）
- [ ] realtimeSimEngine.ts: ダウ理論（上昇）シグナル受信後に押し目確認ステートマシンを追加（最大5本待ち・直近安値割れでキャンセル）
- [ ] チェックポイント保存

## 5分足上位足フィルター実装（2026-06-15）
- [x] vwap.ts に buildHigherTfCandles / calcSMA / getHigherTfTrend ヘルパーを追加
- [x] realtimeSimEngine.ts のダウ理論シグナル処理に5分足フィルターを適用
- [x] realtimeSimEngine.test.ts にフィルターのユニットテストを追加
- [x] TypeScript 0エラー確認・全テスト通過確認（189テスト全通過）
- [x] チェックポイント保存（version: 55ca8303）

## ダブルトップ/ボトム ピーク間隔強化（案A）実装（2026-06-15）
- [x] detectSignals.tsのダブルトップ/ボトム検出ロジックのピーク間隔を3→10本以上に修正
- [x] realtimeSimEngine.test.tsにテストを追加（2件追加）
- [x] TypeScript 0エラー確認・全テスト通過確認（191テスト全通過）
- [x] チェックポイント保存（version: d21d44f7）

## 大台超え/割れ 5本維持確認フィルター実装（2026-06-15）
- [x] realtimeSimEngine.tsに大台シグナルの5本維持確認ステートマシンを追加
- [x] realtimeSimEngine.test.tsにテストを追加（2件追加）
- [x] TypeScript 0エラー確認・全テスト通過確認（193テスト全通過）
- [x] チェックポイント保存（version: a8d25243）

## リアルタイム運用ダッシュボード機能追加（2026-06-16）
- [x] realtimeSimEngine.tsに接続状態・最終受信時刻・銘柄別確定損益の状態管理を追加
- [x] trading routerにgetRtDashboardStatus APIを追加（接続状態・銘柄別損益・当日サマリー）
- [x] RtDashboard.tsxページを新規作成（接続状態・銘柄別リアルタイム損益・シグナル履歴・銘柄別受信足数）
- [x] App.tsxに/rt-dashboardルートを追加
- [x] Home.tsxにダッシュボードへのリンクを追加（青色ボタン）
- [x] TypeScript 0エラー確認・テスト通過確認（200テスト全通過）
- [x] チェックポイント保存

## 改善適用（2026-06-16 シミュレーション検証済み）
- [x] 改善①: ダウ理論SHORTに5分足フィルター追加（5分足MA5<MA25確認）
- [x] 改善②: 板情報neutral時エントリー抑制（buy_pressure/sell_pressureのみ許可）
- [x] 改善③: 損切りを-0.7%→-0.5%に引き締め
- [x] 改善④: 09:30以前エントリー禁止（寄り付きダマシ排除）
- [x] 改善⑤: 大台超え/割れの確認バー完了後に押し目待ちを追加（ダマシ排除・強トレンドのみエントリー）
- [x] 改善⑥: VWAPシグナル（クロス上抜け/下抜け/反発/反落）に出来高フィルター追加（直近10本平均の1.2倍以上で発火）

## 板読みスコアv6実装（2026-06-16）— 閾値≧1で5要素統合
- [x] realtimeSimEngine.tsに板読みスコア関数(boardReadingScore)を追加
- [x] 要素C: 板圧力トレンド（直近5本のbuyPressureRatio変化量≧0.15で±1）
- [x] 要素D: 相場モード判定（active/building→+1, trap/quiet→-2）
- [x] 要素E: 板圧力の強さ（bpr≧1.4 or bpr≦0.65で±1）
- [x] 板読み早期利確: 保有中に逆方向の強い板シグナル→利益確保で早期決済
- [x] 既存のisBoardBullish/isBoardBearish/hasBoardCounterWallフィルターを板読みスコアに統合
- [x] 閾値BOARD_SCORE_THRESHOLD=1を定数として定義
- [x] 銀柄ごとのbuyPressureRatio履歴をメモリに保持（直近5本分）
- [x] realtimeSimEngine.test.tsに板読みスコアのテストを追加
- [x] TypeScript 0エラー確認・全テスト通過確認

## sell_pressure時LONG禁止 / buy_pressure時SHORT禁止（2026-06-17）
- [x] realtimeSimEngine.tsにsell_pressure時LONG禁止を実装
- [x] realtimeSimEngine.tsにbuy_pressure時SHORT禁止を実装
- [x] 本日(6/17)を含む4日間のシミュレーション結果を報告
- [x] テスト全通過確認（210テスト全pass）
- [x] チェックポイント保存 (d8d286fb)

## 対策A + ダウ理論条件変更シミュレーション（2026-06-17）
- [x] 対策A: プルバック経由LONGにもsell_pressureチェックをrealtimeSimEngine.tsに実装
- [x] 対策A: プルバック経由SHORTにもbuy_pressureチェックをrealtimeSimEngine.tsに実装
- [x] ダウ理論条件変更の複数パターンをシミュレーション（非推奨と判断）
- [x] 結果報告

## ATRフィルター実装（2026-06-17）
- [x] realtimeSimEngine.tsにATRフィルター実装（期間=7, 閾値=0.12%）
- [x] テスト全通過確認（212テスト全pass）
- [ ] チェックポイント保存
- [ ] NOTE: 今後ボラティリティが問題になった際はATRフィルターの閾値見直しを提案すること

## 押し目深さフィルター実装（2026-06-20）
- [x] realtimeSimEngine.tsにダウ理論LONG用の押し目深さフィルター実装（30-70%範囲外をブロック）
- [x] realtimeSimEngine.tsにダウ理論SHORT用の押し目深さフィルター実装（30-70%範囲外をブロック）
- [x] フィルター適用時のログ出力を追加
- [x] テスト作成・全通過確認（realtimeSimEngine.test.ts: 30テスト全pass）
- [x] detectSignalsのrecentSwingLow/Highがc.signalに含まれないバグを修正（stockData.ts）
- [x] チェックポイント保存

## VWAPクロス上抜けシグナル無効化（2026-06-20）
- [x] VWAPクロス上抜けシグナルを無効化（エントリーをブロック）
- [x] テスト更新・全通過確認（realtimeSimEngine.test.ts: 31テスト全pass）
- [x] 実装後の仕様で5日間シミュレーション検証（46件・+493,409円）
- [x] チェックポイント保存

## RTダッシュボードに信頼度（強/中/弱）表示を追加
- [x] signalHistory型にconfidenceフィールドを追加（realtimeSimEngine.ts）
- [x] OpenPosition型にconfidenceフィールドを追加（realtimeSimEngine.ts）
- [x] enterPosition関数でsignalConfirmation.tsのevaluateConfirmationを呼び出し信頼度を計算
- [x] RtDashboardのオープンポジションカードに信頼度バッジを表示
- [x] RtDashboardのシグナル履歴テーブルに信頼度列を追加
- [x] テスト確認・チェックポイント保存

## サーバー再起動時にオープンポジションをDBから自動復元
- [x] restoreBuffersFromDb()内でDBから未決済ポジションを復元するロジックを追加
- [x] signalHistoryもDBから復元する
- [x] テスト確認・チェックポイント保存

## 昼休み（11:30〜12:30）の足をprocessCandleでスキップ
- [x] processCandle冒頭で11:30〜12:29の足をスキップ（DBにも保存しない）
- [x] テスト確認・チェックポイント保存

## バッファを当日構築に変更（前日バッファ引き継ぎを廃止）
- [x] restoreBuffersFromDb()で前日分のバッファ復元を廃止し、当日分のみ復元するように変更
- [x] resetIfNewDay()でバッファを完全クリアするように変更
- [x] テスト確認・チェックポイント保存

## 改良案B・C 本番実装（2026-06-25）
- [x] 改良案B: 歩み値方向推定（estimateTickDirection）をboardReadingScoreに追加（要素F: ±2点）
- [x] 改良案C: 見せ板検出強化（detectFakeOrder）をboardReadingScoreに追加（要素D修正+要素G: ±1点）
- [x] TypeScriptコンパイルエラーなし確認
- [x] 既存テスト216件パス確認
- [x] サーバー再起動・正常動作確認

## 改良策3改: medium直接エントリー禁止（2026-06-25）
- [x] realtimeSimEngine.tsの直接エントリー分岐にmediumブロックを追加（ステートマシントリガーは許可）
- [x] TypeScriptコンパイルエラーなし確認
- [x] テスト追加・全テスト通過確認（218 passed）
- [x] チェックポイント保存

## 改良策5: 時間帯フィルター追加（2026-06-25）
- [x] 11:00〜11:30のエントリー禁止を本番エンジンに追加
- [x] 12:30〜13:00のエントリー禁止を本番エンジンに追加
- [x] TypeScriptコンパイルエラーなし確認
- [x] テスト追加・全テスト通過確認（223 passed）
- [x] チェックポイント保存
- [x] UI修正: リアルタイム取引シミュレーション画面で信頼度が切り詰められて見えない問題を修正（信頼度を独立列として表示、理由テキストの折り返し対応）

## BEストップ（+0.5%トリガー）本番実装（2026-06-29）
- [x] realtimeSimEngine.tsにBEトリガーロジック追加（含み益+0.5%到達でSLを建値に移動）
- [x] OpenPosition型にbeTriggered/beTriggeredAtフィールドを追加
- [x] processCandle内でBEトリガー判定＆SL価格更新
- [x] BEトリガー発動時にシグナル履歴にログ記録
- [x] RTダッシュボードにBE状態（未発動/発動済み）を表示
- [x] テスト追加・全テスト通過確認（42テスト全通過）
- [x] チェックポイント保存

## 後場BPRフィルター実装（2026-06-29）
- [x] 後場(13:00以降) + SHORT + BPR>=0.65 でエントリーブロック
- [x] enterPosition内のエントリー判定に条件追加
- [x] シグナル履歴にブロック理由を記録
- [x] テスト追加・全テスト通過確認（45テスト全通過）
- [x] チェックポイント保存

## 改善2+3 本番実装（2026-06-30）
- [x] 改善2: VWAPクロス下抜けSHORT急落フィルター実装 (5本下落率≤-0.8%でブロック)
- [x] 改善3: BEストップの修正確認（既に実装済みの+0.5%BEが正しく動作しているか確認）
- [x] テスト追加・全テスト通過確認 (48テスト全pass)
- [x] チェックポイント保存

## BUYシグナル取り逃し原因調査（2026-06-30）
- [x] 実施1: BUYブロック理由ログ追加（分析スクリプトで実施）
- [x] 実施2: Ghost Trade仮想BUY検証ロジック実装
- [x] 実施3: 今日の対象銘柄別分析（7銘柄）
- [x] 実施4: sell_pressure時LONGブロック妥当性検証（A/B比較）
- [x] 実施5: 最終レポート作成

## パターンC+10銘柄方式 実装（2026-07-01）
- [x] shared/stocks.ts: TARGET_STOCKSを17銘柄→10銘柄に限定（追加7銘柄を除外: 9107,8306,4568,285A,5016,6758,7203）
- [x] realtimeSimEngine.ts: isBullish（始値比+0.2%）方式を廃止
- [x] realtimeSimEngine.ts: B2方式（9:30市場全体方向性判定、前場のみ適用）を実装
- [x] realtimeSimEngine.ts: SHORT medium全ブロック → 前場bullish時のみブロック、それ以外は許可に変更
- [x] realtimeSimEngine.ts: 後場全SHORT BPR>=0.65ブロックは維持
- [x] realMarketData.test.ts: TARGET_STOCKS長さアサーションを17→10に更新
- [x] TypeScriptコンパイルエラー0件確認
- [x] テスト233件パス（J-Quants APIキー未設定の2件のみ失敗 — 環境依存）

## 板スナップショット10秒間隔ポーリング＋アイスバーグ検出精度向上（2026-07-02）
- [x] 10秒間隔の板ポーリング＋メモリリングバッファ実装
- [x] 1分足確定時にアイスバーグ検出回数・大口約定方向・10秒BPR平均を集約してDB保存
- [x] boardReadingScoreを新フィールド（icebergCount, largeTradeDirection, avgBprIn10s）対応に更新
- [x] テスト・動作確認

## +D構成回帰（2026-07-03）— 6/26版エンジン + 後場BPRフィルター
- [x] BEストップ撤廃（アブレーションテストで-15.4%のマイナス影響確認）
- [x] B2方式 → isBullish方式に回帰（銘柄別始値比+0.2%でSHORT禁止）
- [x] SHORT medium全ブロックに回帰（medium許可は-18.3%のマイナス影響確認）
- [x] VWAP急落フィルター撤廃（-19.6%のマイナス影響確認）
- [x] 後場BPRフィルター維持（13:00〜, BPR≥0.65でSHORTブロック）— 唯一プラス効果(+37.8%)
- [x] 17銘柄に復活（10銘柄→17銘柄、アブレーションテストで17銘柄+PM_BPRが最良+659,337円）
- [x] テスト更新（BE→純粋SL/TP、銘柄数10→17）
- [x] TypeScriptエラー0件確認

## 3分足HTFフィルター（neutral通過版）本番実装（2026-07-04）
- [x] realtimeSimEngine.tsのgetHigherTfTrendを5分足→3分足に変更
- [x] 全シグナル（BUY/SELL）にHTFフィルター適用（逆方向のみブロック、neutral通過）
- [x] ステートマシンエントリー時にもHTFフィルター適用（逆方向のみブロック）
- [x] テスト更新・全テスト通過確認
- [x] チェックポイント保存

## 自動売買システム実装（2026-07-08）— Phase 1: ドライラン
- [x] order_instructions テーブル設計・DB作成
- [x] auto_trade_daily テーブル設計・DB作成
- [x] server/db.ts に order_instructions / auto_trade_daily のCRUDヘルパー追加（orderBridge.tsに統合）
- [x] server/orderBridge.ts 実装（rt_trades監視→発注指示生成）
- [x] tRPC エンドポイント追加（executor用ポーリング・結果報告）
- [x] kabu_order_executor.py 実装（ドライラン版）
- [x] 結合テスト（vitest）— 14件パス
- [x] 設計ドキュメント作成 (analysis/AUTO_TRADE_DESIGN.md)
- [x] JX金属(5016)をTARGET_STOCKSから除外（SHORT 0勝8敗、16日間-71,086円）
- [x] 午後安値圏フィルター(-3%)を実装: 13:00以降のショートで始値比-3%以上下落済みならエントリー見送り
- [x] キオクシア(285A)のみTP3.0%/SL1.0%に変更（他銘柄は変更なし）
- [x] ソニーグループ(6758)、SBG(9984)、三菱重工業(7011)をTARGET_STOCKSから除外
- [x] 8316三井住友FG、9107川崎汽船、8306三菱UFJ、4568第一三共、7203トヨタをTARGET_STOCKSから除外

## 午後高値圏フィルター追加
- [x] realtimeSimEngine.ts に PM_HIGHZONE_THRESHOLD 定数追加 (0.04 = 4%)
- [x] enterPosition内に午後高値圏フィルター実装（13:00以降 + 始値比+4%以上でLONGブロック）
- [x] 午後安値圏フィルター閾値を-3%から-5%に変更（再検証で-5%が最適と確定: ネット+188,044円、-5%以下は勝率0-25%の明確な負け領域）

## 3山v2シグナルログ記録 & 毎平日通知
- [x] 3山v2シグナル検出ロジックをrealtimeSimEngineに追加（ログ記録のみ、エントリーなし）
- [x] 3山v2シグナルログ用DBテーブル(rt_3peak_signals)作成
- [x] 3山v2シグナルの仮想損益追跡（TP/SL/EOD判定）
- [x] 毎平日の3山v2シグナル結果通知（Heartbeat + notifyOwner）

## 日次利益上限フィルター
- [x] 日次確定利益が20万円を超えたら新規エントリー禁止 → 撤回・削除済み
- [ ] 緊急停止ボタン: サーバー側tRPCプロシージャ（エントリー禁止+即時決済指示生成）
- [ ] 緊急停止ボタン: フロントエンドUI（RTダッシュボードに配置）
- [ ] 緊急停止ボタン: 解除機能
- [x] kabu_order_executor_v2.py: クラウド通信断時の新規エントリー停止
- [x] kabu_order_executor_v2.py: 起動時の建玉同期（/positions）
- [x] kabu_order_executor_v2.py: 発注後の約定確認（/orders照会）
- [x] kabu_order_executor_v2.py: ローカル大引け強制決済（15:25〜15:29ループ）
- [x] kabu_order_executor_v2.py: 建玉保有中の通信バックオフ短縮（30秒→2秒）
- [x] kabu_order_executor_v2.py: DRY_RUN=Trueで全機能テスト可能な状態

## 大台乖離率0.8%フィルター実装
- [x] ヘルパー関数追加（calculateRoundDistancePct, shouldBlockRoundDistance）
- [x] 3箇所のenterPosition呼び出し直前にフィルター挿入
- [x] ブロック時signalHistory記録
- [x] vitest単体テスト作成
- [x] バックテスト再現確認（204件→131件、+373,696円）
- [x] チェックポイント保存

## データ受信と取引除外の分離
- [x] shared/stocks.ts: 除外銘柄をTARGET_STOCKSに復活（コメントアウト解除）
- [x] shared/stocks.ts: TRADE_EXCLUDED_SYMBOLSセット追加
- [x] realtimeSimEngine.ts: insertRtCandleをALLOWED_SYMBOLSチェックの前に移動
- [x] realtimeSimEngine.ts: TRADE_EXCLUDED_SYMBOLSで取引除外判定
- [x] TypeScriptチェック・vitestテスト通過
- [x] チェックポイント保存

## CB v2 SHORT 日次シミュレーション（7/17〜5営業日）
- [x] 既存日次レポート処理の構造確認
- [x] CB v2 SHORTシミュレーション関数実装（当日1分足から仮想取引計算）
- [x] 日次レポートにCB v2結果セクション統合
- [x] テスト・動作確認
- [x] チェックポイント保存

## drop_0.6バイパス分岐型シミュレーション追加
- [ ] cbV2Simulation.tsにdrop_0.6急落判定+バイパスエントリー関数追加
- [ ] scheduledHandlers.tsの日次レポートに分岐型結果セクション追加
- [ ] TypeScriptチェック・テスト通過
- [ ] チェックポイント保存

## スコア0+信頼度強ブロックの日次シミュレーション追加
- [x] realtimeSimEngine.tsでスコア0+信頼度強ブロック時にrt_score0_blocksテーブルに記録
- [x] DBテーブルrt_score0_blocks作成（tradeDate, symbol, candleTime, side, signal, entryPrice, confidence）
- [x] cbV2Simulation.tsにscore0シミュレーション関数追加（ブロック記録からSL/TP/EODを計算）
- [x] 日次レポートに「スコア0+信頼度強シミュレーション」セクション追加（件数・勝率・損益・累計）
- [x] TypeScriptチェック・テスト通過
- [x] チェックポイント保存

## 除外銘柄の復活（6920, 6758, 8316）
- [x] TRADE_EXCLUDED_SYMBOLSから6920, 6758, 8316を削除
- [x] TypeScriptチェック通過
- [x] チェックポイント保存

## isBullish判定の動的MA傾き方式への変更
- [x] isBullish判定を動的MA20傾き方式に変更（MA20, 傾き閾値-0.03%/分）
- [x] TypeScriptチェック通過
- [x] チェックポイント保存
- [x] 大台乖離率0.8%フィルターを撤廃（shouldBlockRoundDistance関連コード削除）

## ROUND_LEVEL_CONFIRM_BARS最適化（2026-07-30）
- [x] ROUND_LEVEL_CONFIRM_BARS を 5→4 に変更（全期間スイープで4本が最適と判明: BUY +374,718円改善、SHORT +654,363円改善）

## 銘柄別SL幅の実装（2026-08-03）
- [x] SYMBOL_SL_OVERRIDE設定を追加（切り戻しやすいフラグ付き構造）
- [x] realtimeSimEngine.tsのSL判定を銘柄別SLに対応
- [x] テスト作成・全テスト通過確認
- [x] チェックポイント保存

## 銘柄入れ替え: 6920/6758除外、6146/6594追加（2026-08-06）
- [x] shared/stocks.ts: 6920レーザーテック、6758ソニーGをTRADE_EXCLUDED_SYMBOLSに追加
- [x] shared/stocks.ts: 6146ディスコ、6594ニデックをTARGET_STOCKSに追加
- [x] realtimeSimEngine.ts: SYMBOL_SL_MAPから6920/6758を削除、6146/6594のSL初期値を追加
- [x] テスト実行・全テスト通過確認
- [x] チェックポイント保存

## 大台確認LONG × buy_pressure 逆張りSHORT実装（2026-08-08）
- [x] realtimeSimEngine.ts: 大台確認LONGシグナル + buy_pressure時にSHORTエントリーに反転
- [x] テスト追加・全テスト通過確認
- [x] チェックポイント保存

## 大台確認LONG停止（2026-08-09）
- [x] realtimeSimEngine.ts: 大台超えシグナル発生時にステートマシン登録をスキップ（LONGのみ停止、SHORTは変更なし）
- [x] テスト追加・全テスト通過確認（274テスト通過、J-Quants環境依存2件のみ失敗）
- [x] チェックポイント保存

## 太陽誘電(6976)GC medium許可（2026-08-09）
- [x] realtimeSimEngine.ts: 6976のみGCシグナルmedium品質をclose>MA20+陽線条件で許可
- [x] テスト全通過確認（274テスト通過、J-Quants環境依存2件のみ失敗）
- [x] チェックポイント保存
- [ ] AI(LLM)呼び出しの全削除: scheduledHandlers.ts, trading.ts, runTodaySimulation.ts, aiAnalysis.ts
- [ ] テスト通過確認
- [ ] チェックポイント保存
- [x] AI(LLM)呼び出しの全削除: scheduledHandlers.ts, trading.ts, runTodaySimulation.ts, aiAnalysis.ts, AIAdvisorPanel.tsx
- [x] AI(LLM)呼び出しの全削除: scheduledHandlers.ts, trading.ts, runTodaySimulation.ts, aiAnalysis.ts, AIAdvisorPanel.tsx
## 自動売買 kabu_relay v6.0 実装（2026-08-11）
- [x] ステートマシン10状態（NO_POSITION/ENTRY_SENT/ENTRY_FILLED/SL_SENT/POSITION_ACTIVE/UNPROTECTED_POSITION/EXIT_REQUESTED/EXIT_SENT/EXIT_FILLED/ERROR_STOP）
- [x] エントリー約定後の逆指値SL自動発注（FrontOrderType=30、銘柄別SL幅）
- [x] TP/EOD/EXIT時の競合制御（SL取消→取消確認→建玉確認→成行返済→約定確認→建玉0確認）
- [x] sendorderタイムアウト時の/orders確認（即再発注禁止）
- [x] UNPROTECTED_POSITION（SL設置失敗時のフェイルセーフ）
- [x] LIVE/SIMULATION管理（LIVE_TRADE_SYMBOLS={"8035"}、段階的テスト対応）
- [x] /positions同期強化（全実建玉確認→LIVE建玉照合、想定外建玉警告）
- [x] 大引け強制決済のLIVE/SIMULATION区別
- [x] NO_POSITION遷移条件強化（返済約定確認+建玉0確認）
- [x] 発注APIレート制御（5件/秒未満、_rate_limit_order_api）
- [x] v5.9.2の全安全機能維持
- [ ] DRY_RUN=Trueで異常系テスト（ENTRY/SLタイムアウト、UNPROTECTED、競合、EOD等）
- [ ] DRY_RUN=False、LIVE_TRADE_SYMBOLS={"8035"}で実売買テスト
- [ ] 段階的にLIVE_TRADE_SYMBOLSを拡大

## リアルタイムデータ受信停止の調査（2026-08-12）
- [x] DB・サーバーログで当日1分足データの最終受信時刻と受信APIの状態を確認
- [x] kabu_relay v6.0更新内容がデータ送信ループ・クラウド接続に影響していないか確認
- [ ] 原因を特定し、ローカルPCで安全に実施できる復旧手順を提示

## 他サーバー移行時のデータ退避手順（2026-08-12）
- [x] 移行対象（ソースコード、DB、環境変数、Windows relay設定）を一覧化
- [x] 安全なバックアップ・復元・切替の手順を作成

## 現時点バックアップ作成（2026-08-12）
- [x] GitHub同期済みソースの復元ポイントを記録
- [x] DB全テーブルのスキーマ・データをSQL形式でエクスポートし、整合性を確認
- [x] Windows relay・タスクスケジューラー設定のローカル退避手順を案内

## 移行用環境変数一覧（2026-08-12）
- [x] 現行アプリで使用する環境変数を値なしで一覧化
- [x] 移行先での再設定・代替方針を文書化

## AIへの新サーバー移行依頼資料（2026-08-12）
- [x] 移行AIへ渡す前提資料・安全制約・受入条件を整理
- [x] 実行順序を定めた移行手順書と貼り付け用プロンプトを作成

## 取引数減少・ブロック・太陽誘電SLの検証（2026-08-13）
- [x] 本日の受信データにおけるシグナル候補とブロック理由を集計
- [x] 8/7時点からの仕様差分が取引数へ与える影響を確認
- [x] 太陽誘電6976の本日取引についてSL幅別の到達結果を検証

## 公開表示・8月7日差分・太陽誘電SL再検証（2026-08-13）
- [x] 分析用ファイル更新とチェックポイント保存が公開表示へ与える影響を確認
- [x] 8月7日時点のrealtimeSimEngine.tsと現行のトレードロジック差分を再確認
- [x] 太陽誘電6976についてSL 0.5%と0.6%のKABU受信足ベース比較を実施

## 方向別SL実装（2026-08-13）
- [x] SYMBOL_SL_MAPを方向別構造(long/short)に変更
- [x] 6526 SHORT: 0.9%→1.0%
- [x] 6981 LONG: 0.9%→0.4%
- [x] 285A SHORT: 0.8%→0.6%
- [x] 5803 SHORT: 0.5%→0.6%
- [x] 6976 LONG: 0.5%→0.6%
- [x] 6976 SHORT: 0.5%→0.8%
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（274通過、J-Quants API環境依存2件のみ失敗）
- [x] チェックポイント保存

## ディスコ(6146)板読みスコア0特例（2026-08-13）
- [x] 6146のみ信頼度強LONGの板読みスコア0ブロックを解除（即エントリー許可）
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（274通過、J-Quants API環境依存2件のみ失敗）
- [x] チェックポイント保存

## 大台超えLONG停止中のbuy_pressure逆張りSHORT復活（2026-08-13）
- [x] realtimeSimEngine.ts 1317〜1337行: ステートマシン登録を復活（大台超えシグナル → 確認バー待機）
- [x] タイムアウト時（1134行付近）: buy_pressureなら逆張りSHORT、それ以外はLONGブロック
- [x] 押し目確認後（1189行付近）: buy_pressureなら逆張りSHORT、それ以外はLONGブロック
- [x] 大台割れSHORT（既存）には影響なし
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（274通過、J-Quants API環境依存2件のみ失敗）
- [x] チェックポイント保存

## 大台割れSHORT A案（CB=2, MW=1）実装（2026-08-14）
- [x] ROUND_SHORT_CONFIRM_BARS=2, ROUND_SHORT_PULLBACK_MAX_WAIT=1 定数追加
- [x] 確認バーカウント判定を方向別に分岐（sell→ROUND_SHORT_CONFIRM_BARS, buy→ROUND_LEVEL_CONFIRM_BARS）
- [x] 押し目待ちタイムアウト判定を方向別に分岐（sell→ROUND_SHORT_PULLBACK_MAX_WAIT, buy→ROUND_PULLBACK_MAX_WAIT）
- [x] 大台超えLONG（逆張りSHORT用）のパラメータ（CB=4, MW=5）は変更なし
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（274通過）
- [x] チェックポイント保存
- [ ] 結果が悪ければ元に戻す（ROUND_SHORT_CONFIRM_BARS=4, ROUND_SHORT_PULLBACK_MAX_WAIT=5）

## isBullish閾値変更: -0.03% → 0%（2026-08-14）
- [x] IS_BULLISH_SLOPE_THRESHOLDを-0.03から0に変更
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（274通過）
- [x] チェックポイント保存
- [ ] 結果が悪ければ元に戻す（IS_BULLISH_SLOPE_THRESHOLD = -0.03）

## 静かな上昇バイパス + ディスコ特例廃止（2026-08-17）
- [x] ディスコ(6146)スコア0特例を廃止
- [x] 「静かな上昇バイパス」実装: ①+②条件を満たすLONGはスコア0でもエントリー許可
  - ① MA乖離<0.3% + エントリー足実体<0.1%（静かな上昇）
  - ② 直近10本で陰線3本以下（売り圧力不在）
  - 追加条件: isBullish=true（MA20上向き）
- [x] シミュレーション: 109件 54勝55敗 勝率49.5% +628,543円（ベース37.5%から+12pt改善）
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（274通過）
- [x] チェックポイント保存
- [ ] 結果が悪ければ元に戻す（ディスコ特例復活 or バイパス条件調整）

## 静かな上昇バイパス時のmedium品質ブロック免除（2026-08-17）
- [x] quietRiseBypassedフラグがtrueの場合、medium品質でもエントリー許可
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（274通過）

## 時間帯フィルター撤廃（2026-08-17）
- [x] 昼休み前（11:00〜11:30）エントリー禁止を撤廃
- [x] 後場序盤（12:30〜13:00）エントリー禁止を撤廃
- [x] シミュレーション: 禁止時間帯のシグナル293件 124勝169敗 +2,166,351円の機会損失
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（274通過）
- [ ] 結果が悪ければ元に戻す

## 案6: 大台割れSHORT即エントリー（sell_pressure + 出来高1.5倍）（2026-08-18）
- [x] FAST_ENTRY_VOL_RATIO=1.5, FAST_ENTRY_VOL_LOOKBACK=20 定数追加
- [x] 大台割れSHORT検出時にsell_pressure + 出来高1.5倍以上ならステートマシンをスキップし即enterPosition
- [x] シミュレーション: 即エントリー393件 勝率44.8% +2,759,857円（通常40.5%より+4.3pt改善）
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（274通過）
- [x] チェックポイント保存
- [ ] 結果が悪ければ閾値変更（1.2倍）または元に戻す（即エントリー廃止）

## 即エントリー条件からsell_pressure除外（8/18）
- [x] 即エントリー条件をsell_pressure + 出来高1.5倍 → 出来高1.5倍のみに変更
- [x] 40営業日シミュレーション: 31件→41件、勝率41.9%→43.9%、+285,487→+434,960円、PF 1.59→1.71
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（274通過、J-Quants環境依存2件のみ失敗）
- [x] チェックポイント保存

## 前場強制決済 + 後場序盤エントリー禁止（8/18）
- [x] 11:27で前場保有銘柄を全て強制決済
- [x] 12:30〜12:50のエントリー禁止
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（277通過、J-Quants環境依存2件のみ失敗）
- [x] チェックポイント保存

## 案4a: 前足近接即エントリー追加（8/18）
- [x] 大台割れSHORT即エントリーに「前足がキリ番+0.05%以内」条件を追加
- [x] 優先順位: ①即vol(出来高1.5倍) → ②即4a(前足近接) → ③従来CB2MW1
- [x] FAST_ENTRY_PREV_DIST_PCT=0.05 定数追加
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（277通過、J-Quants環境依存2件のみ失敗）
- [x] チェックポイント保存
- [x] チェックポイント保存

## 静かな上昇バイパス 緩和A（8/18）
- [x] MA乖離閾値を0.3%→0.5%に変更
- [x] 実体閾値を0.1%→0.2%に変更
- [x] 陰線閾値を3本→4本に変更
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（57通過）
- [x] チェックポイント保存
- [x] チェックポイント保存

## isBullish MA期間変更 20→8（8/18）
- [x] IS_BULLISH_MA_PERIOD を 20→8 に変更
- [x] TypeScriptエラーゼロ確認
- [x] テスト通過確認（57通過）
- [x] テスト通過確認（57通過）
- [x] チェックポイント保存
- [ ] チェックポイント保存

## 本日（8/18 火曜日）の実装まとめ
- [x] 即エントリー条件からsell_pressure除外（出来高1.5倍のみで即エントリー）
- [x] 前場強制決済（11:27）実装
- [x] 後場序盤エントリー禁止（12:30〜12:50）実装
- [x] 前足近接即エントリー（案4a: 前足+0.05%以内）実装
- [x] 静かな上昇バイパス 緩和A（MA乖離<0.5% / 実体<0.2% / 陰線≤4本）実装
- [x] isBullish MA期間変更（20→8）実装

## 8/19（水曜日）の実装
- [x] 逆張りSHORT・静かな上昇バイパスのアプリ表示修正（extractConfidence関数で括弧タグ保持）
- [x] 静かな上昇バイパスから逆三尊mediumを除外（逆三尊は信頼度「強」のみエントリー）
- [x] テスト通過確認（57通過）
- [x] チェックポイント保存
- [x] SHORTスコア0ブロック緩和: 逆三尊以外（ダウ理論/VWAP/大台割れ）はスコア0でもSHORTエントリー許可
- [x] テスト通過確認（57通過）
- [x] チェックポイント保存

## 8/19（水曜日）の変更
- [x] 静かな上昇バイパスでのエントリーをアプリ上で識別可能にする（reason文字列に「(静かな上昇バイパス)」付加、strong品質でも表示）
- [x] 静かな上昇バイパスでのエントリーをアプリ上で識別可能にする（reason文字列に「(静かな上昇バイパス)」付加、strong品質でも表示）

## LONGのTP幅変更 1.5%→0.5%（8/19）
- [x] realtimeSimEngine.ts: LONGのTP幅を1.5%→0.5%に変更
- [x] テスト通過確認（277通過、J-Quants環境依存2件のみ失敗）
- [ ] チェックポイント保存・結果が悪ければ元に戻す（TP 1.5%）
- [ ] 結果が悪ければ元に戻す（TP 1.5%）

## 案A+B前場のみ: 前場ブースト + 出来高ブレイクLONG（8/19）
- [x] realtimeSimEngine.ts: 前場（09:30〜11:27）のバイパス条件緩和（MA乖離<1.0%, 実体<0.5%, 陰線≤5本）
- [x] realtimeSimEngine.ts: 前場限定の出来高ブレイクLONG（出来高1.5倍以上 + 直近高値更新）
- [x] 後場は現行バイパス条件を維持
- [x] 大台超えLONG停止は維持
- [x] テスト通過確認（57テスト全通過、TypeScriptエラーゼロ）
- [ ] チェックポイント保存
- [ ] 結果が悪ければ元に戻す

## SHORT改善: 案1（安値更新即エントリー）+ 案2（確認バー中isBullish免除）（8/19）
- [x] 案1: 直近安値更新（ダウ理論シグナル）+ 出来高1.2倍以上で即SHORTエントリー（大台割れとは独立した条件）
- [x] 案2: 大台割れSHORTシグナルの場合、isBullish=trueでもブロックせずステートマシンに登録
- [x] テスト通過確認（57テスト全通過、TypeScriptエラーゼロ）
- [ ] チェックポイント保存
- [ ] 結果が悪ければ元に戻す

## 案2撤廃 + 前場ブースト撤廃（8/19）
- [x] 案2（大台割れisBullish免除）を撤廃: isBullish=trueの時は大台割れSHORTもブロック
- [x] 前場ブースト（案A）を撤廃: PF0.83でマイナスのため
- [x] 出来高ブレイクLONG（案B）は前場限定で維持
- [x] テスト通過確認（57テスト全通過、TypeScriptエラーゼロ）
- [x] チェックポイント保存

## 高値下落<1.5%フィルター実装（8/20）
- [x] SHORT_DROP_FROM_HIGH_MAX = 1.5% 定数追加
- [x] isBullishブロック後、板読みスコア判定前に高値下落フィルターを追加
- [x] 直近20本高値から1.5%以上下落済みならSHORTブロック（追いかけSHORT防止）
- [x] テスト通過確認（57テスト全通過、TypeScriptエラーゼロ）
- [x] チェックポイント保存
- [ ] 結果が悪ければ元に戻す

## 案E: ダウ理論LONG押し目深さフィルター撤廃（8/20）
- [x] PULLBACK_DEPTH_MIN = 0.30 → 0.0、PULLBACK_DEPTH_MAX = 0.70 → 1.0 に変更
- [x] 押し目確認ステートマシン自体は維持（一度下がって再上昇でエントリー）
- [x] テスト通過確認（57テスト全通過、TypeScriptエラーゼロ）
- [x] チェックポイント保存
- [ ] 結果が悪ければ元に戻す

## 高値下落フィルター閾値変更（8/20）
- [x] SHORT_DROP_FROM_HIGH_MAX = 1.5% → 2.0% に変更（ルックバック20本は維持）
- [x] グリッドサーチで20本×2.0%が安定して高成績（PF1.33、+3,835k円）
- [x] テスト通過確認（57テスト全通過、TypeScriptエラーゼロ）
- [ ] チェックポイント保存
- [ ] 結果が悪ければ元に戻す
- [ ] 案A: LONGのBPRスコア修正（BPR0.8-1.2→+2、BPR≥1.5→-2）
- [x] 案A: LONGのBPRスコア修正（BPR0.8-1.2→+2、BPR≥1.5→-2）
- [x] 方法1: neutral時SHORT -2減点（新要素J）
- [x] テスト通過確認（277テスト通過、J-Quants環境依存2件のみ失敗）
- [x] SHORTスコア0緩和にneutral時除外条件を追加（neutral時はスコア0ブロック維持）

## 銘柄別ロジック最適化（2026-08-21〜）

### Phase 1: 基盤実装
- [x] エントリー対象銘柄を1つに絞る設定（ACTIVE_ENTRY_SYMBOLS）の追加
- [x] 銘柄別パラメータ設定の基盤（SYMBOL_CONFIG型定義）
- [ ] 銘柄別UIの実装（銘柄別成績ダッシュボード）
- [ ] テスト通過確認

### Phase 2: キオクシア(285A)のくせ分析・ロジック調整
- [x] キオクシアの過去データからくせ分析
- [x] キオクシア専用パラメータの最適化
- [x] キオクシア専用ロジックの検証・実装
- [x] キオクシア: 大台超えLONG廃止 → 反転LONG実装（落2.5%/SL0.6%/TP0.8%/前場のみ）
- [x] キオクシア: 反転LONGに開始時間09:45 + MA8傾き>=0.02%を追加（勝率70.4%、+6,258円/株）
- [x] キオクシア: 前場大台割れCB SHORTの損切り事例（7/16・8/18）を分析し、再現性のある除外条件を検証
- [x] キオクシア: CB SHORT（前場主軸）と反転SHORTを併用した際の勝率70%・現行比+20万円達成案を検証
- [x] キオクシア: TPがSLを上回るリスクリワードを維持したSHORT併用案を最適化
- [x] キオクシア: 反転LONGと安全CB SHORT・反転SHORTのポジション競合を考慮し、1日あたりの実発火件数を集計
- [x] キオクシア: 安全CB SHORTの除外条件（日中-8%超・当日安値から1%超反発）を実装
- [x] キオクシア: 反転SHORT（始値+3%・高値から1.5%反落・MA8下向き・10本安値更新、SL0.8%/TP1.5%）を実装
- [x] キオクシア: CB優先・同一銘柄1ポジションのLONG/SHORT統合制御を確認
- [x] キオクシア: LONG/SHORT統合戦略のテスト・8/19および8/20の再現確認
- [x] キオクシア: 未来情報を使わず、時刻順にCB優先と1ポジション制御を適用した統合成績を再検証
- [x] キオクシア: 反転LONGのSL・TPを現行条件でグリッドサーチし、時系列で妥当性を確認
- [x] キオクシア: 安全CB SHORT・反転SHORTのSL・TPを現行条件でグリッドサーチし、時系列で妥当性を確認
- [x] キオクシア: LONG・SHORT別のSL・TP最適値と現行設定との差分を報告
- [x] キオクシア: 反転SHORTのTPを1.5%から1.2%へ変更し、SL0.8%・他条件を維持
- [x] キオクシア: 反転SHORT TP1.2%変更の型チェック・回帰テスト・保存
- [x] キオクシア: 本日分の現行LONG・SHORT統合ロジックを1分足で再シミュレーションし、取引明細・損益を報告
- [x] キオクシア: 8月21日の理想LONG（10:05〜10:23）と理想SHORT（13:01〜14:20）の発火条件を分析・検証
- [x] キオクシア: 朝の反転待機でSHORTを抑止し、記憶型LONGとの競合を回避できるか40営業日で検証
- [x] キオクシア: 後場ピーク反転SHORTと板読みBPR条件の整合性を確認
- [x] キオクシア: 現行LONG・SHORT統合ロジックを直近5営業日で再生し、全取引明細と日別成績を報告
- [x] キオクシア: 8月17日の終日上昇で反転LONGが未発火となった条件を時系列分析
- [x] キオクシア: 現行285AのLONG・SHORTシグナルとブロック条件を棚卸し
- [x] キオクシア: 上昇継続・下落継続に対応する順張りLONG・SHORT候補を40営業日で検証
- [x] キオクシア: 順張りLONG（10:15以降・始値以上・MA8上向き・20本高値更新・陽線・出来高1.2倍）を実装
- [x] キオクシア: 順張りSHORT（10:15以降・始値比-1%以下・MA8下向き・10本安値更新・陰線・出来高1.0倍）を実装
- [x] キオクシア: 順張り統合案の既存安全フィルター適用・単体テスト・40営業日再現を確認
- [x] キオクシア: 板読み・3分足HTF・後場BPRのブロック履歴と損益寄与を評価
- [x] キオクシア: 順張りを含む現行統合仕様を直近5営業日で再生し、全エントリーと決済を報告
- [x] 10銘柄の個別ロジック化によるリアルタイム処理・自動売買発注遅延リスクを評価
- [x] 東京エレクトロン(8035): 過去取引・ブロック履歴・1分足からLONG・SHORTの特徴を分析
- [x] 東京エレクトロン(8035): 反転・順張り候補を40営業日で検証し、実装候補を提案
- [x] 東京エレクトロン(8035): 8月19日〜21日の理想LONG・SHORT時間帯で提案済み3方式の発火を確認
- [x] 東京エレクトロン(8035): 勝率75%以上・現行提案比損益1.2倍を目指す高精度候補を検証
- [x] 東京エレクトロン(8035): 上昇幅上限付き順張りLONGをSL0.7%/TP1.0%で実装
- [x] 東京エレクトロン(8035): 下落継続SHORT・高値反転SHORTをSL0.6%/TP1.8%で実装
- [x] 東京エレクトロン(8035): 順張り3方式の板読み・HTF・BPR適用、テスト、40営業日再現を確認
- [x] 東京エレクトロン(8035): 未来情報なしの時刻順・1ポジション制御で直近5営業日を再生し、全エントリーと決済を報告
- [x] 東京エレクトロン(8035): 8月17日・18日のSHORT発火時刻を分析し、理想時間帯で発火する早期SHORT候補を40営業日で検証（調査のみ・実装なし）

### Phase 3: 次の銘柄へ展開
- [ ] 次の銘柄を選定・くせ分析・ロジック調整
- [x] フジクラ(5803): KABUステーション保存データから値動き・板・既存取引・ブロック要因を分析し、未来情報なしで最適化候補を提案（調査のみ・実装なし）
- [x] フジクラ(5803): キオクシア・東京エレクトロンと同等の詳細度で銘柄特性、候補別明細、時系列分割、採否理由を整理・報告（調査のみ・実装なし）
- [x] フジクラ(5803): 詳細な検証結果をアプリ内ファイルではなくチャットに直接表示（調査のみ・実装なし）
- [x] フジクラ(5803): 候補A+B統合で勝率80%以上・損益1.2倍以上を目標に、追加フィルターとSL/TPを検証（調査のみ・実装なし）
- [x] フジクラ(5803): 候補Cで損切りとなった8月7日・8月19日の価格・板・出来高・MA要因を分解（調査のみ・実装なし）
- [x] フジクラ(5803): 候補Cのプラス5件を維持しつつ損切り2件を除外する低過学習フィルターを検証（調査のみ・実装なし）
- [x] フジクラ(5803): 候補Cの値幅・出来高・MA乖離・安値下抜け幅について、異常値検知の選定根拠と閾値安定性を検証（調査のみ・実装なし）
- [x] フジクラ(5803): 候補A・B・Cへのショック足ブロックの方式別影響を検証（調査のみ・実装なし）
- [x] フジクラ(5803): 候補Cの後場安値更新SHORT（13:30〜14:00・5本安値更新・始値比-1%以下・MA8傾き≤-0.1%・出来高1.0倍・BPR≤1.0・SL0.6%/TP1.5%）と、候補C専用ショック足ブロック（値幅0.75%以上かつ出来高3.0倍以上）を実装し、A・B非影響を回帰テストで確認
- [x] フジクラ(5803): 公開済み最新状態で候補Cの実装有無と条件を確認し、安全フィルターの適用経路を確定（候補Cの実装なし）
- [x] フジクラ(5803): 候補Cと専用ショック足ブロックを含む現行仕様で、直近5営業日を実エンジン再生し全取引を報告（調査のみ・追加実装なし）
- [x] フジクラ(5803): 直近5営業日の理想エントリー時間帯を診断し、競合を含めた改善候補を未来情報なしで検証（調査のみ・実装なし）
- [x] フジクラ(5803): 時間帯依存を抑えた少数の汎用LONG・SHORT候補を40営業日・時系列分割・1ポジション条件で検証（調査のみ・実装なし）
- [x] フジクラ(5803): 安値反転ブレイクLONGと高値失速ブレイクSHORTのみで、直近5営業日を時刻順・1ポジション制御で再生し全取引を報告（調査のみ・実装なし）
- [x] フジクラ(5803): 2方式統合39件のプラス27件を維持しつつ、マイナス12件のみを除外できる異常値フィルターを検証（調査のみ・実装なし）
- [x] フジクラ(5803): LONGのBPR下限・SHORTのMA8急落上限について、周辺閾値と時系列分割の安定性を検証（調査のみ・実装なし）
- [x] フジクラ(5803): 安値反転ブレイクLONGにBPR≤0.25停止、高値失速ブレイクSHORTにMA8傾き≤-0.20%停止を実装し、既存方式への非影響を回帰テストで確認
- [x] 村田製作所(6981): KABUステーション保存データから値動き・板・既存取引・ブロック要因を分析し、汎用性を重視した最適化方針を提案（調査のみ・実装なし）
- [x] 村田製作所(6981): ダウ理論初動と大台を1日1回・1方向1回・1本確認・追撃回避で再検証（調査のみ・実装なし）
- [x] 村田製作所(6981): VWAP・BPR変化・出来高を使う確認ブレイクLONGとトレンド追随SHORTを39営業日で検証（調査のみ・実装なし）
- [x] 村田製作所(6981): 寄り付きブレイクSHORTの損切り4件について、急落末端・ショック足を分析しプラス取引を維持する安全フィルターを検証（調査のみ・実装なし）
- [x] 村田製作所(6981): 安値反転LONG・寄り付きSHORT・SHORTショック足ブロックのみで、直近5営業日を時刻順・1ポジション制御で再生し全取引を報告（調査のみ・実装なし）
- [x] 村田製作所(6981): 安値反転LONG・寄り付きSHORTを別々に、TP>SLを維持してSL・TP再最適化（調査のみ・実装なし）
- [x] 村田製作所(6981): 安値反転ブレイクLONG（SL1.0%/TP1.5%）・寄り付きブレイクSHORT（SL0.6%/TP1.5%）・SHORTショック足ブロックを実装し、回帰テストで確認
- [x] 太陽誘電(6976): KABUステーション保存データから値動き・板・既存取引・ブロック要因を分析し、汎用性を重視した最適化方針を提案（調査のみ・実装なし）
- [x] 太陽誘電(6976): 後場反転候補の損切り6件を分解し、プラス取引を維持する低過学習安全フィルターを検証（調査のみ・実装なし）
- [x] 太陽誘電(6976): 指定された理想エントリー時間帯を診断し、日付・分単位時刻に過適合しない発火条件を全保存期間で検証（調査のみ・実装なし）
- [x] 太陽誘電(6976): 理想局面を可能な限り捉えつつ勝率70%以上・TP>SLを維持する回数制限付き最小構成を検証（調査のみ・実装なし）
- [x] 太陽誘電(6976): 推奨3方式を完全保存日で時刻順・1ポジション再集計し、損益・勝敗を報告（調査のみ・実装なし）
- [x] 太陽誘電(6976): 朝初動SHORT・後場反転LONG・後場反転SHORT（SL1.0%/TP1.5%、1本確認、朝1回・後場1回）を実装し、回帰テストで確認
- [x] アドバンテスト(6857): KABUステーション保存の1分足・板スナップショットから値動きのくせ、既存取引、ブロック要因を分析し、低過学習の個別LONG・SHORT候補を検証
- [x] 銘柄別最適化: 検証結果はアプリ内へ保存・表示せず、チャットで直接報告する運用を徹底
- [x] アドバンテスト(6857): 高値失速SHORTを基準に、勝率70%以上かつ損益1.2倍以上を満たす低過学習の安全フィルター・SL/TPを再検証（調査のみ・未実装）
- [x] アドバンテスト(6857): 推奨SHORTの損失に偏る異常値ブロックを検証し、取引数を維持して勝率75%を目指す（調査のみ・未実装）
- [x] アドバンテスト(6857): 高値失速SHORT（SL1.0%/TP1.2%）と前足陰線実体0.05%以上の異常値ブロックを実装し、回帰テスト・保存データ再生で検証
- [x] アドバンテスト(6857): 保存KABUデータでLONGの順張り・反転・確認型候補と方向別SL/TPを比較し、低過学習の最適候補を提案（調査のみ・未実装）
- [x] アドバンテスト(6857): 確認型LONGと高値失速SHORTの競合日を相互排他的な条件で分離し、先着順に依存しない1日1ポジション統合を検証（調査のみ・未実装）
- [x] アドバンテスト(6857): 初回決済後に反対方向の市場状態を再確認した場合だけ再エントリーを許可する設計を時刻順で検証（調査のみ・未実装）
- [x] アドバンテスト(6857): 確認型LONG（SL0.5%/TP1.0%）と、高値失速SHORT・初回損切り後のみ反対方向を再評価する最大1回の再エントリーを実装し、回帰テスト・保存データ再生で検証
- [x] アドバンテスト(6857): 現行LONG・SHORT・損切り後再評価を保存KABUの直近5営業日で時刻順に再生し、全エントリー・決済をチャットで報告
- [x] 実装済み6銘柄（285A・8035・5803・6981・6976・6857）: 保存KABUの直近5営業日を時刻順に再生し、全エントリー・決済を銘柄別にチャットで報告
- [x] 実装済み6銘柄: 元金300万円・注文単位・余力拘束・シグナル発火順を反映した本番想定で直近5営業日を再生し、実行取引と資金制約による見送りを報告
- [x] 実装済み6銘柄: 単独再生と資金制約付き統合再生の不一致を調査し、銘柄状態を独立に保つ正しい本番想定再生へ修正して再検証
- [x] キオクシア（285A）: 個別検証時の直近5営業日7件と現行エンジン再生15件を行単位で照合し、後続変更による不一致の原因と是正方針を特定
- [x] 完了済み6銘柄（285A・8035・5803・6981・6976・6857）: 承認済みの銘柄専用エントリーロジックだけで判定し、既存汎用エントリー経路を銘柄別に遮断して個別検証と実エンジン再生を整合
- [x] 実装済み6銘柄: 専用ロジック限定後の直近5営業日を元金300万円・余力拘束・シグナル発火順で統合再生し、修正後の本番想定を報告
- [x] DRY_RUN開始設定: 全銘柄のデータ受信を維持し、エントリー対象だけを実装済み6銘柄（285A・8035・5803・6981・6976・6857）へ変更して開始前テストを実施
- [x] DRY_RUN開始前確認: 実稼働するWindows中継スクリプトの全銘柄データ受信設定とDRY_RUN設定を確認
- [x] DRY_RUN開始前レビュー: 実装済み6銘柄の専用ロジック・共通制御・資金制約・Windows v6.0連携を自己レビューし、開始可否と残存リスクを確認
- [x] サーバー移管パッケージ: コード以外のDB・設定・Windows中継・現行仕様・移管先AI向け実行依頼書を安全な手順とともに作成
- [x] 現行仕様監査・40営業日再生: 6銘柄限定、20銘柄受信、専用ロジック限定を再確認し、元金300万円・余力拘束で完全保存40営業日を時刻順に再生（6銘柄共通の完全保存日は34営業日）
- [x] 他AI改善案の精査: 6976・8035・285A・6981の提案を現行実装・保存KABUデータで再現し、近傍安定性・競合・資金制約・ポートフォリオ影響を比較
- [x] 改善案実装: 6976後場反転の出来高1.0倍・TP1.2%と、8035の最大保有22分・次足始値決済を実装し、回帰テスト・保存KABU再生で検証
- [x] 全営業日再生: 最新実装の6銘柄専用ロジックを、保存KABUデータの全利用可能営業日で元金300万円・余力拘束・時刻順に再生し、銘柄別・日別成績を報告
- [x] 本日リアルタイムレポート: 当日のrt_trades・rt_daily_summariesを銘柄別・シグナル別に集計し、勝率・損益・特記事項を報告
- [x] 低損益日分析: 現行6銘柄ロジックの完全保存34営業日再生について、取引ゼロ日・損益2万円未満日・マイナス日の取引構成、決済理由、資金制約を保存KABUデータで比較し、共通要因を報告
- [x] 異常値ブロック検証: 現行6銘柄ロジックの完全保存34営業日における全損失取引を保存KABUデータで再分析し、利益取引への副作用と近傍安定性を満たす低過学習の安全ブロック候補があるかを報告
- [x] ディスコ(6146)銘柄別最適化: KABUステーション保存データで値動き・出来高・板・時間帯の癖を分析し、既存6銘柄専用ロジックも比較して勝率70%以上かつ損益最大の低過学習LONG・SHORT候補を提案（調査のみ・未実装）
- [x] ディスコ(6146)他AI時間決済案の精査: 前回12エントリーを保存KABUデータで独立再現し、LONG60分・SHORT35分の次足始値決済、近傍値、約定悪化、期間分割、入口条件の再現性を比較して採否を報告（調査のみ・未実装）
- [x] ディスコ(6146)専用ロジック実装: 確認型10本高値更新LONG（VWAP上・MA8傾き+0.02%以上・出来高1.2倍以上・SL0.5%/TP1.8%）を追加
- [x] ディスコ(6146)専用ロジック実装: 寄り付き10本安値更新SHORT（09:30〜10:45・始値比-1.0%以下・MA8傾き0%以下・出来高0.8倍以上・SL0.5%/TP2.0%）を追加
- [x] ディスコ(6146)専用制御: 同時保有なし・LONG/SHORT各1日1回・決済後の反対方向再評価1回・汎用後段経路の遮断を実装
- [x] DRY_RUN対象拡張: ACTIVE_ENTRY_SYMBOLSを6146を含む7銘柄へ変更し、他13銘柄のデータ受信継続を回帰テストで固定
- [x] 6146実装検証: 専用経路、SL/TP、日次回数制御、保存KABUデータ時刻順再生、既存6銘柄非回帰、型チェックを完了
- [x] 7銘柄自己レビュー: 285A・8035・5803・6981・6976・6857・6146の専用設定値とエントリー経路を承認仕様に照合
- [x] 7銘柄自己レビュー: 専用経路の優先順位・汎用経路遮断・SL/TP・時間決済・日次発火回数・再起動復元を監査
- [x] 7銘柄自己レビュー: ACTIVE_ENTRY_SYMBOLSが7銘柄、TARGET_STOCKSが20銘柄のままであることを回帰確認
- [x] 7銘柄自己レビュー: 関連Vitest・型チェック・保存KABU再生を実行し、問題点と残存リスクをチャットで報告（本番ロジック変更なし）
- [x] 285A安全CB SHORT修正: exclusiveEntryRoutesより前の専用経路として安全CBを実エントリー可能にし、反転SHORT・順張りSHORTとの優先順位を維持
- [x] 5803正式仕様再確認: 候補A・Bが調査のみで、正式実装が候補C＋安値反転LONG＋高値失速SHORTの3方式だったかを履歴・テスト・コードで確定
- [x] 285A反転LONG修正: 承認済みSL0.6%・TP0.8%を専用オーバーライドとして実ポジションへ適用
- [x] 専用経路発火枠修正: 条件検出時ではなくenterPosition成功後だけ日次発火済みフラグを消費するよう対象経路を統一
- [x] 6976後場TP再確認: 承認履歴、通常時の朝TP1.5%・後場TP、再起動復元時のSL/TPを照合し、不一致があれば理由別に修正
- [x] 修正回帰検証: 関連単体テスト、285A保存KABU再生、既存7銘柄非回帰、型チェック、本番ビルドを確認
- [x] 6976再起動復元再確認: 朝初動SHORTはSL1.0%/TP1.5%、後場反転LONG/SHORTはSL1.0%/TP1.2%を理由別に復元することを恒久テストで固定
- [x] 5803保存KABU再生: 候補C＋安値反転LONG＋高値失速SHORTの正式3方式だけが時刻順再生で発火する恒久テストを追加
- [x] 6981保存KABU再生: 安値反転LONG＋寄り付きブレイクSHORTだけが時刻順再生で発火する恒久テストを追加
- [x] 7銘柄再起動復元: 専用ポジションの理由別SL/TPと8035最大保有22分設定を恒久回帰テストで固定し、起動時・スケジューラー復元で共通化
- [x] 復元・保存再生検証: 関連・全Vitest、型チェック、本番ビルドを実行し問題の有無を報告
- [x] 他AI指摘1精査: 285A安全CBがexclusiveEntryRoutes通過後の汎用状態へ依存する構造、確認待ち消失・古い状態再開・直近5日12件化の影響を再現
- [x] 他AI指摘2精査: 285A・8035・5803・6981・6976の日次発火済み状態復元と、285A順張り・8035専用3方式を含む理由別SL/TP復元の実装範囲を確認
- [x] 他AI指摘3精査: enterPositionのDB保存失敗時にopenPositionsと発注指示が不整合になるかをコード・失敗注入テストで再現
- [x] 他AI指摘4精査: TARGET_STOCKSとACTIVE_ENTRY_SYMBOLSの実数、受信のみ銘柄数、既存回帰テスト・説明の不一致を確認
- [x] 他AI4指摘の採否報告: 正しい指摘、誤り・部分的誤り、修正優先度、7銘柄再シミュレーション要否をチャットで報告（精査中は本番ロジック変更なし）
- [x] 285A安全CB専用化案: 汎用大台状態へ流さず専用確認状態で管理し、保存KABUデータで勝率80%以上を維持する低過学習の条件・SL/TP・待機時間を検証（提案後に実装判断）
- [x] 方式別発火状態復元: 285A・8035・5803・6981・6976について、当日DB履歴から専用方式ごとの発火済み状態をサーバー再起動時に復元
- [x] DB失敗整合性精査: 仮予約＋失敗時ロールバック、銘柄単位ロック、冪等キーの各方式を同時リクエスト条件で比較し、安全な修正案を確定
- [x] Windows中継22銘柄化: WATCH_SYMBOLSへ6920・6758を追加し、クラウドTARGET_STOCKSと一致させる
- [x] 22銘柄整合性テスト: エントリー7銘柄・クラウド受信22銘柄・Windows監視22銘柄・受信のみ15銘柄を固定確認
- [ ] 変更後検証: 安全CB専用化の実装承認後、関連回帰、285A保存再生、7銘柄資金制約付き全期間再生、型チェック、本番ビルドを実行し結果を報告
### Phase 4: 全銘柄同時エントリー
- [x] 285A改善案精査: 安定版e0835e5dの53取引を方式別に再現し、他AI提示の基準値と入口・決済を照合
- [x] 285A改善案精査: 反転LONG TP1.0%/SL0.8%、順張りLONG TP0.7%/SL0.6%、反転SHORT利益保護を終値・次足始値で独立再計算
- [x] 285A改善案精査: 前半後半、近傍値、利益保護0.1%不利約定、PF・最大DD・1件依存を確認
- [x] 285A改善案精査: 7銘柄の各全保存期間を元金300万円・総エクスポージャ891万円で時刻順統合し、安定版と比較
- [x] 285A改善案精査: 隔離検証環境を削除し、本番コード未変更のまま採否と過学習リスクをチャットで報告
- [x] 後場BPRブロック精査: 現行エンジンの適用条件・対象銘柄・専用経路との優先順位をコード単位で特定
- [x] 後場BPRブロック精査: 保存KABUデータからブロック対象候補を復元し、通過時の入口・決済・勝敗・損益を確認
- [x] 後場BPRブロック精査: 現状維持・全銘柄撤廃・銘柄別撤廃を実エンジンで比較し、期間分割と近傍閾値を確認
- [x] 後場BPRブロック精査: 7銘柄全保存期間を元金300万円・総エクスポージャ891万円・資金制約付きで時系列統合比較
- [x] 後場BPRブロック精査: 隔離検証環境を削除し、本番コード未変更のまま採否と過学習リスクをチャットで報告
- [x] 2026-08-26前場成績調査: 本番取引5件の銘柄・時刻・専用方式・約定・決済・勝敗・損益をDB履歴から確定
- [x] 2026-08-26前場成績調査: 7銘柄の保存1分足・板スナップショット・受信本数・欠損時間を確認
- [x] 2026-08-26前場成績調査: 現行e0835e5d実エンジンで本日前場を再生し、本番取引との差異を取引単位で照合
- [x] 2026-08-26前場成績調査: 4損失をロジックどおり・約定差・板早期決済・データ欠損・資金競合に分類
- [x] 2026-08-26前場成績調査: 過去平均70%超との母数・期間・銘柄構成・資金制約・約定基準の差を確認
- [x] 2026-08-26前場成績調査: 本番ロジック未変更を確認し、原因・緊急度・対応方針をチャットで報告
- [x] 直近10営業日前場成績: 保存KABUデータが存在する直近10営業日と7銘柄の前場受信完全性を確定
- [x] 直近10営業日前場成績: 現行e0835e5dを元金300万円・総エクスポージャ891万円・資金制約付きで日別再生
- [x] 直近10営業日前場成績: 日別の取引数・勝敗・勝率・損益を検算してチャットで報告
- [x] 直近10営業日前場要因分析: 46取引の銘柄・専用シグナル・売買方向・勝敗・損益を現行e0835e5dで再生成
- [x] 直近10営業日前場要因分析: 銘柄別・シグナル別・LONG/SHORT別の勝率・損益・母数・損失寄与を比較
- [x] 直近10営業日前場要因分析: 全保存期間の同方式基準と比較し、最近だけ悪化した銘柄・方式を特定して報告
- [x] 2026-08-26 6146利益保護精査: 09:38 SHORTの最大含み益・戻り時刻・現行損切りまでの1分足推移を確定
- [x] 2026-08-26 6146利益保護精査: 発動値・保護値別に同一足禁止を含めた決済時刻・損益を再計算
- [x] 2026-08-26 6146利益保護精査: 過去の6146利益保護提案・実装有無をコード・TODO・履歴から確認して報告
- [x] 2026-08-26日次レポート: 本番日次レポート・rt_trades・rt_daily_summariesを照合して全取引を確定
- [x] 2026-08-26日次レポート: 取引件数・勝率・総損益・銘柄別・シグナル別・時間帯別成績を集計
- [x] 2026-08-26日次レポート: 損切り集中・不調方式・資金競合・発注指示・受信銘柄数の特記事項を確認して報告
- [x] 2026-08-26終日再生照合: 保存KABU 1分足・同時点板を現行e0835e5dへ実受信順で再投入
- [x] 2026-08-26終日再生照合: 標準時刻順でも再生し、7取引の時刻・方式・株数・決済・損益を本番DBと比較
- [x] 2026-08-26終日再生照合: 取引数・勝率・総損益の一致または差異原因をチャットで報告
- [x] 1日5敗前後の過去頻度: 現行e0835e5dで全保存営業日を前場・終日別に資金制約付き再生
- [x] 1日5敗前後の過去頻度: 5敗以上・勝率30%以下・本日2勝5敗に近い日を日別に抽出
- [x] 1日5敗前後の過去頻度: 発生日数・頻度・損益を検算し、本日が過去分布上どの程度異常か報告
- [x] 2026-08-26損失異常値精査: 本日5損失と同一銘柄・同一専用シグナルの過去取引を再生成
- [x] 2026-08-26損失異常値精査: 値幅・出来高倍率・MA傾き・VWAP乖離・始値比・反転速度・板BPRを勝敗別比較
- [x] 2026-08-26損失異常値精査: 過去勝ちを減らさない単独・複合ブロック候補と近傍値を探索
- [x] 2026-08-26損失異常値精査: 期間分割・取引数・損益への影響を確認し、低過学習で採用可能か報告
- [x] 6981・5803他AI案再精査: 他AIとの基準勝敗差と対象方式の定義・資金競合条件を確定
- [x] 6981・5803他AI案再精査: 6981案を方式単独・7銘柄統合・閾値近傍・取引減少率で再検証
- [x] 6981・5803他AI案再精査: 5803案と7月7日取引を方式単独・7銘柄統合・閾値近傍で再検証
- [x] 6981・5803他AI案再精査: 過学習リスクを比較し、追加検証候補・保留・不採用の最終判断を報告
- [x] 6981実装リスク評価: 3損失除外効果と新規MA条件・27.3%取引減・将来誤ブロック・資金再配分リスクを整理
- [x] 2026-08-26 SL整合性調査: 6146・6981・5803・6976のクラウド側理由別SLと実決済価格を確定
- [x] 2026-08-26 SL整合性調査: OrderBridge発注指示とWindows Executor側の保護SL生成・既定値を取引単位で照合
- [x] 2026-08-26 SL整合性調査: SL差によるDRY_RUN損益・将来自動注文への影響と修正優先度を報告
- [x] 6981 MA8フィルター実装: 寄り付きブレイクSHORTをMA8二本傾き-0.15%以上で停止し、6981専用経路だけへ限定
- [x] 6981 MA8フィルター実装: 7月15日・7月21日・8月26日の3損失停止と過去勝ち維持を保存KABU再生で確認
- [x] 6981 MA8フィルター実装: 他銘柄・他シグナル・SL/TP・OrderBridge・Windows Executorが未変更であることを回帰確認
- [x] SL不一致添付再精査: 8月26日のクラウド可変数量とExecutor100株固定のDRY_RUN損益差を再確認
- [x] SL不一致添付再精査: ローカル逆指値約定の監視・クラウド即時報告・ポジション自動同期の有無をコードで確認
- [x] SL不一致添付再精査: クラウドexitとローカルSLの競合時に二重決済・反対建玉を防ぐロックと冪等性を確認
- [x] SL不一致添付再精査: SL・TP・数量・positionId・strategyVersionを含む安全な契約と修正優先順位を報告
- [x] SL追加添付再精査: Issue #1119の投稿者・回答状況を確認し、公式見解との表現を修正
- [x] SL追加添付再精査: HoldID・ClosePositionsの公式仕様と公開Issueの取得・指定障害報告を確認
- [x] SL追加添付再精査: PARTIALLY_OPEN／PARTIALLY_CLOSEDと実約定数量反映を含む状態契約を再設計
- [x] SL追加添付再精査: DRY_RUN／LIVE二重許可・指示有効期限・CashMargin事前検査の優先度を確定して報告
- [ ] 10銘柄同時エントリー・シグナル発火順エントリー
- [ ] 全銘柄の成績を1日ごとに見れるUI
- [x] 添付Pasted_content_02再精査: 6146利益保護の同一5取引直接効果と資金解放後の追加・消失取引を分解
- [x] 添付Pasted_content_02再精査: 6146保護決済だけを0.1%・0.2%・0.3%不利にした耐性を資金制約付きで比較
- [x] 添付Pasted_content_02再精査: 5803の最低利益0.4%・0.45%・早期利確完全停止を最大DD・戻し・平均保有時間で比較
- [x] 添付Pasted_content_02再精査: 5803板読み決済の個別取引と0.4%到達後のTP・反転経路を取引単位で確認
- [x] 添付Pasted_content_02再精査: 統合版で消えた勝ち・新規負けの銘柄・方式・時刻・損益・資金拘束を特定
- [x] 添付Pasted_content_02再精査: 出口の同一足・ギャップ・TP/SL/保護優先順位を保守的規則で再確認
- [x] 添付Pasted_content_02再精査: 6981アウト・オブ・サンプル扱いと修正後の候補優先順位を報告
- [x] 2026-08-27 DRY_RUN日次報告: 当日のrt_trades・rt_daily_summaries・受信状況・未決済をDBから確定
- [x] 2026-08-27 DRY_RUN日次報告: 入口と決済を対応付け、全体・銘柄別・シグナル別成績を再計算
- [x] 2026-08-27 DRY_RUN日次報告: 損切り多発・特定シグナル不調・発注指示異常を確認して報告
- [x] 添付Pasted_content_03精査: Pasted_content_02および既存追加検証との主張・数値差分を確認
- [x] 添付Pasted_content_03精査: 6146利益保護の直接効果・入替効果・同時刻処理順・0.1〜0.3%不利約定耐性を確定
- [x] 添付Pasted_content_03精査: 5803の0.4%・0.45%・完全停止を統合DD・入替取引・100株固定感度まで比較
- [x] 添付Pasted_content_03精査: 6981のインサンプル／アウト・オブ・サンプル区分と追加変更不要判断を確認
- [x] 添付Pasted_content_03精査: 出口約定規則と複数候補のシャドー記録案を評価し、修正後優先順位を報告
- [x] 2026-08-26〜27出口再検証: 6146利益保護0.8→0.7%を実取引順・資金制約込みで再生
- [x] 2026-08-26〜27出口再検証: 6146自身の決済差と資金解放による追加・入替取引を分離
- [x] 5803板読み早期利確再検証: 安値反転LONG全件で固定TP/SLより良かった決済事例の有無を確認
- [x] 5803板読み早期利確再検証: 有効事例・不利益事例と完全停止判断を分かりやすく報告
- [x] 6146利益保護実装: 寄り付き10本安値更新SHORT限定で+0.8%到達後、次足以降+0.7%戻り決済を追加
- [x] 6146利益保護実装: 発動足同時決済禁止、SL優先、TP同時時は保護優先、ギャップ時不利価格を保証
- [x] 6146利益保護実装: 発動状態をDB保存または保存足から復元し、再起動後も二重発動・状態消失を防止
- [x] 5803出口変更: 安値反転ブレイクLONGだけ板読み早期利確を無効化し、他方式・他銘柄は維持
- [x] 6146・5803出口変更: 単体・復元・保存KABU再生・型チェック・ビルド・全Vitestで非干渉を確認
- [x] 6146・5803出口変更自己レビュー: 実装差分と稼働中コードがcheckpoint c7e452e5に一致するか確認
- [x] 6146利益保護自己レビュー: 発動・同一足・SL/TP優先・ギャップ・日付変更・再起動復元を監査
- [x] 5803出口変更自己レビュー: 安値反転LONGだけが板読み利確対象外で、他方式・他銘柄が維持されるか監査
- [x] 6146・5803出口変更自己レビュー: OrderBridge発注理由・数量・DRY_RUN連携と既知のLIVE不一致への影響を確認
- [x] 6146・5803出口変更自己レビュー: 不足テストを補完し、対象回帰・全Vitest・型チェック・ビルドを再実行
- [x] 現行シグナル成績精査: 7銘柄の完全保存日と現行119921f8の専用シグナル一覧を確定
- [x] 現行シグナル成績精査: 保存KABUデータを元金300万円・総エクスポージャ891万円・時刻順で全期間再生
- [x] 現行シグナル成績精査: シグナル別の取引数・勝敗・勝率・損益・PFを全期間と直近で比較
- [x] 現行シグナル成績精査: 低勝率を母数不足・最近悪化・全期間不調へ分類し、停止・観察の優先度を報告
- [x] 6146利益保護再精査: 596fb980とc7e452e5の8月7日〜21日・12取引・100株比較を取引単位で再現
- [x] 6146利益保護再精査: 8月26日・27日の損失救済と9日間の利益削減が期間差で両立するか確認
- [x] 6146利益保護再精査: 全保存期間の寄り付きSHORT直接効果を救済・利益削減・不変へ分解
- [x] 6146利益保護再精査: 7銘柄・元金300万円・891万円上限の統合損益と資金解放効果を再確認
- [x] 6146利益保護再精査: 停止・維持・再設計の判断を本番変更なしで報告
- [x] SHORT地合い条件精査: 現行119921f8・6月26日旧版・監視22銘柄・主力7銘柄・45日データ条件を確定
- [x] SHORT地合い条件精査: 各シグナル時点までの実受信データだけでギャップ中央値・始値比中央値・安値距離を再構築
- [x] SHORT地合い条件精査: 2条件あり・なしを現行版と旧版で資金制約付き再生し、提示された件数・勝敗・損益を照合
- [x] SHORT地合い条件精査: 停止損失・勝ち誤停止・LONG転換・6146利益保護取引の維持を取引単位で確認
- [x] SHORT地合い条件精査: 閾値近傍・発動3日依存・データ不足・同時刻処理順・受信遅延・中央値更新タイミングを評価
- [x] SHORT地合い条件精査: 軽量なシャドー判定と本番直接適用の実装方式を比較し、採否を本番変更なしで報告
- [x] 2026-08-28 DRY_RUN日次報告: 当日のrt_trades・rt_daily_summaries・未決済・受信状況をDBから確定
- [x] 2026-08-28 DRY_RUN日次報告: 入口と決済を対応付け、全体・銘柄別・シグナル別成績を再計算
- [x] 2026-08-28 DRY_RUN日次報告: 損切り集中・不調シグナル・発注指示・受信異常を確認して報告
- [x] 2026-08-28ブロック取引精査: 証拠金・同時保有・業種上限で停止した入口候補を実受信順で抽出
- [x] 2026-08-28ブロック取引精査: 各候補を保存足・同時点板・現行SL/TPと出口規則で個別仮想決済
- [x] 2026-08-28ブロック取引精査: 実取引・ブロック取引・合算をシグナル別件数・勝敗・勝率・損益で比較
- [x] 2026-08-28ブロック取引精査: 一時検証物を削除し、資金制約の機会損益と注意点を報告
- [x] 2026-08-26〜28統合表示: 3日間の実取引と証拠金ブロック候補を実受信順で確定
- [x] 2026-08-26〜28統合表示: 8月26日・27日のブロック候補を現行出口規則で個別仮想決済
- [x] 2026-08-26〜28統合表示: 実取引・ブロック取引を日付順・シグナル別に件数・勝敗・勝率・損益集計
- [x] 2026-08-26〜28統合表示: 各シグナルの現行ロジック全保存期間の過去勝率・損益を同じ表に併記
- [x] 2026-08-26〜28統合表示: 一時検証物を削除し、重複再試行を除いた統合結果を報告
- [x] 285Aロジック再検証: 現行5方式・SL/TP・完全保存日と直近5日／全保存日の基準成績を確定
- [x] 285Aロジック再検証: 直近5完全保存日の全取引・負け・ブロック候補・方式競合を取引単位で分析
- [x] 285Aロジック再検証: 直近5日勝率75%以上となる低学習な入口・競合・出口候補を比較
- [x] 285Aロジック再検証: 固定候補を全保存営業日に適用し勝率70%以上・損益・PF・DD・期間分割を確認
- [x] 285Aロジック再検証: 7銘柄資金競合・近傍値・処理順感度を確認し、本番変更なしで候補を報告
- [x] 285A直近3日全シグナル比較: 8月26〜28日の当時仕様・実取引・証拠金ブロック候補を確定
- [x] 285A直近3日全シグナル比較: 証拠金上限解除で変更前の全入口候補を時系列再生
- [x] 285A直近3日全シグナル比較: 順張りLONG+0.5%・SHORT-1.5%適用後を同条件再生
- [x] 285A直近3日全シグナル比較: 全取引を維持・停止・時刻変更・追加へ分類し勝敗・損益を比較
- [x] 285A直近3日全シグナル比較: 一時検証物を削除し、本番変更なしで結果を報告
- [x] 285A全発火シグナル再検証: 証拠金ブロックも母数に含む全発火シグナルの定義と完全保存日を確定
- [x] 285A全発火シグナル再検証: 現行条件を直近5日・全保存期間で証拠金上限なし再生して基準成績を再集計
- [x] 285A全発火シグナル再検証: 直近5日75%以上・全期間70%以上・損益非悪化の低学習候補を探索
- [x] 285A全発火シグナル再検証: 候補のPF・DD・期間分割・近傍値・勝ち誤停止・方式別成績を確認
- [x] 285A全発火シグナル再検証: 7銘柄資金制約付き統合の採用取引・他銘柄・処理順への影響を確認
- [x] 285A全発火シグナル再検証: 一時検証物を削除し、本番変更なしで修正後候補を報告
- [x] 285A他AI最終候補精査: 119921f8・全発火シグナル・47保存日・直近5日・出口約定規則を固定
- [x] 285A他AI最終候補精査: 現行・始値比候補・反転SHORT3.0%＋順張りLONG利益保護候補の成績を照合
- [x] 285A他AI最終候補精査: 反転SHORT停止2件と順張りLONG利益保護7件の直接効果・勝ち利益削減を取引単位で分解
- [x] 285A他AI最終候補精査: 閾値近傍・不利約定・同一足・ギャップ・期間分割・状態復元を検証
- [x] 285A他AI最終候補精査: 7銘柄資金制約付き統合で他銘柄・取引順・DDへの影響を確認
- [x] 285A他AI最終候補精査: 一時検証物を削除し、本番変更なしで妥当性と修正後候補を報告
- [x] 285A始値比条件実装: 順張りLONGを始値比+0.5%以上、順張りSHORTを-1.5%以下へ変更
- [x] 285A始値比条件実装: 反転LONG・反転SHORT・安全CB・SL/TP・利益保護・他6銘柄への非干渉を確認
- [x] 285A始値比条件実装: 境界値・銘柄限定・日次発火済み状態と再起動復元の恒久回帰を追加
- [x] 285A始値比条件実装: 保存KABU再生・7銘柄資金制約・全Vitest・型チェック・本番ビルドを確認
- [x] 8035ロジック再検証: 現行3方式・SL/TP・完全保存日と証拠金ブロックを含む全発火シグナル基準を確定
- [x] 8035ロジック再検証: 直近5完全営業日の全取引・負け・ブロック候補・方式競合を取引単位で分析
- [x] 8035ロジック再検証: 直近5日勝率80%以上となる低学習な入口・競合・出口候補を比較
- [x] 8035ロジック再検証: 固定候補を全保存営業日に適用し勝率75%以上・損益・PF・DD・期間分割を確認
- [x] 8035ロジック再検証: 7銘柄資金競合・近傍値・処理順感度を確認し、本番変更なしで候補を報告
- [x] 8035短期ブレイク提案精査: 10:00〜10:30の5本ブレイク・MA8・出来高・TP/SL/時間決済を保存KABUデータのみで独立再生
- [x] 8035短期ブレイク提案精査: 新方式単独・非発火時の現行予備・損失後再評価を取引単位と近傍値で比較し、将来情報混入を確認
- [x] 8035短期ブレイク提案精査: 7銘柄資金制約・発火順感度を確認し、本番変更なしで採否を報告・一時検証物を削除
- [x] 8035短期ブレイク統合差分調査: 他6銘柄の取引変動を取引単位で照合し、共有状態・処理順・再生構成の影響を切り分け
- [x] 8035短期ブレイク統合差分調査: 銘柄別に独立固定した取引履歴を用い、8035候補のみ差替えた資金制約付き統合結果を再計算
- [x] 8035短期ブレイク統合差分調査: 原因・正しい統合影響・採用判断を報告し、一時検証物を削除
- [x] 8035短期ブレイク実装: 10:00〜10:30の5本終値ブレイク・MA8二本傾き・出来高1.2倍を現行3方式より優先
- [x] 8035短期ブレイク実装: TP0.5%・SL0.6%・最大15分後次足始値・板読み早期利確無効を方式限定で適用
- [x] 8035短期ブレイク実装: 非発火時のみ10:31以降に現行3方式を予備利用し、損失後再評価は追加しない
- [x] 8035短期ブレイク実装: 日次発火済み・証拠金ブロック・再起動復元・専用SL/TP復元を整合させる
- [x] 8035短期ブレイク実装: 境界値・保存KABU再生・他6銘柄非干渉・既存回帰・型・ビルドを確認
- [x] 8035実装後再検証: 短期ブレイク＋現行予備の固定条件と全発火シグナル評価基準を確認
- [x] 8035実装後再検証: 証拠金ブロック候補を100株で仮想約定し、直近5完全営業日と全保存営業日の勝率・損益を再計算
- [x] 8035実装後再検証: 目標達成を確認し、追加の低学習候補探索・本番変更は不要と判断
- [x] 8035実装後再検証: 一時テスト・ログ・分析物を削除し、本番コードの差分有無を確認
- [x] 6981ロジック再検証: 現行専用方式・SL/TP・直近5完全営業日・全保存営業日の対象を確定
- [x] 6981ロジック再検証: 証拠金ブロック候補を100株固定で仮想約定し、全発火シグナルの基準成績を再生
- [x] 6981ロジック再検証: 直近5日80%以上・全期間75%以上を目標に低学習候補を比較
- [x] 6981ロジック再検証: 近傍値・期間分割・取引減少・7銘柄資金競合を確認し、本番未変更で報告
- [x] 6981ロジック再検証: 一時テスト・ログ・分析物を削除し、本番コード差分を確認
- [x] 6981候補直接比較: SHORT開始09:55案と始値比-3.8%以下案を同一データ・100株固定で再生
- [x] 6981候補直接比較: 直近5日・全期間・完全保存日・期間分割・方式別・取引差分・近傍値を比較
- [x] 6981候補直接比較: 7銘柄資金制約と同時刻処理順感度を比較し、最適候補を本番未変更で報告
- [x] 6981候補直接比較: 一時worktree・テスト・ログ・分析物を削除し、本番コード差分を確認
- [x] 6981開始09:55実装: 寄り付きブレイクSHORT開始を09:45から09:55へ変更し、他条件・他銘柄を維持
- [x] 6981開始09:55実装: 09:54停止・09:55以降許可の境界値と日次発火・復元を回帰確認
- [x] 6981開始09:55実装: 保存KABU直近5日・全期間期待値、7銘柄非干渉、全Vitest・型・ビルドを確認
- [x] 6981開始09:55実装: DRY_RUN維持を自己レビューし、チェックポイントを保存
- [x] 6976ロジック再検証: 現行3方式・方向別SL/TP・直近5完全営業日・全保存営業日の対象を確定
- [x] 6976ロジック再検証: 証拠金ブロック候補を100株固定で仮想約定し、全発火シグナルの基準成績を再生
- [x] 6976ロジック再検証: 直近5日80%以上・全期間75%以上を目標に現行調整と新方式候補を比較
- [x] 6976ロジック再検証: 近傍値・期間分割・取引減少・7銘柄資金競合・処理順感度を確認
- [x] 6976ロジック再検証: 最有力候補を本番未変更で報告し、一時worktree・テスト・ログを削除
- [x] 6976候補直接比較: 5本・5分ハイブリッド案と10本・60分ハイブリッド案を同一保存KABUデータ・100株固定で再現
- [x] 6976候補直接比較: 直近5日・全期間・完全保存日・期間分割・方向別・取引差分を比較
- [x] 6976候補直接比較: 近傍値・スリッページ・長時間保有・TP＜SL構造のリスクを評価
- [x] 6976候補直接比較: 7銘柄資金制約と同時刻処理順感度を比較し、最適候補を本番未変更で報告
- [x] 6976候補直接比較: 一時worktree・テスト・ログ・分析物を削除し、本番コード差分を確認
- [x] 6976 A案再監査固定: 数値化した板・BPR・共通ATR・欠損時・再探索条件を候補仕様としてGitへ保存
- [x] 6976 A案再監査固定: 本番未有効の候補経路を実エンジンへ監査専用で組み込み、現行取引への非干渉を保証
- [x] 6976 A案再監査固定: 全21取引・新方式16件・現行SHORT予備5件をKABU由来2,202足fixtureと回帰テストで固定
- [x] 6976 A案再監査固定: 旧『除外7件』仮定は同一状態遷移で再現せず、初動条件通過後に板だけで拒否された全18候補と確認失敗理由を固定
- [x] 6976 A案再監査固定: 確認成功・確認失敗後の同一足再検出・日付変更・発火済み状態遷移を恒久テスト化
- [x] 6976 A案再監査固定: 独立再監査コマンド、対象9件、DBソース1件、全Vitest 399件中396成功・1スキップ・既知J-Quants未設定2件のみ失敗、型・ビルドを確認
- [x] 6976 A案監査再精査: 5分時間決済が完成済み足の始値へ遡る非因果的処理と確認し、時間決済8件の三価格比較を独立再現
- [x] 6976 A案監査再精査: 24区間fixtureのSHA-256は802cd234で一致、ただし全46日非発火証明は不足と確認
- [x] 6976 A案監査再精査: 板読み早期利確の原案差、板欠損許可、10:30初動と確認足境界、決済理由未固定を確認
- [x] 6976 A案監査修正: 本番未有効・DRY_RUN維持のまま、5分以上となる最初の確定足終値による因果的出口へ監査専用経路を変更
- [x] 6976 A案監査修正: 全46保存日・14,719足の6976 KABU足・同時点板をDB不要fixtureとして固定し、全日・全21取引・全除外を照合
- [x] 6976 A案監査修正: 全21取引の決済理由、10:29初動/10:30確認、確認失敗再検出、板欠損拒否、板読み利確無効を恒久テスト化
- [x] 6976 A案監査修正: 0.05%・0.10%約定悪化と保存ID順93,072足の7銘柄資金制約統合を再計算し、期待値・監査手順へ固定
- [x] 6976 A案監査修正: 対象13件、DB全46日ソース1件、7銘柄統合2シナリオ、全Vitest 403件中399成功・2スキップ・既知J-Quants未設定2件のみ失敗、型・ビルド・差分自己レビューを確認
- [x] 6976候補B再確認: 残存検証コードから10本・60分ハイブリッドの入口・確認・出口・予備経路を正確に復元
- [x] 6976候補B再確認: 保存KABU全46日fixtureで直近5完全営業日（8/20・21・26・27・28）を100株固定・証拠金制限なしで再生
- [x] 6976候補B再確認: 日別の時刻・方向・入口価格・出口・100株損益と5日集計（5勝0敗・+24,463.40円）を確認
- [x] 6976候補B・30分案精査: 15・20・30・60分の単独全期間成績、保有時間分布、直近5日を同一因果的出口で再計算
- [x] 6976候補B・30分案精査: 保存ID順93,072足・総エクスポージャ891万円・可変株数で現行と各保有時間を統合比較し、15〜60分が同一結果になることを確認
- [x] 6976候補B・30分案精査: 8月21日6976の8,852,000円使用中ブロックと5803・6981の3取引差を取引単位で照合
- [x] 6976候補B・30分案精査: 提示集計は09:00始値では214件を再現する一方、勝敗・損益と15分差は同一実エンジンで再現せず、30分優位は未確定と判定
- [x] 6976候補B30分DRY_RUN: 09:00以降最初の足を当日始値とし、09:45〜10:59初動・11:00最終確認の10本終値ブレイク、初動出来高1.0倍、MA8二本傾き±0.05%、次足方向確認を正式仕様化
- [x] 6976候補B30分DRY_RUN: 朝初動SHORTと後場LONGを停止し、前場候補B＋既存後場SHORTだけを使用、TP0.6%・SL1.0%・最大30分確定足終値・11:27前場決済・板読み早期利確なしを実装
- [x] 6976候補B30分DRY_RUN: ATR・証拠金・共通ゲート拒否では日次発火枠を消費せず、拒否理由を記録して次の有効候補を再探索し、実エントリー成功時だけ発火済みにする
- [x] 6976候補B30分DRY_RUN: 全46日・14,719足fixtureで全33取引（primary30・後場SHORT3）、28勝5敗・84.85%・+157,872.01円/100株、全決済理由、確認失敗42件を実エンジン期待値へ固定
- [x] 6976候補B30分DRY_RUN: 証拠金・ATR拒否後再探索、SL/TP・発火状態・確認待ち再起動復元、16時DRY_RUN乖離監視欄、第三者監査手順を恒久テスト化
- [x] 6976候補B30分DRY_RUN: 保存ID順7銘柄93,072足で214件164勝50敗・+3,831,483円を再現。Windows参照版DRY_RUN=True、LIVE注文経路非変更、関連182件・復元51件・報告61件成功、全419件中415成功・2スキップ・既知J-Quants未設定2件のみ失敗、型・ビルド成功を確認
- [x] 6976候補B安全再確認: MA8二本傾き±0.05%は今回追加ではなく、残存原B検証コードの既存仕様と確認
- [x] 6976候補B安全再確認: Windows CRLFチェックアウトでfixture生バイトSHAが変わり得るため、.gitattributesで監査JSONをtext eol=lfへ固定
- [x] 6976候補B安全再確認: liveOrderApproved=falseは設定だけで注文生成・Windows Executorへ未接続だったことを確認
- [x] 6976候補B安全修正: 候補BのLIVE新規注文をクラウド指示作成境界とWindows Executor/relayの双方で強制拒否し、決済は許可する回帰を追加
- [x] 6976候補B安全再確認: ATR・証拠金・確認失敗イベントはメモリー依存で、16時通知前の再起動で消失することを確認
- [x] 6976候補B安全修正: 専用DB表へ確認失敗・共通ゲート拒否を冪等保存し、16時レポートでDB復元・メモリー重複排除する回帰を追加
- [x] 6976候補B安全修正: DRY_RUN維持・全33取引期待値非変更、関連30件成功、全424件中420成功・2スキップ・既知J-Quants未設定2件のみ失敗、型・ビルド成功を確認
- [x] 6976候補B運用確認: 本番DBにrt_taiyo_candidate_b_events表・全必要列・複合一意制約が適用済みとinformation_schemaで照合
- [x] 6976候補B運用確認: 最新Executor記録は2026-08-28にDRY_RUN=trueで実行済みだが、バージョン・ホスト・スクリプトSHA送信欄がなく稼働中版はクラウドから特定不能と確認
- [x] 6976候補B運用確認: Git参照版SHA-256を算出し、実稼働Windows版との同一性はWindows側ファイル照合が必要と確定
- [x] 5803再検証: 現行3方式・47保存日14,568足・37完全日・証拠金ブロックを含む全発火100株評価の母集団を固定
- [x] 5803再検証: 直近5完全営業日は7件6勝1敗・85.71%・+24,166.40円で目標80%以上を達成
- [x] 5803再検証: 全47保存日は43件33勝10敗・76.74%・+119,994.10円、方式別・期間分割・10敗を集計
- [x] 5803再検証: 新方式は不要と判断し、安値反転LONGのBPR上限0.70〜0.80を実エンジン近傍検証
- [x] 5803再検証: 現行は0.10%約定悪化後も33勝10敗・+97,032円、BPR0.72〜0.74候補は41件34勝7敗・82.93%・+129,329.20円、7銘柄統合で現行比+46,602円を確認
- [x] 5803再検証: 本番コード・DRY_RUN未変更のまま、現行維持とBPR0.72〜0.74の追加検証候補という採否判断を報告
- [x] 6857再検証: 現行LONG・SHORT・損切り後再評価、47保存日15,351足・43完全日、証拠金ブロックを含む全発火100株評価の母集団を固定
- [x] 6857再検証: 直近5完全日は5件3勝2敗・60.0%・+43,732円で、8/21・8/26の初回SHORT損失を不足要因と特定
- [x] 6857再検証: 全保存期間は28件22勝6敗・78.57%・+459,915円、初回LONG/SHORT・再評価別・前中後期を集計
- [x] 6857再検証: 初回SHORTだけ『始値比+1.9%以上かつ出来高2.2倍未満』を停止する単純候補を近傍検証し、再評価SHORTは維持
- [x] 6857再検証: 候補は23件20勝3敗・86.96%・+486,137円、直近3勝0敗、0.10%悪化後19勝4敗・82.61%・+413,382円、7銘柄統合は214件166勝48敗・+3,985,091円を確認
- [x] 6857再検証: 本番コード・DRY_RUN未変更のまま、現行は直近目標未達、上記候補をDRY_RUN実装前の追加監査候補として報告
- [x] 6857候補比較: 他AIのSHORT開始09:55案と弱出来高ブロック案を同じ47保存日・15,382足・全発火100株で再生
- [x] 6857候補比較: 09:55案26件22勝4敗・84.62%・+527,621円、弱出来高案23件20勝3敗・86.96%・+486,137円、直近はいずれも3勝0敗・+112,302円と照合
- [x] 6857候補比較: 09:55〜09:56は同一、09:54・09:57以降で劣化。弱出来高案の既確認近傍、期間分割、0.05/0.10%約定悪化を比較
- [x] 6857候補比較: 保存ID順93,072足・891万円制約で09:55案215件165勝50敗・+3,903,574円、弱出来高案214件166勝48敗・+3,985,091円を再現
- [x] 6857候補比較: 単独損益は09:55案、勝率・PF・DD・0.10%耐性・統合損益は弱出来高案が優位。低過学習性は09:55案がやや優位と判定し、本番コード未変更で報告
- [x] 6857弱出来高案実装: 初回高値失速SHORTで始値比+1.9%以上かつ初動出来高2.2倍未満を見送り、再評価SHORT・LONG・SL/TPは維持
- [x] 6857弱出来高案実装: 見送り時に日次発火枠を消費せず、8/21・8/26の後続LONGへ再探索する状態遷移を固定
- [x] 6857弱出来高案実装: 始値比1.9%・出来高2.2倍の境界、初回限定、再評価非対象を純粋関数・実エンジン回帰で固定
- [x] 6857弱出来高案実装: 保存KABU全47日で23件20勝3敗・+486,137円、直近3勝0敗・+112,302円の全取引期待値を固定
- [x] 6857弱出来高案実装: 保存ID順7銘柄214件166勝48敗・+3,985,091円、既存候補A/B・他銘柄・LIVE安全ガードへの非回帰を確認
- [x] 6857弱出来高案実装: DRY_RUN維持、対象9件・候補A統合1件成功、全431件中426成功・3スキップ・既知J-Quants未設定2件のみ失敗、型・ビルド・差分自己レビュー完了
- [x] 6146再検証: 現行LONG・SHORT・決済後反対方向再評価、13保存日・4,065足、証拠金ブロックを含む全発火100株評価の母集団を固定
- [x] 6146再検証: 直近5完全営業日の全シグナルを再生し、現行7件4勝3敗・57.14%の3敗がすべてLONGであることを取引単位で確認
- [x] 6146再検証: 全保存期間の現行17件12勝5敗・70.59%・+654,466円/100株をLONG/SHORT・期間分割・PF・最大DDで集計
- [x] 6146再検証: LONG利益保護・時間決済・TP/SL・MA傾き×出来高・始値比レンジを実エンジンで比較し、後続再探索を含め単独では採用基準未達または損益悪化と確認
- [x] 6146再検証: LONG時間窓09:45〜11:10候補は全14件11勝3敗・78.57%・+709,680円、直近5件4勝1敗・80.00%・+222,638円を再現
- [x] 6146再検証: 開始09:41〜09:45・終了11:01〜11:10で同成績帯を確認し、09:40・09:46・11:14で崩れる境界感度と小標本・事後探索リスクを明示
- [x] 6146再検証: 09:45〜11:10候補は0.05%悪化後11勝3敗・+666,152.50円、0.10%悪化後11勝3敗・+622,625円、PF8.47・最大DD32,480円を確認
- [x] 6146再検証: 保存ID順93,072足・891万円制約の7銘柄統合は現行214件166勝48敗・+3,985,091円、候補211件166勝45敗・+4,127,147円を再現
- [x] 6146再検証: 統合差+142,056円を6146自身+88,524円と資金解放による6857+53,532円へ分解し、資金無制限では他6銘柄が完全一致するため共有状態不整合ではないと確認
- [x] 6146再検証: 本番コード・DRY_RUNロジック未変更のまま、09:45〜11:10を確信度中〜低のシャドー／追加前向き検証候補とし、明示実装指示前は現行維持と判断
- [x] 6146他AI案比較: SHORT固定TP0.8%・利益保護停止・LONG 09:45〜11:05を最新実エンジンで再現し、14件11勝3敗・78.57%・+659,951円、直近5件4勝1敗・+240,563円を確認
- [x] 6146他AI案比較: 提示12日/4,004足は、最新13日/4,065足から取引なしの8/25部分保存61足を除いた範囲と特定し、成績への影響なし、完全保存10日12件9勝3敗・+497,967円を照合
- [x] 6146他AI案比較: 利益保護＋LONG 09:45〜11:05/11:10は14件11勝3敗・+709,680円、固定TP案は同勝率で単独-49,729円、直近+17,925円。PF8.47対7.95、最大DDはいずれも32,480円と比較
- [x] 6146他AI案比較: 固定TP案の決済価格基準0.05/0.10%不利は+616,275.87円/+572,600.75円で提示値を再現。入口価格基準でも+616,423.50円/+572,896円、11勝3敗を維持
- [x] 6146他AI案比較: LONG開始09:42/09:45・終了11:05、SHORT TP0.5〜0.8%で目標達成を確認。ただし終了10:55では13件10勝3敗・76.92%へ取引減、TP0.8%が同勝率帯で最大損益
- [x] 6146他AI案比較: 最新93,072足・891万円制約では現行214件166勝48敗・+3,985,091円、利益保護時間窓211件166勝45敗・+4,127,147円、固定TP時間窓211件168勝43敗・+4,202,185円を再現
- [x] 6146他AI案比較: 固定TP案は利益保護案比+75,038円。6146自身-49,729円に対し、資金解放による6981+51,648円・8035+72,765円・5803+354円で相殺。取引総数は同じで追加ではなく採用時刻の置換と確認
- [x] 6146他AI案比較: 資金無制限では他6銘柄が完全一致し固定TP案は6146差-49,729円のみ。提示の統合絶対値は旧基準で再現しないが、固定TP案が7銘柄全体で優位という順位と機序は最新基準でも成立
- [x] 6146他AI案比較: 7銘柄共有資金を主目的とする総合候補は固定TP0.8%＋LONG 09:45〜11:05、6146単独重視なら利益保護＋時間窓と判断。本番コード未変更・明示実装指示前は現行維持
- [x] 6146実装: 確認型10本高値更新LONGの発火時間を09:45〜11:10へ限定し、SHORT時間・入口・TP2.0%・既存利益保護0.8%→0.7%を維持
- [x] 6146実装: 09:44まで非発火、09:45から発火、11:10まで発火、11:11以降非発火の境界回帰を追加
- [x] 6146実装: 保存KABU全13日4,065足で14件11勝3敗・+709,680円、直近5完全日5件4勝1敗・+222,638円を実エンジン再現
- [x] 6146実装: 保存ID順7銘柄93,072足・891万円制約で211件166勝45敗・+4,127,147円を再現し、6976候補A監査シナリオも202件156勝46敗・+3,993,425円へ整合
- [x] 6146実装: Git保存Windows Executor/relayのDRY_RUN=True、6976候補B LIVE二重拒否、6857弱出来高・他6銘柄ロジック・16時日次報告を非変更で維持
- [x] 6146実装: 対象113件成功、全433件中428件成功・3件スキップ・既知JQUANTS_API_KEY未設定2件のみ失敗。TypeScript型検査・本番ビルド・差分検査成功
- [x] 6526再検証: 現在は監視対象だがACTIVE_ENTRY_SYMBOLS外で専用売買経路なしと確認。仮に汎用ロジックを許可した46保存日・15,079足、38完全日、全発火100株評価を母集団として固定
- [x] 6526再検証: 汎用ロジック現行は直近5完全日5件2勝3敗・40.00%・-2,589円/100株で、LONG1敗・SHORT2敗を含み目標80%未達と確認
- [x] 6526再検証: 汎用ロジック現行は全67件28勝39敗・41.79%・-5,703円、PF0.92・最大DD15,281円。完全日61件25勝36敗・40.98%で全期間75%未達
- [x] 6526再検証: 現行取引への単純な時間・方向・始値比・板フィルターでは、後続再探索を含め直近80%・全期間75%を同時達成できず、新しい前場SHORT方式を比較
- [x] 6526再検証: 低過学習候補を09:45〜10:15、陰線終値で直前5本安値更新、MA8二本傾き-0.05%以下、出来高20本平均1.5倍以上、日次1回SHORT、SL/TP各0.8%、最大20分確定足終値、板入口/早期利確なしと定義
- [x] 6526再検証: 低過学習候補は全22件17勝5敗・77.27%・+20,758円/100株、直近5日4件4勝0敗・+5,553円、完全日21件16勝5敗・76.19%、PF4.13・最大DD3,091円を実エンジン再現
- [x] 6526再検証: 低過学習候補は0.05%悪化後17勝5敗・+18,250円、0.10%悪化後17勝5敗・+15,741円。MA傾き0.04〜0.05%、終了10:15〜10:20で同成績帯、出来高1.6倍でも76.19%を維持
- [x] 6526再検証: 高勝率0.06%案は全21件17勝4敗・80.95%・+22,749円、完全日80.00%、PF5.90だが、7/22のMA傾き-0.055%の1敗だけを境界で除外するため低過学習候補より確信度を下げる
- [x] 6526再検証: 広い10本案は全32件24勝8敗・75.00%・+21,213円、確認型LONG案は20件15勝5敗・75.00%で、いずれも目標余裕・約定耐性または損益で低過学習5本SHORT案に劣後
- [x] 6526再検証: 現行7銘柄93,072足・891万円制約は211件166勝45敗・+4,127,147円。6526低過学習案を8銘柄目として加えると108,151足・231件177勝54敗・+4,052,852円で-74,295円
- [x] 6526再検証: 8銘柄統合では6526自身19件14勝5敗・+181,975円だが、資金競合で285A-186,071円・6976-36,210円・8035-34,064円などの取引時刻が置換。資金無制限では既存7銘柄が完全一致し、共有状態不整合ではないと確認
- [x] 6526再検証: シグナル品質目標は低過学習5本SHORT案で達成するが、現行7銘柄への追加は保存期間の統合損益を悪化させるため、実装せずシャドー候補として前向き確認を推奨。本番コード・DRY_RUNロジック未変更
- [x] 6526他AI案比較: 09:30〜11:00・10本高値更新・次足確認・LONG専用・TP0.5%/SL0.8%・最大20分を最新実エンジンと全46日15,079足で再現
- [x] 6526他AI案比較: 当日始値を08:59準備足ではなく09:00以降最初の足と定義すると19件16勝3敗・84.21%・+11,823.90円、直近3勝0敗・+2,953.73円を提示値どおり再現。08:59足を使うと15勝4敗となるため定義固定が必要
- [x] 6526他AI案比較: 6/17〜7/7は4勝0敗、7/8〜7/31は7件5勝2敗・71.43%、8/3〜8/28は8件7勝1敗・87.50%。PF3.01・最大DD2,170.78円を確認
- [x] 6526他AI案比較: 0.05%悪化後16勝3敗・+9,598.33円、0.10%後15勝4敗・+7,372.75円、0.15%後15勝4敗・+5,147.18円、PF2.53/2.10/1.72を再現
- [x] 6526他AI案比較: 高値更新5/8/10/12/15本、MA傾き0.03〜0.07%、出来高1.05〜1.40倍、開始09:28〜09:36、終了10:55〜11:10の2,500組が直近80%・全期間75%を維持。緩い端20件16勝4敗、厳しい端17件14勝3敗も実エンジン確認
- [x] 6526他AI案比較: 出口はTP0.5%/SL0.8%/20分が19件16勝3敗で最良。TP0.6%では14勝5敗・73.68%、SL0.7%では14勝5敗・73.68%、15分/30分では15勝4敗・78.95%となり入口より敏感
- [x] 6526他AI案比較: 最新7銘柄211件166勝45敗・+4,127,147円を基準に、6526追加後は229件182勝47敗・+4,281,533円、差+18件・16勝2敗・+154,386円を保存ID順・891万円制約で再現
- [x] 6526他AI案比較: 既存7銘柄は全取引時刻・勝敗・損益が完全一致。単独損失の7/23 10:10だけ、8035 6,825,000円保有中に6526 2,604,500円を加えると9,429,500円となり上限8,910,000円超過でmargin_block
- [x] 6526他AI案比較: 他AIの214件→232件・+3,985,091円→+4,139,477円は6146時間窓実装前の旧基準。最新基準では211件→229件・+4,127,147円→+4,281,533円だが、差分+154,386円と既存7銘柄不変は一致
- [x] 6526他AI案比較: 5本SHORT案は単独損益+20,758円・PF4.13でLONG案を上回る一方、統合-74,295円・既存銘柄置換あり。LONG案は勝率84.21%・DD2,171円・統合+154,386円・非干渉で総合優位と判断し、本番コード未変更でDRY_RUN第一候補に更新
- [x] 6526確認型LONG実装: ACTIVE_ENTRY_SYMBOLSへ6526を追加し、汎用経路を停止して前場確認型LONG専用経路だけをDRY_RUN有効化
- [x] 6526確認型LONG実装: 09:00以降最初の足を当日始値、09:30〜10:59初動・11:00最終確認、10本高値更新、陽線、MA8二本傾き+0.05%以上、出来高1.2倍以上、次足終値上抜けを固定
- [x] 6526確認型LONG実装: TP0.5%・SL0.8%・最大20分確定足終値、同足SL優先、板入口・板読み早期利確・シグナル反転決済なし、日次1回を固定
- [x] 6526確認型LONG実装: 確認失敗・ATR/証拠金等の共通ゲート拒否では日次枠を消費せず後続候補を再探索し、実エントリー成功時だけ発火済みにする
- [x] 6526確認型LONG実装: 確認待ち・発火済み・オープンポジション・SL/TP・最大20分出口の再起動復元を固定
- [x] 6526確認型LONG実装: DRY_RUN限定・LIVE新規注文をクラウド注文生成境界とGit保存Windows Executor/relayで強制拒否し、決済注文は許可
- [x] 6526確認型LONG実装: 16時日次報告へエントリー・確認失敗・共通ゲート拒否・証拠金ブロック・理論損益を追加し、専用DB表と複合一意制約で再起動後も復元可能にする
- [x] 6526確認型LONG実装: 全46日15,079足で19件16勝3敗・+11,823.89円/100株、直近3勝0敗・+2,953.73円、全17確認失敗、入口境界、全決済理由、0.05%後16勝3敗+9,598.31円・0.10%後15勝4敗+7,372.74円をGit fixtureへ恒久固定
- [x] 6526確認型LONG実装: 保存ID順8銘柄108,151足・891万円制約で229件182勝47敗・+4,281,533円、既存7銘柄211件・+4,127,147円の全取引完全一致、7/23 10:10 margin_blockを恒久ソース監査化
- [x] 6526確認型LONG実装: 関連86件成功、全454件中447件成功・5件スキップ・既知JQUANTS_API_KEY未設定2件のみ失敗。TypeScript型検査・本番ビルド・Python構文・差分検査成功、DRY_RUN=Trueと6526/6976 LIVE二重拒否を確認
- [x] 6594再検証: 6594は22銘柄の受信・保存対象だがACTIVE_ENTRY_SYMBOLS外で、専用経路なし。保存KABUステーションは13保存日・最新ID重複除去4,087足、12完全日と8/25午後60足の不完全日、同時点板ありと固定
- [x] 6594再検証: 汎用ロジックを仮に許可した現行相当は、証拠金制限なし・100株固定・全発火で15件6勝9敗・40.00%・+229円、PF1.02・最大DD6,909円。直近5完全日は4件2勝2敗・50.00%・-1,994円で両目標未達
- [x] 6594再検証: 現行15件は全て汎用SHORTで、初期8/7〜8/14は6件1勝5敗・16.67%。時刻・始値比・板・出来高の単純フィルターだけでは十分な標本で直近80%・全期間75%を安定達成できず、専用方式を比較
- [x] 6594再検証: 有力候補は09:30〜10:30の10本安値更新陰線SHORT、MA8二本傾き-0.02%以下、出来高20本平均1.2倍以上、専用ATR率0.10%以上、板・次足確認なし、TP0.5%/SL0.8%、最大30分確定足終値、1日1回・拒否後再探索
- [x] 6594再検証: 有力候補は全12完全日で12件10勝1敗1分・83.33%・+9,612円/100株、PF9.74・最大DD1,100円。直近5完全日は5件4勝1敗・80.00%・+1,800円、直近前は7件6勝0敗1分・85.71%・+7,812円
- [x] 6594再検証: 期間分割は8/7〜8/14が4件3勝0敗1分・75.00%、8/17〜8/19が3勝0敗、直近5日が4勝1敗。0.05%不利後10勝2敗・+7,988円・PF6.83、0.10%後10勝2敗・+6,364円・PF4.89、0.15%後9勝3敗・75.00%・+4,740円
- [x] 6594再検証: 244組が両目標を満たし、中心近傍は高値/安値参照5〜15本、MA傾き0.02%、出来高1.0〜1.2倍、終了10:15〜11:00、専用ATR0.08〜0.11%で維持。一方、出口はTP0.4〜0.5%・保有28〜30分で維持するが、TP0.6%や保有25/32分では直近または全期間目標を外し確信度は中
- [x] 6594再検証: 最新8銘柄108,151足・891万円制約は229件182勝47敗・+4,281,533円。中心候補を可変株数の9銘柄112,238足へ加えると239件188勝49敗2分・+4,228,882円で-52,651円
- [x] 6594再検証: 可変株数では6594自身11件9勝0敗2分・+88,399円だが、既存8銘柄が-141,050円。資金無制限では既存8銘柄268件・+5,440,775円が完全一致し、6594分12件10勝1敗1分・+89,644円だけ増えるため共有状態不整合ではなく証拠金競合と確認
- [x] 6594再検証: TP0.4%・28分の早期資金解放案は単独12件10勝2敗・83.33%・+7,786円、直近4勝1敗を維持するが、統合は+4,271,153円で現行比-10,380円。主要な構造候補は可変株数で現行8銘柄を上回らず
- [x] 6594再検証: 6594を100株固定に限ると9銘柄241件192勝48敗1分・+4,290,898円で現行比+9,365円、既存8銘柄差は6981の8/18入口置換による-247円のみ。ただし200株で-70,693円、300株で-61,481円となり100株一点の資金余裕に敏感
- [x] 6594再検証: 単独シグナル品質は専用SHORT候補で目標達成するが、標本12件・出口感度・可変株数統合悪化を踏まえ、現行8銘柄へ通常ロットで追加せず「100株限定シャドー候補」として前向き確認を推奨。本番コード・DRY_RUNロジック未変更
- [x] 6594採否: ユーザー判断により不採用を確定し、取引対象・シャドー候補へ追加せず現行8銘柄を維持
- [x] 3436再検証: 3436は22銘柄の受信・保存対象だがACTIVE_ENTRY_SYMBOLS外で専用経路・銘柄別設定なし。保存KABUステーションは29保存日・最新ID重複除去9,418足、25完全日と6/23・6/30・7/31・8/25の不完全日、同時点板ありと固定
- [x] 3436再検証: 汎用ロジックを仮に許可した現行相当は、証拠金制限なし・100株固定・全発火で62件24勝38敗・38.71%・+10,347円、PF1.15・最大DD19,068円。直近5完全日は14件4勝10敗・28.57%・-7,362円で両目標未達
- [x] 3436再検証: 現行62件はSHORT43件15勝28敗・34.88%、LONG19件9勝10敗・47.37%。直近もLONG6件2勝4敗、SHORT8件2勝6敗で、時刻・方向・板・始値比・出来高の単純フィルターだけでは十分な標本で目標を安定達成できず専用方式を比較
- [x] 3436再検証: 有力候補は09:30〜11:00の15本安値更新陰線SHORT、MA8二本傾き-0.05%以下、出来高20本平均1.0倍以上、板・次足確認・始値方向・追加ATRなし、TP0.7%/SL0.8%、最大30分確定足終値、1日1回・拒否後再探索
- [x] 3436再検証: 有力候補は全29保存日・完全日のみとも22件19勝3敗・86.36%・+38,735.51円/100株、PF5.29・最大DD3,218.33円。直近5完全日は5件4勝1敗・80.00%・+6,680.05円、直近以前は17件15勝2敗・88.24%・+32,055.46円
- [x] 3436再検証: 期間分割は6/17〜7/17が1件1勝、7/21〜8/19が16件14勝2敗・87.50%、直近5日が4勝1敗。0.05%不利後19勝3敗・+34,759.49円・PF4.62、0.10%後19勝3敗・+30,783.46円・PF4.03、0.15%後19勝3敗・+26,807.44円・PF3.50
- [x] 3436再検証: 共通30本ウォームアップ反映後も612組が両目標を満たし、参照5〜20本・MA傾き0〜-0.05%・出来高1.0〜1.5倍・終了10:15〜11:00に達成帯あり。実エンジン近傍も10本/傾き-0.02%/出来高1.2倍で17勝5敗・77.27%、20本/傾き-0.05%/出来高1.0倍で18勝4敗・81.82%、終了10:30で16勝3敗・84.21%
- [x] 3436再検証: 開始09:45では21件14勝7敗・66.67%へ低下するため09:30開始は重要。一方、TP0.4〜0.7%は全て19勝3敗、TP0.8%も18勝4敗、SL0.6〜1.0%は17〜19勝、最大保有20〜45分は19勝3敗で出口は広く安定
- [x] 3436再検証: 最新8銘柄108,151足・891万円制約は229件182勝47敗・+4,281,533円。TP0.7%候補を9銘柄117,568足へ加えると248件199勝49敗・+4,550,579円で+269,046円
- [x] 3436再検証: 9銘柄では3436自身22件19勝3敗・+276,721円、既存8銘柄は226件180勝46敗・+4,273,858円で-7,675円。TP0.5%は+178,169円、TP0.6%は+226,206円、TP0.8%は+272,499円だが単独勝率81.82%・既存取引置換増のため、勝率余裕と総損益の均衡でTP0.7%を優先
- [x] 3436再検証: 資金無制限では既存8銘柄268件・+5,440,775円がTP0.7%候補追加後も全取引完全一致し、3436分22件19勝3敗・+276,304円だけ増加。共有状態不具合ではなく、891万円制約下の既存8銘柄差は証拠金競合と確認
- [x] 3436再検証: 単独目標・約定耐性・入口/出口近傍・9銘柄統合を全て満たすため、3436前場15本安値更新SHORT（TP0.7%/SL0.8%）をDRY_RUN実装の第一候補と判断。ただし標本22件のためLIVE不可、本番コード・DRY_RUNロジックは未変更
- [x] 3436専用SHORT実装: ACTIVE_ENTRY_SYMBOLSへ3436を追加し、汎用経路を停止して前場15本安値更新SHORT専用経路だけをDRY_RUN有効化
- [x] 3436専用SHORT実装: 09:30〜11:00、陰線終値で直前15本安値更新、MA8二本傾き-0.05%以下、出来高20本平均1.0倍以上を固定し、板・次足確認・始値方向・追加ATRを使わない
- [x] 3436専用SHORT実装: TP0.7%・SL0.8%・最大30分確定足終値、同足SL優先、板読み早期利確・汎用反転決済なし、1日1回を固定
- [x] 3436専用SHORT実装: ATR・証拠金等の共通ゲート拒否では日次枠を消費せず後続候補を再探索し、実エントリー成功時だけ発火済みにする
- [x] 3436専用SHORT実装: 発火済み・オープンポジション・SL/TP・最大30分出口を再起動復元へ固定
- [x] 3436専用SHORT実装: DRY_RUN限定・LIVE新規注文をクラウド注文生成境界とGit保存Windows Executor/relayで強制拒否し、決済注文は許可
- [x] 3436専用SHORT実装: 16時日次報告へエントリー・共通ゲート拒否・証拠金ブロック・理論損益を追加し、専用DB表と複合一意制約で再起動後も復元可能にする
- [x] 3436専用SHORT実装: 最新DBの全29日9,417足で22件20勝2敗・+43,984.96円/100株、直近5勝0敗・+11,948.34円、全決済理由、0.05%不利後20勝2敗+40,009.94円、0.10%不利後20勝2敗+36,034.91円をGit fixtureへ恒久固定
- [x] 3436専用SHORT実装: 保存ID順9銘柄117,568足・891万円制約で249件200勝49敗・+4,589,426円、3436は22件19勝3敗+277,637円、既存8銘柄227件181勝46敗+4,311,789円、証拠金拒否後再探索を恒久ソース監査化
- [x] 3436専用SHORT実装: 関連88件、DBソース7件、9銘柄統合1件成功。全472件中463件成功・7件スキップ・既知JQUANTS_API_KEY未設定2件のみ失敗。型検査・本番ビルド・Python構文・差分検査成功、DRY_RUN=Trueと3436/6526/6976 LIVE拒否を確認
- [x] 9984専用LONG実装: ACTIVE_ENTRY_SYMBOLSへ9984を追加し、汎用経路を停止して前場10本高値更新LONG専用経路だけをDRY_RUN有効化
- [x] 9984専用LONG実装: 09:40〜10:30、陽線終値で直前10本高値更新、MA8二本傾き+0.02%以上、出来高20本平均1.2倍以上、共通ATRを固定し、板入口・次足確認を使わない
- [x] 9984専用LONG実装: TP0.3%・SL0.8%・最大45分確定足終値、同足SL優先、板読み早期利確・汎用反転決済なし、1日1回を固定
- [x] 9984専用LONG実装: ATR・証拠金等の共通ゲート拒否では日次枠を消費せず後続候補を再探索し、実エントリー成功時だけ発火済みにする
- [x] 9984専用LONG実装: 発火済み・オープンポジション・SL/TP・最大45分出口を再起動復元へ固定
- [x] 9984専用LONG実装: DRY_RUN限定・LIVE新規注文をクラウド注文生成境界とGit保存Windows Executor/relayで強制拒否し、決済注文は許可
- [x] 9984専用LONG実装: 16時日次報告へエントリー・共通ゲート拒否・証拠金ブロック・理論損益を追加し、専用DB表と複合一意制約で再起動後も復元可能にする
- [x] 9984専用LONG実装: 保存KABU全44日14,353足のfixtureで全25取引23勝2敗・+29,675.80円/100株、直近5件4勝1敗・+2,010.15円、全決済理由、0.05%/0.10%約定悪化を恒久固定
- [x] 9984専用LONG実装: 保存ID順10銘柄131,921足・891万円制約で270件220勝50敗・+4,726,287円、9984は22件20勝2敗+101,809円、既存9銘柄影響と証拠金拒否後再探索を恒久監査化
- [x] 9984専用LONG実装: 対象154件、DBソース1件、10銘柄統合1件成功。全492件中481件成功・9件スキップ、失敗2件は既知JQUANTS_API_KEY未設定のみ。型検査・本番ビルド・Python構文・fixture SHA・差分検査成功、本番DB表9列・複合一意制約適用、DRY_RUN=Trueと9984/3436/6526/6976 LIVE拒否を確認
- [x] 6857利益保護実装: 高値失速SHORTだけを対象に含み益+0.8%到達状態を保持し、発動足では決済せず次足以降+0.7%戻りで決済する
- [x] 6857利益保護実装: SL・TPを利益保護より先に判定して同足SL優先とし、利益保護決済後は損切り後LONG再評価を作らない
- [x] 6857利益保護実装: オープンポジションと保存済み確定足から発動状態を再起動復元し、営業日更新・決済時に状態を確実に破棄する
- [x] 6857利益保護実装: 発動足非決済・次足決済・SL優先・再起動復元のVitest回帰を追加する
- [x] 6857利益保護実装: 全48日6857固定14 SHORTを12勝2敗・+260,476円/100株、本日10:12・+22,974円で恒久再生する
- [x] 6857利益保護実装: 保存ID順10銘柄135,217足・891万円制約で280件229勝51敗・+4,958,063円、直近3日・5日と資金解放後の置換を固定する
- [x] 6857利益保護実装: 入口条件・TP1.2%・SL1.0%・弱出来高・損切り後再評価・6146終了11:10・他9銘柄・DRY_RUN・LIVE拒否が不変であることを確認する
- [x] 6857利益保護実装: 全496件中485件成功・9件スキップ、失敗2件は既知JQUANTS_API_KEY未設定のみ。型検査・本番ビルド・差分検査、全48日DBソース監査、10銘柄統合監査、DRY_RUN=Trueと既存LIVE拒否を確認する
- [x] 285A両SHORT条件実装: 反転SHORTの最初の適格候補でBPR<0.70なら当日終了し、後続の反転SHORTを再探索しない
- [x] 285A両SHORT条件実装: 安全CB SHORTの最初の最終適格候補で出来高比<0.45なら当日終了し、出来高急増・前足近接・確認後タイムアウト・押し戻りの全4入口へ同じ条件を適用する
- [x] 285A両SHORT条件実装: BPR／出来高の当日終了状態を13列の専用DB表へ冪等保存し、再起動後に同日の後続候補を再開しないよう復元する
- [x] 285A両SHORT条件実装: 16時DRY_RUN報告へ両ブロックの発生時刻・値・理由を追加し、直前20本中10本以上の出来高ゼロをデータ欠損疑いとして表示する
- [x] 285A両SHORT条件実装: BPR0.69/0.70境界、出来高比0.44/0.45境界、当日終了、全4安全CB入口、再起動復元のVitest回帰を追加する
- [x] 285A両SHORT条件実装: 全45日14,278足・証拠金制限なし100株で72件55勝16敗1分・76.39%・+2,610,703円、除外5敗・監査イベント4件を恒久固定する
- [x] 285A両SHORT条件実装: 保存ID順10銘柄135,217足・891万円制約で277件229勝48敗・82.67%・+5,101,681円、既存9銘柄不変を恒久固定する
- [x] 285A両SHORT条件実装: 入口・SL/TP・他方式・他9銘柄・DRY_RUN・既存LIVE拒否を不変とし、対象125件、全504件中492件成功・10件スキップ、失敗2件は既知JQUANTS_API_KEY未設定のみ。型検査・本番ビルド・差分・fixture SHA・本番DB表13列／複合一意制約を確認してチェックポイントを自動公開する
- [x] 285A他AI案実装: 現行順張りLONGを停止し、09:45〜11:20・終値10本高値更新・陽線実体0.20%以上・MA8二本傾き0%以上・出来高20本平均1.2倍以上・始値比+0.5%以上の確認型前場LONGをDRY_RUN有効化する
- [x] 285A他AI案実装: 反転LONGをSL0.6%／TP1.2%、反転SHORTを終了11:20・SL0.8%／TP1.6%、順張りSHORTをSL0.8%／TP1.6%、安全CB SHORTをSL0.6%／TP1.5%へ固定する
- [x] 285A他AI案実装: 新確認型LONGの経路優先順位、日次1回枠、共通ATR・証拠金拒否後の再探索、実エントリー成功時だけ発火済みとなる状態遷移を固定する
- [x] 285A他AI案実装: 新確認型LONGの発火済み・オープンポジション・SL/TP・前場強制決済を再起動復元し、監査DBと16時DRY_RUN報告へ候補・拒否・取引を追加する
- [x] 285A他AI案実装: 285A LIVE新規entryをクラウド注文生成境界とGit保存Windows Executor/relayで拒否し、DRY_RUNと既存ポジション決済だけを許可する安全設計を維持する
- [x] 285A他AI案実装: 保存KABU全45日14,278足で75件56勝18敗1分・74.67%・+3,636,936円/100株、新確認型LONG18件14勝4敗、直近5日7件5勝2敗を固定回帰する
- [x] 285A他AI案実装: 保存ID順10銘柄135,217足・891万円制約で269件219勝50敗・81.41%・+5,573,734円、証拠金ブロック255回と他9銘柄影響を固定する
- [x] 285A他AI案実装: 境界・拒否後再探索・日次枠・再起動・監査・型検査・通常506件成功・10件スキップ（既知JQUANTS_API_KEY不足2件のみ失敗）・本番ビルド・Python構文・DRY_RUN安全設定を確認し、チェックポイントを自動公開する
- [x] 8035始値方向案実装: 10:00〜10:30の短期ブレイクへLONG始値比+0.25%以上・SHORT始値比-0.25%以下、出来高20本平均1.0倍以上を追加する
- [x] 8035始値方向案実装: 短期ブレイクをSL0.6%／TP1.2%・最大20分、予備順張りLONGをSL0.7%／TP1.4%、予備順張りSHORTをSL0.6%／TP1.8%へ変更し、高値反転SHORTを停止する
- [x] 8035始値方向案実装: 実エントリー成功時だけ日次枠を消費し、共通ATR・証拠金拒否後は後続候補を再探索する状態遷移と経路優先順位を固定する
- [x] 8035始値方向案実装: 20分決済・発火済み・オープンポジション・SL/TPを再起動復元し、候補・ATR／証拠金拒否を監査DBと16時DRY_RUN報告へ追加する
- [x] 8035始値方向案実装: 8035新経路のLIVE新規entryをクラウド注文生成境界とGit保存Windows Executor/relayで拒否し、DRY_RUNと決済のみ許可する
- [x] 8035始値方向案実装: 保存KABU48日15,697足で35件27勝8敗・77.14%・+867,618円/100株、主要LONG73.68%・SHORT76.92%、直近5日3件2勝1敗を全取引fixtureで固定する
- [x] 8035始値方向案実装: 保存ID順10銘柄135,217足・891万円制約で264件213勝51敗・80.68%・+5,799,957円、margin_block253回を固定する
- [x] 8035始値方向案実装: 境界・拒否後再探索・再起動・監査・通常518件成功・11件スキップ（既知JQUANTS_API_KEY不足2件のみ失敗）・型検査・ビルド・Python構文・DRY_RUN安全設定を確認し、チェックポイントを自動公開する
- [x] 6857 SHORT TP3.0%実装: 確認型LONGのSL0.5%／TP1.0%、入口条件、弱出来高ガード、SHORT利益保護0.8%→0.7%、6146、他8銘柄を不変として変更範囲を固定する
- [x] 6857 SHORT TP3.0%実装: 高値失速SHORTと損切り後SHORT再評価のSL1.0%を維持し、TPを1.2%から3.0%へ変更する
- [x] 6857 SHORT TP3.0%実装: オープンポジションと再起動復元時のSHORT TP3.0%、利益保護発動状態、SL優先・同一足保守処理を固定する
- [x] 6857 SHORT TP3.0%実装: 保存KABU49日15,927足で25件22勝3敗・88.00%・+582,735円/100株、SHORT系14件12勝2敗・+334,210円、直近5日3勝0敗を全取引fixtureへ固定する
- [x] 6857 SHORT TP3.0%実装: 保存ID順10銘柄135,217足・891万円制約で264件213勝51敗・+5,858,184円・margin_block257回を恒久固定し、最新138,560足で271件217勝54敗・+5,845,593円を隔離検証で確認する
- [x] 6857 SHORT TP3.0%実装: DRY_RUN、既存LIVE拒否、型検査、対象209件成功、通常518件成功・11件スキップ（既知JQUANTS_API_KEY不足2件のみ失敗）、本番ビルド、再起動、差分を確認してチェックポイントを自動公開する

## 未見データ前向きシャドー評価基盤（2026-09-02 実装）
- [x] 現行`f6878060`の売買条件、10銘柄、DRY_RUN、既存LIVE新規entry拒否を固定する
- [x] 本番サーバーがGit SHA、設定ハッシュ、戦略バージョン、対象銘柄一覧を自己表示できるようにする
- [x] relayイベントIDと評価方式を含む監査データモデルを追加し、同一戦略版・同一イベント・同一評価方式の二重処理をDBで拒否する
- [x] 訂正足を追記保存し、完了済みの過去判断を変更しないイベント処理を実装する
- [x] 一経路を副作用のない共通判定コアへ切り出し、現行DRY_RUN・シャドー・保存足再生で共有する
- [x] シャドー評価は注文指示へ接続せず、理論終値と次足始値の実行可能価格を分離する
- [x] 窓開けSLは不利始値、同一足TP/SLはSL優先として固定する
- [x] 100株・証拠金なし全発火と891万円・可変株数を独立状態機械として保存・復元する
- [x] 2週間一時判定、2週間以上かつ20件または4週間かつ10件の最終判定、最大8週間、停止条件を実装する
- [x] 16時DRY_RUN報告へ版自己証明、再現一致、候補別前向き累計、判定残件数、実現損益比を追加する
- [x] DBマイグレーション、Vitest、型検査、本番ビルド、DRY_RUN/LIVE拒否回帰を検証してチェックポイントを保存する
- [x] 公開基盤でGit SHA環境変数が未提供の場合、deployment version・revisionを表示しつつ、f6878060売買ソース固定SHA一致を計測開始条件として使用する

## 5803 A＋B 独立前向きシャドー実装（2026-09-02）
- [x] 既存8035のstrategyVersion・candidateKey・2評価方式・状態を回帰固定し、5803から変更できないことを確認する
- [x] 実行可能価格を受信時点価格へ変更し、過去の次足始値を約定価格へ使わないようにする
- [x] シャドー処理失敗イベントを再試行可能にし、現行売買処理を二重実行しない独立claimを実装する
- [x] 状態更新へ楽観ロックまたは直列化を追加し、同一strategyVersion・評価方式の競合を防ぐ
- [x] 5803専用strategyVersionとcandidateKeyを追加し、8035とは別状態・別判断・別取引として保存する
- [x] 5803入口A（次足確認時BPR≤0.70）と出口B（SL0.5%／TP1.0%、+0.5%到達後、次足以降+0.3%保護）を実装する
- [x] 5803の100株全発火版と891万円可変株数版を独立状態で保存・復元する
- [x] 5803シャドーを注文生成・OrderBridge・Windows Executorから構造的に分離し、LIVE新規entryを作れないことを固定する
- [x] 16時報告と固定版再生監査を8035・5803のstrategyVersion別に表示する
- [x] DBマイグレーション、対象Vitest、全体回帰、型検査、本番ビルド、DRY_RUN/LIVE拒否を検証する
- [x] チェックポイントを保存し、自動公開後の初回未見受信状態を確認する

## 5803シャドー 96本基準値・前場跨ぎ決済の修正（2026-09-03）
- [x] 96本切り詰め後に当日始値・当日安値が変わる問題を独立テストで再現する
- [x] 11:27〜11:29欠損時に12:30受信で前場ポジションが決済されない問題を独立テストで再現する
- [x] 当日始値・当日安値をローリング配列から分離して状態保存・復元する
- [x] 前場エントリーの保有が11:27以降の最初の受信足で必ず決済されるよう修正する
- [x] 8035、現行10銘柄売買、OrderBridge、LIVE拒否を変更しないことを回帰固定する
- [x] 修正後から5803の正式4週間・10件カウントを開始するようstrategyVersionを更新する
- [x] 対象Vitest、全体回帰、型検査、本番ビルド、固定版再生を検証して自動公開する

## 285A MA8失速確認付き利益保護 独立シャドー実装（2026-09-03）
- [x] 現行285A確認型前場LONG、8035、5803のstrategyVersion・状態・取引を回帰固定する
- [x] 285A現行入口、SL0.8%／TP1.6%、前場決済を副作用のない純粋コアへ固定する
- [x] +0.6%到達後、次イベント以降に利益+0.3%以下かつMA8二本傾き-0.05%以下で受信時点価格決済する
- [x] 285A専用の別strategyVersion・candidateKey・状態・判断・取引を追加する
- [x] 100株全発火版と可変株数版を独立状態で保存・復元し、現行285Aと相互作用させない
- [x] 285Aシャドーを通常取引DB、OrderBridge、Windows Executor、LIVE注文から構造的に分離する
- [x] 16時報告と当日固定版再生監査を8035・5803・285AのstrategyVersion別に表示する
- [x] 対象Vitest、全体回帰、型検査、本番ビルド、DRY_RUN/LIVE拒否を検証する
- [x] チェックポイントを保存し、自動公開後の285A独立初期状態を確認する

## 285A 第2シャドー候補検証（2026-09-03）
- [x] 保存KABUステーションの最新重複除去データで、現行285A全5経路の全期間・直近10営業日を100株固定・証拠金制限なしで再現する
- [x] 直近10営業日勝率80%以上・全期間勝率70%以上を同時に満たす低自由度候補を、入口案と出口案の少数比較から選定する
- [x] 第1シャドーの確認型前場LONG MA8失速利益保護と対象経路・変更因子が重複しない第2候補を優先し、単一経路および確認型LONG除外案は目標未達と確認する
- [x] 経路別、前後半、直近10日、0.05%・0.10%不利約定、PF、期待値、最大DD、TP≧SL×2を確認する
- [x] 10銘柄・891万円制約の統合再生で他銘柄への証拠金競合影響を確認する
- [x] 候補選定に使用した最終日以前は学習データとし、今回は検証・提案のみで現行売買・シャドー実装・公開を変更しない

## 285A 第2シャドー実装（ATR0.36%経路別日次終了）
- [x] 8035・5803・285A共通の状態ロックownerTokenを64文字以内へ固定し、本番STRICT DBで取得・解放できることを回帰テストする
- [x] 第2シャドーのstrategyVersion・学習カットオフ・正式開始日を第1シャドーと別定数で固定する
- [x] 現行285Aの5経路入口を再現し、最初の候補でATR7率0.36%未満なら該当経路だけ当日終了する純粋仕様を実装する
- [x] 第2シャドー専用の状態・判断・取引を2評価方式別に保存・復元し、現行285Aと第1シャドーへ影響させない
- [x] 第2シャドーを受信ディスパッチ、戦略自己証明、16時固定版再生レポート、公開集計APIへ別strategyVersionで接続する
- [x] 経路別終了、他経路継続、ATR境界、日付切替、板欠損、SL/TP、前場決済、2評価方式、冪等性、再試行、固定版再生のVitestを追加する
- [x] 第2シャドーを通常取引DB、OrderBridge、Windows Executor、LIVE注文から構造的に分離し、常時DRY_RUNを維持する
- [x] 型検査、対象テスト、全体回帰、本番ビルド、relay構文、f6878060売買ソース固定ハッシュ一致を確認する
- [x] チェックポイントを保存して自動公開し、本番APIの4戦略独立表示と第2シャドー開始前DBゼロ状態を確認する

## 他AI提案「10銘柄実時・固定版再生比較基盤＋改善案A」精査（2026-09-04）
- [x] 現行のsourceEvent保存、親処理冪等性、strategyVersion別判断・状態ハッシュ・固定版再生・再試行の実装済み範囲を確認する
- [x] 実時現行と固定版再生の最初の不一致をeventSeq順で検出するために不足する保存項目と比較単位を特定する
- [x] 10銘柄共有891万円portfolio評価、同一1分候補集合、ブロック因果関係を再現するための要件を精査する
- [x] 改善案Aの次イベント板確認が因果的か、対象経路と拒否後再探索が現行状態機械を壊さないかを確認する
- [x] 採用条件と実装順序を、未見評価・DRY_RUN・注文非接続・現行売買不変の境界で評価する
- [x] 精査結果のみを報告し、承認前にGit・本番コード・戦略版を変更しない

## 実時再生一致＋成績乖離原因分析 統合ロードマップ精査（2026-09-04）
- [x] プログラム乖離、価格乖離、資金乖離、成績乖離を順番に切り分ける判定ゲートを定義する
- [x] 発火時点特徴量、未来の診断専用特徴量、反実仮想結果を用途別に分離する
- [x] 過去勝ち・過去負け・本番負けの比較と原因確信度を、小標本・多重探索に耐える形へ修正する
- [x] 10銘柄共有891万円、同一分候補、ブロック因果、後続取引への影響を評価表へ統合する
- [x] 改善案A/Bを自動採用せず、未見シャドーへ進める条件・停止条件・実装順序を確定する
- [x] 統合ロードマップのみを報告し、承認前に売買コード・DB・戦略版・公開ロジックを変更しない

## 追加指摘「再現一致・因果性・時刻契約・10銘柄バッチ」精査（2026-09-04）
- [x] 本番と再生の一致確認と、利用可能情報・価格の因果性確認を別ゲートとして定義する
- [x] 8035現行DRY_RUN、既存8035シャドー、提案Aの入口・約定・時間決済差をコードで確定する
- [x] 理論価格、実行可能価格の近似、実約定価格の名称と利用可能時刻を正規化する
- [x] 正式再生順をDB受信連番とrelaySessionId＋eventSeqの役割別に定義する
- [x] 現行10銘柄の受信遅延分布から同一candleTimeバッチの待機時間・欠損・訂正規則を評価する
- [x] 修正版12段階ロードマップと8035現行完全再現版→因果性検査→A案の順序を確定する
- [x] 精査結果のみを報告し、承認前に売買コード・DB・戦略版・公開ロジックを変更しない

## 実時再生一致・因果性・共有資金・成績乖離分析基盤 実装（2026-09-04）
- [x] 現行10銘柄の売買条件・DRY_RUN・LIVE拒否・f6878060固定売買ソースhashを実装前基準として固定する
- [x] source event、現行判断、engineSequence、候補、価格観測、portfolio配分、結果ラベル、不一致のDB契約を追加する
- [x] 現行processCandleの入出力を変更せず、判断前後状態・route・拒否・価格・証拠金を監査台帳へ追記保存する
- [x] `baseline-8035-current-parity-v1`を比較専用・採用審査対象外の別strategyVersionとして実装する
- [x] DB受信順とengineSequence順で8035現行再現を行い、最初の項目別不一致と連鎖差を保存する
- [x] 日中再起動位置を変え、pending・日次枠・発火済み・保有・利益保護・証拠金の状態連続性を検証する
- [x] `baseline-8035-causality-audit-v1`へobservedAt・decisionAt・価格種別・板鮮度・因果違反を保存する
- [x] 現行10銘柄・891万円の実受信順portfolioを現行採用・margin_blockと一致させる
- [x] 同一candleTimeの日次確定固定優先順位portfolioとblocker→blocked因果辺を実装する
- [x] MFE・MAE・1分3分5分後・仮想exit・最終損益を診断専用結果ラベルとして保存する
- [x] 過去勝ち・過去負け・本番負けの原因候補、確信度、失う勝ち、防げる負け、後続取引影響を集計する
- [x] `candidate-8035-executable-confirm-v1`をブレイク維持・0.10%不利上限・元初動非再利用で別状態実装する
- [x] 16時レポートと公開APIへGate、最初の不一致、因果性、portfolio、原因候補、改善案成績を表示する
- [x] DB migration、対象Vitest、全体回帰、ビルド、relay構文、固定売買hash、注文非接続を検証する
- [ ] チェックポイント保存・自動公開後に本番DB、3版の独立性、初期状態、エラー0件を確認する
- [x] 公開後に判明した5803 strategyVersionの64文字超過を再現し、戦略版列を既存versionを変えず非破壊拡張する
- [x] 5803・8035・285Aのシャドー専用再試行が本番で回復し、親現行DRY_RUNを再実行しないことを確認する
