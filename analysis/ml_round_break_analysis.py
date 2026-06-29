"""
大台割れ 勝敗分析 - 統計検定 + 決定木 + Random Forest
"""
import json
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import cross_val_score
import warnings
warnings.filterwarnings('ignore')

# Load data
with open('/home/ubuntu/stock-alert-app/analysis/round_break_features_v2.json', 'r') as f:
    data = json.load(f)

df = pd.DataFrame(data)
print(f"Total trades: {len(df)}")
print(f"Wins: {df['win'].sum()}, Losses: {(~df['win']).sum()}")
print(f"Win rate: {df['win'].mean()*100:.1f}%")
print()

# ============================================================
# 1. 統計的比較（勝ち vs 負け）
# ============================================================
wins = df[df['win'] == True]
losses = df[df['win'] == False]

numeric_features = [
    'timeMinutes', 'volumeRatio', 'atrRatio', 'adx', 'boardScore',
    'buyPressureRatio', 'slope', 'vwapDeviation', 'rsi', 'bbPosition',
    'barsAboveRound', 'hour'
]

categorical_features = [
    'regime', 'boardSignal', 'largeBuyWall', 'largeSellWall', 'ma5_above_ma25_5m'
]

print("=" * 80)
print("  統計的比較: 勝ちトレード vs 負けトレード")
print("=" * 80)
print()

# Numeric features - t-test and Mann-Whitney U
print(f"{'特徴量':<20} {'勝ち(平均±SD)':<22} {'負け(平均±SD)':<22} {'t検定 p値':<12} {'有意':<6}")
print("-" * 82)

significant_features = []
for feat in numeric_features:
    w = wins[feat].values
    l = losses[feat].values
    w_mean, w_std = np.mean(w), np.std(w)
    l_mean, l_std = np.mean(l), np.std(l)
    
    # t-test
    t_stat, p_val = stats.ttest_ind(w, l, equal_var=False)
    # Mann-Whitney U (non-parametric)
    try:
        u_stat, u_p = stats.mannwhitneyu(w, l, alternative='two-sided')
    except:
        u_p = 1.0
    
    sig = "***" if p_val < 0.01 else "**" if p_val < 0.05 else "*" if p_val < 0.1 else ""
    if p_val < 0.1:
        significant_features.append((feat, p_val, w_mean, l_mean))
    
    print(f"{feat:<20} {w_mean:>8.4f}±{w_std:.4f}   {l_mean:>8.4f}±{l_std:.4f}   {p_val:>8.4f}    {sig}")

print()
print(f"{'特徴量':<20} {'勝ち(平均±SD)':<22} {'負け(平均±SD)':<22} {'U検定 p値':<12} {'有意':<6}")
print("-" * 82)
for feat in numeric_features:
    w = wins[feat].values
    l = losses[feat].values
    w_mean, w_std = np.mean(w), np.std(w)
    l_mean, l_std = np.mean(l), np.std(l)
    try:
        u_stat, u_p = stats.mannwhitneyu(w, l, alternative='two-sided')
    except:
        u_p = 1.0
    sig = "***" if u_p < 0.01 else "**" if u_p < 0.05 else "*" if u_p < 0.1 else ""
    print(f"{feat:<20} {w_mean:>8.4f}±{w_std:.4f}   {l_mean:>8.4f}±{l_std:.4f}   {u_p:>8.4f}    {sig}")

# Categorical features - Chi-squared / Fisher's exact
print()
print(f"\n{'カテゴリ特徴量':<20} {'勝ち分布':<30} {'負け分布':<30} {'p値':<10} {'有意':<6}")
print("-" * 96)
for feat in categorical_features:
    w_vals = wins[feat].value_counts()
    l_vals = losses[feat].value_counts()
    
    # Create contingency table
    all_vals = sorted(set(df[feat].unique()))
    w_counts = [w_vals.get(v, 0) for v in all_vals]
    l_counts = [l_vals.get(v, 0) for v in all_vals]
    
    contingency = np.array([w_counts, l_counts])
    if contingency.shape[1] == 2:
        # Fisher's exact for 2x2
        _, p_val = stats.fisher_exact(contingency)
    else:
        chi2, p_val, _, _ = stats.chi2_contingency(contingency)
    
    sig = "***" if p_val < 0.01 else "**" if p_val < 0.05 else "*" if p_val < 0.1 else ""
    w_str = str(dict(zip(all_vals, w_counts)))[:28]
    l_str = str(dict(zip(all_vals, l_counts)))[:28]
    print(f"{feat:<20} {w_str:<30} {l_str:<30} {p_val:<10.4f} {sig}")

# ============================================================
# 2. 詳細集計
# ============================================================
print("\n" + "=" * 80)
print("  詳細集計")
print("=" * 80)

# Time distribution
print("\n【時間帯別】")
df['time_bucket'] = pd.cut(df['timeMinutes'], bins=[540, 600, 660, 720, 780, 840, 900], 
                           labels=['9:00-10:00', '10:00-11:00', '11:00-12:00', '12:00-13:00', '13:00-14:00', '14:00-15:00'])
time_stats = df.groupby('time_bucket', observed=True).agg(
    count=('win', 'count'),
    wins=('win', 'sum'),
    total_pnl=('pnl', 'sum')
).reset_index()
time_stats['win_rate'] = time_stats['wins'] / time_stats['count'] * 100
print(time_stats.to_string(index=False))

# Regime
print("\n【レジーム別】")
regime_stats = df.groupby('regime').agg(
    count=('win', 'count'),
    wins=('win', 'sum'),
    total_pnl=('pnl', 'sum')
).reset_index()
regime_stats['win_rate'] = regime_stats['wins'] / regime_stats['count'] * 100
print(regime_stats.to_string(index=False))

# Board score
print("\n【板読みスコア別】")
board_stats = df.groupby('boardScore').agg(
    count=('win', 'count'),
    wins=('win', 'sum'),
    total_pnl=('pnl', 'sum')
).reset_index()
board_stats['win_rate'] = board_stats['wins'] / board_stats['count'] * 100
print(board_stats.to_string(index=False))

# VWAP deviation
print("\n【VWAP乖離率別】")
df['vwap_bucket'] = pd.cut(df['vwapDeviation'], bins=[-0.02, -0.005, -0.002, 0, 0.002, 0.005, 0.02],
                           labels=['<-0.5%', '-0.5~-0.2%', '-0.2~0%', '0~0.2%', '0.2~0.5%', '>0.5%'])
vwap_stats = df.groupby('vwap_bucket', observed=True).agg(
    count=('win', 'count'),
    wins=('win', 'sum'),
    total_pnl=('pnl', 'sum')
).reset_index()
vwap_stats['win_rate'] = vwap_stats['wins'] / vwap_stats['count'] * 100
print(vwap_stats.to_string(index=False))

# Volume ratio
print("\n【出来高倍率別】")
df['vol_bucket'] = pd.cut(df['volumeRatio'], bins=[0, 1.0, 1.5, 2.0, 3.0, 100],
                          labels=['<1.0x', '1.0-1.5x', '1.5-2.0x', '2.0-3.0x', '>3.0x'])
vol_stats = df.groupby('vol_bucket', observed=True).agg(
    count=('win', 'count'),
    wins=('win', 'sum'),
    total_pnl=('pnl', 'sum')
).reset_index()
vol_stats['win_rate'] = vol_stats['wins'] / vol_stats['count'] * 100
print(vol_stats.to_string(index=False))

# 5m MA
print("\n【5分足MA5 vs MA25】")
ma5m_stats = df.groupby('ma5_above_ma25_5m').agg(
    count=('win', 'count'),
    wins=('win', 'sum'),
    total_pnl=('pnl', 'sum')
).reset_index()
ma5m_stats['win_rate'] = ma5m_stats['wins'] / ma5m_stats['count'] * 100
print(ma5m_stats.to_string(index=False))

# ============================================================
# 3. 決定木 & Random Forest
# ============================================================
print("\n" + "=" * 80)
print("  機械学習: 特徴量重要度ランキング")
print("=" * 80)

# Prepare features
feature_cols = [
    'timeMinutes', 'volumeRatio', 'atrRatio', 'adx', 'boardScore',
    'buyPressureRatio', 'slope', 'vwapDeviation', 'rsi', 'bbPosition',
    'barsAboveRound', 'hour'
]
# Add encoded categoricals
df['regime_down'] = (df['regime'] == 'down').astype(int)
df['regime_up'] = (df['regime'] == 'up').astype(int)
df['board_sell_pressure'] = (df['boardSignal'] == 'sell_pressure').astype(int)
df['large_buy_wall_int'] = df['largeBuyWall'].astype(int)
df['large_sell_wall_int'] = df['largeSellWall'].astype(int)
df['ma5_above_ma25_5m_int'] = df['ma5_above_ma25_5m'].astype(int)

all_feature_cols = feature_cols + [
    'regime_down', 'regime_up', 'board_sell_pressure',
    'large_buy_wall_int', 'large_sell_wall_int', 'ma5_above_ma25_5m_int'
]

X = df[all_feature_cols].values
y = df['win'].astype(int).values

# Decision Tree
print("\n【決定木 (max_depth=3)】")
dt = DecisionTreeClassifier(max_depth=3, min_samples_leaf=3, random_state=42)
dt.fit(X, y)
dt_score = cross_val_score(dt, X, y, cv=min(5, len(df)), scoring='accuracy')
print(f"  CV精度: {dt_score.mean():.3f} ± {dt_score.std():.3f}")
print()
tree_rules = export_text(dt, feature_names=all_feature_cols, max_depth=3)
print(tree_rules)

# Feature importance from DT
dt_importance = pd.DataFrame({
    'feature': all_feature_cols,
    'importance': dt.feature_importances_
}).sort_values('importance', ascending=False)
print("\n  決定木 特徴量重要度:")
for _, row in dt_importance[dt_importance['importance'] > 0].iterrows():
    print(f"    {row['feature']:<25} {row['importance']:.4f}")

# Random Forest
print("\n【Random Forest (n_estimators=100, max_depth=4)】")
rf = RandomForestClassifier(n_estimators=100, max_depth=4, min_samples_leaf=3, random_state=42)
rf.fit(X, y)
rf_score = cross_val_score(rf, X, y, cv=min(5, len(df)), scoring='accuracy')
print(f"  CV精度: {rf_score.mean():.3f} ± {rf_score.std():.3f}")

rf_importance = pd.DataFrame({
    'feature': all_feature_cols,
    'importance': rf.feature_importances_
}).sort_values('importance', ascending=False)
print("\n  Random Forest 特徴量重要度ランキング:")
print(f"  {'順位':<4} {'特徴量':<25} {'重要度':<10}")
print("  " + "-" * 42)
for rank, (_, row) in enumerate(rf_importance.iterrows(), 1):
    bar = "█" * int(row['importance'] * 50)
    print(f"  {rank:<4} {row['feature']:<25} {row['importance']:.4f} {bar}")

# ============================================================
# 4. Ver4条件の自動生成
# ============================================================
print("\n" + "=" * 80)
print("  Ver4条件の自動生成")
print("=" * 80)

# Use top features from RF and statistical significance
top_features = rf_importance.head(6)['feature'].tolist()
print(f"\n  上位6特徴量: {top_features}")

# For each top feature, find optimal threshold
print("\n  最適閾値の探索:")
for feat in top_features:
    if feat in all_feature_cols:
        feat_idx = all_feature_cols.index(feat)
        vals = X[:, feat_idx]
        # Try different thresholds
        best_score = 0
        best_thresh = None
        best_direction = None
        
        for pct in [25, 33, 50, 67, 75]:
            thresh = np.percentile(vals, pct)
            # Above threshold
            mask_above = vals >= thresh
            if mask_above.sum() > 3 and (~mask_above).sum() > 3:
                wr_above = y[mask_above].mean()
                wr_below = y[~mask_above].mean()
                if wr_above > best_score:
                    best_score = wr_above
                    best_thresh = thresh
                    best_direction = ">="
                if wr_below > best_score:
                    best_score = wr_below
                    best_thresh = thresh
                    best_direction = "<"
        
        if best_thresh is not None:
            mask = vals >= best_thresh if best_direction == ">=" else vals < best_thresh
            n_pass = mask.sum()
            wr_pass = y[mask].mean() * 100
            pnl_pass = df.loc[mask, 'pnl'].sum()
            print(f"    {feat:<25} {best_direction} {best_thresh:.6f}  → {n_pass}件, 勝率{wr_pass:.1f}%, P&L={pnl_pass:,.0f}円")

# Generate Ver4 rules based on analysis
print("\n" + "=" * 80)
print("  【勝てる大台割れ条件 Ver4】（自動生成）")
print("=" * 80)

# Find best combination
# Strategy: use top 3-4 features with thresholds that maximize win rate
# while keeping sample size reasonable (>= 10 trades)
from itertools import combinations

best_combo = None
best_wr = 0
best_pnl = 0
best_n = 0

# Generate candidate rules from top features
rules_candidates = []
for feat in rf_importance.head(8)['feature'].tolist():
    feat_idx = all_feature_cols.index(feat)
    vals = X[:, feat_idx]
    for pct in [25, 33, 40, 50, 60, 67, 75]:
        thresh = np.percentile(vals, pct)
        for direction in ['>=', '<']:
            mask = vals >= thresh if direction == '>=' else vals < thresh
            if mask.sum() >= 5:
                rules_candidates.append((feat, direction, thresh, mask))

# Try combinations of 2-4 rules
print("\n  最適ルール組み合わせ探索...")
results = []
for n_rules in [2, 3, 4]:
    for combo in combinations(range(len(rules_candidates)), n_rules):
        combined_mask = np.ones(len(df), dtype=bool)
        for idx in combo:
            combined_mask &= rules_candidates[idx][3]
        n_pass = combined_mask.sum()
        if n_pass >= 8:  # Minimum 8 trades
            wr = y[combined_mask].mean()
            pnl = df.loc[combined_mask, 'pnl'].sum()
            if wr > 0.45 and pnl > 0:  # Must be profitable
                rules = [(rules_candidates[idx][0], rules_candidates[idx][1], rules_candidates[idx][2]) for idx in combo]
                results.append((wr, pnl, n_pass, rules))

results.sort(key=lambda x: (-x[0], -x[1]))

print(f"\n  利益が出る組み合わせ: {len(results)}件")
if results:
    print("\n  === Top 5 ルールセット ===")
    for rank, (wr, pnl, n, rules) in enumerate(results[:5], 1):
        print(f"\n  #{rank}: 勝率={wr*100:.1f}%, P&L={pnl:,.0f}円, 件数={n}")
        for feat, direction, thresh in rules:
            print(f"      {feat} {direction} {thresh:.6f}")
    
    # Best rule set
    best_wr, best_pnl, best_n, best_rules = results[0]
    print(f"\n\n  ★ 推奨 Ver4 条件 ★")
    print(f"  勝率: {best_wr*100:.1f}% (現行: {df['win'].mean()*100:.1f}%)")
    print(f"  P&L: {best_pnl:,.0f}円 (現行: {df['pnl'].sum():,.0f}円)")
    print(f"  件数: {best_n}件 (現行: {len(df)}件)")
    print(f"  通過率: {best_n/len(df)*100:.1f}%")
    print()
    for feat, direction, thresh in best_rules:
        # Human-readable name
        names = {
            'timeMinutes': '時間帯(分)', 'volumeRatio': '出来高倍率',
            'atrRatio': 'ATR率', 'adx': 'ADX', 'boardScore': '板読みスコア',
            'buyPressureRatio': '買い圧力比率', 'slope': 'トレンド傾き',
            'vwapDeviation': 'VWAP乖離率', 'rsi': 'RSI', 'bbPosition': 'BB位置',
            'barsAboveRound': '大台下本数', 'hour': '時',
            'regime_down': 'レジーム=down', 'regime_up': 'レジーム=up',
            'board_sell_pressure': '板=売り圧力', 'large_buy_wall_int': '大口買い壁',
            'large_sell_wall_int': '大口売り壁', 'ma5_above_ma25_5m_int': '5分足MA5>MA25'
        }
        name = names.get(feat, feat)
        print(f"    条件: {name} {direction} {thresh:.6f}")
else:
    print("  利益が出る組み合わせが見つかりませんでした")

# ============================================================
# 5. 全取引一覧
# ============================================================
print("\n" + "=" * 80)
print("  全取引一覧")
print("=" * 80)
print(f"\n{'日付':<12} {'銘柄':<6} {'時間':<6} {'結果':<6} {'損益':>8} {'出来高':>6} {'ATR率':>7} {'ADX':>5} {'板':>3} {'レジーム':<8} {'VWAP乖離':>8} {'5mMA':>6}")
print("-" * 100)
for _, row in df.sort_values(['date', 'entryTime']).iterrows():
    result = "WIN" if row['win'] else "LOSS"
    ma5m = "↑" if row['ma5_above_ma25_5m'] else "↓"
    print(f"{row['date']:<12} {row['symbol']:<6} {row['entryTime']:<6} {result:<6} {row['pnl']:>8,.0f} {row['volumeRatio']:>5.1f}x {row['atrRatio']:>6.4f} {row['adx']:>5.1f} {row['boardScore']:>3} {row['regime']:<8} {row['vwapDeviation']:>7.4f} {ma5m:>6}")

print("\n\nDone.")
