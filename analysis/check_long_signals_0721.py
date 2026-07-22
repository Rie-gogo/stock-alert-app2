import subprocess, json

# Collect all non-Auth log entries from trading hours (UTC 00:00-06:35 = JST 09:00-15:35)
all_entries = []
end_time = "2026-07-21T06:35:21Z"

for i in range(30):  # max 30 pages
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
        if '[Auth]' not in msg and ts >= '2026-07-21T00:00:00Z':
            all_entries.append((ts, msg))
    
    end_time = data.get('oldest_time', '')
    if not end_time or end_time < '2026-07-21T00:00:00Z':
        break
    if not data.get('has_more'):
        break

# Sort by time
all_entries.sort(key=lambda x: x[0])

print(f"Total non-Auth log entries: {len(all_entries)}")

# Categorize
buy_signals = []
short_signals = []
blocks = []
entries_made = []
other = []

for ts, msg in all_entries:
    if 'BUYシグナル' in msg or 'LONG' in msg or '大台超え' in msg or '大台確認完了' in msg:
        buy_signals.append((ts, msg))
    elif 'SHORTブロック' in msg or 'SHORT' in msg:
        short_signals.append((ts, msg))
    elif 'ブロック' in msg or 'block' in msg.lower():
        blocks.append((ts, msg))
    elif 'short @' in msg or 'buy @' in msg or 'cover @' in msg or 'sell @' in msg:
        entries_made.append((ts, msg))
    else:
        other.append((ts, msg))

print(f"\n=== BUY/LONGシグナル関連 ({len(buy_signals)}件) ===")
for ts, msg in buy_signals:
    # Convert UTC to JST for display
    print(f"  {ts} {msg[:250]}")

print(f"\n=== SHORTシグナル関連 ({len(short_signals)}件) ===")
for ts, msg in short_signals:
    print(f"  {ts} {msg[:250]}")

print(f"\n=== ブロック ({len(blocks)}件) ===")
for ts, msg in blocks:
    print(f"  {ts} {msg[:250]}")

print(f"\n=== 実際のエントリー/決済 ({len(entries_made)}件) ===")
for ts, msg in entries_made:
    print(f"  {ts} {msg[:250]}")

print(f"\n=== その他 ({len(other)}件) ===")
for ts, msg in other:
    print(f"  {ts} {msg[:250]}")
