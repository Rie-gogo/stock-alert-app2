"""
kabu_board_relay_v5.4.py  ─  WebSocket切断許容・REST継続強化版
================================================
v5.4修正点（2026-06-16）:
  1. WebSocket ping無効化（kabuステーション®はpingプロトコル非対応）:
     - v5.3でping_interval=20に設定したが「ping/pong timed out」が発生
     - kabuステーション®のWebSocketサーバーはpongを返さないため、pingを無効化
     - ping_interval=0（無効）に戻す
  2. WinError 10054対策の方針変更:
     - WebSocket切断は「正常な動作」として受け入れる
     - 切断後は即座に再接続（5秒待機）
     - WebSocketが切断中でもRESTポーリングで1分足送信を継続（フォールバック）
  3. 板情報タイムアウト修正（v5.3から継続）:
     - タイムアウト3秒・local_session使用・WARNINGログ

v5.3からの変更点:
  - start_websocket: ping_interval=20 → ping_interval=0（無効）
  - ping_timeout削除
"""

import json
import logging
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import socket
import threading
import time
from datetime import datetime, timezone, timedelta

# ============================================================
# 設定
# ============================================================

KABU_API_PORT = 18080
KABU_API_BASE = "http://localhost:" + str(KABU_API_PORT) + "/kabusapi"
KABU_API_PASSWORD = "1MabqUug47"

WATCH_SYMBOLS = [
    {"Symbol": "6526", "Exchange": 1},
    {"Symbol": "6920", "Exchange": 1},
    {"Symbol": "6857", "Exchange": 1},
    {"Symbol": "9107", "Exchange": 1},
    {"Symbol": "8306", "Exchange": 1},
    {"Symbol": "9984", "Exchange": 1},
    {"Symbol": "8035", "Exchange": 1},
    {"Symbol": "7011", "Exchange": 1},
    {"Symbol": "4568", "Exchange": 1},
    {"Symbol": "3778", "Exchange": 1},
    {"Symbol": "285A", "Exchange": 1},
    {"Symbol": "6981", "Exchange": 1},
    {"Symbol": "6976", "Exchange": 1},
    {"Symbol": "5803", "Exchange": 1},
    {"Symbol": "5016", "Exchange": 1},
    {"Symbol": "3436", "Exchange": 1},
    {"Symbol": "8316", "Exchange": 1},
    {"Symbol": "6758", "Exchange": 1},
    {"Symbol": "6723", "Exchange": 1},
    {"Symbol": "7203", "Exchange": 1},
]
SYMBOL_CODES = [s["Symbol"] for s in WATCH_SYMBOLS]

CLOUD_BASE_URL = "https://stockalert-mwf5hf9f.manus.space"
CLOUD_CANDLE_WITH_BOARD_URL = CLOUD_BASE_URL + "/api/trpc/trading.pushCandleWithBoard"

SEND_LEGACY = False
CLOUD_CANDLE_URL = CLOUD_BASE_URL + "/api/trpc/trading.pushCandle"

SEND_INTERVAL_SEC = 0.1   # 銘柄間の送信間隔（0.1秒）
MARKET_OPEN_TIME  = "08:45"
MARKET_CLOSE_TIME = "15:35"

# 大口注文の閾値（平均の何倍以上を「大口」とするか）
LARGE_WALL_MULTIPLIER = 5.0
# アイスバーグ検出: 前回比でこの割合以上減少したら「消えた」と判断
ICEBERG_DROP_RATIO = 0.5
# 板キャンセル検出: 大口注文が前回比でこの割合以上消えたら「キャンセル」と判断
CANCEL_DROP_RATIO = 0.7

logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("kabu_relay.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

api_token       = None
token_lock      = threading.Lock()
last_candle_time = {}
candle_accum     = {}

# トークンTTLキャッシュ（WebSocket接続中のみ使用）
TOKEN_TTL_SEC   = 270  # 4.5分ごとに再取得
_token_fetched_at = 0.0

# 前回の板スナップショット（アイスバーグ・キャンセル検出用）
prev_board_snapshot = {}

JST = timezone(timedelta(hours=9))

# WebSocket接続状態フラグ
ws_connected = False
ws_connected_lock = threading.Lock()

# ============================================================
# HTTPSセッション（クラウド送信用・SSL接続を再利用）
# ============================================================

def _create_cloud_session():
    session = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=0.5,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["POST", "GET"],
    )
    adapter = HTTPAdapter(
        max_retries=retry,
        pool_connections=5,
        pool_maxsize=5,
    )
    session.mount("https://", adapter)
    return session

def _create_local_session():
    """ローカルkabuステーション®REST API用セッション（クラウド用と分離）。"""
    session = requests.Session()
    adapter = HTTPAdapter(
        pool_connections=3,
        pool_maxsize=3,
    )
    session.mount("http://", adapter)
    return session

cloud_session = _create_cloud_session()
cloud_session_lock = threading.Lock()

local_session = _create_local_session()
local_session_lock = threading.Lock()


# ============================================================
# 時刻ユーティリティ
# ============================================================

def now_jst():
    return datetime.now(JST)

def today_jst_str():
    return now_jst().strftime("%Y-%m-%d")

def current_minute_jst():
    return now_jst().strftime("%H:%M")

def is_market_open():
    t = current_minute_jst()
    return MARKET_OPEN_TIME <= t <= MARKET_CLOSE_TIME


# ============================================================
# kabu STATION API: トークン取得・銘柄登録
# ============================================================

def get_api_token(force=False):
    global api_token, _token_fetched_at
    now_ts = time.time()
    with token_lock:
        if not force and api_token and (now_ts - _token_fetched_at) < TOKEN_TTL_SEC:
            return api_token
    logger.info("APIトークンを取得中" + ("（強制再取得）" if force else "（TTLキャッシュ使用）") + "...")
    try:
        r = requests.post(
            KABU_API_BASE + "/token",
            json={"APIPassword": KABU_API_PASSWORD},
            timeout=10,
        )
        if r.status_code == 200:
            token = r.json().get("Token")
            logger.info("APIトークン取得成功: " + token[:8] + "...")
            with token_lock:
                api_token = token
                _token_fetched_at = time.time()
            return token
        logger.error("APIトークン取得失敗: " + str(r.status_code) + " " + r.text)
        return None
    except Exception as e:
        logger.error("APIトークン取得エラー: " + str(e))
        return None

def get_current_token():
    with token_lock:
        return api_token

def register_push_symbols(token):
    try:
        r = requests.put(
            KABU_API_BASE + "/register",
            headers={"X-API-KEY": token},
            json={"Symbols": WATCH_SYMBOLS},
            timeout=10,
        )
        if r.status_code == 200:
            logger.info(str(len(WATCH_SYMBOLS)) + "銘柄のプッシュ配信を登録しました")
            return True
        logger.error("プッシュ配信登録失敗: " + str(r.status_code) + " " + r.text)
        return False
    except Exception as e:
        logger.error("プッシュ配信登録エラー: " + str(e))
        return False


# ============================================================
# 板情報の拡張分析（v5の核心）
# ============================================================

def analyze_board_extended(raw, symbol):
    asks = raw.get("asks", [])
    bids = raw.get("bids", [])
    current_price = raw.get("currentPrice", 0)
    market_buy_qty  = raw.get("marketOrderBuyQty", 0)
    market_sell_qty = raw.get("marketOrderSellQty", 0)
    over_sell_qty   = raw.get("overSellQty", 0)
    under_buy_qty   = raw.get("underBuyQty", 0)

    total_ask_qty = sum(a["qty"] for a in asks) + over_sell_qty
    total_bid_qty = sum(b["qty"] for b in bids) + under_buy_qty

    large_ask_wall_ratio = 0.0
    large_ask_wall_price = None
    if asks:
        avg_ask = total_ask_qty / len(asks) if len(asks) > 0 else 0
        for a in asks:
            ratio = a["qty"] / avg_ask if avg_ask > 0 else 0
            if ratio > large_ask_wall_ratio:
                large_ask_wall_ratio = ratio
                large_ask_wall_price = a["price"]
        if large_ask_wall_ratio < LARGE_WALL_MULTIPLIER:
            large_ask_wall_price = None

    large_bid_wall_ratio = 0.0
    large_bid_wall_price = None
    if bids:
        avg_bid = total_bid_qty / len(bids) if len(bids) > 0 else 0
        for b in bids:
            ratio = b["qty"] / avg_bid if avg_bid > 0 else 0
            if ratio > large_bid_wall_ratio:
                large_bid_wall_ratio = ratio
                large_bid_wall_price = b["price"]
        if large_bid_wall_ratio < LARGE_WALL_MULTIPLIER:
            large_bid_wall_price = None

    near_ask_wall_pct = None
    near_bid_wall_pct = None
    if current_price > 0:
        if large_ask_wall_price:
            near_ask_wall_pct = round((large_ask_wall_price - current_price) / current_price * 100, 2)
        if large_bid_wall_price:
            near_bid_wall_pct = round((current_price - large_bid_wall_price) / current_price * 100, 2)

    market_order_direction = "neutral"
    if market_buy_qty > market_sell_qty * 1.5:
        market_order_direction = "buy"
    elif market_sell_qty > market_buy_qty * 1.5:
        market_order_direction = "sell"

    ask_cancel_detected = False
    bid_cancel_detected = False
    iceberg_ask_detected = False
    iceberg_bid_detected = False

    prev = prev_board_snapshot.get(symbol)
    if prev:
        curr_ask_map = {a["price"]: a["qty"] for a in asks}
        curr_bid_map = {b["price"]: b["qty"] for b in bids}
        prev_ask_map = prev.get("ask_qty_map", {})
        prev_bid_map = prev.get("bid_qty_map", {})

        for price, prev_qty in prev_ask_map.items():
            curr_qty = curr_ask_map.get(price, 0)
            if prev_qty > 0:
                drop_ratio = (prev_qty - curr_qty) / prev_qty
                if drop_ratio >= CANCEL_DROP_RATIO and prev_qty >= (total_ask_qty / max(len(asks), 1)) * LARGE_WALL_MULTIPLIER:
                    ask_cancel_detected = True
                elif ICEBERG_DROP_RATIO <= drop_ratio < CANCEL_DROP_RATIO:
                    iceberg_ask_detected = True

        for price, prev_qty in prev_bid_map.items():
            curr_qty = curr_bid_map.get(price, 0)
            if prev_qty > 0:
                drop_ratio = (prev_qty - curr_qty) / prev_qty
                if drop_ratio >= CANCEL_DROP_RATIO and prev_qty >= (total_bid_qty / max(len(bids), 1)) * LARGE_WALL_MULTIPLIER:
                    bid_cancel_detected = True
                elif ICEBERG_DROP_RATIO <= drop_ratio < CANCEL_DROP_RATIO:
                    iceberg_bid_detected = True

    prev_board_snapshot[symbol] = {
        "ask_qty_map": {a["price"]: a["qty"] for a in asks},
        "bid_qty_map": {b["price"]: b["qty"] for b in bids},
    }

    return {
        "totalAskQty":          total_ask_qty,
        "totalBidQty":          total_bid_qty,
        "marketOrderBuyQty":    market_buy_qty,
        "marketOrderSellQty":   market_sell_qty,
        "largeAskWallRatio":    round(large_ask_wall_ratio, 2),
        "largeBidWallRatio":    round(large_bid_wall_ratio, 2),
        "largeAskWallPrice":    large_ask_wall_price,
        "largeBidWallPrice":    large_bid_wall_price,
        "nearAskWallPct":       near_ask_wall_pct,
        "nearBidWallPct":       near_bid_wall_pct,
        "marketOrderDirection": market_order_direction,
        "askCancelDetected":    ask_cancel_detected,
        "bidCancelDetected":    bid_cancel_detected,
        "icebergAskDetected":   iceberg_ask_detected,
        "icebergBidDetected":   iceberg_bid_detected,
    }


# ============================================================
# kabu STATION REST API: 板情報取得（v5.3: タイムアウト3秒・local_session）
# ============================================================

def fetch_board_from_api(symbol, token):
    try:
        with local_session_lock:
            r = local_session.get(
                KABU_API_BASE + "/board/" + symbol + "@1",
                headers={"X-API-KEY": token},
                timeout=3,
            )
        if r.status_code != 200:
            return None
        raw = r.json()

        asks = []
        for i in range(1, 11):
            sell = raw.get("Sell" + str(i), {})
            if isinstance(sell, dict):
                price = sell.get("Price", 0)
                qty   = sell.get("Qty", 0)
            else:
                price, qty = 0, 0
            if price and price > 0:
                asks.append({"price": float(price), "qty": int(qty)})

        bids = []
        for i in range(1, 11):
            buy = raw.get("Buy" + str(i), {})
            if isinstance(buy, dict):
                price = buy.get("Price", 0)
                qty   = buy.get("Qty", 0)
            else:
                price, qty = 0, 0
            if price and price > 0:
                bids.append({"price": float(price), "qty": int(qty)})

        current_price_raw = raw.get("CurrentPrice")
        current_price = float(current_price_raw) if current_price_raw is not None else 0.0

        base_data = {
            "symbol":              str(raw.get("Symbol", symbol)),
            "symbolName":          str(raw.get("SymbolName", symbol)),
            "currentPrice":        current_price,
            "currentPriceTime":    str(raw.get("CurrentPriceTime", "")),
            "asks":                asks,
            "bids":                bids,
            "marketOrderSellQty":  int(raw.get("MarketOrderSellQty", 0) or 0),
            "marketOrderBuyQty":   int(raw.get("MarketOrderBuyQty", 0) or 0),
            "overSellQty":         int(raw.get("OverSellQty", 0) or 0),
            "underBuyQty":         int(raw.get("UnderBuyQty", 0) or 0),
            "vwap":                float(raw.get("VWAP", 0) or 0),
        }

        extended = analyze_board_extended(base_data, symbol)
        base_data.update(extended)

        return base_data

    except Exception as e:
        logger.warning("板情報取得スキップ: " + symbol + " (" + str(e).split("(")[0].strip() + ")")
        return None


# ============================================================
# クラウド送信（セッション再利用・直列送信）
# ============================================================

def send_candle_with_board(candle_data, board_data=None):
    symbol      = candle_data.get("symbol", "")
    candle_time = candle_data.get("candleTime", "")
    key = symbol + "_" + candle_time
    if key in last_candle_time:
        return True

    payload = {**candle_data}
    if board_data:
        payload["board"] = board_data

    try:
        with cloud_session_lock:
            r = cloud_session.post(
                CLOUD_CANDLE_WITH_BOARD_URL,
                json={"json": payload},
                headers={"Content-Type": "application/json"},
                timeout=10,
            )
        if r.status_code == 200:
            last_candle_time[key] = time.time()
            result = r.json()
            action = (
                result.get("result", {})
                      .get("data", {})
                      .get("json", {})
                      .get("action", "none")
            )
            pnl = (
                result.get("result", {})
                      .get("data", {})
                      .get("json", {})
                      .get("pnl")
            )
            board_status = "板v5あり" if board_data else "板なし"

            if board_data:
                extra = []
                if board_data.get("largeAskWallRatio", 0) >= LARGE_WALL_MULTIPLIER:
                    extra.append(f"大口売り壁{board_data['largeAskWallRatio']:.1f}倍@{board_data.get('largeAskWallPrice')}")
                if board_data.get("largeBidWallRatio", 0) >= LARGE_WALL_MULTIPLIER:
                    extra.append(f"大口買い壁{board_data['largeBidWallRatio']:.1f}倍@{board_data.get('largeBidWallPrice')}")
                if board_data.get("askCancelDetected"):
                    extra.append("売り板キャンセル検出")
                if board_data.get("bidCancelDetected"):
                    extra.append("買い板キャンセル検出")
                if board_data.get("icebergAskDetected"):
                    extra.append("売りアイスバーグ検出")
                if board_data.get("icebergBidDetected"):
                    extra.append("買いアイスバーグ検出")
                if board_data.get("marketOrderDirection") != "neutral":
                    extra.append(f"成り行き{board_data['marketOrderDirection']}")
                if extra:
                    board_status += " [" + " / ".join(extra) + "]"

            if action != "none":
                pnl_str = (
                    (" 損益:+" + str(pnl) + "円")
                    if (pnl is not None and pnl >= 0)
                    else (" 損益:" + str(pnl) + "円")
                    if pnl is not None
                    else ""
                )
                logger.info(
                    "★取引発生: " + symbol + " " + candle_time
                    + " " + action + pnl_str + " [" + board_status + "]"
                )
            else:
                logger.info(
                    "1分足送信: " + symbol + " " + candle_time
                    + " C=" + str(candle_data["close"])
                    + " [" + board_status + "]"
                )
            return True
        logger.warning("1分足送信失敗: " + symbol + " " + str(r.status_code))
        return False
    except Exception as e:
        logger.error("1分足送信エラー: " + symbol + " " + candle_time + " " + str(e))
        return False


# ============================================================
# ティック蓄積（WebSocket 経由）
# ============================================================

def update_candle_accum(symbol, price, trading_volume=0):
    if price <= 0:
        return
    current_minute = current_minute_jst()
    if symbol not in candle_accum:
        candle_accum[symbol] = {
            "open": price, "high": price, "low": price,
            "close": price, "volume": 0, "minute": current_minute,
            "last_trading_volume": trading_volume,
        }
        return
    accum = candle_accum[symbol]
    last_tv = accum.get("last_trading_volume", 0)
    if trading_volume > 0 and trading_volume >= last_tv:
        tick_vol = trading_volume - last_tv
        accum["volume"] = accum.get("volume", 0) + tick_vol
        accum["last_trading_volume"] = trading_volume
    if accum["minute"] != current_minute:
        candle_accum[symbol] = {
            "open": price, "high": price, "low": price,
            "close": price, "volume": 0, "minute": current_minute,
            "last_trading_volume": trading_volume,
        }
    else:
        accum["high"]  = max(accum["high"], price)
        accum["low"]   = min(accum["low"], price)
        accum["close"] = price


# ============================================================
# 1分足ポーリングループ（直列送信）
# ============================================================

def candle_polling_loop():
    logger.info("1分足ポーリングループ開始（v5.4: 直列送信・SSL接続再利用・板情報タイムアウト修正）")
    while True:
        try:
            now = now_jst()
            if not is_market_open():
                time.sleep(30)
                continue
            if now.second < 15:
                time.sleep(15 - now.second)
                continue

            prev_minute = (now - timedelta(minutes=1)).strftime("%H:%M")
            trade_date  = today_jst_str()
            token       = get_current_token()
            if not token:
                time.sleep(10)
                continue

            for symbol in SYMBOL_CODES:
                key = symbol + "_" + prev_minute
                if key in last_candle_time:
                    continue

                board_data = None
                accum = candle_accum.get(symbol)
                if accum and accum.get("minute") == prev_minute:
                    candle = {
                        "symbol":     symbol,
                        "tradeDate":  trade_date,
                        "candleTime": prev_minute,
                        "open":   accum["open"],
                        "high":   accum["high"],
                        "low":    accum["low"],
                        "close":  accum["close"],
                        "volume": accum["volume"],
                    }
                    board_data = fetch_board_from_api(symbol, token)
                else:
                    board_raw = fetch_board_from_api(symbol, token)
                    if board_raw and board_raw.get("currentPrice", 0) > 0:
                        price = board_raw["currentPrice"]
                        candle = {
                            "symbol":     symbol,
                            "tradeDate":  trade_date,
                            "candleTime": prev_minute,
                            "open": price, "high": price,
                            "low":  price, "close": price,
                            "volume": 0,
                        }
                        board_data = board_raw
                    else:
                        continue

                send_candle_with_board(candle, board_data)
                time.sleep(SEND_INTERVAL_SEC)

            now2      = now_jst()
            next_send = now2.replace(second=15, microsecond=0) + timedelta(minutes=1)
            wait_sec  = (next_send - now2).total_seconds()
            if wait_sec > 0:
                time.sleep(min(wait_sec, 60))

        except Exception as e:
            logger.error("1分足ポーリングエラー: " + str(e))
            time.sleep(10)


# ============================================================
# WebSocket ハンドラ（ティック蓄積のみ）
# ============================================================

try:
    import websocket
    WEBSOCKET_AVAILABLE = True
except ImportError:
    WEBSOCKET_AVAILABLE = False
    logger.warning("websocket-client 未インストール。WebSocket ティック蓄積は無効。")

def on_message(ws, message):
    try:
        raw = json.loads(message)
        symbol = str(raw.get("Symbol", ""))
        if not symbol:
            return
        price_raw = raw.get("CurrentPrice")
        if price_raw is not None:
            price = float(price_raw)
            trading_volume = int(raw.get("TradingVolume") or 0)
            if price > 0:
                update_candle_accum(symbol, price, trading_volume)
    except json.JSONDecodeError:
        pass

def on_error(ws, error):
    # WinError 10054は頻繁に発生するためWARNINGレベルで記録
    err_str = str(error)
    if "10054" in err_str or "forcibly closed" in err_str.lower():
        logger.warning("WebSocket切断（kabuステーション®がアイドル切断）: " + err_str[:60])
    else:
        logger.error("WebSocketエラー: " + err_str)

def on_close(ws, close_status_code, close_msg):
    logger.warning("WebSocket切断（RESTフォールバックで継続）")

def _set_tcp_keepalive(sock):
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, 'SIO_KEEPALIVE_VALS'):
            sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 30000, 5000))  # v5.4: idle=30s, interval=5s（より積極的に）
            logger.info("TCP keepalive設定完了（Windows: idle=30s, interval=5s）")
        else:
            if hasattr(socket, 'TCP_KEEPIDLE'):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 30)
            if hasattr(socket, 'TCP_KEEPINTVL'):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 5)
            if hasattr(socket, 'TCP_KEEPCNT'):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
            logger.info("TCP keepalive設定完了（Linux/macOS: idle=30s, interval=5s）")
    except Exception as e:
        logger.warning("TCP keepalive設定失敗（無視して続行）: " + str(e))

def on_open(ws):
    logger.info("WebSocket接続確立 - ティック蓄積を開始します")
    try:
        if ws.sock and ws.sock.sock:
            _set_tcp_keepalive(ws.sock.sock)
        elif ws.sock:
            _set_tcp_keepalive(ws.sock)
    except Exception as e:
        logger.warning("on_open: TCP keepalive設定スキップ: " + str(e))

def start_websocket(token):
    if not WEBSOCKET_AVAILABLE:
        logger.warning("WebSocket 無効。REST ポーリングのみで動作します。")
        while is_market_open():
            time.sleep(60)
        return
    ws_url = "ws://localhost:" + str(KABU_API_PORT) + "/kabusapi/websocket"
    ws = websocket.WebSocketApp(
        ws_url,
        header={"X-API-KEY": token},
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )
    # v5.4: ping_interval=0（無効）に戻す
    # kabuステーション®はWebSocket標準のpingプロトコルに対応していないため
    # TCP keepalive（OS レベル）で接続維持を試みる
    ws.run_forever(ping_interval=0)


# ============================================================
# メイン
# ============================================================

def main():
    global api_token
    logger.info("kabu STATION API 中継スクリプト v5.4 起動（WebSocket切断許容・REST継続強化）")
    logger.info("監視銘柄(" + str(len(SYMBOL_CODES)) + "銘柄): " + str(SYMBOL_CODES))
    logger.info("送信先: " + CLOUD_CANDLE_WITH_BOARD_URL)
    logger.info("銘柄間送信間隔: " + str(SEND_INTERVAL_SEC) + "秒 / 大口壁閾値: " + str(LARGE_WALL_MULTIPLIER) + "倍")
    logger.info("WebSocket ping: 無効（kabuステーション®はpong非対応）/ TCP keepalive: idle=30s, interval=5s")

    candle_thread = threading.Thread(target=candle_polling_loop, daemon=True)
    candle_thread.start()

    while True:
        if not is_market_open():
            logger.info("取引時間外 (" + current_minute_jst() + ") - 8:45まで待機します")
            time.sleep(60)
            continue

        logger.info("APIトークンを取得中（強制再取得）...")
        token = get_api_token(force=True)
        if not token:
            logger.error("トークン取得失敗。30秒後に再試行します...")
            time.sleep(30)
            continue

        if not register_push_symbols(token):
            logger.error("プッシュ配信登録失敗。30秒後に再試行します...")
            time.sleep(30)
            continue

        start_websocket(token)

        if is_market_open():
            logger.warning("WebSocket切断。5秒後に再接続します...")
            time.sleep(5)
        else:
            logger.info("取引時間終了。次の取引日まで待機します。")
            time.sleep(60)


if __name__ == "__main__":
    main()
