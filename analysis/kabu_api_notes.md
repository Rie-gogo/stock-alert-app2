# kabuステーションAPI リファレンスメモ

## エンドポイント
- 本番: http://localhost:18080/kabusapi
- 検証: http://localhost:18081/kabusapi

## トークン取得
- POST /token → {"APIPassword": "xxx"} → {"Token": "xxx"}
- トークンはkabuステーション終了・ログアウト・別トークン発行で無効化

## 発注 (POST /sendorder)
- レスポンス: {"Result": 0, "OrderId": "xxx"} (Result=0が成功)
- 信用デイトレ新規買い: Side="2", CashMargin=2, MarginTradeType=3, DelivType=0
- 信用デイトレ新規売り: Side="1", CashMargin=2, MarginTradeType=3, DelivType=0
- 信用返済(買建→売返済): Side="1", CashMargin=3, DelivType=2
- 信用返済(売建→買返済): Side="2", CashMargin=3, DelivType=2
- ClosePositionOrder=0: 日付古い順・損益高い順で自動選択
- Exchange=27 (東証+)
- FrontOrderType=10: 成行, =20: 指値, =30: 逆指値
- 逆指値: ReverseLimitOrder { TriggerSec, TriggerPrice, UnderOver, AfterHitOrderType, AfterHitPrice }
- 流量制限: 発注系は秒間約5件

## 注文照会 (GET /orders)
- パラメータ: product=0(全般), 他にupdtime等
- レスポンス: 配列。各要素に OrderId, State, CumQty, OrderQty, Price, Details[] 等
- State: 1=待機, 2=処理中, 3=処理済, 4=訂正取消送信中, 5=終了
- Details[].RecType: 1=受付, 2=繰越, 3=期限切, 4=発注, 5=訂正, 6=取消, 7=失効, 8=約定
- CumQty: 累計約定数量
- /orders?id=XXX でOrderId指定照会可能(issue#1253確認: IDは注文約定照会画面の注文番号と同一)

## 建玉照会 (GET /positions)
- パラメータ: product=2(信用)
- レスポンス: 配列。各要素に ExecutionID, Symbol, Side, Qty, Price, CurrentPrice, ProfitLoss, HoldQty 等
- HoldQty: 拘束数量（返済注文中の数量）
- LeavesQty: 残数量

## 注文取消 (PUT /cancelorder)
- ボディ: {"OrderId": "xxx"}
- レスポンス: {"Result": 0, "OrderId": "xxx"}

## 重要な注意点
- sendorder成功 = 注文受付成功 ≠ 約定完了
- 特別気配・ストップ高安・売買停止時は即約定しない
- 100株成行でも全約定確認が必要
- 東証で保有の建玉はSOR/東証+では返済不可
- デイトレ信用の強制決済は翌営業日寄り付き(証券会社側)
