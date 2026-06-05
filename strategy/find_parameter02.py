import os
import pymssql
import pandas as pd
import numpy as np
import itertools
import warnings
warnings.filterwarnings('ignore')

# DB 連線一律走環境變數（勿把帳密寫進檔案／commit）；需先設 DB_SERVER/DB_USER/DB_PASSWORD/DB_DATABASE
_missing = [k for k in ('DB_SERVER', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE') if not os.environ.get(k)]
if _missing:
    raise SystemExit(f"缺少環境變數：{', '.join(_missing)}（請先設 DB_* 環境變數，勿把帳密寫進檔案）")

# ==========================================
# 1. 動態設定與資料庫連線設定
# ==========================================
TARGET_STOCK = '2303'         # 動態設定：要跑哪一支股票
START_DATE = '2023-01-01'     # 動態設定：起始時間
END_DATE = '2025-12-31'       # 動態設定：結束時間
INITIAL_CAPITAL = 10000000    # 動態設定：初始資金

db_settings = {
    "host": os.environ['DB_SERVER'],
    "user": os.environ['DB_USER'],
    "password": os.environ['DB_PASSWORD'],
    "database": os.environ['DB_DATABASE'],
}

# ==========================================
# 2. 獲取原始資料
# ==========================================
def fetch_data(StockCode, start_date, end_date):
    conn = pymssql.connect(
        server=db_settings['host'],
        user=db_settings['user'],
        password=db_settings['password'],
        database=db_settings['database'],
    )
    
    query = f"""
        SELECT [date], [Close] AS c
        FROM dbo.StockTrading_Live 
        WHERE StockCode = '{StockCode}' 
          AND [date] BETWEEN '{start_date}' AND '{end_date}'
        ORDER BY [date] ASC
    """
    df = pd.read_sql(query, conn)
    conn.close()
    
    df['date'] = pd.to_datetime(df['date'])
    return df

# ==========================================
# 3. 策略核心：全進全出 (All-in / All-out 向量化極速版)
# ==========================================
def run_granville_backtest(df, ma_window, dev_low, dev_high):
    data = df.copy()
    
    # 1. 計算均線與指標
    data['MA'] = data['c'].rolling(window=ma_window).mean()
    data['PrevMA'] = data['MA'].shift(1)
    data['PrevClose'] = data['c'].shift(1)
    data['Trend'] = np.where(data['MA'] > data['PrevMA'], 1, -1)
    data['PrevTrend'] = data['Trend'].shift(1)
    data['Deviation'] = (data['c'] - data['MA']) / data['MA'] * 100
    
    # 2. 判斷訊號
    rule1_buy = (data['Trend'] == 1) & (data['PrevTrend'] == -1) & (data['c'] > data['MA'])
    rule2_buy = (data['Trend'] == 1) & (data['PrevClose'] < data['PrevMA']) & (data['c'] > data['MA'])
    rule4_buy = (data['Trend'] == -1) & (data['Deviation'] <= dev_low)
    buy_signal = rule1_buy | rule2_buy | rule4_buy
    
    rule5_sell = (data['Trend'] == -1) & (data['PrevTrend'] == 1) & (data['c'] < data['MA'])
    rule8_sell = (data['Trend'] == 1) & (data['Deviation'] >= dev_high)
    sell_signal = rule5_sell | rule8_sell
    
    # 3. 部位管理 (1=持有, 0=空手，利用 ffill 自動延續部位)
    data['Signal'] = np.nan
    data.loc[buy_signal, 'Signal'] = 1
    data.loc[sell_signal, 'Signal'] = 0
    data['Position'] = data['Signal'].ffill().fillna(0)
    
    # 4. 計算報酬率
    data['Daily_Return'] = data['c'].pct_change()
    data['Strategy_Return'] = data['Position'].shift(1) * data['Daily_Return']
    
    total_return = (1 + data['Strategy_Return'].fillna(0)).prod() - 1
    
    return total_return

# ==========================================
# 4. 參數最佳化與輸出格式
# ==========================================
def optimize_strategy():
    df_raw = fetch_data(TARGET_STOCK, START_DATE, END_DATE)
    
    if df_raw.empty:
        print("查無資料，請檢查資料庫設定或日期區間。")
        return
    
    # ---------------- 參數池設定 ----------------
    ma_windows = [20, 60]                            # 均線
    dev_lows = [-5.0, -10.0, -15.0, -20.0]           # 負乖離買點
    dev_highs = [5.0, 10.0, 15.0, 20.0]              # 正乖離賣點
    # --------------------------------------------
    
    best_return = -np.inf
    best_params = {}
    
    combination_count = 1
    
    # itertools.product 自動排列組合
    for ma, d_low, d_high in itertools.product(ma_windows, dev_lows, dev_highs):
        
        total_ret = run_granville_backtest(df_raw, ma, d_low, d_high)
        
        ma_type_str = f"MA{ma}"
        
        # 排版輸出
        print(f"組合 {combination_count:<3}: {{'MA': '{ma_type_str}', 'Dev_L': {d_low:5.1f}, 'Dev_H': {d_high:4.1f}}} => 報酬率: {total_ret * 100:>6.2f}%")
        
        if total_ret > best_return:
            best_return = total_ret
            best_params = {
                'MA': ma_type_str, 'Dev_Low': d_low, 'Dev_High': d_high
            }
            
        combination_count += 1

    final_assets = INITIAL_CAPITAL * (1 + best_return)

    print("\n" + "=" * 50)
    print("🏆 最終結果！")
    print("=" * 50)
    print(f"股票: {TARGET_STOCK}、日期: {START_DATE} ~ {END_DATE}")
    print(f"最佳指標參數: 均線 {best_params['MA']} | 負乖離 {best_params['Dev_Low']} | 正乖離 {best_params['Dev_High']}")
    print("-" * 50)
    print(f"最終總資產  : ${int(final_assets):,}")
    print(f"區間總報酬率: {best_return * 100:.2f}%")
    print("=" * 50)

if __name__ == "__main__":
    optimize_strategy()