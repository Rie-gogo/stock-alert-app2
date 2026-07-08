# KABUステーションAPI 発注仕様メモ

Source: https://kabucom.github.io/kabusapi/reference/index.html

## エンドポイント
- 本番: `http://localhost:18080/kabusapi/sendorder`
- 検証: `http://localhost:18081/kabusapi/sendorder`
- レート制限: 秒間5件
- 同一銘柄同時注文上限: 5件

## 認証
- POST /token でAPIトークン発行
- ヘッダー `X-API-KEY` にトークンを設定
- トークン無効化タイミング: KABUステーション終了時、ログアウト時、別トークン発行時
- 早朝に強制ログアウトあり

## 信用取引（デイトレ）発注パラメータ

### 新規建て（信用新規）
```json
{
  "Symbol": "9984",        // 銘柄コード（必須）
  "Exchange": 27,          // 市場: 27=東証+（通常時はSOR=9か東証+=27）
  "SecurityType": 1,       // 商品種別: 1=株式（必須）
  "Side": "2",             // 売買: "1"=売, "2"=買（必須）
  "CashMargin": 2,         // 信用区分: 1=現物, 2=新規, 3=返済（必須）
  "MarginTradeType": 3,    // 信用取引区分: 1=制度, 2=一般(長期), 3=一般(デイトレ)（信用時必須）
  "DelivType": 0,          // 受渡区分: 信用新規は0（必須）
  "FundType": "11",        // 資産区分: "11"=信用取引（信用時は"11"か省略）
  "AccountType": 4,        // 口座種別: 4=特定（必須）
  "Qty": 100,              // 注文数量（必須）
  "FrontOrderType": 10,    // 執行条件: 10=成行（必須）
  "Price": 0,              // 注文価格: 成行時は0（必須）
  "ExpireDay": 0           // 有効期限: 0=本日（必須）
}
```

### 返済（信用返済）
```json
{
  "Symbol": "9984",
  "Exchange": 27,
  "SecurityType": 1,
  "Side": "1",             // 買い建玉の返済は"1"(売)、売り建玉の返済は"2"(買)
  "CashMargin": 3,         // 返済
  "MarginTradeType": 3,    // デイトレ
  "DelivType": 2,          // 返済時は2=お預り金（必須）
  "FundType": "11",
  "AccountType": 4,
  "Qty": 100,
  "ClosePositionOrder": 0, // 決済順序: 0=日付古い順・損益高い順
  "FrontOrderType": 10,    // 成行
  "Price": 0,
  "ExpireDay": 0
}
```

### 執行条件（FrontOrderType）一覧
| 値 | 説明 | Price指定 |
|----|------|-----------|
| 10 | 成行 | 0 |
| 13 | 寄成（前場） | 0 |
| 14 | 寄成（後場） | 0 |
| 15 | 引成（前場） | 0 |
| 16 | 引成（後場） | 0 |
| 17 | IOC成行 | 0 |
| 20 | 指値 | 発注金額 |
| 21 | 寄指（前場） | 発注金額 |
| 22 | 寄指（後場） | 発注金額 |
| 23 | 引指（前場） | 発注金額 |
| 24 | 引指（後場） | 発注金額 |
| 25 | 不成（前場） | 発注金額 |
| 26 | 不成（後場） | 発注金額 |
| 27 | IOC指値 | 発注金額 |
| 30 | 逆指値 | AfterHitPriceで指定 |

### 市場コード（Exchange）
| 値 | 説明 |
|----|------|
| 1 | 東証（メンテ時のみ現物可） |
| 9 | SOR |
| 27 | 東証+ |

### 注文照会
- GET /orders でフィルタ可能
- レスポンスにOrderId, State, OrderQty, CumQty, Price, Side等

### 建玉照会
- GET /positions でフィルタ可能
- レスポンスにHoldID, Symbol, Side, Qty, Price, ProfitLoss等

### 注文取消
- PUT /cancelorder
- パラメータ: OrderId, Password

## 重要な制約
1. 発注APIはローカルPC（localhost:18080）からのみアクセス可能
2. 秒間5件のレート制限
3. 同一銘柄同時5件上限
4. デイトレ信用（MarginTradeType=3）は当日中に返済必須
5. 東証+（Exchange=27）を通常時に使用
6. 早朝の強制ログアウトでトークン無効化

## 自動売買での使用方針
- エントリー: 成行（FrontOrderType=10）で即約定を狙う
- 決済: 成行（FrontOrderType=10）
- 大引け強制決済: 引成（FrontOrderType=16）で確実に引けで約定させる
  - ただし引成は前場引け/後場引けのみ有効
  - 15:25に成行で出す方が確実（引成は約定しない場合がある）
- 信用区分: デイトレ信用（MarginTradeType=3）→ 手数料無料、金利も低い
- 口座: 特定口座（AccountType=4）
