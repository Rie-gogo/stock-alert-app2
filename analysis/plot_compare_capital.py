"""
plot_compare_capital.py
元金300万 vs 500万 バックテスト比較グラフ
"""
import csv, os, math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np
import japanize_matplotlib  # noqa

plt.rcParams['axes.unicode_minus'] = False

BASE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE, 'jq_out')

# ---- データ読み込み ----
def load_daily(fname):
    rows = list(csv.DictReader(open(os.path.join(OUT_DIR, fname))))
    dates = [r['date'] for r in rows]
    profits = [int(r['totalProfit']) for r in rows]
    cumul = []
    s = 0
    for p in profits:
        s += p
        cumul.append(s)
    return dates, profits, cumul

dates3, profits3, cumul3 = load_daily('daily_6m.csv')   # 300万
dates5, profits5, cumul5 = load_daily('daily_5m.csv')   # 500万

def load_month(fname):
    rows = list(csv.DictReader(open(os.path.join(OUT_DIR, fname))))
    return {r['month']: r for r in rows}

month3 = load_month('by_month_6m.csv')
month5 = load_month('by_month_5m.csv')
months_sorted = sorted(month3.keys())
month_labels = [m[5:] + '月' for m in months_sorted]

def load_symbol(fname):
    rows = list(csv.DictReader(open(os.path.join(OUT_DIR, fname))))
    return {r['symbol']: r for r in rows if int(r['trades']) > 0}

sym3 = load_symbol('by_symbol_6m.csv')
sym5 = load_symbol('by_symbol_5m.csv')

# ---- スタイル ----
BG = '#0f1117'
PANEL = '#1a1a2e'
GRID = '#2a2a3a'
TITLE = '#e8eaf6'
AXIS = '#9e9e9e'
C3 = '#7c4dff'   # 300万: 紫
C5 = '#00e5ff'   # 500万: シアン
POS = '#4caf50'
NEG = '#f44336'
GOLD = '#ffd54f'

def style_ax(ax, title='', xlabel='', ylabel=''):
    ax.set_facecolor(PANEL)
    ax.tick_params(colors=AXIS, labelsize=9)
    for sp in ['bottom','left']: ax.spines[sp].set_color(GRID)
    for sp in ['top','right']: ax.spines[sp].set_visible(False)
    ax.grid(axis='y', color=GRID, linewidth=0.5, alpha=0.7)
    if title: ax.set_title(title, color=TITLE, fontsize=11, fontweight='bold', pad=8)
    if xlabel: ax.set_xlabel(xlabel, color=AXIS, fontsize=9)
    if ylabel: ax.set_ylabel(ylabel, color=AXIS, fontsize=9)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:,.0f}'))

fig = plt.figure(figsize=(20, 22))
fig.patch.set_facecolor(BG)

# ===== 1. 累積損益比較 =====
ax1 = fig.add_subplot(4, 2, (1, 2))
style_ax(ax1, '累積損益比較（137営業日）', '日付', '累積損益（円）')
ax1.fill_between(range(len(cumul3)), cumul3, 0, alpha=0.15, color=C3)
ax1.fill_between(range(len(cumul5)), cumul5, 0, alpha=0.15, color=C5)
ax1.plot(range(len(cumul3)), cumul3, color=C3, linewidth=2, label=f'元金300万  最終: {cumul3[-1]:+,}円')
ax1.plot(range(len(cumul5)), cumul5, color=C5, linewidth=2, label=f'元金500万  最終: {cumul5[-1]:+,}円')
ax1.axhline(0, color=GRID, linewidth=1)

# 月境界線
month_starts = {}
for i, d in enumerate(dates3):
    m = d[:7]
    if m not in month_starts:
        month_starts[m] = i
for m, idx in month_starts.items():
    ax1.axvline(idx, color=GRID, linewidth=0.8, linestyle='--', alpha=0.5)
    ax1.text(idx + 0.5, max(max(cumul3), max(cumul5)) * 0.96, m[5:]+'月', color=AXIS, fontsize=7)

tick_step = max(1, len(dates3) // 10)
ax1.set_xticks(range(0, len(dates3), tick_step))
ax1.set_xticklabels([dates3[i] for i in range(0, len(dates3), tick_step)], rotation=30, ha='right', fontsize=7)
ax1.legend(facecolor=PANEL, labelcolor=TITLE, fontsize=10, loc='upper left')

# ===== 2. 月別損益比較（グループ棒グラフ） =====
ax2 = fig.add_subplot(4, 2, 3)
style_ax(ax2, '月別損益比較', '月', '損益（円）')
x = np.arange(len(months_sorted))
w = 0.35
bars3m = [int(month3[m]['profit']) for m in months_sorted]
bars5m = [int(month5.get(m, {'profit': '0'})['profit']) for m in months_sorted]
b3 = ax2.bar(x - w/2, bars3m, w, color=C3, alpha=0.85, label='300万')
b5 = ax2.bar(x + w/2, bars5m, w, color=C5, alpha=0.85, label='500万')
ax2.axhline(0, color=GRID, linewidth=1)
ax2.set_xticks(x)
ax2.set_xticklabels(month_labels, fontsize=9)
ax2.legend(facecolor=PANEL, labelcolor=TITLE, fontsize=9)
for bar, val in zip(b3, bars3m):
    ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + (5000 if val >= 0 else -12000),
             f'{val//1000:+}k', ha='center', va='bottom', color=C3, fontsize=7.5)
for bar, val in zip(b5, bars5m):
    ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + (5000 if val >= 0 else -12000),
             f'{val//1000:+}k', ha='center', va='bottom', color=C5, fontsize=7.5)

# ===== 3. 月別日平均比較 =====
ax3 = fig.add_subplot(4, 2, 4)
style_ax(ax3, '月別日平均損益比較', '月', '日平均（円）')
avg3m = [int(month3[m]['avgPerDay']) for m in months_sorted]
avg5m = [int(month5.get(m, {'avgPerDay': '0'})['avgPerDay']) for m in months_sorted]
b3a = ax3.bar(x - w/2, avg3m, w, color=C3, alpha=0.85, label='300万')
b5a = ax3.bar(x + w/2, avg5m, w, color=C5, alpha=0.85, label='500万')
ax3.axhline(0, color=GRID, linewidth=1)
ax3.axhline(15000, color=GOLD, linewidth=1.2, linestyle='--', alpha=0.7, label='目標15,000円')
ax3.set_xticks(x)
ax3.set_xticklabels(month_labels, fontsize=9)
ax3.legend(facecolor=PANEL, labelcolor=TITLE, fontsize=9)

# ===== 4. 銘柄別損益比較 =====
ax4 = fig.add_subplot(4, 2, 5)
style_ax(ax4, '銘柄別損益比較（500万）', '損益（円）', '銘柄')
all_syms = sorted(set(list(sym3.keys()) + list(sym5.keys())),
                  key=lambda s: int(sym5.get(s, {'profit':'0'})['profit']))
names_sym = [sym5.get(s, sym3.get(s, {})).get('name', s) for s in all_syms]
p3s = [int(sym3.get(s, {'profit':'0'})['profit']) for s in all_syms]
p5s = [int(sym5.get(s, {'profit':'0'})['profit']) for s in all_syms]
y_pos = np.arange(len(all_syms))
ax4.barh(y_pos - 0.2, p3s, 0.35, color=C3, alpha=0.85, label='300万')
ax4.barh(y_pos + 0.2, p5s, 0.35, color=C5, alpha=0.85, label='500万')
ax4.set_yticks(y_pos)
ax4.set_yticklabels(names_sym, fontsize=8)
ax4.axvline(0, color=GRID, linewidth=1)
ax4.legend(facecolor=PANEL, labelcolor=TITLE, fontsize=9)

# ===== 5. 日次損益分布比較 =====
ax5 = fig.add_subplot(4, 2, 6)
style_ax(ax5, '日次損益分布比較（ゼロ除く）', '損益（円）', '日数')
nz3 = [p for p in profits3 if p != 0]
nz5 = [p for p in profits5 if p != 0]
bins = np.linspace(min(min(nz3), min(nz5)), max(max(nz3), max(nz5)), 35)
ax5.hist(nz3, bins=bins, color=C3, alpha=0.6, label='300万')
ax5.hist(nz5, bins=bins, color=C5, alpha=0.6, label='500万')
ax5.axvline(0, color=NEG, linewidth=1.5, linestyle='--')
ax5.axvline(np.mean(nz3), color=C3, linewidth=1.5, linestyle=':', label=f'300万平均: {np.mean(nz3):,.0f}円')
ax5.axvline(np.mean(nz5), color=C5, linewidth=1.5, linestyle=':', label=f'500万平均: {np.mean(nz5):,.0f}円')
ax5.legend(facecolor=PANEL, labelcolor=TITLE, fontsize=8)

# ===== 6. サマリーテキスト =====
ax6 = fig.add_subplot(4, 2, (7, 8))
ax6.set_facecolor(PANEL)
ax6.axis('off')

total3 = sum(profits3)
total5 = sum(profits5)
avg3 = total3 / len(profits3)
avg5 = total5 / len(profits5)
w3 = sum(int(r['winCount']) for r in csv.DictReader(open(os.path.join(OUT_DIR, 'daily_6m.csv'))))
l3 = sum(int(r['lossCount']) for r in csv.DictReader(open(os.path.join(OUT_DIR, 'daily_6m.csv'))))
w5 = sum(int(r['winCount']) for r in csv.DictReader(open(os.path.join(OUT_DIR, 'daily_5m.csv'))))
l5 = sum(int(r['lossCount']) for r in csv.DictReader(open(os.path.join(OUT_DIR, 'daily_5m.csv'))))
wr3 = w3/(w3+l3)*100 if (w3+l3)>0 else 0
wr5 = w5/(w5+l5)*100 if (w5+l5)>0 else 0
pos3 = sum(1 for p in profits3 if p > 0)
pos5 = sum(1 for p in profits5 if p > 0)
neg3 = sum(1 for p in profits3 if p < 0)
neg5 = sum(1 for p in profits5 if p < 0)
over15k3 = sum(1 for p in profits3 if p >= 15000)
over15k5 = sum(1 for p in profits5 if p >= 15000)
best3 = max(profits3); worst3 = min(profits3)
best5 = max(profits5); worst5 = min(profits5)
ratio = total5 / total3 if total3 != 0 else 0

# 月次目標達成（日平均15,000円以上の月）
months_hit3 = sum(1 for m in months_sorted if int(month3[m]['avgPerDay']) >= 15000)
months_hit5 = sum(1 for m in months_sorted if int(month5.get(m, {'avgPerDay':'0'})['avgPerDay']) >= 15000)

lines = [
    ('■ 元金300万 vs 500万  比較サマリー（137営業日）', GOLD, 13),
    ('', TITLE, 8),
    ('', TITLE, 8),
]

table_data = [
    ('指標', '元金300万', '元金500万', '倍率'),
    ('累計損益', f'{total3:+,}円', f'{total5:+,}円', f'×{ratio:.2f}'),
    ('日平均損益', f'{avg3:+,.0f}円', f'{avg5:+,.0f}円', f'×{avg5/avg3:.2f}' if avg3!=0 else '-'),
    ('勝率', f'{wr3:.1f}%', f'{wr5:.1f}%', '-'),
    ('プラス日/マイナス日', f'{pos3}/{neg3}日', f'{pos5}/{neg5}日', '-'),
    ('最良日', f'{best3:+,}円', f'{best5:+,}円', '-'),
    ('最悪日', f'{worst3:+,}円', f'{worst5:+,}円', '-'),
    ('15,000円超の日数', f'{over15k3}日 ({over15k3/len(profits3)*100:.1f}%)', f'{over15k5}日 ({over15k5/len(profits5)*100:.1f}%)', '-'),
    ('月平均15,000円超の月', f'{months_hit3}/7ヶ月', f'{months_hit5}/7ヶ月', '-'),
]

col_x = [0.02, 0.28, 0.56, 0.82]
y = 0.95
for i, row in enumerate(table_data):
    colors_row = [GOLD, C3, C5, AXIS] if i == 0 else [AXIS, TITLE, TITLE, GOLD]
    sizes = [10, 10, 10, 10] if i == 0 else [9, 9, 9, 9]
    for j, (cell, cx) in enumerate(zip(row, col_x)):
        ax6.text(cx, y, cell, transform=ax6.transAxes,
                 color=colors_row[j], fontsize=sizes[j],
                 fontweight='bold' if i == 0 else 'normal', va='top')
    y -= 0.085
    if i == 0:
        ax6.plot([0.01, 0.99], [y + 0.04, y + 0.04], color=GRID, linewidth=0.8,
                 transform=ax6.transAxes, clip_on=False)

y -= 0.02
ax6.text(0.02, y, '■ 結論', transform=ax6.transAxes, color=GOLD, fontsize=11, fontweight='bold', va='top')
y -= 0.07
conclusion = f'元金500万円では累計+{total5:,}円（日平均+{avg5:,.0f}円）。300万円比×{ratio:.2f}倍の収益。'
ax6.text(0.02, y, conclusion, transform=ax6.transAxes, color=TITLE, fontsize=10, va='top')
y -= 0.06
ax6.text(0.02, y, f'月平均15,000円超を達成した月: {months_hit5}/7ヶ月（300万: {months_hit3}/7ヶ月）',
         transform=ax6.transAxes, color=TITLE, fontsize=10, va='top')

fig.suptitle('元金300万 vs 500万  バックテスト比較レポート（2025年11月〜2026年5月）',
             color=TITLE, fontsize=15, fontweight='bold', y=0.99)
plt.tight_layout(rect=[0, 0, 1, 0.98])
out_path = os.path.join(OUT_DIR, 'compare_capital_report.png')
plt.savefig(out_path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
print(f'Saved: {out_path}')
plt.close()
