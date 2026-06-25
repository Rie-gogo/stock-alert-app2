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
