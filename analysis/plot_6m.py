"""
plot_6m.py
半年バックテスト結果の可視化スクリプト
"""
import csv
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.font_manager as fm
import numpy as np
import os
import japanize_matplotlib  # noqa: F401

plt.rcParams['axes.unicode_minus'] = False

BASE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE, 'jq_out')

# データ読み込み
daily = list(csv.DictReader(open(os.path.join(OUT_DIR, 'daily_6m.csv'))))
by_symbol = list(csv.DictReader(open(os.path.join(OUT_DIR, 'by_symbol_6m.csv'))))
by_month = list(csv.DictReader(open(os.path.join(OUT_DIR, 'by_month_6m.csv'))))
by_reason = list(csv.DictReader(open(os.path.join(OUT_DIR, 'by_reason_6m.csv'))))

dates = [r['date'] for r in daily]
profits = [int(r['totalProfit']) for r in daily]
cumulative = []
s = 0
for p in profits:
    s += p
    cumulative.append(s)

# 月ラベル
months = [r['month'] for r in by_month]
month_profits = [int(r['profit']) for r in by_month]
month_winrates = [float(r['winRate']) * 100 for r in by_month]
month_avgday = [int(r['avgPerDay']) for r in by_month]

# 銘柄データ（取引のある銘柄のみ）
sym_data = [(r['name'], int(r['profit']), int(r['trades']), float(r['winRate'])*100)
            for r in by_symbol if int(r['trades']) > 0]
sym_data.sort(key=lambda x: x[1])

# 決済理由データ
reason_data = [(r['reason'].strip('"'), int(r['profit']), int(r['count']), float(r['winRate'])*100)
               for r in by_reason]
reason_data.sort(key=lambda x: x[1])

fig = plt.figure(figsize=(20, 24))
fig.patch.set_facecolor('#0f1117')

TITLE_COLOR = '#e8eaf6'
AXIS_COLOR = '#9e9e9e'
GRID_COLOR = '#2a2a3a'
POS_COLOR = '#4caf50'
NEG_COLOR = '#f44336'
ACCENT_COLOR = '#7c4dff'
HIGHLIGHT_COLOR = '#ffd54f'

def style_ax(ax, title='', xlabel='', ylabel=''):
    ax.set_facecolor('#1a1a2e')
    ax.tick_params(colors=AXIS_COLOR, labelsize=9)
    ax.spines['bottom'].set_color(GRID_COLOR)
    ax.spines['left'].set_color(GRID_COLOR)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.grid(axis='y', color=GRID_COLOR, linewidth=0.5, alpha=0.7)
    if title:
        ax.set_title(title, color=TITLE_COLOR, fontsize=12, fontweight='bold', pad=10)
    if xlabel:
        ax.set_xlabel(xlabel, color=AXIS_COLOR, fontsize=9)
    if ylabel:
        ax.set_ylabel(ylabel, color=AXIS_COLOR, fontsize=9)

# ========== 1. 累積損益 ==========
ax1 = fig.add_subplot(4, 2, (1, 2))
style_ax(ax1, '累積損益推移（半年間 137営業日）', '日付', '累積損益（円）')
ax1.fill_between(range(len(cumulative)), cumulative, 0,
                 where=[c >= 0 for c in cumulative], color=POS_COLOR, alpha=0.3)
ax1.fill_between(range(len(cumulative)), cumulative, 0,
                 where=[c < 0 for c in cumulative], color=NEG_COLOR, alpha=0.3)
ax1.plot(range(len(cumulative)), cumulative, color=ACCENT_COLOR, linewidth=2)
ax1.axhline(0, color=GRID_COLOR, linewidth=1)

# 月境界線
month_starts = {}
for i, d in enumerate(dates):
    m = d[:7]
    if m not in month_starts:
        month_starts[m] = i

for m, idx in month_starts.items():
    ax1.axvline(idx, color=GRID_COLOR, linewidth=0.8, linestyle='--', alpha=0.5)
    ax1.text(idx + 0.5, max(cumulative) * 0.95, m[5:] + '月', color=AXIS_COLOR, fontsize=7)

# 最終値表示
final = cumulative[-1]
ax1.annotate(f'最終: {final:+,}円', xy=(len(cumulative)-1, final),
             xytext=(-60, 20), textcoords='offset points',
             color=HIGHLIGHT_COLOR, fontsize=10, fontweight='bold',
             arrowprops=dict(arrowstyle='->', color=HIGHLIGHT_COLOR))

# xticks
tick_step = max(1, len(dates) // 10)
ax1.set_xticks(range(0, len(dates), tick_step))
ax1.set_xticklabels([dates[i] for i in range(0, len(dates), tick_step)],
                    rotation=30, ha='right', fontsize=7)
ax1.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x:,.0f}'))

# ========== 2. 月別損益棒グラフ ==========
ax2 = fig.add_subplot(4, 2, 3)
style_ax(ax2, '月別損益', '月', '損益（円）')
colors = [POS_COLOR if p >= 0 else NEG_COLOR for p in month_profits]
bars = ax2.bar(months, month_profits, color=colors, alpha=0.85, width=0.6)
ax2.axhline(0, color=GRID_COLOR, linewidth=1)
for bar, val in zip(bars, month_profits):
    ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + (5000 if val >= 0 else -8000),
             f'{val:+,}', ha='center', va='bottom', color=TITLE_COLOR, fontsize=8)
ax2.set_xticklabels([m[5:]+'月' for m in months], rotation=0, fontsize=9)
ax2.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x:,.0f}'))

# ========== 3. 月別勝率 ==========
ax3 = fig.add_subplot(4, 2, 4)
style_ax(ax3, '月別勝率', '月', '勝率（%）')
bar_colors = [POS_COLOR if w >= 50 else NEG_COLOR for w in month_winrates]
bars3 = ax3.bar(months, month_winrates, color=bar_colors, alpha=0.85, width=0.6)
ax3.axhline(50, color=HIGHLIGHT_COLOR, linewidth=1, linestyle='--', alpha=0.7)
ax3.set_ylim(0, 80)
for bar, val in zip(bars3, month_winrates):
    ax3.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 1,
             f'{val:.0f}%', ha='center', va='bottom', color=TITLE_COLOR, fontsize=9)
ax3.set_xticklabels([m[5:]+'月' for m in months], rotation=0, fontsize=9)

# ========== 4. 銘柄別損益 ==========
ax4 = fig.add_subplot(4, 2, 5)
style_ax(ax4, '銘柄別損益（取引あり銘柄のみ）', '損益（円）', '銘柄')
names = [d[0] for d in sym_data]
sym_profits = [d[1] for d in sym_data]
sym_colors = [POS_COLOR if p >= 0 else NEG_COLOR for p in sym_profits]
ax4.barh(names, sym_profits, color=sym_colors, alpha=0.85)
ax4.axvline(0, color=GRID_COLOR, linewidth=1)
for i, (p, t, wr) in enumerate([(d[1], d[2], d[3]) for d in sym_data]):
    ax4.text(p + (max(sym_profits)*0.02 if p >= 0 else -max(sym_profits)*0.02),
             i, f'{p:+,}円 ({wr:.0f}%)', va='center',
             ha='left' if p >= 0 else 'right', color=TITLE_COLOR, fontsize=8)
ax4.xaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x:,.0f}'))

# ========== 5. 決済理由別損益 ==========
ax5 = fig.add_subplot(4, 2, 6)
style_ax(ax5, '決済理由別損益', '損益（円）', '決済理由')
r_names = [d[0] for d in reason_data]
r_profits = [d[1] for d in reason_data]
r_colors = [POS_COLOR if p >= 0 else NEG_COLOR for p in r_profits]
ax5.barh(r_names, r_profits, color=r_colors, alpha=0.85)
ax5.axvline(0, color=GRID_COLOR, linewidth=1)
for i, (p, cnt, wr) in enumerate([(d[1], d[2], d[3]) for d in reason_data]):
    ax5.text(p + (max(r_profits)*0.02 if p >= 0 else -max(r_profits)*0.02),
             i, f'{p:+,}円 ({cnt}回, {wr:.0f}%)', va='center',
             ha='left' if p >= 0 else 'right', color=TITLE_COLOR, fontsize=7.5)
ax5.xaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x:,.0f}'))

# ========== 6. 日次損益分布 ==========
ax6 = fig.add_subplot(4, 2, 7)
style_ax(ax6, '日次損益分布', '損益（円）', '日数')
non_zero = [p for p in profits if p != 0]
ax6.hist(non_zero, bins=30, color=ACCENT_COLOR, alpha=0.7, edgecolor=GRID_COLOR)
ax6.axvline(0, color=NEG_COLOR, linewidth=1.5, linestyle='--')
avg_nz = np.mean(non_zero) if non_zero else 0
ax6.axvline(avg_nz, color=HIGHLIGHT_COLOR, linewidth=1.5, linestyle='--', label=f'平均: {avg_nz:,.0f}円')
ax6.legend(facecolor='#1a1a2e', labelcolor=TITLE_COLOR, fontsize=9)
ax6.xaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x:,.0f}'))

# ========== 7. サマリーテキスト ==========
ax7 = fig.add_subplot(4, 2, 8)
ax7.set_facecolor('#1a1a2e')
ax7.axis('off')

total_profit = sum(profits)
total_trades = sum(int(r['winCount']) + int(r['lossCount']) for r in daily)
total_wins = sum(int(r['winCount']) for r in daily)
total_losses = sum(int(r['lossCount']) for r in daily)
win_rate = total_wins / total_trades * 100 if total_trades > 0 else 0
avg_day = total_profit / len(profits)
pos_days = sum(1 for p in profits if p > 0)
neg_days = sum(1 for p in profits if p < 0)
zero_days = sum(1 for p in profits if p == 0)
days_over15k = sum(1 for p in profits if p >= 15000)
best_day = max(profits)
worst_day = min(profits)

# 60日比較
rows60 = [r for r in daily if r['date'] >= '2026-03-02']
p60 = [int(r['totalProfit']) for r in rows60]
w60 = sum(int(r['winCount']) for r in rows60)
l60 = sum(int(r['lossCount']) for r in rows60)
total60 = sum(p60)
avg60 = total60 / len(p60)
wr60 = w60 / (w60 + l60) * 100 if (w60 + l60) > 0 else 0

summary_lines = [
    ('■ 半年バックテスト総合サマリー', HIGHLIGHT_COLOR, 13),
    ('', TITLE_COLOR, 10),
    (f'期間: 2025-11-04 〜 2026-05-29（137営業日）', TITLE_COLOR, 10),
    ('', TITLE_COLOR, 8),
    (f'累計損益:  {total_profit:+,} 円', POS_COLOR if total_profit >= 0 else NEG_COLOR, 12),
    (f'日平均:    {avg_day:+,.0f} 円', TITLE_COLOR, 11),
    (f'勝率:      {win_rate:.1f}%（{total_wins}勝 {total_losses}敗）', TITLE_COLOR, 11),
    (f'プラス日:  {pos_days}日  マイナス日: {neg_days}日  ゼロ日: {zero_days}日', TITLE_COLOR, 10),
    (f'最良日:    {best_day:+,}円  最悪日: {worst_day:+,}円', TITLE_COLOR, 10),
    (f'15,000円超: {days_over15k}/{len(profits)}日（{days_over15k/len(profits)*100:.1f}%）', TITLE_COLOR, 10),
    ('', TITLE_COLOR, 8),
    ('■ 60日比較（2026-03〜05）', HIGHLIGHT_COLOR, 11),
    (f'累計: {total60:+,}円  日平均: {avg60:+,.0f}円  勝率: {wr60:.1f}%', TITLE_COLOR, 10),
    ('', TITLE_COLOR, 8),
    ('■ 1月の大幅損失について', HIGHLIGHT_COLOR, 11),
    ('2026年1月は関税ショック等の急落相場。', AXIS_COLOR, 9),
    ('空売りロジックが逆張りになり損失拡大。', AXIS_COLOR, 9),
    ('2月以降は回復し安定推移。', AXIS_COLOR, 9),
]

y = 0.97
for text, color, size in summary_lines:
    ax7.text(0.05, y, text, transform=ax7.transAxes,
             color=color, fontsize=size, va='top')
    y -= 0.055 if size >= 11 else 0.045

fig.suptitle('半年バックテスト総合レポート（2025年11月〜2026年5月）',
             color=TITLE_COLOR, fontsize=16, fontweight='bold', y=0.99)

plt.tight_layout(rect=[0, 0, 1, 0.98])
out_path = os.path.join(OUT_DIR, 'backtest_6m_report.png')
plt.savefig(out_path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
print(f'Saved: {out_path}')
plt.close()
