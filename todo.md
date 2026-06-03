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
- [] 共通の確認フィルタ関数を作成（出来高の裏付け・トレンド方向・直近モメンタムを評価する純粋関数）
- [ ] 画面のシグナル監視ボード（detectSignals）に確認フィルタを適用し、流れに逆らう弱いシグナルを抑制
- [ ] シグナルに信頼度（strong / medium / weak）を付与し、複数指標が同時に裏付けるものを strong とする
- [ ] 出来高急増（直近平均比）を確認条件に追加
- [ ] 確認フィルタの vitest を追加（弱いシグナルが抑制される／強いシグナルが残ることを検証）
- [ ] フロントUIで信頼度バッジを表示（強=即通知、弱=参考表示）
- [ ] 全テスト pass・型エラー0・動作確認・チェックポイント保存・報告


## シグナル判定ロジックの精度向上（2026-06-03 完了）

- [x] 確認フィルタの共通純粋関数 server/signalConfirmation.ts を作成（出来高裏付け・トレンド方向一致・モメンタム一致）
- [x] シグナルに信頼度（strong/medium/weak）を付与、weakは通知抑制
- [x] 画面側 detectSignals に確認フィルタを組み込み（誤シグナル抑制）
- [x] ScannedSignal / extractLatestSignal に confidence を引き継ぎ
- [x] フロント SignalMonitorBoard に信頼度バッジ表示・通知トーストに信頼度反映
- [x] バックテスト realSimulation のロング/ショートエントリーに出来高裏付けゲート追加
- [x] signalConfirmation の vitest を追加（21テスト）
- [x] 型チェック0件・全130テスト通過・ブラウザ確認・チェックポイント保存
