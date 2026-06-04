"""
チャートシグナルベース デイトレシミュレーション 2026-06-04 レポート
"""
import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import japanize_matplotlib
import numpy as np
from pathlib import Path

with open('/home/ubuntu/stock-alert-app/analysis/jq_out/chart_signal_today.json') as f:
    data = json.load(f)

results = data['results']
total_pnl = data['totalPnl']
total_trades = data['totalTrades']
total_wins = data['totalWins']
total_losses = data['totalLosses']
win_rate = total_wins / total_trades * 100 if total_trades > 0 else 0

# ===== レイアウト =====
fig = plt.figure(figsize=(16, 14), facecolor='#0f1117')
fig.suptitle(f'チャートシグナルベース デイトレシミュレーション  2026年6月4日（水）',
             fontsize=16, color='white', fontweight='bold', y=0.98)

# グリッド
gs = fig.add_gridspec(3, 2, hspace=0.45, wspace=0.35,
                      left=0.07, right=0.97, top=0.92, bottom=0.06)

ax_bar   = fig.add_subplot(gs[0, :])   # 銘柄別損益棒グラフ（全幅）
ax_pie   = fig.add_subplot(gs[1, 0])   # 勝敗円グラフ
ax_table = fig.add_subplot(gs[1, 1])   # サマリーテーブル
ax_comp  = fig.add_subplot(gs[2, :])   # アルゴ vs チャートシグナル比較

for ax in [ax_bar, ax_pie, ax_table, ax_comp]:
    ax.set_facecolor('#1a1d27')
    for spine in ax.spines.values():
        spine.set_color('#333')

# ===== 銘柄別損益棒グラフ =====
active = [r for r in results if r['tradeCount'] > 0]
names = [r['name'] for r in active]
pnls  = [r['totalPnl'] for r in active]
colors = ['#22c55e' if p >= 0 else '#ef4444' for p in pnls]

bars = ax_bar.bar(names, pnls, color=colors, edgecolor='#333', linewidth=0.5, width=0.6)
ax_bar.axhline(0, color='#555', linewidth=1)
ax_bar.set_title('銘柄別損益（チャートシグナル）', color='white', fontsize=12, pad=8)
ax_bar.tick_params(colors='#aaa', labelsize=9)
ax_bar.set_ylabel('損益（円）', color='#aaa', fontsize=9)
ax_bar.yaxis.label.set_color('#aaa')

for bar, pnl in zip(bars, pnls):
    label = f'+{pnl:,}' if pnl >= 0 else f'{pnl:,}'
    ax_bar.text(bar.get_x() + bar.get_width()/2, bar.get_height() + (500 if pnl >= 0 else -2000),
                label, ha='center', va='bottom' if pnl >= 0 else 'top',
                color='white', fontsize=8, fontweight='bold')

ax_bar.set_facecolor('#1a1d27')
ax_bar.tick_params(axis='x', colors='white', labelsize=9)
ax_bar.tick_params(axis='y', colors='#aaa', labelsize=8)

# ===== 勝敗円グラフ =====
if total_trades > 0:
    pie_data = [total_wins, total_losses]
    pie_colors = ['#22c55e', '#ef4444']
    pie_labels = [f'勝ち {total_wins}件', f'負け {total_losses}件']
    wedges, texts, autotexts = ax_pie.pie(
        pie_data, colors=pie_colors, labels=pie_labels,
        autopct='%1.0f%%', startangle=90,
        textprops={'color': 'white', 'fontsize': 9},
        wedgeprops={'edgecolor': '#0f1117', 'linewidth': 2}
    )
    for at in autotexts:
        at.set_color('white')
        at.set_fontsize(10)
    ax_pie.set_title(f'勝敗内訳（全{total_trades}取引）', color='white', fontsize=11, pad=8)
else:
    ax_pie.text(0.5, 0.5, '取引なし', ha='center', va='center', color='#aaa', fontsize=12)
    ax_pie.set_title('勝敗内訳', color='white', fontsize=11)

# ===== サマリーテーブル =====
ax_table.axis('off')
summary_rows = [
    ['項目', '値'],
    ['本日損益', f'{total_pnl:+,}円'],
    ['取引数', f'{total_trades}件'],
    ['勝率', f'{win_rate:.1f}%'],
    ['勝ち', f'{total_wins}件'],
    ['負け', f'{total_losses}件'],
    ['取引銘柄数', f'{len(active)}銘柄'],
    ['元金', '300万円'],
    ['シグナル方式', 'RSI+MA5/25クロス'],
]

tbl = ax_table.table(
    cellText=summary_rows[1:],
    colLabels=summary_rows[0],
    cellLoc='center',
    loc='center',
    bbox=[0.05, 0.05, 0.9, 0.9]
)
tbl.auto_set_font_size(False)
tbl.set_fontsize(9)
for (row, col), cell in tbl.get_celld().items():
    cell.set_facecolor('#252836' if row % 2 == 0 else '#1a1d27')
    cell.set_text_props(color='white')
    cell.set_edgecolor('#333')
    if row == 0:
        cell.set_facecolor('#2563eb')
        cell.set_text_props(color='white', fontweight='bold')
    # 損益行を色付け
    if row == 1:
        val = summary_rows[1][1]
        if '+' in val:
            cell.set_facecolor('#14532d')
        else:
            cell.set_facecolor('#450a0a')

ax_table.set_title('本日サマリー', color='white', fontsize=11, pad=8)

# ===== アルゴ vs チャートシグナル比較 =====
ax_comp.axis('off')
comp_data = [
    ['銘柄', '値幅', 'アルゴ損益', 'チャートSG損益', '取引数(SG)', '勝率(SG)'],
]
# アルゴ結果（本日）
algo_pnl_map = {
    'さくらインターネット': 7000,
}
for r in results:
    algo_pnl = algo_pnl_map.get(r['name'], 0)
    sg_pnl = r['totalPnl']
    sg_trades = r['tradeCount']
    sg_wr = f"{r['winCount']/sg_trades*100:.0f}%" if sg_trades > 0 else '—'
    comp_data.append([
        r['name'],
        f"{r['dayRange']}%",
        f'+{algo_pnl:,}円' if algo_pnl >= 0 else f'{algo_pnl:,}円',
        f'+{sg_pnl:,}円' if sg_pnl >= 0 else f'{sg_pnl:,}円',
        f'{sg_trades}件',
        sg_wr,
    ])

tbl2 = ax_comp.table(
    cellText=comp_data[1:],
    colLabels=comp_data[0],
    cellLoc='center',
    loc='center',
    bbox=[0.0, 0.0, 1.0, 1.0]
)
tbl2.auto_set_font_size(False)
tbl2.set_fontsize(8.5)
for (row, col), cell in tbl2.get_celld().items():
    cell.set_facecolor('#252836' if row % 2 == 0 else '#1a1d27')
    cell.set_text_props(color='white')
    cell.set_edgecolor('#333')
    if row == 0:
        cell.set_facecolor('#7c3aed')
        cell.set_text_props(color='white', fontweight='bold')
    # チャートSG損益列（col=3）の色
    if row > 0 and col == 3:
        val_str = comp_data[row][3]
        if '+' in val_str and val_str != '+0円':
            cell.set_facecolor('#14532d')
        elif '-' in val_str:
            cell.set_facecolor('#450a0a')
    # アルゴ損益列（col=2）の色
    if row > 0 and col == 2:
        val_str = comp_data[row][2]
        if '+' in val_str and val_str != '+0円':
            cell.set_facecolor('#14532d')

ax_comp.set_title('アルゴリズム vs チャートシグナル 比較', color='white', fontsize=11, pad=8)

# 総合損益テキスト
pnl_color = '#22c55e' if total_pnl >= 0 else '#ef4444'
pnl_str = f'+{total_pnl:,}円' if total_pnl >= 0 else f'{total_pnl:,}円'
fig.text(0.5, 0.005,
         f'チャートシグナル合計損益: {pnl_str}  |  勝率: {win_rate:.1f}%  |  {total_trades}取引',
         ha='center', va='bottom', color=pnl_color, fontsize=12, fontweight='bold')

out = '/home/ubuntu/stock-alert-app/analysis/jq_out/chart_signal_today_report.png'
plt.savefig(out, dpi=150, bbox_inches='tight', facecolor='#0f1117')
print(f'Saved: {out}')
plt.close()
