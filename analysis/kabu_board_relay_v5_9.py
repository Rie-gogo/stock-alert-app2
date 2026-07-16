"""
================================================
kabu_board_relay_v5.9.2.py  ─  自動売買executor統合版（安全機能強化 + レビュー修正第2版）
================================================
v5.9.2修正点（2026-07-15）:
  ★v5.9.1のレビュー指摘を反映:

  [修正9] 大引け強制決済: 注文照会失敗時の二重返済防止:
    ordersがNoneの場合、「返済注文なし」と仮定して発注するのではなく、
    発注せずに再照会する。二重返済リスクを排除。

  [修正10] 大引け強制決済: 発注受付時のメモリ建玉削除抑止:
    sendorder成功=注文受付であり約定完了ではないため、
    active_positionsを削除しない。次ループの/positions照会で建玉が
    消えていれば自然にループ終了する。

  [修正11] 建玉同期成功フラグ(executor_position_sync_ok)追加:
    建玉同期が未完了の場合、新規エントリーをブロック。
    取引セッション開始時に再試行し、成功すればブロック解除。
    早朝起動（08:44前）でトークン待機が空振りしても、
    取引開始前に必ず同期が完了してからエントリーを許可する。

v5.9.1修正点（2026-07-15）:
  ★v5.9のレビュー指摘５点 + 追加2点を修正:

  [修正1] 起動時建玉同期のトークン待機:
    executorスレッド冒頭でget_current_token()がNone以外を返すまで待機してから
    建玉同期を実行する。main側のregister_push_with_retry()完了を確実に待つ。

  [修正2] executorスレッドの夜間終了防止:
    取引時間外でreturnせず、日付変更検知+日次リセットで翌朝も継続動作。
    夜間起動→翌朝取引開始のケースに対応。

  [修正3] ローカルHTTPセッション2系統分離:
    board_session/board_session_lock（板取得専用）と
    trade_session/trade_session_lock（注文・建玉・約定照会用）に分離。
    約定確認ループが板取得をブロックしない。

  [修正4] クラウドHTTPセッション2系統分離:
    candle_cloud_session/candle_cloud_lock（1分足送信専用）と
    executor_cloud_session/executor_cloud_lock（executor tRPC用）に分離。
    executor通信遅延が1分足送信をブロックしない。

  [修正5] 15:25強制決済の入口条件修正:
    executor_active_positionsの有無に関係なく、必ず executor_local_force_close()を
    呼び出す。内部で実建玉を照会するため、メモリ不整合があっても安全。

  [修正6] API照会失敗と0件の区別:
    executor_get_positions/ordersは失敗時にNoneを返す（成功+0件は[]）。
    呼び出し側でNoneチェックを追加し、照会失敗を「建玉なし」と誤判定しない。

  [修正7] 起動時建玉同期のNone対応:
    executor_sync_positions_on_startup()でAPI失敗時はリトライ（最大3回）。

  [修正8] 部分約定時の注意コメント追加:
    100株成行では低リスクだが、将来の複数株対応時に要修正であることを明記。

v5.9からの変更点（board relay部分は一切変更なし）:
  - HTTPセッションを4系統に分離（board/trade/candle_cloud/executor_cloud）
  - executor_get_positions/orders: 失敗時None返却に変更
  - executor_sync_positions_on_startup: リトライ追加+None対応
  - executor_local_force_close: None対応（照会失敗時リトライ）
  - executor_polling_loop: トークン待機追加、夜間終了→待機に変更、
    強制決済の入口条件削除
  - executor tRPCラッパー: executor専用セッション使用
  - ★v5.9.2: 二重返済防止、発注受付時削除抑止、position_sync_okフラグ
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

CLOUD_BASE_URL = "https://stockalert-ulxu9jpf.manus.space"
CLOUD_CANDLE_WITH_BOARD_URL = CLOUD_BASE_URL + "/api/trpc/trading.pushCandleWithBoard"
CLOUD_TRPC_BASE = CLOUD_BASE_URL + "/api/trpc"

SEND_INTERVAL_SEC = 0.1   # 銘柄間の送信間隔（0.1秒）
MARKET_OPEN_TIME  = "08:45"
MARKET_CLOSE_TIME = "15:35"

# 大口注文の閾値（平均の何倍以上を「大口」とするか）
LARGE_WALL_MULTIPLIER = 5.0
# アイスバーグ検出: 前回比でこの割合以上減少したら「消えた」と判断
ICEBERG_DROP_RATIO = 0.5
# 板キャンセル検出: 大口注文が前回比でこの割合以上消えたら「キャンセル」と判断
CANCEL_DROP_RATIO = 0.7

# ★v5.7: 自動復旧設定
HEALTH_CHECK_CONSECUTIVE_ZERO = 5  # WS蓄積使用=0がこの回数連続で自動再起動
MAX_REGISTER_RETRIES = 5  # プッシュ配信登録の最大リトライ回数

# ============================================================
# ★v5.9: Executor設定（v5.8 + 安全機能パラメータ）
# ============================================================

# ドライランモード（True=実際の発注を行わない）
DRY_RUN = True

# executorポーリング間隔（秒）
EXECUTOR_POLL_INTERVAL = 1.0

# 日次損失上限（円）- ローカル側でも二重チェック
LOCAL_DAILY_LOSS_LIMIT = -100000

# 取引時間帯（executor用: relayより少し早く開始、少し早く終了）
EXECUTOR_TRADING_START = "08:55"
EXECUTOR_TRADING_END = "15:30"

# --- v5.9 安全機能設定 ---

# クラウド通信断の閾値（秒）: この時間以上通信できなければ新規エントリー停止
CLOUD_DISCONNECT_THRESHOLD = 60

# 約定確認タイムアウト（秒）
ORDER_CONFIRM_TIMEOUT = 30

# 約定確認ポーリング間隔（秒）
ORDER_CONFIRM_INTERVAL = 1.0

# 大引け強制決済の開始時刻・終了時刻（JST）
FORCE_CLOSE_START = "15:25"
FORCE_CLOSE_END = "15:29"

# 大引け強制決済のチェック間隔（秒）
FORCE_CLOSE_CHECK_INTERVAL = 5

# 建玉保有中の通信エラー時バックオフ（秒）
BACKOFF_WITH_POSITIONS = 2
BACKOFF_WITHOUT_POSITIONS = 30

# 連続エラー回数の閾値（バックオフ発動）
BACKOFF_ERROR_THRESHOLD = 5


# ============================================================
# ログ設定
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("kabu_relay.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

# ★v5.9: executor専用ログ
executor_log_file = f"executor_{datetime.now(timezone(timedelta(hours=9))).strftime('%Y%m%d')}.log"

def executor_log(msg: str, level: str = "INFO"):
    """executor専用のログ出力（メインログとexecutorログ両方に出力）"""
    ts = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    line = f"[{ts}] [EXECUTOR/{level}] {msg}"
    logger.info(line)
    try:
        with open(executor_log_file, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

# ============================================================
# 共有状態
# ============================================================

api_token       = None
token_lock      = threading.Lock()
last_candle_time = {}

# ★v5.5: 2バッファ方式 - 現在分と前分を分離保持
candle_accum      = {}   # 現在分のティック蓄積
prev_candle_accum = {}   # 前分の確定済みティック蓄積（送信用）
accum_lock        = threading.Lock()  # スレッドセーフ化

# トークンTTLキャッシュ（WebSocket接続中のみ使用）
TOKEN_TTL_SEC   = 270  # 4.5分ごとに再取得
_token_fetched_at = 0.0

# 前回の板スナップショット（アイスバーグ・キャンセル検出用）
prev_board_snapshot = {}

# ★v5.5: REST TradingVolume追跡（WebSocket切断時の出来高補完用）
rest_trading_volume = {}  # {symbol: last_trading_volume}

JST = timezone(timedelta(hours=9))

# ★v5.5: WebSocket接続状態フラグ（正しく管理）
ws_connected = False
ws_connected_lock = threading.Lock()

# ★v5.5: 診断カウンター
ws_msg_count = 0       # WS受信メッセージ数（1分ごとリセット）
ws_msg_count_lock = threading.Lock()
fallback_count = 0     # RESTフォールバック回数（1分ごとリセット）
ws_accum_used_count = 0  # WS蓄積データ使用回数（1分ごとリセット）

# ★v5.7: 自動復旧用
consecutive_zero_accum = 0  # WS蓄積使用=0の連続回数
request_ws_restart = False  # WS再起動要求フラグ
ws_restart_lock = threading.Lock()

# ★v5.7: 現在のWebSocketAppインスタンス（再起動用）
current_ws_app = None
current_ws_lock = threading.Lock()

# ★v5.9: Executor状態（v5.8 + 通信断追跡）
executor_local_daily_pnl = 0
executor_local_trade_count = 0
executor_active_positions: dict = {}  # symbol -> instruction info
executor_last_cloud_success_at: float = 0.0  # ★v5.9: クラウド通信成功時刻（time.time()）
executor_position_sync_ok: bool = False  # ★v5.9.2: 建玉同期成功フラグ（未同期時はentryブロック）



# ============================================================
# HTTPSセッション（★v5.9.1: 4系統分離）
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
    """ローカルkabuステーション®REST API用セッション。"""
    session = requests.Session()
    adapter = HTTPAdapter(
        pool_connections=3,
        pool_maxsize=3,
    )
    session.mount("http://", adapter)
    return session

# ★v5.9.1: クラウドセッションを用途別に分離
# candle_cloud: 1分足送信専用（candle_polling_loopから使用）
# executor_cloud: executor tRPC通信専用（executor_polling_loopから使用）
candle_cloud_session = _create_cloud_session()
candle_cloud_lock = threading.Lock()

executor_cloud_session = _create_cloud_session()
executor_cloud_lock = threading.Lock()

# ★v5.9.1: ローカルセッションを用途別に分離
# board_session: 板情報取得専用（candle_polling_loopのfetch_board_from_apiから使用）
# trade_session: 注文・建玉・約定照会用（executorから使用）
board_session = _create_local_session()
board_session_lock = threading.Lock()

trade_session = _create_local_session()
trade_session_lock = threading.Lock()


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


# ★v5.7: 翌朝08:44までの待機秒数を計算
def seconds_until_next_market_open():
    """翌営業日の08:44までの秒数を計算する。"""
    now = now_jst()
    # 今日の08:44
    target = now.replace(hour=8, minute=44, second=0, microsecond=0)
    if now >= target:
        # 翌日の08:44
        target += timedelta(days=1)
    diff = (target - now).total_seconds()
    return max(diff, 60)  # 最低60秒


# ============================================================
# kabu STATION API: トークン取得・銘柄登録
# ★重要: /token を呼ぶ箇所はここだけ。他のスレッドは絶対に直接呼ばない。
# ============================================================

def get_api_token(force=False):
    """
    KABUステーションAPIトークンを取得する。
    ★v5.8: 全スレッド共有。/tokenを呼ぶのはこの関数のみ。
    401エラー時のみ force=True で再取得する。
    ★修正: /token呼び出しをロック内で実行し、複数スレッドの同時再取得を防止。
    """
    global api_token, _token_fetched_at
    with token_lock:
        now_ts = time.time()
        if not force and api_token and (now_ts - _token_fetched_at) < TOKEN_TTL_SEC:
            return api_token
        # ロック内で/tokenを呼ぶ（排他保証）
        logger.info("APIトークンを取得中" + ("（強制再取得）" if force else "") + "...")
        try:
            r = requests.post(
                KABU_API_BASE + "/token",
                json={"APIPassword": KABU_API_PASSWORD},
                timeout=10,
            )
            if r.status_code == 200:
                token = r.json().get("Token")
                logger.info("APIトークン取得成功: " + token[:8] + "...")
                api_token = token
                _token_fetched_at = time.time()
                return token
            logger.error("APIトークン取得失敗: " + str(r.status_code) + " " + r.text)
            return None
        except Exception as e:
            logger.error("APIトークン取得エラー: " + str(e))
            return None

def get_current_token():
    """現在のトークンを取得する（/tokenは呼ばない）"""
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


# ★v5.7: トークン再取得付きプッシュ配信登録（リトライ付き）
def register_push_with_retry():
    """トークン不一致時に自動で再取得してリトライする。"""
    for attempt in range(MAX_REGISTER_RETRIES):
        token = get_api_token(force=(attempt > 0))
        if not token:
            logger.error(f"トークン取得失敗（試行{attempt + 1}/{MAX_REGISTER_RETRIES}）")
            time.sleep(5)
            continue
        if register_push_symbols(token):
            return token
        logger.warning(f"プッシュ配信登録失敗（試行{attempt + 1}/{MAX_REGISTER_RETRIES}）- トークン再取得してリトライ")
        time.sleep(3)
    logger.error("プッシュ配信登録: 最大リトライ回数超過")
    return None


# ★v5.7: バッファ完全クリア（再起動時）
def clear_all_buffers():
    """全ティック蓄積バッファをクリアする。"""
    global candle_accum, prev_candle_accum, ws_msg_count, fallback_count, ws_accum_used_count
    global consecutive_zero_accum, rest_trading_volume, prev_board_snapshot
    with accum_lock:
        candle_accum.clear()
        prev_candle_accum.clear()
    with ws_msg_count_lock:
        ws_msg_count = 0
    fallback_count = 0
    ws_accum_used_count = 0
    consecutive_zero_accum = 0
    rest_trading_volume.clear()
    # prev_board_snapshotはクリアしない（アイスバーグ検出の連続性維持）
    logger.info("★バッファクリア完了")


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
# kabu STATION REST API: 板情報取得（v5.3: タイムアウト3秒・v5.9.1: board_session）
# ============================================================

def fetch_board_from_api(symbol, token):
    try:
        with board_session_lock:  # ★v5.9.1: 板専用セッション
            r = board_session.get(
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

        # ★v5.5: TradingVolumeもREST APIから取得（出来高補完用）
        trading_volume_raw = raw.get("TradingVolume")
        trading_volume = int(trading_volume_raw) if trading_volume_raw is not None else 0

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
            "tradingVolume":       trading_volume,
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
        with candle_cloud_lock:  # ★v5.9.1: 1分足送信専用セッション
            r = candle_cloud_session.post(
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

            ohlc_info = (
                f" O={candle_data.get('open', 0)}"
                f" H={candle_data.get('high', 0)}"
                f" L={candle_data.get('low', 0)}"
                f" C={candle_data.get('close', 0)}"
                f" V={candle_data.get('volume', 0)}"
            )

            board_detail = ""
            if board_data:
                total_ask = board_data.get("totalAskQty", 0) or 1
                total_bid = board_data.get("totalBidQty", 0)
                bpr = round(total_bid / total_ask, 2) if total_ask > 0 else 1.0
                total_all = (
                    (board_data.get("totalAskQty", 0) + board_data.get("totalBidQty", 0))
                    + (board_data.get("marketOrderBuyQty", 0) + board_data.get("marketOrderSellQty", 0))
                )
                market_qty = board_data.get("marketOrderBuyQty", 0) + board_data.get("marketOrderSellQty", 0)
                mor = round(market_qty / total_all, 3) if total_all > 0 else 0.0
                board_detail = (
                    f" BPR={bpr:.2f}"
                    f" LAR={board_data.get('largeAskWallRatio', 0):.1f}"
                    f" LBR={board_data.get('largeBidWallRatio', 0):.1f}"
                    f" MOR={mor:.3f}"
                    f" MOD={board_data.get('marketOrderDirection', 'neutral')}"
                    f" AC={int(board_data.get('askCancelDetected', False))}"
                    f" BC={int(board_data.get('bidCancelDetected', False))}"
                    f" IA={int(board_data.get('icebergAskDetected', False))}"
                    f" IB={int(board_data.get('icebergBidDetected', False))}"
                )

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
                    + " " + action + pnl_str + ohlc_info + board_detail
                    + " [" + board_status + "]"
                )
            else:
                logger.info(
                    "1分足送信: " + symbol + " " + candle_time
                    + ohlc_info + board_detail
                    + " [" + board_status + "]"
                )
            return True
        logger.warning("1分足送信失敗: " + symbol + " " + str(r.status_code))
        return False
    except Exception as e:
        logger.error("1分足送信エラー: " + symbol + " " + candle_time + " " + str(e))
        return False


# ============================================================
# ★v5.5: ティック蓄積（2バッファ方式）
# ============================================================

def update_candle_accum(symbol, price, trading_volume=0):
    """WebSocketティックを受信し、1分足OHLCVを蓄積する。"""
    global ws_msg_count
    if price <= 0:
        return

    current_minute = current_minute_jst()
    
    with ws_msg_count_lock:
        ws_msg_count += 1
    
    with accum_lock:
        if symbol not in candle_accum:
            candle_accum[symbol] = {
                "open": price, "high": price, "low": price,
                "close": price, "volume": 0, "minute": current_minute,
                "last_trading_volume": trading_volume,
            }
            return
        
        accum = candle_accum[symbol]
        
        # 出来高の差分計算（TradingVolumeは当日累計）
        last_tv = accum.get("last_trading_volume", 0)
        if trading_volume > 0 and trading_volume >= last_tv:
            tick_vol = trading_volume - last_tv
            accum["volume"] = accum.get("volume", 0) + tick_vol
            accum["last_trading_volume"] = trading_volume
        
        # ★v5.5: 分が切り替わる時、前分データを退避してから新分を開始
        if accum["minute"] != current_minute:
            # 前分の確定データを退避
            prev_candle_accum[symbol] = {
                "open":   accum["open"],
                "high":   accum["high"],
                "low":    accum["low"],
                "close":  accum["close"],
                "volume": accum["volume"],
                "minute": accum["minute"],
            }
            # 新しい分を開始
            candle_accum[symbol] = {
                "open": price, "high": price, "low": price,
                "close": price, "volume": 0, "minute": current_minute,
                "last_trading_volume": trading_volume,
            }
        else:
            # 同じ分内: OHLCを更新
            accum["high"]  = max(accum["high"], price)
            accum["low"]   = min(accum["low"], price)
            accum["close"] = price


# ============================================================
# ★v5.5: REST出来高補完（WebSocket切断時）
# ============================================================

def estimate_volume_from_rest(symbol, board_raw):
    """REST APIのTradingVolume（累計）から1分間の出来高を推定する。"""
    if not board_raw:
        return 0
    
    trading_volume = board_raw.get("tradingVolume", 0)
    if trading_volume <= 0:
        return 0
    
    prev_tv = rest_trading_volume.get(symbol, 0)
    rest_trading_volume[symbol] = trading_volume
    
    if prev_tv <= 0:
        return 0
    
    if trading_volume >= prev_tv:
        return trading_volume - prev_tv
    else:
        return 0


# ============================================================
# 1分足ポーリングループ（v5.7: ヘルスチェック付き）
# ============================================================

def candle_polling_loop():
    global fallback_count, ws_accum_used_count, ws_msg_count
    global consecutive_zero_accum, request_ws_restart
    logger.info("1分足ポーリングループ開始（v5.7: 自動復旧版）")
    
    last_diag_minute = ""
    
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

            # ★v5.7: 診断ログ（1分ごと・重複防止）
            current_min = current_minute_jst()
            if current_min != last_diag_minute:
                with ws_connected_lock:
                    ws_state = ws_connected
                with ws_msg_count_lock:
                    msg_count = ws_msg_count
                    ws_msg_count = 0
                
                local_accum_used = ws_accum_used_count
                local_fallback = fallback_count
                
                logger.info(
                    f"[診断] {current_min} WS={('接続中' if ws_state else '切断中')}"
                    f" WS受信={msg_count}件/分"
                    f" WS蓄積使用={local_accum_used}件 RESTフォールバック={local_fallback}件"
                )
                
                # ★v5.7: ヘルスチェック - 取引時間中にWS蓄積が0なら異常
                if current_min >= "09:05" and current_min <= "15:30":
                    if local_accum_used == 0 and msg_count > 0:
                        # WSは受信しているが蓄積が使われていない = バッファ不整合
                        consecutive_zero_accum += 1
                        if consecutive_zero_accum >= HEALTH_CHECK_CONSECUTIVE_ZERO:
                            logger.warning(
                                f"★自動復旧: WS蓄積使用=0が{consecutive_zero_accum}分連続 - WS再起動を要求"
                            )
                            with ws_restart_lock:
                                request_ws_restart = True
                            consecutive_zero_accum = 0
                    elif local_accum_used == 0 and msg_count == 0 and ws_state:
                        # WS接続中なのに受信もない = 完全停止
                        consecutive_zero_accum += 1
                        if consecutive_zero_accum >= HEALTH_CHECK_CONSECUTIVE_ZERO:
                            logger.warning(
                                f"★自動復旧: WS受信=0が{consecutive_zero_accum}分連続 - WS再起動を要求"
                            )
                            with ws_restart_lock:
                                request_ws_restart = True
                            consecutive_zero_accum = 0
                    else:
                        consecutive_zero_accum = 0
                
                fallback_count = 0
                ws_accum_used_count = 0
                last_diag_minute = current_min

            for symbol in SYMBOL_CODES:
                key = symbol + "_" + prev_minute
                if key in last_candle_time:
                    continue

                board_data = None
                candle = None

                # ★v5.5: まず prev_candle_accum を確認（2バッファ方式）
                with accum_lock:
                    prev_accum = prev_candle_accum.get(symbol)
                    curr_accum = candle_accum.get(symbol)
                
                if prev_accum and prev_accum.get("minute") == prev_minute:
                    # WebSocket蓄積データあり（前分バッファ）
                    candle = {
                        "symbol":     symbol,
                        "tradeDate":  trade_date,
                        "candleTime": prev_minute,
                        "open":   prev_accum["open"],
                        "high":   prev_accum["high"],
                        "low":    prev_accum["low"],
                        "close":  prev_accum["close"],
                        "volume": prev_accum["volume"],
                    }
                    board_data = fetch_board_from_api(symbol, token)
                    ws_accum_used_count += 1
                elif curr_accum and curr_accum.get("minute") == prev_minute:
                    # 現在バッファにまだ前分データが残っている（ティック頻度が低い銘柄）
                    candle = {
                        "symbol":     symbol,
                        "tradeDate":  trade_date,
                        "candleTime": prev_minute,
                        "open":   curr_accum["open"],
                        "high":   curr_accum["high"],
                        "low":    curr_accum["low"],
                        "close":  curr_accum["close"],
                        "volume": curr_accum["volume"],
                    }
                    board_data = fetch_board_from_api(symbol, token)
                    ws_accum_used_count += 1
                else:
                    # RESTフォールバック
                    board_raw = fetch_board_from_api(symbol, token)
                    if board_raw and board_raw.get("currentPrice", 0) > 0:
                        price = board_raw["currentPrice"]
                        estimated_vol = estimate_volume_from_rest(symbol, board_raw)
                        candle = {
                            "symbol":     symbol,
                            "tradeDate":  trade_date,
                            "candleTime": prev_minute,
                            "open": price, "high": price,
                            "low":  price, "close": price,
                            "volume": estimated_vol,
                        }
                        board_data = board_raw
                        fallback_count += 1
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
# WebSocket ハンドラ（v5.7: 再起動対応）
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
        if symbol not in SYMBOL_CODES:
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
    global ws_connected
    err_str = str(error)
    with ws_connected_lock:
        ws_connected = False
    if "10054" in err_str or "forcibly closed" in err_str.lower():
        logger.warning("WebSocket切断（kabuステーション®がアイドル切断）: " + err_str[:60])
    else:
        logger.error("WebSocketエラー: " + err_str)

def on_close(ws, close_status_code, close_msg):
    global ws_connected
    with ws_connected_lock:
        ws_connected = False
    logger.warning("WebSocket切断（RESTフォールバックで継続）code=" + str(close_status_code))

def _set_tcp_keepalive(sock):
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, 'SIO_KEEPALIVE_VALS'):
            sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 30000, 5000))
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
    global ws_connected
    with ws_connected_lock:
        ws_connected = True
    logger.info("WebSocket接続確立 - ティック蓄積を開始します")
    try:
        if ws.sock and ws.sock.sock:
            _set_tcp_keepalive(ws.sock.sock)
        elif ws.sock:
            _set_tcp_keepalive(ws.sock)
    except Exception as e:
        logger.warning("on_open: TCP keepalive設定スキップ: " + str(e))

def start_websocket(token):
    """WebSocket接続を開始する。切断時またはrestart要求時にreturnする。"""
    global current_ws_app, request_ws_restart
    
    if not WEBSOCKET_AVAILABLE:
        logger.warning("WebSocket 無効。REST ポーリングのみで動作します。")
        while is_market_open():
            with ws_restart_lock:
                if request_ws_restart:
                    request_ws_restart = False
                    return
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
    
    with current_ws_lock:
        current_ws_app = ws
    
    # ★v5.7: 別スレッドでrestart要求を監視し、WSを閉じる
    def restart_watcher():
        global request_ws_restart
        while True:
            time.sleep(5)
            with ws_restart_lock:
                if request_ws_restart:
                    request_ws_restart = False
                    logger.info("★自動復旧: WebSocket接続を強制切断します")
                    try:
                        ws.close()
                    except Exception:
                        pass
                    return
            # WS自体が切断されたら監視終了
            with ws_connected_lock:
                if not ws_connected:
                    return
            if not is_market_open():
                return
    
    watcher_thread = threading.Thread(target=restart_watcher, daemon=True)
    watcher_thread.start()
    
    ws.run_forever(ping_interval=0)
    
    with current_ws_lock:
        current_ws_app = None


# ============================================================
# ★v5.9: Executor機能（統合版 + 安全機能5項目）
# ============================================================

def executor_trpc_query(procedure: str, input_data: dict):
    """tRPC queryを呼び出す（GET）- executor用
    ★tRPC v11 + superjsonは input={"json": ...} 形式を要求する
    ★v5.9: 成功時にexecutor_last_cloud_success_atを更新
    """
    global executor_last_cloud_success_at
    try:
        url = f"{CLOUD_TRPC_BASE}/{procedure}"
        params = {"input": json.dumps({"json": input_data})}
        with executor_cloud_lock:  # ★v5.9.1: executor専用クラウドセッション
            resp = executor_cloud_session.get(url, params=params, timeout=10)
        if resp.status_code == 200:
            executor_last_cloud_success_at = time.time()  # ★v5.9
            data = resp.json()
            # superjsonのレスポンス: result.data.json に実データが入る
            result_data = data.get("result", {}).get("data", {})
            if isinstance(result_data, dict):
                return result_data.get("json", result_data)
            return result_data
        else:
            executor_log(f"tRPC query失敗: {procedure} status={resp.status_code}", "ERROR")
            return None
    except requests.exceptions.Timeout:
        executor_log(f"tRPC queryタイムアウト: {procedure}", "WARN")
        return None
    except Exception as e:
        executor_log(f"tRPC query例外: {procedure} - {e}", "ERROR")
        return None


def executor_trpc_mutation(procedure: str, input_data: dict):
    """tRPC mutationを呼び出す（POST）- executor用
    ★tRPC v11 + superjsonは {"json": ...} 形式を要求する
    ★v5.9: 成功時にexecutor_last_cloud_success_atを更新
    """
    global executor_last_cloud_success_at
    try:
        url = f"{CLOUD_TRPC_BASE}/{procedure}"
        with executor_cloud_lock:  # ★v5.9.1: executor専用クラウドセッション
            resp = executor_cloud_session.post(url, json={"json": input_data}, timeout=10)
        if resp.status_code == 200:
            executor_last_cloud_success_at = time.time()  # ★v5.9
            data = resp.json()
            result_data = data.get("result", {}).get("data", {})
            if isinstance(result_data, dict):
                return result_data.get("json", result_data)
            return result_data
        else:
            executor_log(f"tRPC mutation失敗: {procedure} status={resp.status_code}", "ERROR")
            return None
    except requests.exceptions.Timeout:
        executor_log(f"tRPC mutationタイムアウト: {procedure}", "WARN")
        return None
    except Exception as e:
        executor_log(f"tRPC mutation例外: {procedure} - {e}", "ERROR")
        return None


# ============================================================
# ★v5.9: 建玉照会（GET /positions）
# ============================================================

def executor_get_positions():
    """
    KABUステーションAPIから信用建玉一覧を取得する (v5.9.1)
    共有トークンを使用。DRY_RUN時は空リスト返却。
    ★v5.9.1: 失敗時はNoneを返す（成功+0件は[]）。trade_session使用。
    """
    if DRY_RUN:
        executor_log("  [DRY RUN] 建玉照会スキップ: 空リスト返却")
        return []

    token = get_current_token()
    if not token:
        executor_log("建玉照会失敗: APIトークン未取得", "ERROR")
        return None  # ★v5.9.1: 失敗=None

    try:
        with trade_session_lock:  # ★v5.9.1: trade専用セッション
            resp = trade_session.get(
                KABU_API_BASE + "/positions",
                params={"product": 2},  # 2=信用
                headers={"X-API-KEY": token},
                timeout=10,
            )
        if resp.status_code == 200:
            positions = resp.json()
            return positions if isinstance(positions, list) else []
        elif resp.status_code == 401:
            executor_log("建玉照会401: トークン再取得", "WARN")
            new_token = get_api_token(force=True)
            if new_token:
                with trade_session_lock:
                    resp2 = trade_session.get(
                        KABU_API_BASE + "/positions",
                        params={"product": 2},
                        headers={"X-API-KEY": new_token},
                        timeout=10,
                    )
                if resp2.status_code == 200:
                    positions = resp2.json()
                    return positions if isinstance(positions, list) else []
            return None  # ★v5.9.1: 401リトライ失敗=None
        else:
            executor_log(f"建玉照会HTTPエラー: status={resp.status_code}", "ERROR")
            return None  # ★v5.9.1: HTTPエラー=None
    except Exception as e:
        executor_log(f"建玉照会例外: {e}", "ERROR")
        return None  # ★v5.9.1: 例外=None


# ============================================================
# ★v5.9: 注文照会（GET /orders）
# ============================================================

def executor_get_orders(order_id: str = None):
    """
    KABUステーションAPIから注文一覧を取得する (v5.9.1)
    共有トークンを使用。order_id指定時はそのOrderIdでフィルタ。
    ★v5.9.1: 失敗時はNoneを返す（成功+0件は[]）。trade_session使用。
    """
    if DRY_RUN:
        return []

    token = get_current_token()
    if not token:
        return None  # ★v5.9.1: 失敗=None

    try:
        params = {"product": 0}  # 0=全般
        with trade_session_lock:  # ★v5.9.1: trade専用セッション
            resp = trade_session.get(
                KABU_API_BASE + "/orders",
                params=params,
                headers={"X-API-KEY": token},
                timeout=10,
            )
        if resp.status_code == 200:
            orders = resp.json()
            if not isinstance(orders, list):
                return []
            if order_id:
                return [o for o in orders if o.get("ID") == order_id]
            return orders
        elif resp.status_code == 401:
            new_token = get_api_token(force=True)
            if new_token:
                with trade_session_lock:
                    resp2 = trade_session.get(
                        KABU_API_BASE + "/orders",
                        params=params,
                        headers={"X-API-KEY": new_token},
                        timeout=10,
                    )
                if resp2.status_code == 200:
                    orders = resp2.json()
                    if not isinstance(orders, list):
                        return []
                    if order_id:
                        return [o for o in orders if o.get("ID") == order_id]
                    return orders
            return None  # ★v5.9.1: 401リトライ失敗=None
        else:
            executor_log(f"注文照会HTTPエラー: status={resp.status_code}", "ERROR")
            return None  # ★v5.9.1: HTTPエラー=None
    except Exception as e:
        executor_log(f"注文照会例外: {e}", "ERROR")
        return None  # ★v5.9.1: 例外=None


# ============================================================
# ★v5.9: 約定確認ループ
# ============================================================

def executor_confirm_order_execution(order_id: str, expected_qty: int) -> dict:
    """
    発注後に約定を確認する (v5.9)

    GET /orders で注文状態を確認し、全約定を待つ。
    タイムアウト時は未約定として返す。
    DRY_RUN時はスキップ（即約定と仮定）。

    Returns:
        {
            "filled": True/False,
            "cum_qty": int,        # 累計約定数量
            "avg_price": float,    # 平均約定価格
            "state": int,          # 注文状態
            "message": str,
        }
    """
    if DRY_RUN:
        return {
            "filled": True,
            "cum_qty": expected_qty,
            "avg_price": 0,  # ドライラン時は参照価格を使う
            "state": 5,
            "message": "ドライラン: 即約定と仮定",
        }

    start_time = time.time()
    last_state = 0
    last_cum_qty = 0

    while time.time() - start_time < ORDER_CONFIRM_TIMEOUT:
        orders = executor_get_orders(order_id)
        if orders is None:
            # ★v5.9.1: API照会失敗 → リトライ
            time.sleep(ORDER_CONFIRM_INTERVAL)
            continue
        if not orders:
            # 注文が見つからない（まだ反映されていない可能性）
            time.sleep(ORDER_CONFIRM_INTERVAL)
            continue

        order = orders[0]
        state = order.get("State", 0)
        cum_qty = order.get("CumQty", 0)
        order_qty = order.get("OrderQty", expected_qty)
        last_state = state
        last_cum_qty = cum_qty

        # 全約定確認
        if cum_qty >= order_qty:
            avg_price = _executor_calc_avg_price(order)
            executor_log(f"  約定確認完了: CumQty={cum_qty}/{order_qty} AvgPrice={avg_price:.1f}")
            return {
                "filled": True,
                "cum_qty": cum_qty,
                "avg_price": avg_price,
                "state": state,
                "message": "全約定確認",
            }

        # 注文が終了状態（取消・失効等）で未全約定
        if state == 5 and cum_qty < order_qty:
            executor_log(f"  注文終了（未全約定）: State=5, CumQty={cum_qty}/{order_qty}", "WARN")
            avg_price = _executor_calc_avg_price(order) if cum_qty > 0 else 0
            return {
                "filled": cum_qty > 0,
                "cum_qty": cum_qty,
                "avg_price": avg_price,
                "state": state,
                "message": f"注文終了: 約定{cum_qty}/{order_qty}株",
            }

        time.sleep(ORDER_CONFIRM_INTERVAL)

    # タイムアウト
    executor_log(f"  約定確認タイムアウト({ORDER_CONFIRM_TIMEOUT}秒): State={last_state}, CumQty={last_cum_qty}/{expected_qty}", "WARN")
    return {
        "filled": last_cum_qty >= expected_qty,
        "cum_qty": last_cum_qty,
        "avg_price": 0,
        "state": last_state,
        "message": f"タイムアウト: 約定{last_cum_qty}/{expected_qty}株",
    }


def _executor_calc_avg_price(order: dict) -> float:
    """注文のDetailsから平均約定価格を計算"""
    details = order.get("Details", [])
    total_qty = 0
    total_value = 0.0
    for detail in details:
        # RecType=8 が約定
        if detail.get("RecType") == 8:
            qty = detail.get("Qty", 0)
            price = detail.get("Price", 0)
            if qty > 0 and price > 0:
                total_qty += qty
                total_value += qty * price
    if total_qty > 0:
        return total_value / total_qty
    # Detailsが取れない場合はorderのPriceを使用
    return float(order.get("Price", 0))


# ============================================================
# ★v5.9: 起動時建玉同期
# ============================================================

def executor_sync_positions_on_startup() -> dict | None:
    """
    起動時にkabu STATION APIから実建玉を取得し、executor_active_positionsを初期化する (v5.9.2)
    再起動後のステート不整合を防止する。
    ★v5.9.1: API失敗時はリトライ（最大3回）。
    ★v5.9.2: API失敗時はNoneを返す（呼び出し側でsync_ok=Falseのまま維持）。

    Returns:
        symbol -> position info のdict。API失敗時はNone。
    """
    # ★v5.9.1: リトライ付き建玉取得
    positions = None
    for attempt in range(3):
        positions = executor_get_positions()
        if positions is not None:
            break
        executor_log(f"起動時建玉同期: API失敗、リトライ({attempt + 1}/3)...", "WARN")
        time.sleep(3)

    synced: dict = {}

    if positions is None:
        executor_log("起動時建玉同期: API照会失敗（3回リトライ済）。新規エントリーを停止します。", "ERROR")
        return None  # ★v5.9.2: 失敗時はNoneを返し、sync_ok=Falseを維持させる

    if not positions:
        executor_log("起動時建玉同期: 建玉なし（またはDRY RUN）")
        return synced

    for pos in positions:
        symbol = pos.get("Symbol", "")
        side_code = pos.get("Side", "")
        leaves_qty = pos.get("LeavesQty", 0)
        price = pos.get("Price", 0)

        if leaves_qty <= 0:
            continue

        # Side: "1"=売り建, "2"=買い建
        if side_code == "1":
            side = "short"
        elif side_code == "2":
            side = "buy"
        else:
            continue

        synced[symbol] = {
            "id": None,  # 起動時同期のため指示IDなし
            "symbol": symbol,
            "side": side,
            "instructionType": "entry",
            "referencePrice": price,
            "qty": leaves_qty,
            "reason": "startup_sync",
        }
        executor_log(f"  建玉同期: {symbol} {side} @{price}円 ×{leaves_qty}株")

    executor_log(f"起動時建玉同期完了: {len(synced)}件")
    return synced


# ============================================================
# ★v5.9: ローカル大引け強制決済
# ============================================================

def executor_local_force_close():
    """
    15:25〜15:29にローカルから直接建玉を全返済する (v5.9)

    クラウドのforce_closeが来ていない場合のフェイルセーフ。
    executor_active_positionsに残っている建玉を成行返済する。
    実建玉（/positions）も照会して漏れがないか確認する。
    """
    global executor_active_positions

    executor_log("=" * 40)
    executor_log("★v5.9: ローカル大引け強制決済開始 (15:25〜15:29)")
    executor_log("=" * 40)

    close_attempts = 0
    max_attempts = int((4 * 60) / FORCE_CLOSE_CHECK_INTERVAL)  # 4分間

    while close_attempts < max_attempts:
        current_time = now_jst().strftime("%H:%M")
        if current_time > FORCE_CLOSE_END:
            executor_log("大引け強制決済: 15:29超過、ループ終了")
            break

        # 1. 実建玉を取得（DRY_RUN時はexecutor_active_positionsのみ使用）
        if not DRY_RUN:
            positions = executor_get_positions()
            if positions is None:
                # ★v5.9.1: API照会失敗 → リトライ
                executor_log("大引け強制決済: 建玉照会失敗。リトライします...", "WARN")
                close_attempts += 1
                time.sleep(FORCE_CLOSE_CHECK_INTERVAL)
                continue
            open_positions = [p for p in positions if p.get("LeavesQty", 0) > 0]
        else:
            # DRY_RUN: executor_active_positionsから仮想建玉を使用
            open_positions = []
            for sym, info in executor_active_positions.items():
                open_positions.append({
                    "Symbol": sym,
                    "Side": "1" if info["side"] == "short" else "2",
                    "LeavesQty": info["qty"],
                    "Price": info["referencePrice"],
                    "CurrentPrice": info["referencePrice"],
                })

        if not open_positions:
            executor_log("大引け強制決済: 建玉なし。完了。")
            break

        # 2. 未約定の返済注文を取得（DRY_RUN時はスキップ）
        pending_close_symbols: set = set()
        if not DRY_RUN:
            orders = executor_get_orders()
            if orders is None:
                # ★v5.9.2: 注文照会失敗 → 二重返済防止のため発注せず再照会
                executor_log("大引け強制決済: 注文状態不明。重複防止のため発注せず再照会します。", "WARN")
                close_attempts += 1
                time.sleep(FORCE_CLOSE_CHECK_INTERVAL)
                continue
            for order in orders:
                state = order.get("State", 0)
                cash_margin = order.get("CashMargin", 0)
                symbol = order.get("Symbol", "")
                if state in (1, 2, 4) and cash_margin == 3:  # 信用返済で未約定
                    pending_close_symbols.add(symbol)

        # 3. 返済注文がなく建玉が残っている銘柄のみ成行返済
        for pos in open_positions:
            symbol = pos.get("Symbol", "")
            if symbol in pending_close_symbols:
                executor_log(f"  {symbol}: 既に返済注文中。スキップ。")
                continue

            side_code = pos.get("Side", "")
            leaves_qty = pos.get("LeavesQty", 0)

            # 返済方向: 買い建(2)→売り返済(sell), 売り建(1)→買い返済(cover)
            close_side = "sell" if side_code == "2" else "cover"

            close_instruction = {
                "symbol": symbol,
                "side": close_side,
                "instructionType": "force_close",
                "referencePrice": pos.get("CurrentPrice", pos.get("Price", 0)),
                "qty": leaves_qty,
                "reason": "local_eod_force_close",
            }

            executor_log(f"  大引け強制決済: {symbol} {close_side} ×{leaves_qty}株")
            result = executor_send_order(close_instruction)
            if result["success"]:
                executor_log(f"  大引け強制決済発注受付: {symbol} OrderId={result['orderId']}")
                # ★v5.9.2: 発注受付=約定完了ではないため、ここではactive_positionsを削除しない。
                # 次ループの/positions照会で建玉が消えていれば自然にループ終了する。
            else:
                executor_log(f"  大引け強制決済失敗: {symbol} - {result['message']}", "ERROR")

        close_attempts += 1
        time.sleep(FORCE_CLOSE_CHECK_INTERVAL)

    executor_log("ローカル大引け強制決済ループ終了")


# ============================================================
# ★v5.9: クラウド通信断チェック
# ============================================================

def executor_is_cloud_connected() -> bool:
    """クラウドとの通信が正常か判定 (v5.9)"""
    if executor_last_cloud_success_at == 0:
        return False
    elapsed = time.time() - executor_last_cloud_success_at
    return elapsed < CLOUD_DISCONNECT_THRESHOLD


def executor_send_order(instruction: dict) -> dict:
    """
    KABUステーションAPIに発注する。
    ★v5.8: get_api_token()の共有トークンを使用。別途/tokenは呼ばない。
    """
    if DRY_RUN:
        # ドライラン: 実際には発注しない（ただし本番と同じ経路を通る）
        executor_log(f"  [DRY RUN] 発注スキップ: {instruction['symbol']} {instruction['side']} "
                     f"@{instruction['referencePrice']}円 ×{instruction['qty']}株")
        return {
            "success": True,
            "orderId": f"DRY_{now_jst().strftime('%H%M%S')}_{instruction['symbol']}",
            "message": "ドライラン: 実際の発注なし",
        }

    # 本番発注: 共有トークンを使用
    token = get_current_token()
    if not token:
        # トークンがない場合、1回だけ再取得を試みる
        token = get_api_token(force=True)
        if not token:
            return {"success": False, "orderId": None, "message": "APIトークン未取得"}

    # 発注パラメータ構築
    order_params = executor_build_order_params(instruction)

    try:
        with trade_session_lock:  # ★v5.9.1: trade専用セッション
            resp = trade_session.post(
                KABU_API_BASE + "/sendorder",
                json=order_params,
                headers={"X-API-KEY": token},
                timeout=10,
            )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("Result") == 0:
                order_id = data.get("OrderId", "")
                executor_log(f"  発注成功: OrderId={order_id}")
                return {"success": True, "orderId": order_id, "message": "発注成功"}
            else:
                msg = f"API Result={data.get('Result')}"
                executor_log(f"  発注失敗: {msg}", "ERROR")
                return {"success": False, "orderId": None, "message": msg}
        elif resp.status_code == 401:
            # ★v5.8: 401時のみロック付きで1回だけトークン再取得
            executor_log("  401エラー: トークン再取得を試行", "WARN")
            new_token = get_api_token(force=True)
            if new_token:
                # リトライ1回
                with trade_session_lock:  # ★v5.9.1
                    resp2 = trade_session.post(
                        KABU_API_BASE + "/sendorder",
                        json=order_params,
                        headers={"X-API-KEY": new_token},
                        timeout=10,
                    )
                if resp2.status_code == 200:
                    data2 = resp2.json()
                    if data2.get("Result") == 0:
                        order_id = data2.get("OrderId", "")
                        executor_log(f"  発注成功（リトライ）: OrderId={order_id}")
                        return {"success": True, "orderId": order_id, "message": "発注成功（トークン再取得後）"}
            msg = f"HTTP 401: トークン再取得後もリトライ失敗"
            executor_log(f"  {msg}", "ERROR")
            return {"success": False, "orderId": None, "message": msg}
        else:
            msg = f"HTTP {resp.status_code}: {resp.text[:100]}"
            executor_log(f"  発注HTTPエラー: {msg}", "ERROR")
            return {"success": False, "orderId": None, "message": msg}
    except Exception as e:
        msg = f"発注例外: {e}"
        executor_log(f"  {msg}", "ERROR")
        return {"success": False, "orderId": None, "message": msg}


def executor_build_order_params(instruction: dict) -> dict:
    """
    order_instructionからKABUステーションAPI発注パラメータを構築する

    信用デイトレ（MarginTradeType=3）:
      - 新規: CashMargin=2, Side=買い"2"/売り"1"
      - 返済: CashMargin=3, Side=買い建玉返済"1"/売り建玉返済"2"
    """
    side = instruction["side"]

    # Side と CashMargin の決定
    if side == "buy":
        api_side = "2"
        cash_margin = 2
    elif side == "short":
        api_side = "1"
        cash_margin = 2
    elif side == "sell":
        api_side = "1"
        cash_margin = 3
    elif side == "cover":
        api_side = "2"
        cash_margin = 3
    else:
        raise ValueError(f"Unknown side: {side}")

    params = {
        "Symbol": instruction["symbol"],
        "Exchange": 27,          # 東証+
        "SecurityType": 1,       # 株式
        "Side": api_side,
        "CashMargin": cash_margin,
        "MarginTradeType": 3,    # 一般信用（デイトレ）
        "DelivType": 2 if cash_margin == 3 else 0,
        "FundType": "11",        # 信用取引
        "AccountType": 4,        # 特定口座
        "Qty": instruction["qty"],
        "FrontOrderType": 10,    # 成行
        "Price": 0,              # 成行時は0
        "ExpireDay": 0,          # 本日
    }

    # 返済時は決済順序を指定（日付古い順・損益高い順）
    if cash_margin == 3:
        params["ClosePositionOrder"] = 0

    return params


def executor_preflight_check(instruction: dict) -> tuple:
    """
    発注前のチェック (v5.9: クラウド通信断チェック追加)
    Returns: (passed: bool, reason: str)
    """
    global executor_local_daily_pnl

    side = instruction["side"]
    symbol = instruction["symbol"]
    instruction_type = instruction["instructionType"]

    # 1. 取引有効チェック（緊急停止中でないか）
    # → クラウド側で既にチェック済みだが、ローカルでも二重チェック

    # 2. ★v5.9: クラウド通信断チェック（新規エントリーのみブロック）
    if instruction_type == "entry" and not executor_is_cloud_connected():
        elapsed = time.time() - executor_last_cloud_success_at if executor_last_cloud_success_at > 0 else 999
        return False, f"クラウド通信断({elapsed:.0f}秒): 新規エントリー停止"

    # 2b. ★v5.9.2: 建玉同期未完了チェック（新規エントリーのみブロック）
    if instruction_type == "entry" and not executor_position_sync_ok:
        return False, "建玉同期未完了: 新規エントリー停止"

    # 3. 二重発注チェック（同一銘柄にpending/sent指示がないか）
    if instruction_type == "entry" and symbol in executor_active_positions:
        return False, f"二重発注防止: {symbol}に既存ポジションあり"

    # 4. 日次損失上限チェック（ローカル側）
    if instruction_type == "entry" and executor_local_daily_pnl <= LOCAL_DAILY_LOSS_LIMIT:
        return False, f"日次損失上限到達(ローカル): {executor_local_daily_pnl}円"

    # 5. KABUステーション接続チェック（共有トークン確認）
    if not DRY_RUN and not get_current_token():
        return False, "KABUステーションAPIトークン未取得"

    # 6. 数量検証
    if instruction["qty"] <= 0 or instruction["qty"] > 1000:
        return False, f"異常な数量: {instruction['qty']}株"

    # 7. 指示鮮度チェック（entryのみ: 60秒以内か）
    if instruction_type == "entry":
        created_at = instruction.get("createdAt")
        if created_at:
            try:
                if isinstance(created_at, str):
                    created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                else:
                    created_dt = created_at
                age_seconds = (datetime.now(timezone.utc) - created_dt).total_seconds()
                if age_seconds > 60:
                    return False, f"指示期限切れ(ローカル判定): {age_seconds:.0f}秒経過"
            except Exception:
                pass

    # 8. 取引時間帯チェック
    current_time = now_jst().strftime("%H:%M")
    if current_time < EXECUTOR_TRADING_START or current_time > EXECUTOR_TRADING_END:
        if instruction_type == "entry":
            return False, f"取引時間外: {current_time}"
        # exit/force_closeは時間外でも許可

    # 9. 銘柄コード妥当性チェック
    if not symbol or len(symbol) < 4:
        return False, f"不正な銘柄コード: {symbol}"

    return True, "OK"


def executor_process_instruction(instruction: dict) -> None:
    """
    1つの発注指示を処理する (v5.9: 約定確認ループ追加)
    board relay / candle pollingをブロックしない。
    """
    global executor_local_daily_pnl, executor_local_trade_count

    instr_id = instruction["id"]
    symbol = instruction["symbol"]
    side = instruction["side"]
    instruction_type = instruction["instructionType"]
    ref_price = instruction["referencePrice"]
    qty = instruction["qty"]
    reason = instruction.get("reason", "")[:60]

    executor_log(f"指示受信: #{instr_id} {symbol} {side} {instruction_type} @{ref_price}円 ×{qty}株 ({reason})")

    # プリフライトチェック
    passed, check_reason = executor_preflight_check(instruction)
    if not passed:
        executor_log(f"  プリフライト不合格: {check_reason}", "WARN")
        executor_trpc_mutation("trading.reportOrderExecution", {
            "instructionId": instr_id,
            "status": "failed",
            "errorMessage": f"プリフライト不合格: {check_reason}",
            "executorLog": {
                "preflightFailed": True,
                "reason": check_reason,
                "timestamp": now_jst().isoformat(),
                "dryRun": DRY_RUN,
            },
        })
        return

    # 発注実行
    executor_log(f"  発注実行中... (DRY_RUN={DRY_RUN})")

    # まず「sent」ステータスを報告
    executor_trpc_mutation("trading.reportOrderExecution", {
        "instructionId": instr_id,
        "status": "sent",
        "executorLog": {
            "sentAt": now_jst().isoformat(),
            "dryRun": DRY_RUN,
        },
    })

    # KABUステーションAPIに発注（共有トークン使用）
    result = executor_send_order(instruction)

    if not result["success"]:
        executor_log(f"  発注失敗: {result['message']}", "ERROR")
        executor_trpc_mutation("trading.reportOrderExecution", {
            "instructionId": instr_id,
            "status": "failed",
            "errorMessage": result["message"],
            "executorLog": {
                "failedAt": now_jst().isoformat(),
                "dryRun": DRY_RUN,
                "message": result["message"],
            },
        })
        return

    # --- ★v5.9: 約定確認ループ ---
    order_id = result["orderId"]
    confirm_result = executor_confirm_order_execution(order_id, qty)

    if not confirm_result["filled"]:
        # 全約定できなかった場合
        # ★v5.9.1注意: 現在は100株成行のため部分約定は低リスクだが、
        # 将来複数株対応時は「部分約定分のみポジション登録」と
        # 「残りの取消/再発注」ロジックが必要。
        executor_log(f"  約定未完了: {confirm_result['message']}", "WARN")

        if confirm_result["cum_qty"] == 0:
            # 1株も約定していない → 失敗として報告
            executor_trpc_mutation("trading.reportOrderExecution", {
                "instructionId": instr_id,
                "status": "failed",
                "errorMessage": f"約定なし: {confirm_result['message']}",
                "executorLog": {
                    "failedAt": now_jst().isoformat(),
                    "dryRun": DRY_RUN,
                    "message": confirm_result["message"],
                    "orderId": order_id,
                },
            })
            return

    # 約定価格の決定
    if DRY_RUN:
        executed_price = float(ref_price)
    elif confirm_result["avg_price"] > 0:
        executed_price = confirm_result["avg_price"]
    else:
        executed_price = float(ref_price)

    executed_qty = confirm_result["cum_qty"] if not DRY_RUN else qty

    # PnL計算（決済時のみ）
    pnl = None
    if instruction_type in ("exit", "force_close") and symbol in executor_active_positions:
        entry_info = executor_active_positions[symbol]
        entry_price = float(entry_info["referencePrice"])
        entry_side = entry_info["side"]
        if entry_side == "buy":
            pnl = int((executed_price - entry_price) * executed_qty)
        elif entry_side == "short":
            pnl = int((entry_price - executed_price) * executed_qty)
        executor_local_daily_pnl += (pnl or 0)
        del executor_active_positions[symbol]
        executor_log(f"  決済完了: PnL={pnl:+d}円 (日次累計: {executor_local_daily_pnl:+d}円)")
    elif instruction_type == "entry":
        executor_active_positions[symbol] = instruction
        executor_active_positions[symbol]["_executed_price"] = executed_price
        executor_active_positions[symbol]["_order_id"] = order_id
        executor_log(f"  エントリー完了: {symbol} {side} @{executed_price}円 (OrderId={order_id})")

    executor_local_trade_count += 1

    report_payload = {
        "instructionId": instr_id,
        "status": "executed",
        "kabuOrderId": order_id,
        "executedPrice": executed_price,
        "executedAt": now_jst().isoformat(),
        "executorLog": {
            "executedAt": now_jst().isoformat(),
            "dryRun": DRY_RUN,
            "message": confirm_result["message"],
            "localDailyPnl": executor_local_daily_pnl,
            "localTradeCount": executor_local_trade_count,
            "cumQty": executed_qty,
            "avgPrice": executed_price,
            "orderId": order_id,
        },
    }
    if pnl is not None:
        report_payload["pnl"] = pnl
    executor_trpc_mutation("trading.reportOrderExecution", report_payload)


def executor_polling_loop():
    """
    ★v5.9: Executorポーリングループ（別スレッド・1秒間隔）
    board relay / candle polling をブロックしない。

    v5.8からの変更:
      - 起動時建玉同期を追加
      - クラウド通信断検知を追加
      - 大引け強制決済（15:25〜15:29）を追加
      - バックオフ分岐（建玉有無で2秒/30秒）を追加
    """
    global executor_local_daily_pnl, executor_local_trade_count, executor_active_positions, executor_position_sync_ok

    executor_log("=" * 60)
    executor_log(f"Executor統合版 v5.9.2 起動（安全機能強化 + レビュー修正版）")
    executor_log(f"  DRY_RUN: {DRY_RUN}")
    executor_log(f"  CLOUD_APP_URL: {CLOUD_BASE_URL}")
    executor_log(f"  POLL_INTERVAL: {EXECUTOR_POLL_INTERVAL}秒")
    executor_log(f"  TRADING_HOURS: {EXECUTOR_TRADING_START} - {EXECUTOR_TRADING_END}")
    executor_log(f"  LOCAL_DAILY_LOSS_LIMIT: {LOCAL_DAILY_LOSS_LIMIT}円")
    executor_log(f"  CLOUD_DISCONNECT_THRESHOLD: {CLOUD_DISCONNECT_THRESHOLD}秒")
    executor_log(f"  ORDER_CONFIRM_TIMEOUT: {ORDER_CONFIRM_TIMEOUT}秒")
    executor_log(f"  FORCE_CLOSE: {FORCE_CLOSE_START}〜{FORCE_CLOSE_END}")
    executor_log(f"  BACKOFF: 建玉あり={BACKOFF_WITH_POSITIONS}秒 / なし={BACKOFF_WITHOUT_POSITIONS}秒")
    executor_log("=" * 60)

    # ★v5.9.1: トークン取得を待機（main側のregister_push_with_retry()完了を待つ）
    executor_log("トークン取得を待機中...")
    token_wait_start = time.time()
    while not get_current_token():
        if time.time() - token_wait_start > 120:
            executor_log("トークン待機タイムアウト(120秒)。建玉同期なしで継続。", "ERROR")
            break
        time.sleep(1)
    else:
        executor_log(f"トークン確認完了: {get_current_token()[:8]}...")

    # ★v5.9: 起動時建玉同期
    # ★v5.9.2: 同期成功フラグを管理。失敗時は取引ループ内で再試行する。
    executor_position_sync_ok = False
    executor_log("--- 起動時建玉同期 ---")
    if get_current_token():
        synced = executor_sync_positions_on_startup()
        if synced is not None:  # ★v5.9.2: 失敗時はNone、成功時は{}または建玉dict
            executor_active_positions = synced
            executor_position_sync_ok = True
            executor_log(f"建玉同期成功: {len(synced)}件")
        else:
            executor_log("建玉同期失敗。取引ループ内で再試行します。", "WARN")
    else:
        executor_log("トークン未取得のため建玉同期スキップ。取引ループ内で再試行します。", "WARN")

    # 起動時にクラウド接続テスト
    trade_date = today_jst_str()
    executor_log(f"クラウド接続テスト... (tradeDate={trade_date})")
    test_result = executor_trpc_query("trading.getAutoTradeStatus", {"tradeDate": trade_date})
    if test_result is None:
        executor_log("クラウド接続失敗。URLを確認してください。リトライを続けます...", "WARN")
    else:
        executor_log(f"クラウド接続OK: tradingEnabled={test_result.get('tradingEnabled')}, "
                     f"isDryRun={test_result.get('isDryRun')}")

    # メインループ
    consecutive_errors = 0
    last_status_log = time.time()
    trading_session_active = False  # 今日の取引セッションが開始されたか
    force_close_executed = False  # ★v5.9: 大引け強制決済実行済みフラグ
    last_trade_date = None  # ★v5.9.1: 日付変更検知用

    while True:
        try:
            current_time = now_jst().strftime("%H:%M")
            trade_date = today_jst_str()

            # ★v5.9.1: 日付変更検知（翌日の日次リセット）
            if trade_date != last_trade_date:
                if last_trade_date is not None:
                    executor_log(f"日付変更検知: {last_trade_date} → {trade_date}。日次リセット。")
                    trading_session_active = False
                    force_close_executed = False
                    executor_local_daily_pnl = 0
                    executor_local_trade_count = 0
                    # ★v5.9.2: 翌日の建玉同期（前日からの持ち越しがある可能性）
                    executor_position_sync_ok = False
                    if get_current_token():
                        executor_log("--- 翌日建玉同期 ---")
                        synced = executor_sync_positions_on_startup()
                        if synced is not None:
                            executor_active_positions = synced
                            executor_position_sync_ok = True
                            executor_log(f"翌日建玉同期成功: {len(synced)}件")
                last_trade_date = trade_date

            # 取引時間外チェック
            if current_time < EXECUTOR_TRADING_START:
                time.sleep(5)
                continue

            # ★v5.9.1: 取引時間後はreturnせず待機（翌日も継続動作）
            if current_time > EXECUTOR_TRADING_END:
                if trading_session_active:
                    # 取引セッションがあった日のみサマリーを出す（1回だけ）
                    executor_log(f"取引時間終了 ({current_time})。本日の成績: "
                                 f"PnL={executor_local_daily_pnl:+d}円, 取引数={executor_local_trade_count}")
                    executor_log("=" * 60)
                    executor_log(f"本日の最終成績:")
                    executor_log(f"  日次損益: {executor_local_daily_pnl:+d}円")
                    executor_log(f"  取引回数: {executor_local_trade_count}")
                    executor_log(f"  残ポジション: {len(executor_active_positions)}件")
                    if executor_active_positions:
                        for sym, pos in executor_active_positions.items():
                            executor_log(f"    ⚠️ 未決済: {sym} {pos['side']} @{pos['referencePrice']}円")
                    executor_log("=" * 60)
                    trading_session_active = False  # ★v5.9.1: サマリーは1回だけ
                # ★v5.9.1: スレッド終了せず待機（翌日も継続動作）
                time.sleep(30)
                continue

            # 取引時間内に入った
            if not trading_session_active:
                trading_session_active = True
                executor_log(f"取引セッション開始 ({current_time})")
                # 日次リセット（起動時同期で取得した建玉は維持）
                executor_local_daily_pnl = 0
                executor_local_trade_count = 0
                force_close_executed = False
                # ★v5.9.2: 建玉同期が未完了ならここで再試行
                if not executor_position_sync_ok and get_current_token():
                    executor_log("--- 取引開始前建玉同期（再試行） ---")
                    synced = executor_sync_positions_on_startup()
                    if synced is not None:
                        executor_active_positions = synced
                        executor_position_sync_ok = True
                        executor_log(f"建玉同期成功: {len(synced)}件")
                    else:
                        executor_log("建玉同期失敗。新規エントリーは停止します。", "WARN")

            # ★v5.9.1: 大引け強制決済ループ (15:25〜15:29)
            # メモリ状態に関係なく必ず呼び出す（内部で実建玉を照会する）
            if not force_close_executed and current_time >= FORCE_CLOSE_START and current_time <= FORCE_CLOSE_END:
                executor_log(f"ローカル大引け強制決済開始 (メモリ建玉={len(executor_active_positions)}件)")
                executor_local_force_close()
                force_close_executed = True

            # pending指示をポーリング
            instructions = executor_trpc_query("trading.getOrderInstructions", {"tradeDate": trade_date})

            if instructions is None:
                consecutive_errors += 1

                # ★v5.9: 建玉保有中はバックオフを短縮
                if executor_active_positions:
                    backoff = BACKOFF_WITH_POSITIONS
                else:
                    backoff = BACKOFF_WITHOUT_POSITIONS

                if consecutive_errors >= BACKOFF_ERROR_THRESHOLD:
                    executor_log(f"連続{consecutive_errors}回の通信エラー。{backoff}秒待機... "
                                 f"(建玉={len(executor_active_positions)}件)", "WARN")

                    # ★v5.9: 通信断状態のログ
                    if not executor_is_cloud_connected():
                        elapsed = time.time() - executor_last_cloud_success_at if executor_last_cloud_success_at > 0 else 999
                        executor_log(f"⚠️ クラウド通信断 {elapsed:.0f}秒: 新規エントリー停止中", "WARN")

                    time.sleep(backoff)
                    if consecutive_errors >= 30:
                        consecutive_errors = 0  # リセットして継続
                else:
                    time.sleep(EXECUTOR_POLL_INTERVAL)
                continue

            consecutive_errors = 0

            # 指示があれば処理
            if instructions:
                for instruction in instructions:
                    executor_process_instruction(instruction)

            # 5分ごとにステータスログ
            if time.time() - last_status_log > 300:
                cloud_status = "OK" if executor_is_cloud_connected() else "DISCONNECTED"
                executor_log(f"[STATUS] 稼働中 | PnL={executor_local_daily_pnl:+d}円 | "
                             f"取引数={executor_local_trade_count} | "
                             f"ポジション={len(executor_active_positions)}件 | "
                             f"Cloud={cloud_status} | 時刻={current_time}")
                last_status_log = time.time()

            time.sleep(EXECUTOR_POLL_INTERVAL)

        except Exception as e:
            executor_log(f"Executorループ例外: {e}", "ERROR")
            time.sleep(5)


# ============================================================
# メイン（v5.9: executor安全機能強化版）
# ============================================================

def main():
    global api_token
    logger.info("=" * 60)
    logger.info("kabu STATION API 中継スクリプト v5.9.2 起動（executor安全機能強化版）")
    logger.info("=" * 60)
    logger.info("監視銘柄(" + str(len(SYMBOL_CODES)) + "銘柄): " + str(SYMBOL_CODES))
    logger.info("送信先: " + CLOUD_CANDLE_WITH_BOARD_URL)
    logger.info("銘柄間送信間隔: " + str(SEND_INTERVAL_SEC) + "秒 / 大口壁閾値: " + str(LARGE_WALL_MULTIPLIER) + "倍")
    logger.info("WebSocket ping: 無効 / TCP keepalive: idle=30s, interval=5s")
    logger.info("★v5.9: executor安全機能5項目 + 自動復旧 + 夜間省電力待機 + WS多重接続防止")
    logger.info(f"★v5.9: DRY_RUN={DRY_RUN} / 損失上限={LOCAL_DAILY_LOSS_LIMIT}円")
    logger.info(f"★v5.9: 通信断閾値={CLOUD_DISCONNECT_THRESHOLD}秒 / 約定確認={ORDER_CONFIRM_TIMEOUT}秒")
    logger.info(f"★v5.9: 大引け強制決済={FORCE_CLOSE_START}〜{FORCE_CLOSE_END}")

    # ポーリングスレッドは1回だけ起動（daemon=Trueなのでmain終了時に自動停止）
    candle_thread = threading.Thread(target=candle_polling_loop, daemon=True)
    candle_thread.start()

    # ★v5.9: Executorスレッドも起動（daemon=True）
    executor_thread = threading.Thread(target=executor_polling_loop, daemon=True)
    executor_thread.start()
    logger.info("★v5.9: Executorスレッド起動完了（安全機能5項目有効）")

    while True:
        # ★v5.7: 取引時間外は翌朝まで長時間sleep（ログスパム防止）
        if not is_market_open():
            wait_sec = seconds_until_next_market_open()
            next_open = now_jst() + timedelta(seconds=wait_sec)
            logger.info(
                f"取引時間外 ({current_minute_jst()}) - "
                f"次回起動: {next_open.strftime('%m/%d %H:%M')} "
                f"（{int(wait_sec / 3600)}時間{int((wait_sec % 3600) / 60)}分後）"
            )
            time.sleep(wait_sec)
            # 起床後、日付が変わっているのでlast_candle_timeをクリア
            last_candle_time.clear()
            logger.info(f"★起床: {current_minute_jst()} - 取引準備を開始します")
            continue

        # ★v5.7: トークン取得 + プッシュ配信登録（リトライ付き）
        token = register_push_with_retry()
        if not token:
            logger.error("初期化失敗。60秒後に再試行します...")
            time.sleep(60)
            continue

        # ★v5.7: バッファクリア（新しいWS接続の前に）
        clear_all_buffers()

        # WebSocket接続（切断時にreturnする）
        start_websocket(token)

        # 切断後の処理
        if is_market_open():
            logger.warning("WebSocket切断。バッファクリア後5秒で再接続します...")
            clear_all_buffers()
            time.sleep(5)
        else:
            # ★v5.7: 取引時間終了 → プロセス終了（毎日クリーンスタート）
            logger.info("="*60)
            logger.info("取引時間終了。プロセスを終了します。")
            logger.info("次回はタスクスケジューラにより自動起動されます。")
            logger.info("="*60)
            import sys
            sys.exit(0)


if __name__ == "__main__":
    main()
