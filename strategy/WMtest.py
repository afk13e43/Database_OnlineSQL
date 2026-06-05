import os
import pymssql
import pandas as pd
import numpy as np
import warnings

warnings.filterwarnings('ignore')

# DB 連線一律走環境變數（勿把帳密寫進檔案／commit）；需先設 DB_SERVER/DB_USER/DB_PASSWORD/DB_DATABASE
_missing = [k for k in ('DB_SERVER', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE') if not os.environ.get(k)]
if _missing:
    raise SystemExit(f"缺少環境變數：{', '.join(_missing)}（請先設 DB_* 環境變數，勿把帳密寫進檔案）")

pd.set_option('display.unicode.east_asian_width', True)
pd.set_option('display.unicode.ambiguous_as_wide', True)
pd.set_option('display.max_columns', None)
pd.set_option('display.width', 220)


# ==============================================================================
# 1. 資料服務模組 (Data Service Layer)
# ==============================================================================
class AzureDataService:
    def __init__(self):
        self.db_settings = {"host": os.environ['DB_SERVER'], "user": os.environ['DB_USER'],
                            "password": os.environ['DB_PASSWORD'], "database": os.environ['DB_DATABASE']}

    def fetch_group_stocks(self, target_stocks, start_date, end_date):
        print(f"[Azure SQL] 正在同步小組共用選單個股與大盤數據...")
        conn = pymssql.connect(server=self.db_settings['host'], user=self.db_settings['user'],
                               password=self.db_settings['password'], database=self.db_settings['database'])
        stocks_str = ",".join([f"'{s}'" for s in target_stocks])
        query = f"SELECT [date], [StockCode] AS stock_code, [Open] AS o, [High] AS h, [Low] AS l, [Close] AS c, [Volume] AS v FROM [dbo].[StockTrading_Live] WHERE [StockCode] IN ({stocks_str}) AND [date] >= '{start_date}' AND [date] <= '{end_date}' ORDER BY [date] ASC"
        df = pd.read_sql(query, conn)
        conn.close()
        df['date'] = df['date'].astype(str)
        print(f"✅ [成功] 數據載入完成，共計 {len(df)} 筆紀錄。\n")
        return df


# ==============================================================================
# 2. 講義標準：動態斜率三重頂底偵測模組
# ==============================================================================
class TriplePatternDetector:
    @staticmethod
    def extract_strict_signals(df):
        df = df.sort_values(by=['date']).reset_index(drop=True)
        df['buy_signal'], df['sell_signal'] = "", ""

        df['peak_idx'] = -1;
        df['peak_val'] = np.nan
        df['valley_idx'] = -1;
        df['valley_val'] = np.nan

        peaks, valleys = [], []

        for i in range(6, len(df)):
            chk_idx = i - 2
            if df['h'].iloc[chk_idx] == max(df['h'].iloc[i - 4:i + 1]) and (not peaks or peaks[-1][0] != chk_idx):
                peaks.append((chk_idx, df['h'].iloc[chk_idx]))
            if df['l'].iloc[chk_idx] == min(df['l'].iloc[i - 4:i + 1]) and (not valleys or valleys[-1][0] != chk_idx):
                valleys.append((chk_idx, df['l'].iloc[chk_idx]))

            peaks, valleys = peaks[-3:], valleys[-3:]

            if len(peaks) > 0: df.at[i, 'peak_idx'] = peaks[-1][0]; df.at[i, 'peak_val'] = peaks[-1][1]
            if len(valleys) > 0: df.at[i, 'valley_idx'] = valleys[-1][0]; df.at[i, 'valley_val'] = valleys[-1][1]

            if len(valleys) < 3 or len(peaks) < 3: continue

            # 改在第 5 點（第三個波谷 Valley 3）剛確認成形的當下直接進場買進
            if valleys[-3][0] < peaks[-2][0] < valleys[-2][0] < peaks[-1][0] < valleys[-1][0]:
                # 只要最新確認的谷底正是第三個 Valley，且目前還沒離得太遠，就發出低檔買進訊號
                if valleys[-1][0] == chk_idx:
                    df.at[i, 'buy_signal'] = "三重底底部埋伏買進"

            # 三重頂賣出判定保持嚴格
            if peaks[-3][0] < valleys[-2][0] < peaks[-2][0] < valleys[-1][0] < peaks[-1][0]:
                v1_idx, v1_val = valleys[-2]
                v2_idx, v2_val = valleys[-1]
                slope = (v2_val - v1_val) / (v2_idx - v1_idx)
                neckline = v1_val + slope * (i - v1_idx)
                if df['c'].iloc[i - 1] >= neckline > df['c'].iloc[i]:
                    df.at[i, 'sell_signal'] = "標準三重頂跌破"
        return df


# ==============================================================================
# 3. 交易執行模組
# ==============================================================================
class GroupExecutionEngine:
    def __init__(self, initial_capital=10000000):
        # 💡 完美模擬台股真實交易成本
        self.capital = initial_capital
        self.fee_rate = 0.001425  # 券商手續費 0.1425%
        self.tax_rate = 0.003  # 證券交易稅 0.3%
        self.position_size_pct = 0.25  # 動用手頭 25% 資金

    def execute_simulation(self, stock_code, df):
        cash, position, equity_curve = self.capital, None, []
        print(
            f"三重頂底底置戰略 -> 標的: {stock_code}\n" + "-" * 125 + f"\n{'交易日期':<12} | {'動作':<4} | {'成交價格':<8} | {'異動股數':<8} | {'目前動態切線防線':<18} | {'帳戶總淨值':<12} | {'型態觸發原因'}\n" + "-" * 125)

        for i, row in df.iterrows():
            close, date = row['c'], row['date']

            # ------ 三重底低檔埋伏買進 ------
            if not position and row['buy_signal'] == "三重底底部埋伏買進":
                allocated_money = cash * self.position_size_pct
                shares = int(allocated_money // close)

                # 精確計算包含買進手續費的總總支出
                while (shares * close * (1 + self.fee_rate)) > cash:
                    shares -= 100

                if shares > 0:
                    cash -= (shares * close * (1 + self.fee_rate))

                    v2_idx = int(row['valley_idx'])
                    v2_val = row['valley_val']

                    # 往回尋找真實的前一個波谷作為 v1
                    past_valleys = df[(df.index < i) & (df['valley_idx'] != v2_idx) & (df['valley_idx'] != -1)]
                    if not past_valleys.empty:
                        v1_idx = int(past_valleys['valley_idx'].iloc[-1])
                        v1_val = past_valleys['valley_val'].iloc[-1]
                    else:
                        v1_idx, v1_val = v2_idx - 10, v2_val * 0.95

                    # 因為買在最底部，停損線直接緊貼著前一個波谷低點（例如低點再減 3%），大幅縮小交易摩擦的虧損空間
                    position = {
                        'entry_p': close, 'shares': shares, 'entry_idx': i,
                        'v1_idx': v1_idx, 'v1_val': v1_val,
                        'v2_idx': v2_idx, 'v2_val': v2_val,
                        'initial_sl': v2_val * 0.97
                    }
                    print(
                        f"{date:<12} | {'買進':<4} | {close:<8.2f} | {shares:<8,.0f} | 底部切線防護啟動  | ${cash + (shares * close):<12,.0f} | {row['buy_signal']}")

            # ------ 持有波段與動態切線出場偵測 (扣除賣出手續費與證交稅) ------
            elif position:
                v1_i, v1_v = position['v1_idx'], position['v1_val']
                v2_i, v2_v = position['v2_idx'], position['v2_val']

                if (v2_i - v1_i) > 0:
                    slope = (v2_v - v1_v) / (v2_i - v1_i)
                    current_line_stop = v1_v + (slope * (i - v1_i))
                else:
                    current_line_stop = position['entry_p'] * 0.90

                # 出場過濾：跌破主要上升切線、跌破腳底停損、或者高檔三重頂破位
                exit_flag = (close < current_line_stop) or (close < position['initial_sl'])
                reason = f"跌破上升切線({current_line_stop:.1f})" if (
                            close < current_line_stop) else f"跌破谷底防禦({position['initial_sl']:.1f})"

                if not exit_flag and row['sell_signal'] == "標準三重頂跌破":
                    exit_flag, reason = True, "波段結構破壞: 三重頂跌破"

                if exit_flag:
                    # 平倉賣出時，同步扣除手續費 (0.1425%) 與證交稅 (0.3%)
                    gross_revenue = position['shares'] * close
                    total_friction = gross_revenue * (self.fee_rate + self.tax_rate)
                    cash += (gross_revenue - total_friction)

                    # 計算扣完所有手續費後的淨利潤
                    total_buy_cost = position['shares'] * position['entry_p'] * (1 + self.fee_rate)
                    net_profit = (gross_revenue - total_friction) - total_buy_cost
                    roi = (net_profit / total_buy_cost) * 100

                    defense_text = f"谷底停損:{position['initial_sl']:.1f}" if (
                                close < position['initial_sl']) else f"切線:{current_line_stop:.1f}"
                    print(
                        f"{date:<12} | {'清倉':<4} | {close:<8.2f} | {position['shares']:<8,.0f} | {defense_text:<18} | ${cash:<12,.0f} | {reason} [{roi:+.2f}%]")
                    position = None

            equity_curve.append(cash if not position else cash + (position['shares'] * close))

        # 期末強制平倉 (同樣扣除摩擦成本)
        if position:
            gross_revenue = position['shares'] * df.iloc[-1]['c']
            total_friction = gross_revenue * (self.fee_rate + self.tax_rate)
            cash += (gross_revenue - total_friction)
            print(
                f"{df.iloc[-1]['date'] :<12} | {'平倉':<4} | {df.iloc[-1]['c']:<8.2f} | {position['shares']:<8,.0f} | {'--':<18} | ${cash:<12,.0f} | 回測期滿終止")
            equity_curve[-1] = cash

        return cash, equity_curve


# ==============================================================================
# 4. 績效矩陣計算與總表輸出 (Report Layer)
# ==============================================================================
class ProjectReportGenerator:
    @staticmethod
    def compile_summary(stock, final_cash, initial_cap, equity):
        mdd = ((pd.Series(equity) - pd.Series(equity).cummax()) / pd.Series(
            equity).cummax()).min() * 100 if equity else 0.0
        return {
            '網頁選單標的': stock,
            '採行量化策略': "切線三重頂底",
            '最終期末淨值': f"${final_cash:,.0f}",
            '小組累積損益': f"${final_cash - initial_cap:+,.0f}",
            '戰略投報率': f"{((final_cash - initial_cap) / initial_cap) * 100:+.2f} %",
            '最大回撤 (MDD)': f"{mdd:.2f} %"
        }


# ==============================================================================
# 5. 系統核心主控台 (Main Orchestrator)
# ==============================================================================
if __name__ == "__main__":
    WEB_DROPDOWN_POOL = ['0050', '2303', '2317', '2330', '2382', '2412', '2454', '2881', 'TWII']
    START_PERIOD, END_PERIOD, CAPITAL = '2022-01-01', '2026-01-02', 10000000

    db_service = AzureDataService()
    backtest_engine = GroupExecutionEngine(initial_capital=CAPITAL)
    group_master_df = db_service.fetch_group_stocks(WEB_DROPDOWN_POOL, START_PERIOD, END_PERIOD)

    if group_master_df is not None and not group_master_df.empty:
        summary_box = []
        for symbol in WEB_DROPDOWN_POOL:
            sub_df = group_master_df[group_master_df['stock_code'].astype(str) == str(symbol)].copy()
            if len(sub_df) < 40:
                continue

            sub_df = TriplePatternDetector.extract_strict_signals(sub_df)
            end_cash, eq_line = backtest_engine.execute_simulation(symbol, sub_df)

            summary_box.append(ProjectReportGenerator.compile_summary(symbol, end_cash, CAPITAL, eq_line))

        print(f"\n 底部優化回測總表 ({START_PERIOD} ~ {END_PERIOD})")
        print(pd.DataFrame(summary_box).to_string(index=False, justify='left') + "\n" + "=" * 115)