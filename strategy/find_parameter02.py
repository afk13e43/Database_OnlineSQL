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
TARGET_STOCK = '2382'         # 動態設定：要跑哪一支股票
START_DATE = '2020-01-01'     # 動態設定：起始時間
END_DATE = '2023-12-31'       # 動態設定：結束時間
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
def fetch_data(stock_code, start_date, end_date):
    conn = pymssql.connect(**db_settings)
    query = f"""
        SELECT [date], [Close] AS c 
        FROM dbo.StockTrading_Live 
        WHERE StockCode = '{stock_code}' 
          AND [date] BETWEEN '{start_date}' AND '{end_date}'
        ORDER BY [date] ASC
    """
    df = pd.read_sql(query, conn)
    conn.close()
    df['date'] = pd.to_datetime(df['date'])
    return df

# ==========================================
# 3. 策略核心：極速迴圈版 (包含保護機制)
# ==========================================
def run_backtest_with_protection(df, ma_window, dev_low, dev_high):
    data = df.copy()
    
    # 1. 向量化預先計算指標 (極速)
    data['MA'] = data['c'].rolling(window=ma_window).mean()
    data['PrevMA'] = data['MA'].shift(1)
    data['PrevClose'] = data['c'].shift(1)
    data['Trend'] = np.where(data['MA'] > data['PrevMA'], 1, -1)
    data['PrevTrend'] = data['Trend'].shift(1)
    data['Deviation'] = (data['c'] - data['MA']) / data['MA'] * 100
    
    # 2. 向量化預先判斷買賣訊號
    rule1_buy = (data['Trend'] == 1) & (data['PrevTrend'] == -1) & (data['c'] > data['MA'])
    rule2_buy = (data['Trend'] == 1) & (data['PrevClose'] < data['PrevMA']) & (data['c'] > data['MA'])
    rule4_buy = (data['Trend'] == -1) & (data['Deviation'] <= dev_low)
    buy_signals = (rule1_buy | rule2_buy | rule4_buy).values
    
    rule5_sell = (data['Trend'] == -1) & (data['PrevTrend'] == 1) & (data['c'] < data['MA'])
    rule8_sell = (data['Trend'] == 1) & (data['Deviation'] >= dev_high)
    sell_signals = (rule5_sell | rule8_sell).values
    
    prices = data['c'].values
    ma_values = data['MA'].values
    
    # 3. 交易成本設定
    FEE_RATE = 0.001425  # 手續費 0.1425%
    TAX_RATE = 0.003     # 證交稅 0.3%
    
    cash = INITIAL_CAPITAL
    holdings = 0
    average_buy_price = 0.0
    
    # 4. 進入逐日迴圈模擬 (Numpy 陣列讀取，速度極快)
    for i in range(len(prices)):
        if np.isnan(ma_values[i]):
            continue
            
        current_price = prices[i]
        
        # 【買進邏輯】：全進 (All-in)
        if buy_signals[i] and cash >= (current_price * (1 + FEE_RATE)):
            shares_to_buy = int(cash // (current_price * (1 + FEE_RATE))) 
            if shares_to_buy > 0:
                principal = shares_to_buy * current_price
                fee = int(principal * FEE_RATE)
                total_cost = principal + fee
                
                # 計算新平均成本
                average_buy_price = ((holdings * average_buy_price) + principal) / (holdings + shares_to_buy)
                cash -= total_cost
                holdings += shares_to_buy
                
        # 【賣出邏輯】：全出 (All-out)，且需通過保護機制
        elif sell_signals[i] and holdings > 0:
            gross_profit_per_share = current_price - average_buy_price
            friction_per_share = (average_buy_price * FEE_RATE) + (current_price * FEE_RATE) + (current_price * TAX_RATE)
            
            # 【保護機制】：每股獲利 > 交易成本 才准賣
            if gross_profit_per_share > friction_per_share:
                principal = holdings * current_price
                fee = int(principal * FEE_RATE)
                tax = int(principal * TAX_RATE)
                net_revenue = principal - fee - tax
                
                cash += net_revenue
                holdings = 0
                average_buy_price = 0.0

    # 5. 期末結算 (若有持股需扣除假定賣出的成本)
    if holdings > 0:
        final_stock_value = (holdings * prices[-1]) * (1 - FEE_RATE - TAX_RATE)
    else:
        final_stock_value = 0
        
    final_total_assets = cash + final_stock_value
    total_return = (final_total_assets / INITIAL_CAPITAL) - 1
    
    return total_return

# ==========================================
# 4. 參數最佳化執行區塊
# ==========================================
def optimize_strategy():
    df_raw = fetch_data(TARGET_STOCK, START_DATE, END_DATE)
    if df_raw.empty:
        print("查無資料，請檢查資料庫設定或日期區間。")
        return
        
    # ---------------- 參數池設定 ----------------
    ma_windows = [20, 60]                             # 均線
    dev_lows = [-5.0, -10.0, -15.0, -20.0]            # 負乖離買點
    dev_highs = [5.0, 10.0, 15.0, 20.0]               # 正乖離賣點
    # --------------------------------------------
    
    best_return = -np.inf
    best_params = {}
    combination_count = 1
    
    print("=" * 60)
    print(f"啟動參數最佳化... (已啟用「獲利>成本才賣出」保護機制)")
    print("=" * 60)
    
    for ma, d_low, d_high in itertools.product(ma_windows, dev_lows, dev_highs):
        
        # 呼叫帶有保護機制的回測引擎
        total_ret = run_backtest_with_protection(df_raw, ma, d_low, d_high)
        
        ma_type_str = f"MA{ma}"
        print(f"組合 {combination_count:<3}: {{'MA': '{ma_type_str}', 'Dev_L': {d_low:5.1f}, 'Dev_H': {d_high:4.1f}}} => 淨報酬率: {total_ret * 100:>6.2f}%")
        
        if total_ret > best_return:
            best_return = total_ret
            best_params = {
                'MA': ma_type_str, 'Dev_Low': d_low, 'Dev_High': d_high
            }
            
        combination_count += 1

    final_assets = INITIAL_CAPITAL * (1 + best_return)

    print("\n" + "=" * 60)
    print("🏆 最終最佳參數結果！(嚴格保護機制版)")
    print("=" * 60)
    print(f"股票: {TARGET_STOCK}、日期: {START_DATE} ~ {END_DATE}")
    print(f"最佳指標參數: 均線 {best_params['MA']} | 負乖離 {best_params['Dev_Low']} | 正乖離 {best_params['Dev_High']}")
    print("-" * 60)
    print(f"最終總資產  : ${int(final_assets):,}")
    print(f"區間總淨報酬率: {best_return * 100:.2f}%")
    print("=" * 60)

if __name__ == "__main__":
    optimize_strategy()