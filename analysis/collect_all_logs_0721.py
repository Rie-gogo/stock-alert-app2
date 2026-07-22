import subprocess, json

# Collect ALL non-Auth log entries from 7/21 trading hours
# Paginate backward from end of day
all_entries = []
end_time = "2026-07-21T07:00:00Z"  # After market close (JST 16:00)
min_time = "2026-07-21T00:00:00Z"  # Market open (JST 09:00)

for i in range(50):
    cmd = f'manus-webdev-logs --limit 200 --end-time "{end_time}"'
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if not result.stdout.strip():
        break
    try:
        data = json.loads(result.stdout)
    except:
        break
    
    entries = data.get('entries', [])
    if not entries:
        break
    
    for entry in entries:
        msg = entry.get('message', '')
        ts = entry.get('timestamp', '')
        if '[Auth]' not in msg and ts >= min_time:
            all_entries.append((ts, msg))
    
    oldest = data.get('oldest_time', '')
    if not oldest or oldest <= min_time:
        break
    if not data.get('has_more'):
        break
    end_time = oldest

# Sort by time
all_entries.sort(key=lambda x: x[0])

print(f"Total non-Auth log entries from 7/21: {len(all_entries)}\n")

# Categorize
buy_board_block = []  # BUY signals blocked by board score
buy_other_block = []  # BUY signals blocked by other reasons
short_bullish_block = []  # SHORT blocked by isBullish
round_distance_block = []  # 0.8% filter blocks
entries_exits = []  # Actual entries/exits
confirmations = []  # 大台確認/押し目待ち
other = []

for ts, msg in all_entries:
    if 'BUYシグナル: 板読みスコア不足' in msg:
        buy_board_block.append((ts, msg))
    elif 'BUYシグナル' in msg or 'LONG' in msg:
        buy_other_block.append((ts, msg))
    elif 'SHORTブロック: isBullish' in msg:
        short_bullish_block.append((ts, msg))
    elif '大台乖離率フィルター' in msg:
        round_distance_block.append((ts, msg))
    elif 'short @' in msg or 'cover @' in msg or 'buy @' in msg or 'sell @' in msg:
        entries_exits.append((ts, msg))
    elif '大台確認' in msg or '押し目' in msg or '確認待機' in msg:
        confirmations.append((ts, msg))
    elif 'OrderBridge' in msg:
        entries_exits.append((ts, msg))
    else:
        other.append((ts, msg))

print(f"=== BUYシグナル: 板読みスコア不足でブロック ({len(buy_board_block)}件) ===")
# Group by symbol
from collections import Counter
buy_symbols = Counter()
buy_scores = []
for ts, msg in buy_board_block:
    # Extract symbol and score
    parts = msg.split(']')
    if len(parts) > 1:
        sym_part = parts[1].strip()
        sym = sym_part.split(' ')[0]
        buy_symbols[sym] += 1
        # Extract score
        if '板読みスコア不足(' in msg:
            score_str = msg.split('板読みスコア不足(')[1].split(')')[0]
            buy_scores.append((sym, int(score_str), ts, msg))

print("  銘柄別:")
for sym, count in buy_symbols.most_common():
    print(f"    {sym}: {count}件")

print(f"\n  スコア分布:")
score_vals = [s[1] for s in buy_scores]
if score_vals:
    from collections import Counter as C2
    for score, cnt in sorted(C2(score_vals).items()):
        print(f"    スコア{score}: {cnt}件")

print(f"\n  最もスコアが高い（惜しい）もの:")
buy_scores.sort(key=lambda x: -x[1])
for sym, score, ts, msg in buy_scores[:10]:
    # Convert UTC to JST
    hour = int(ts[11:13]) + 9
    minute = ts[14:16]
    jst = f"{hour}:{minute}"
    reason = msg.split('(', 1)[1] if '(' in msg else msg
    print(f"    {jst} {sym} スコア={score} {reason[:100]}")

print(f"\n=== SHORTブロック: isBullish上昇相場判定 ({len(short_bullish_block)}件) ===")
short_symbols = Counter()
for ts, msg in short_bullish_block:
    parts = msg.split(']')
    if len(parts) > 1:
        sym = parts[1].strip().split(' ')[0]
        short_symbols[sym] += 1
print("  銘柄別:")
for sym, count in short_symbols.most_common():
    print(f"    {sym}: {count}件")

print(f"\n=== 0.8%大台乖離率フィルターブロック ({len(round_distance_block)}件) ===")
for ts, msg in round_distance_block:
    hour = int(ts[11:13]) + 9
    minute = ts[14:16]
    jst = f"{hour}:{minute}"
    print(f"  {jst} {msg}")

print(f"\n=== 大台確認/押し目待ち ({len(confirmations)}件) ===")
for ts, msg in confirmations:
    hour = int(ts[11:13]) + 9
    minute = ts[14:16]
    jst = f"{hour}:{minute}"
    print(f"  {jst} {msg[:200]}")

print(f"\n=== 実際のエントリー/決済 ({len(entries_exits)}件) ===")
for ts, msg in entries_exits:
    hour = int(ts[11:13]) + 9
    minute = ts[14:16]
    jst = f"{hour}:{minute}"
    print(f"  {jst} {msg[:200]}")

print(f"\n=== その他 ({len(other)}件) ===")
for ts, msg in other:
    hour = int(ts[11:13]) + 9
    minute = ts[14:16]
    jst = f"{hour}:{minute}"
    print(f"  {jst} {msg[:200]}")
