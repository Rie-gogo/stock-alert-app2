# Engine Parameters for Simulation

## Position Sizing
- INITIAL_CAPITAL_PER_STOCK = 3,000,000
- LOT_RATIO = 0.9
- calcShares: Math.max(100, Math.floor(Math.floor(amount/price) / 100) * 100) where amount = 3M * 0.9 = 2,700,000
- MARGIN_CAPITAL = 3,000,000, MULTIPLIER = 3.3, USAGE_LIMIT = 0.9
- MAX_TOTAL_EXPOSURE = 8,910,000

## TP/SL
- STOP_LOSS_PERCENT = 0.5%
- TAKE_PROFIT_PERCENT = 1.5%
- No symbol-specific overrides currently

## Time Filters
- NO_ENTRY_BEFORE = "09:30"
- NO_ENTRY_AFTER = "15:05"
- NO_ENTRY_PRE_LUNCH = "11:00"-"11:30"
- NO_ENTRY_POST_LUNCH = "12:30"-"13:00"
- MARKET_CLOSE_TIME = "15:25"
- Lunch skip: "11:30"-"12:30"

## State Machine
- ROUND_LEVEL_CONFIRM_BARS = 5
- ROUND_PULLBACK_MAX_WAIT = 5
- ROUND_DISTANCE_BLOCK_THRESHOLD_PCT = 0.8

## Filters (in order for BUY)
1. VWAPクロス上抜け無効化
2. sell_pressure板圧力
3. 板読みスコア < 1 (boardReadingScore)
4. 3分足HTFフィルター (htfTrend==="down")
5. ダウ理論→押し目SM (with pullback depth 30-70%)
6. 大台超え→確認SM→押し目SM→0.8%チェック
7. medium直接ブロック

## Filters (in order for SHORT)
1. buy_pressure板圧力
2. isBullish方式 (MA20 slope > -0.03%)
3. 板読みスコア < 1
4. 3分足HTFフィルター (htfTrend==="up")
5. ダウ理論→押し目SM (with pullback depth)
6. 大台割れ→確認SM→押し目SM→0.8%チェック
7. SHORT medium全ブロック

## At enterPosition level
- 午後安値圏フィルター: 13:00以降 SHORT 始値比-5%以下ブロック
- 午後高値圏フィルター: 13:00以降 LONG 始値比+4%以上ブロック (PM_HIGHZONE_THRESHOLD=0.04)
- 証拠金使用率制限 (MAX_TOTAL_EXPOSURE)

## isBullish
- MA20 period, slope threshold = -0.03%
- Fallback: 始値比+0.2%

## Board Score
- Returns 1 when no board data (neutral = pass)
- BOARD_SCORE_THRESHOLD = 1

## HTF at SM entry time
- Checked AGAIN at timeout entry and pullback confirmation entry
- Also checks sell_pressure/buy_pressure at SM entry

## Key: simulation WITHOUT board data
- boardReadingScore returns 1 (always passes)
- sell_pressure/buy_pressure never triggers
- This is a SIGNIFICANT difference from production
