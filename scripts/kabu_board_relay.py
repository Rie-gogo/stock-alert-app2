"""
kabu STATION® API 板情報＋1分足中継スクリプト
=============================================

【動作環境】
- Windows PC（kabuステーション®が起動していること）
- Python 3.8以上
- 必要ライブラリ: pip install requests websocket-client

【使い方】
1. kabuステーション®を起動する
2. このスクリプトをWindowsのコマンドプロンプトで実行:
   python kabu_board_relay.py

【動作の流れ】
kabuステーション® (localhost:18080)
    ↓ WebSocket で板情報をリアルタイム受信（プッシュ型）
    ↓ REST API で1分足OHLCVを1分ごとにポーリング（プル型）
このスクリプト（Windows）
    ↓ HTTP POST でクラウドWebアプリに転送
クラウドWebアプリ（stockalert-mwf5hf9f.manus.space）
    ↓ 板情報キャッシュ + 1分足シグナル判定 + 架空取引記録
ブラウザ画面に表示
"""

import json
import hashlib
import time
import threading
import uuid
import requests
import websocket
import logging
from datetime import datetime, timezone, timedelta

# ===== 設定 =====

# kabuステーション® APIの設定
# 検証環境: 18081、本番環境: 18080
KABU_API_PORT = 18081  # 検証環境
KABU_API_BASE = f"http://localhost:{KABU_API_PORT}/kabusapi"

# kabu STATION APIパスワード（kabuステーションのAPIシステム設定で設定したもの）
KABU_API_PASSWORD = "YOUR_API_PASSWORD_HERE"  # ← ここに設定したパスワードを入力

# 監視する銘柄コード（証券コード）
# 現在のシステムで使用している銘柄
WATCH_SYMBOLS = [
    {"Symbol": "6976", "Exchange": 1},  # 太陽誘電（東証プライム）
    {"Symbol": "6981", "Exchange": 1},  # 村田製作所（東証プライム）
    {"Symbol": "3778", "Exchange": 1},  # さくらインターネット（東証プライム）
    {"Symbol": "3436", "Exchange": 1},  # SUMCO（東証プライム）
    {"Symbol": "6600", "Exchange": 1},  # キオクシアHD（東証プライム）
]

# 銘柄コードのリスト（1分足取得用）
SYMBOL_CODES = [s["Symbol"] for s in WATCH_SYMBOLS]

# クラウドWebアプリのURL
CLOUD_BASE_URL = "https://stockalert-mwf5hf9f.manus.space"
CLOUD_BOARD_URL = f"{CLOUD_BASE_URL}/api/trpc/trading.pushOrderBook"
CLOUD_CANDLE_URL = f"{CLOUD_BASE_URL}/api/trpc/trading.pushCandle"

# 板情報の送信間隔（秒）- 同じ銘柄を連続送信しないためのレート制限
SEND_INTERVAL_SEC = 0.5

# 1分足のポーリング間隔（秒）- 毎分0秒から15秒後に取得
CANDLE_POLL_INTERVAL_SEC = 60

# 取引時間（JST）
MARKET_OPEN_TIME = "09:00"
MARKET_CLOSE_TIME = "15:30"

# ===== ログ設定 =====
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("kabu_relay.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

# ===== グローバル変数 =====
api_token = None
token_lock = threading.Lock()
last_send_time = {}  # 銘柄ごとの最終送信時刻

# 1分足の前回取得時刻（銘柄ごと）
last_candle_time = {}  # symbol -> "HH:MM"

# 前向き監査: 同じ送信イベントの再試行では同じIDを再利用する。
relay_session_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12]
event_seq = 0
event_seq_lock = threading.Lock()
event_metadata_by_key = {}

# 1分足の累積OHLCV（銘柄ごと、1分間の集計用）
candle_accum = {}  # symbol -> {"open": float, "high": float, "low": float, "close": float, "volume": int, "minute": str}


# ===== 日時ユーティリティ =====

JST = timezone(timedelta(hours=9))

def now_jst() -> datetime:
    """現在のJST時刻を返す"""
    return datetime.now(JST)

def today_jst_str() -> str:
    """今日のJST日付を YYYY-MM-DD 形式で返す"""
    return now_jst().strftime("%Y-%m-%d")

def current_minute_jst() -> str:
    """現在のJST時刻を HH:MM 形式で返す"""
    return now_jst().strftime("%H:%M")

def is_market_open() -> bool:
    """取引時間中かどうかを判定する"""
    t = current_minute_jst()
    return MARKET_OPEN_TIME <= t <= MARKET_CLOSE_TIME


# ===== APIトークン管理 =====

def get_api_token() -> str | None:
    """APIトークンを取得する"""
    try:
        response = requests.post(
            f"{KABU_API_BASE}/token",
            json={"APIPassword": KABU_API_PASSWORD},
            timeout=10,
        )
        if response.status_code == 200:
            token = response.json().get("Token")
            logger.info(f"APIトークン取得成功: {token[:8]}...")
            return token
        else:
            logger.error(f"APIトークン取得失敗: {response.status_code} {response.text}")
            return None
    except Exception as e:
        logger.error(f"APIトークン取得エラー: {e}")
        return None


def get_current_token() -> str | None:
    """スレッドセーフにトークンを取得する"""
    with token_lock:
        return api_token


# ===== 板情報（WebSocketプッシュ型） =====

def register_push_symbols(token: str) -> bool:
    """板情報のプッシュ配信を登録する"""
    try:
        response = requests.put(
            f"{KABU_API_BASE}/board",
            headers={"X-API-KEY": token},
            json={"Symbols": WATCH_SYMBOLS},
            timeout=10,
        )
        if response.status_code == 200:
            logger.info(f"{len(WATCH_SYMBOLS)}銘柄の板情報プッシュ配信を登録しました")
            return True
        else:
            logger.error(f"プッシュ配信登録失敗: {response.status_code} {response.text}")
            return False
    except Exception as e:
        logger.error(f"プッシュ配信登録エラー: {e}")
        return False


def parse_board_data(raw: dict) -> dict | None:
    """kabu STATION APIの板データをWebアプリ用に変換する"""
    try:
        symbol = str(raw.get("Symbol", ""))
        if not symbol:
            return None

        # 売気配（Sell1〜Sell10）を変換
        asks = []
        for i in range(1, 11):
            sell = raw.get(f"Sell{i}", {})
            if isinstance(sell, dict):
                price = sell.get("Price", 0)
                qty = sell.get("Qty", 0)
            else:
                price = raw.get(f"Sell{i}Price", 0)
                qty = raw.get(f"Sell{i}Qty", 0)
            if price and price > 0:
                asks.append({"price": float(price), "qty": int(qty)})

        # 買気配（Buy1〜Buy10）を変換
        bids = []
        for i in range(1, 11):
            buy = raw.get(f"Buy{i}", {})
            if isinstance(buy, dict):
                price = buy.get("Price", 0)
                qty = buy.get("Qty", 0)
            else:
                price = raw.get(f"Buy{i}Price", 0)
                qty = raw.get(f"Buy{i}Qty", 0)
            if price and price > 0:
                bids.append({"price": float(price), "qty": int(qty)})

        return {
            "symbol": symbol,
            "symbolName": str(raw.get("SymbolName", symbol)),
            "currentPrice": float(raw.get("CurrentPrice", 0)),
            "currentPriceTime": str(raw.get("CurrentPriceTime", "")),
            "asks": asks,
            "bids": bids,
            "marketOrderSellQty": int(raw.get("MarketOrderSellQty", 0)),
            "marketOrderBuyQty": int(raw.get("MarketOrderBuyQty", 0)),
            "overSellQty": int(raw.get("OverSellQty", 0)),
            "underBuyQty": int(raw.get("UnderBuyQty", 0)),
            "vwap": float(raw.get("VWAP", 0)),
        }
    except Exception as e:
        logger.error(f"板データ変換エラー: {e}")
        return None


def send_board_to_cloud(board_data: dict) -> bool:
    """板情報をクラウドWebアプリに送信する"""
    symbol = board_data.get("symbol", "")

    # レート制限チェック
    now = time.time()
    if symbol in last_send_time:
        elapsed = now - last_send_time[symbol]
        if elapsed < SEND_INTERVAL_SEC:
            return True  # スキップ（エラーではない）

    try:
        # tRPC形式でPOST送信
        response = requests.post(
            CLOUD_BOARD_URL,
            json={"json": board_data},
            headers={"Content-Type": "application/json"},
            timeout=5,
        )
        if response.status_code == 200:
            last_send_time[symbol] = now
            logger.debug(f"板情報送信成功: {symbol} 現値={board_data.get('currentPrice')}")
            return True
        else:
            logger.warning(f"板情報送信失敗: {symbol} {response.status_code}")
            return False
    except Exception as e:
        logger.error(f"板情報送信エラー: {symbol} {e}")
        return False


def on_message(ws, message):
    """WebSocketからメッセージを受信したとき"""
    try:
        raw = json.loads(message)
        board_data = parse_board_data(raw)
        if board_data:
            # 別スレッドで非同期送信（WebSocketをブロックしない）
            threading.Thread(
                target=send_board_to_cloud,
                args=(board_data,),
                daemon=True,
            ).start()

            # 板情報から現在値を取得して1分足累積データを更新
            symbol = board_data.get("symbol", "")
            price = board_data.get("currentPrice", 0)
            if symbol and price > 0:
                update_candle_accum(symbol, price)

    except json.JSONDecodeError:
        pass  # 非JSONメッセージは無視


def on_error(ws, error):
    """WebSocketエラー"""
    logger.error(f"WebSocketエラー: {error}")


def on_close(ws, close_status_code, close_msg):
    """WebSocket切断"""
    logger.warning(f"WebSocket切断: {close_status_code} {close_msg}")


def on_open(ws):
    """WebSocket接続確立"""
    logger.info("WebSocket接続確立 - 板情報の受信を開始します")


def start_websocket(token: str):
    """WebSocketで板情報をリアルタイム受信する"""
    ws_url = f"ws://localhost:{KABU_API_PORT}/kabusapi/websocket"

    ws = websocket.WebSocketApp(
        ws_url,
        header={"X-API-KEY": token},
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )

    logger.info(f"WebSocket接続中: {ws_url}")
    ws.run_forever(ping_interval=30, ping_timeout=10)


# ===== 1分足OHLCV（WebSocket板情報から集計） =====

def update_candle_accum(symbol: str, price: float):
    """
    板情報の現在値から1分足OHLCVを累積する。
    毎分0秒になったら前の分の足を確定して送信する。
    """
    current_minute = current_minute_jst()

    if symbol not in candle_accum:
        # 初回: 新しい分の足を開始
        candle_accum[symbol] = {
            "open": price,
            "high": price,
            "low": price,
            "close": price,
            "volume": 0,
            "minute": current_minute,
        }
        return

    accum = candle_accum[symbol]

    if accum["minute"] != current_minute:
        # 分が変わった: 前の分の足を確定して送信
        prev_minute = accum["minute"]
        prev_candle = {
            "symbol": symbol,
            "tradeDate": today_jst_str(),
            "candleTime": prev_minute,
            "open": accum["open"],
            "high": accum["high"],
            "low": accum["low"],
            "close": accum["close"],
            "volume": accum["volume"],
        }

        # 別スレッドで送信
        threading.Thread(
            target=send_candle_to_cloud,
            args=(prev_candle,),
            daemon=True,
        ).start()

        # 新しい分の足を開始
        candle_accum[symbol] = {
            "open": price,
            "high": price,
            "low": price,
            "close": price,
            "volume": 0,
            "minute": current_minute,
        }
    else:
        # 同じ分: 高値・安値・終値を更新
        accum["high"] = max(accum["high"], price)
        accum["low"] = min(accum["low"], price)
        accum["close"] = price


def fetch_candle_from_api(symbol: str, token: str) -> dict | None:
    """
    kabu STATION APIの /kabusapi/board エンドポイントから現在の板情報を取得し、
    1分足として使用する（WebSocket補完用）。
    """
    try:
        response = requests.get(
            f"{KABU_API_BASE}/board/{symbol}@1",  # @1 = 東証プライム
            headers={"X-API-KEY": token},
            timeout=5,
        )
        if response.status_code == 200:
            data = response.json()
            price = float(data.get("CurrentPrice", 0))
            if price > 0:
                return {
                    "symbol": symbol,
                    "tradeDate": today_jst_str(),
                    "candleTime": current_minute_jst(),
                    "open": price,
                    "high": price,
                    "low": price,
                    "close": price,
                    "volume": int(data.get("TradingVolume", 0)),
                }
        return None
    except Exception as e:
        logger.error(f"板情報REST取得エラー: {symbol} {e}")
        return None


def send_candle_to_cloud(candle_data: dict) -> bool:
    """1分足OHLCVをクラウドWebアプリに送信する"""
    symbol = candle_data.get("symbol", "")
    candle_time = candle_data.get("candleTime", "")

    # 重複送信チェック（同じ銘柄・同じ分は1回だけ送信）
    key = f"{symbol}_{candle_time}"
    if key in last_candle_time:
        return True  # 既に送信済み

    payload = {**candle_data}
    audit_key = candle_data.get("tradeDate", "") + "_" + key
    with event_seq_lock:
        global event_seq
        metadata = event_metadata_by_key.get(audit_key)
        if metadata is None:
            event_seq += 1
            received_at_ms = int(time.time() * 1000)
            canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            metadata = {
                "sourceEventId": relay_session_id + ":" + str(event_seq),
                "relaySessionId": relay_session_id,
                "eventSeq": event_seq,
                "payloadHash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
                "relayReceivedAtMs": received_at_ms,
            }
            event_metadata_by_key[audit_key] = metadata
    payload.update(metadata)
    payload["relaySentAtMs"] = int(time.time() * 1000)

    try:
        response = requests.post(
            CLOUD_CANDLE_URL,
            json={"json": payload},
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        if response.status_code == 200:
            last_candle_time[key] = time.time()
            result = response.json()
            action = result.get("result", {}).get("data", {}).get("json", {}).get("action", "none")
            pnl = result.get("result", {}).get("data", {}).get("json", {}).get("pnl")
            if action != "none":
                pnl_str = f" 損益:{'+' if pnl and pnl >= 0 else ''}{pnl}円" if pnl is not None else ""
                logger.info(f"1分足送信→取引発生: {symbol} {candle_time} {action}{pnl_str}")
            else:
                logger.debug(f"1分足送信成功: {symbol} {candle_time} O={candle_data['open']} H={candle_data['high']} L={candle_data['low']} C={candle_data['close']}")
            return True
        else:
            logger.warning(f"1分足送信失敗: {symbol} {candle_time} {response.status_code} {response.text[:100]}")
            return False
    except Exception as e:
        logger.error(f"1分足送信エラー: {symbol} {candle_time} {e}")
        return False


def candle_polling_loop():
    """
    1分ごとに全銘柄の1分足を送信するポーリングループ。
    WebSocketの板情報から累積したOHLCVを毎分送信する補完機能。
    板情報が届いていない銘柄はREST APIで取得する。
    """
    logger.info("1分足ポーリングループ開始")

    while True:
        try:
            now = now_jst()
            current_min = now.strftime("%H:%M")

            # 取引時間外はスキップ
            if not is_market_open():
                time.sleep(30)
                continue

            # 毎分15秒後に実行（前の分の足が確定してから送信）
            # 例: 09:01:15 に 09:01 の足を送信
            seconds = now.second
            if seconds < 15:
                time.sleep(15 - seconds)
                continue

            # 前の分の時刻を計算
            prev_minute_dt = now - timedelta(minutes=1)
            prev_minute = prev_minute_dt.strftime("%H:%M")
            trade_date = today_jst_str()

            token = get_current_token()
            if not token:
                time.sleep(10)
                continue

            # 全銘柄の1分足を送信
            for symbol in SYMBOL_CODES:
                key = f"{symbol}_{prev_minute}"
                if key in last_candle_time:
                    continue  # 既に送信済み

                # WebSocket累積データがあればそれを使用
                accum = candle_accum.get(symbol)
                if accum and accum.get("minute") == prev_minute:
                    candle = {
                        "symbol": symbol,
                        "tradeDate": trade_date,
                        "candleTime": prev_minute,
                        "open": accum["open"],
                        "high": accum["high"],
                        "low": accum["low"],
                        "close": accum["close"],
                        "volume": accum["volume"],
                    }
                else:
                    # WebSocket累積データがない場合はREST APIで取得
                    candle = fetch_candle_from_api(symbol, token)
                    if candle:
                        candle["candleTime"] = prev_minute  # 前の分の時刻に修正

                if candle:
                    threading.Thread(
                        target=send_candle_to_cloud,
                        args=(candle,),
                        daemon=True,
                    ).start()

            # 次の分まで待機（次の分の15秒後まで）
            now2 = now_jst()
            next_send = now2.replace(second=15, microsecond=0) + timedelta(minutes=1)
            wait_sec = (next_send - now2).total_seconds()
            if wait_sec > 0:
                time.sleep(min(wait_sec, 60))

        except Exception as e:
            logger.error(f"1分足ポーリングエラー: {e}")
            time.sleep(10)


def main():
    """メイン処理"""
    global api_token

    logger.info("=" * 60)
    logger.info("kabu STATION® API 板情報＋1分足中継スクリプト 起動")
    logger.info(f"監視銘柄: {SYMBOL_CODES}")
    logger.info(f"板情報送信先: {CLOUD_BOARD_URL}")
    logger.info(f"1分足送信先: {CLOUD_CANDLE_URL}")
    logger.info("=" * 60)

    # 1分足ポーリングスレッドを起動
    candle_thread = threading.Thread(target=candle_polling_loop, daemon=True)
    candle_thread.start()
    logger.info("1分足ポーリングスレッド起動完了")

    while True:
        # Step 1: APIトークンを取得
        logger.info("APIトークンを取得中...")
        token = get_api_token()
        if not token:
            logger.error("トークン取得失敗。30秒後に再試行します...")
            time.sleep(30)
            continue

        with token_lock:
            api_token = token

        # Step 2: プッシュ配信を登録
        if not register_push_symbols(token):
            logger.error("プッシュ配信登録失敗。30秒後に再試行します...")
            time.sleep(30)
            continue

        # Step 3: WebSocketで板情報を受信（切断されるまでブロック）
        logger.info("板情報の受信を開始します...")
        start_websocket(token)

        # WebSocketが切断された場合、10秒後に再接続
        logger.warning("WebSocket切断。10秒後に再接続します...")
        time.sleep(10)


if __name__ == "__main__":
    main()
