#!/usr/bin/env python3
"""
明日（月曜日）の大引け後に実際の市場データを使って自動検証を行い、
レポートを生成するスクリプト。
"""

import sys
sys.path.append('/opt/.manus/.sandbox-runtime')
from data_api import ApiClient
import json
import datetime

# 監視対象の10銘柄 (.Tは東証を表す)
STOCKS = {
    '6526': 'ソシオネクスト',
    '6920': 'レーザーテック',
    '6857': 'アドバンテスト',
    '9107': '川崎汽船',
    '8306': '三菱UFJ FG',
    '9984': 'ソフトバンクグループ',
    '8035': '東京エレクトロン',
    '7011': '三菱重工業',
    '4568': '第一三共',
    '3778': 'さくらインターネット'
}

client = ApiClient()

def calculate_rsi(prices, period=14):
    if len(prices) < period + 1:
        return [50] * len(prices)
    
    rsi_values = [50] * len(prices)
    gains = []
    losses = []
    
    for i in range(1, len(prices)):
        diff = prices[i] - prices[i-1]
        if diff >= 0:
            gains.append(diff)
            losses.append(0)
        else:
            gains.append(0)
            losses.append(abs(diff))
            
    # 初期の平均
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    
    if avg_loss == 0:
        rsi_values[period] = 100
    else:
        rs = avg_gain / avg_loss
        rsi_values[period] = 100 - (100 / (1 + rs))
        
    for i in range(period + 1, len(prices)):
        avg_gain = (avg_gain * (period - 1) + gains[i-1]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i-1]) / period
        
        if avg_loss == 0:
            rsi_values[i] = 100
        else:
            rs = avg_gain / avg_loss
            rsi_values[i] = 100 - (100 / (1 + rs))
            
    return rsi_values

def calculate_ma(prices, period):
    ma = []
    for i in range(len(prices)):
        if i < period - 1:
            ma.append(None)
        else:
            ma.append(sum(prices[i - period + 1 : i + 1]) / period)
    return ma

def calculate_bollinger_bands(prices, period=20, num_std=2):
    upper = []
    lower = []
    for i in range(len(prices)):
        if i < period - 1:
            upper.append(None)
            lower.append(None)
        else:
            slice_prices = prices[i - period + 1 : i + 1]
            ma = sum(slice_prices) / period
            variance = sum((x - ma) ** 2 for x in slice_prices) / period
            std_dev = variance ** 0.5
            upper.append(ma + num_std * std_dev)
            lower.append(ma - num_std * std_dev)
    return upper, lower

def simulate_trading(symbol, name, timestamps, closes, initial_capital=3000000):
    # テクニカル指標の計算
    ma5 = calculate_ma(closes, 5)
    ma25 = calculate_ma(closes, 25)
    rsi = calculate_rsi(closes, 14)
    bb_upper, bb_lower = calculate_bollinger_bands(closes, 20, 2)
    
    capital = initial_capital
    position_shares = 0
    position_price = 0
    trades = []
    win_count = 0
    loss_count = 0
    
    for i in range(25, len(closes)):
        time_str = datetime.datetime.fromtimestamp(timestamps[i]).strftime('%H:%M')
        close = closes[i]
        
        # 指標の値
        c_rsi = rsi[i]
        c_m5 = ma5[i]
        c_m25 = ma25[i]
        c_bbu = bb_upper[i]
        c_bbl = bb_lower[i]
        
        p_m5 = ma5[i-1]
        p_m25 = ma25[i-1]
        
        if c_rsi is None or c_m5 is None or c_m25 is None or c_bbu is None or c_bbl is None:
            continue
            
        # 1. 買い判定（超厳格化ロジック：下降トレンド中は買わない、GCまたは売られすぎ+ボリバン下限）
        is_gc = p_m5 <= p_m25 and c_m5 > c_m25
        is_oversold = c_rsi <= 35
        is_bb_lower = close <= c_bbl
        
        is_downtrend = c_m5 < c_m25
        is_strong_downtrend = is_downtrend and close < c_m5
        
        # 強い下降トレンド中は絶対に買わない
        should_buy = not is_strong_downtrend and (is_gc or (is_oversold and is_bb_lower))
        
        if position_shares == 0 and should_buy:
            max_spend = capital * 0.98
            shares = int(max_spend // close)
            if shares > 0:
                total_amount = shares * close
                position_shares = shares
                position_price = close
                capital -= total_amount
                trades.append({
                    'time': time_str,
                    'type': 'buy',
                    'price': close,
                    'shares': shares,
                    'total_amount': total_amount
                })
                
        # 2. 売り判定（強い上昇トレンドでのフライング売り防止 ＆ デッドクロス厳選）
        is_dc = p_m5 >= p_m25 and c_m5 < c_m25
        is_overbought = c_rsi >= 65
        is_bb_upper = close >= c_bbu
        
        # 強い上昇トレンドの判定
        is_strong_uptrend = c_m5 > c_m25 * 1.003 and close >= c_m5
        
        # 売りシグナル：デッドクロス、または(トレンドが強くない状態での買われすぎ＋ボリバン上限)
        should_sell = is_dc or (is_overbought and is_bb_upper and not is_strong_uptrend)
        
        # 損切りロジック (-1.5% で強制損切り)
        is_stop_loss = position_shares > 0 and close <= position_price * 0.985
        
        if position_shares > 0 and (should_sell or is_stop_loss):
            total_amount = position_shares * close
            profit = total_amount - (position_shares * position_price)
            profit_rate = (close - position_price) / position_price
            
            capital += total_amount
            if profit > 0:
                win_count += 1
            else:
                loss_count += 1
                
            trades.append({
                'time': time_str,
                'type': 'sell',
                'price': close,
                'shares': position_shares,
                'total_amount': total_amount,
                'profit': profit,
                'profit_rate': profit_rate,
                'reason': '損切り' if is_stop_loss else 'シグナル決済'
            })
            position_shares = 0
            position_price = 0
            
    # 最後にポジションが残っていれば強制大引け決済
    if position_shares > 0:
        last_close = closes[-1]
        time_str = "15:00"
        total_amount = position_shares * last_close
        profit = total_amount - (position_shares * position_price)
        profit_rate = (last_close - position_price) / position_price
        
        capital += total_amount
        if profit > 0:
            win_count += 1
        else:
            loss_count += 1
            
        trades.append({
            'time': time_str,
            'type': 'sell',
            'price': last_close,
            'shares': position_shares,
            'total_amount': total_amount,
            'profit': profit,
            'profit_rate': profit_rate,
            'reason': '大引け強制決済'
        })
        
    profit_amount = capital - initial_capital
    profit_rate = profit_amount / initial_capital
    win_rate = win_count / (win_count + loss_count) if (win_count + loss_count) > 0 else 0
    
    # 動的マイナス原因と対策
    loss_causes = []
    countermeasures = []
    if profit_amount < 0:
        loss_causes.append("急激なトレンド転換による一時的な含み損の拡大と、-1.5%損切りラインへの抵触。")
        loss_causes.append("もみ合い（レンジ）相場での小刻みなシグナルによる手数料・スプレッド負け。")
        countermeasures.append("もみ合い相場を検知するため、ADXやボリンジャーバンドの幅（スクイーズ）による取引フィルターの追加。")
        countermeasures.append("ボラティリティに応じた損切り幅の動的調整（ATR指標の導入）。")
    else:
        loss_causes.append("特になし（利益獲得に成功）。")
        countermeasures.append("現在の厳格化フィルタリングルールを維持し、利益を最大化する。")
        
    return {
        'symbol': symbol,
        'name': name,
        'initial_capital': initial_capital,
        'final_balance': capital,
        'profit_amount': profit_amount,
        'profit_rate': profit_rate,
        'win_rate': win_rate,
        'trades_count': len(trades) // 2,
        'trades': trades,
        'loss_causes': loss_causes,
        'countermeasures': countermeasures
    }

def main():
    print("=== 明日の市場データシミュレーションの実行準備 ===")
    reports = []
    total_profit = 0
    
    for symbol, name in STOCKS.items():
        print(f"Fetching data for {symbol} ({name})...")
        try:
            response = client.call_api('YahooFinance/get_stock_chart', query={
                'symbol': f"{symbol}.T",
                'region': 'JP',
                'interval': '1m',
                'range': '1d',
            })
            
            if response and 'chart' in response and 'result' in response['chart']:
                result = response['chart']['result'][0]
                timestamps = result.get('timestamp', [])
                quotes = result['indicators']['quote'][0]
                closes = [c for c in quotes.get('close', []) if c is not None]
                
                # 有効なデータのみに絞る
                valid_timestamps = [timestamps[i] for i in range(len(quotes.get('close', []))) if quotes.get('close', [])[i] is not None]
                
                if len(closes) > 30:
                    report = simulate_trading(symbol, name, valid_timestamps, closes)
                    reports.append(report)
                    total_profit += report['profit_amount']
                    print(f"-> {name} 損益: {report['profit_amount']:+,.0f}円 ({(report['profit_rate']*100):+.2f}%)")
                else:
                    print(f"-> データ不足（東証開場前など）")
            else:
                print(f"-> データ取得失敗")
        except Exception as e:
            print(f"-> エラー: {e}")
            
    # レポートファイルの保存
    output_path = '/home/ubuntu/stock-alert-app/tomorrow_actual_report.json'
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump({
            'date': datetime.datetime.now().strftime('%Y-%m-%d'),
            'total_profit': total_profit,
            'reports': reports
        }, f, ensure_ascii=False, indent=2)
        
    print(f"レポートを保存しました: {output_path}")

if __name__ == '__main__':
    main()
