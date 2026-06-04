"""
plot_leverage.py
信用取引レバレッジ別バックテスト結果の可視化
"""
import japanize_matplotlib
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np
import csv
import os

# データ
leverages = [1.0, 1.5, 2.0, 2.5, 3.0, 3.3]
total_profits = [582700, 1022300, 1381250, 1767500, 2137250, 2347050]
avg_per_day   = [4253,   7462,    10082,   12901,   15600,   17132]
jan_loss      = [-120950, -239650, -277050, -415450, -574400, -582550]
max_loss_day  = [-30100,  -43050,  -57800,  -88500,  -153650, -165800]
days_15k      = [20, 32, 38, 40, 48, 51]
pos_days      = [57, 66, 72, 71, 72, 72]
neg_days      = [40, 50, 58, 60, 61, 61]

months = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]
monthly_data = {
    1.0:  [117850, 147200, -120950, -550,   131750, 164700, 142700],
    1.5:  [254200, 303200, -239650, 33400,  180450, 274200, 216500],
    2.0:  [321500, 381950, -277050, 4050,   249800, 402950, 298050],
    2.5:  [374800, 485750, -415450, -22250, 399950, 570550, 374150],
    3.0:  [505200, 629300, -574400, -71850, 473750, 786000, 389250],
    3.3:  [527750, 674550, -582550, -66000, 486450, 967750, 339100],
}

fig = plt.figure(figsize=(20, 16))
fig.patch.set_facecolor('#0d1117')

colors = ['#58a6ff', '#3fb950', '#f78166', '#d2a8ff', '#ffa657', '#ff7b72']
lev_labels = ['1.0x\n(現状)', '1.5x', '2.0x', '2.5x', '3.0x', '3.3x\n(フルレバ)']

# タイトル
fig.suptitle('信用取引レバレッジ別シミュレーション（元金300万円 / 137営業日）',
             fontsize=18, color='white', fontweight='bold', y=0.98)

# ─── 1. 半年累計損益 ───
ax1 = fig.add_subplot(3, 3, 1)
ax1.set_facecolor('#161b22')
bars = ax1.bar(lev_labels, [p/10000 for p in total_profits], color=colors, alpha=0.85, edgecolor='#30363d')
ax1.axhline(0, color='#8b949e', linewidth=0.8, linestyle='--')
ax1.set_title('半年累計損益（万円）', color='white', fontsize=11, fontweight='bold', pad=8)
ax1.tick_params(colors='#8b949e', labelsize=9)
for spine in ax1.spines.values(): spine.set_edgecolor('#30363d')
ax1.set_facecolor('#161b22')
for bar, val in zip(bars, total_profits):
    ax1.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 2,
             f'{val/10000:.0f}万', ha='center', va='bottom', color='white', fontsize=8)

# ─── 2. 日平均損益 ───
ax2 = fig.add_subplot(3, 3, 2)
ax2.set_facecolor('#161b22')
bars2 = ax2.bar(lev_labels, avg_per_day, color=colors, alpha=0.85, edgecolor='#30363d')
ax2.axhline(15000, color='#f78166', linewidth=1.5, linestyle='--', label='目標15,000円')
ax2.set_title('日平均損益（円）', color='white', fontsize=11, fontweight='bold', pad=8)
ax2.tick_params(colors='#8b949e', labelsize=9)
for spine in ax2.spines.values(): spine.set_edgecolor('#30363d')
ax2.legend(fontsize=8, facecolor='#161b22', edgecolor='#30363d', labelcolor='white')
for bar, val in zip(bars2, avg_per_day):
    ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 100,
             f'{val:,.0f}円', ha='center', va='bottom', color='white', fontsize=8)

# ─── 3. 目標15,000円達成日数 ───
ax3 = fig.add_subplot(3, 3, 3)
ax3.set_facecolor('#161b22')
bars3 = ax3.bar(lev_labels, days_15k, color=colors, alpha=0.85, edgecolor='#30363d')
ax3.set_title('日利15,000円超の日数（137日中）', color='white', fontsize=11, fontweight='bold', pad=8)
ax3.tick_params(colors='#8b949e', labelsize=9)
for spine in ax3.spines.values(): spine.set_edgecolor('#30363d')
for bar, val in zip(bars3, days_15k):
    pct = val / 137 * 100
    ax3.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.3,
             f'{val}日\n({pct:.0f}%)', ha='center', va='bottom', color='white', fontsize=8)

# ─── 4. 1月損失 vs 最悪日損失 ───
ax4 = fig.add_subplot(3, 3, 4)
ax4.set_facecolor('#161b22')
x = np.arange(len(leverages))
w = 0.35
b1 = ax4.bar(x - w/2, [abs(j)/10000 for j in jan_loss], w, label='1月合計損失', color='#f78166', alpha=0.85, edgecolor='#30363d')
b2 = ax4.bar(x + w/2, [abs(m)/10000 for m in max_loss_day], w, label='最悪1日損失', color='#d2a8ff', alpha=0.85, edgecolor='#30363d')
ax4.set_title('損失リスク（万円）', color='white', fontsize=11, fontweight='bold', pad=8)
ax4.set_xticks(x); ax4.set_xticklabels(lev_labels, fontsize=9)
ax4.tick_params(colors='#8b949e', labelsize=9)
for spine in ax4.spines.values(): spine.set_edgecolor('#30363d')
ax4.legend(fontsize=8, facecolor='#161b22', edgecolor='#30363d', labelcolor='white')

# ─── 5. 月別損益ヒートマップ ───
ax5 = fig.add_subplot(3, 3, (5, 6))
ax5.set_facecolor('#161b22')
matrix = np.array([[monthly_data[l][i] for i in range(len(months))] for l in leverages])
im = ax5.imshow(matrix / 10000, cmap='RdYlGn', aspect='auto', vmin=-60, vmax=100)
ax5.set_xticks(range(len(months))); ax5.set_xticklabels([m[5:] for m in months], color='#8b949e', fontsize=9)
ax5.set_yticks(range(len(leverages))); ax5.set_yticklabels([f'{l}x' for l in leverages], color='#8b949e', fontsize=9)
ax5.set_title('月別損益ヒートマップ（万円）', color='white', fontsize=11, fontweight='bold', pad=8)
for i in range(len(leverages)):
    for j in range(len(months)):
        val = matrix[i][j]
        txt_color = 'black' if abs(val) < 300000 else 'white'
        ax5.text(j, i, f'{val/10000:.0f}万', ha='center', va='center', fontsize=8, color=txt_color, fontweight='bold')
plt.colorbar(im, ax=ax5, label='万円', shrink=0.8)

# ─── 6. リスクリワード比較 ───
ax6 = fig.add_subplot(3, 3, 7)
ax6.set_facecolor('#161b22')
risk_reward = [abs(p) / abs(j) if j != 0 else 0 for p, j in zip(total_profits, jan_loss)]
bars6 = ax6.bar(lev_labels, risk_reward, color=colors, alpha=0.85, edgecolor='#30363d')
ax6.axhline(1.0, color='#f78166', linewidth=1.5, linestyle='--', label='損益同等ライン')
ax6.set_title('半年利益 ÷ 1月損失（リスクリワード）', color='white', fontsize=11, fontweight='bold', pad=8)
ax6.tick_params(colors='#8b949e', labelsize=9)
for spine in ax6.spines.values(): spine.set_edgecolor('#30363d')
ax6.legend(fontsize=8, facecolor='#161b22', edgecolor='#30363d', labelcolor='white')
for bar, val in zip(bars6, risk_reward):
    ax6.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.02,
             f'{val:.2f}x', ha='center', va='bottom', color='white', fontsize=9, fontweight='bold')

# ─── 7. ポジ日数 vs ネガ日数 ───
ax7 = fig.add_subplot(3, 3, 8)
ax7.set_facecolor('#161b22')
x = np.arange(len(leverages))
w = 0.35
ax7.bar(x - w/2, pos_days, w, label='プラス日', color='#3fb950', alpha=0.85, edgecolor='#30363d')
ax7.bar(x + w/2, neg_days, w, label='マイナス日', color='#f78166', alpha=0.85, edgecolor='#30363d')
ax7.set_title('プラス日 vs マイナス日', color='white', fontsize=11, fontweight='bold', pad=8)
ax7.set_xticks(x); ax7.set_xticklabels(lev_labels, fontsize=9)
ax7.tick_params(colors='#8b949e', labelsize=9)
for spine in ax7.spines.values(): spine.set_edgecolor('#30363d')
ax7.legend(fontsize=8, facecolor='#161b22', edgecolor='#30363d', labelcolor='white')

# ─── 8. 推奨レバレッジの総合評価 ───
ax8 = fig.add_subplot(3, 3, 9)
ax8.set_facecolor('#161b22')
ax8.axis('off')

summary = [
    ("1.0x（現状）",   "日均+4,253円", "1月-12万円", "⚠️ 目標未達"),
    ("1.5x",          "日均+7,462円", "1月-24万円", "⚠️ 目標未達"),
    ("2.0x",          "日均+10,082円","1月-28万円", "⚠️ 目標未達"),
    ("2.5x",          "日均+12,901円","1月-42万円", "⚠️ 目標に迫る"),
    ("3.0x ★推奨",    "日均+15,600円","1月-57万円", "✅ 目標達成"),
    ("3.3x（フルレバ）","日均+17,132円","1月-58万円", "✅ 目標超過"),
]
ax8.set_title('レバレッジ別総合評価', color='white', fontsize=11, fontweight='bold', pad=8)
y_pos = 0.92
for lev, avg_d, jan_l, judge in summary:
    color = '#3fb950' if '✅' in judge else ('#ffa657' if '迫る' in judge else '#8b949e')
    ax8.text(0.02, y_pos, f"{lev}", color=color, fontsize=9, fontweight='bold', transform=ax8.transAxes)
    ax8.text(0.40, y_pos, avg_d, color='#58a6ff', fontsize=8, transform=ax8.transAxes)
    ax8.text(0.65, y_pos, jan_l, color='#f78166', fontsize=8, transform=ax8.transAxes)
    y_pos -= 0.13

plt.tight_layout(rect=[0, 0, 1, 0.96])
out_path = os.path.join(os.path.dirname(__file__), "jq_out", "leverage_report.png")
plt.savefig(out_path, dpi=150, bbox_inches='tight', facecolor='#0d1117')
print(f"✅ 保存: {out_path}")
plt.close()
