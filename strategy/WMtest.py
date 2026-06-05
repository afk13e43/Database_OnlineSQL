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

# 系統環境排版優化
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
        print(f"[成功] 數據載入完成，共計 {len(df)} 筆紀錄。\n")
        return df


# ==============================================================================
# 2. 講義標準：動態斜率三重頂底偵測模組
# ==============================================================================
class TriplePatternDetector:
    @staticmethod
    def calculate_indicators(df, window=14):
        df = df.copy()
        for col in ['c', 'h', 'l', 'o']: df[col] = df[col].apply(lambda x: np.nan if x <= 0 else x)
        df.ffill(inplace=True)

        # 標準 ATR 還原：計算真實波幅 (True Range) 與 14天平均波幅
        prev_c = df['c'].shift(1)
        tr = pd.concat([df['h'] - df['l'], (df['h'] - prev_c).abs(), (df['l'] - prev_c).abs()], axis=1).max(axis=1)
        df['ATR'] = tr.rolling(window=window).mean()
        return df

    @staticmethod
    def extract_strict_signals(df):
        df = df.sort_values(by=['date']).reset_index(drop=True)
        df['buy_signal'], df['sell_signal'] = "", ""
        peaks, valleys = [], []

        for i in range(6, len(df)):
            chk_idx = i - 2
            # 5天區間轉折偵測 (ZigZag)
            if df['h'].iloc[chk_idx] == max(df['h'].iloc[i - 4:i + 1]) and (
                    not peaks or peaks[-1][0] != chk_idx): peaks.append((chk_idx, df['h'].iloc[chk_idx]))
            if df['l'].iloc[chk_idx] == min(df['l'].iloc[i - 4:i + 1]) and (
                    not valleys or valleys[-1][0] != chk_idx): valleys.append((chk_idx, df['l'].iloc[chk_idx]))

            peaks, valleys = peaks[-3:], valleys[-3:]
            if len(valleys) < 3 or len(peaks) < 3: continue
            cur_p, prev_p = df['c'].iloc[i], df['c'].iloc[i - 1]

            # 三重底買進判定 (第7點向上突破斜率頸線)
            if valleys[-3][0] < peaks[-2][0] < valleys[-2][0] < peaks[-1][0] < valleys[-1][0]:
                p1_idx, p1_val = peaks[-2]
                p2_idx, p2_val = peaks[-1]
                slope = (p2_val - p1_val) / (p2_idx - p1_idx)
                neckline = p1_val + slope * (i - p1_idx)
                if prev_p <= neckline < cur_p: df.at[i, 'buy_signal'] = "標準三重底突破"

            # 三重頂賣出判定 (第7點向下跌破斜率頸線)
            if peaks[-3][0] < valleys[-2][0] < peaks[-2][0] < valleys[-1][0] < peaks[-1][0]:
                v1_idx, v1_val = valleys[-2]
                v2_idx, v2_val = valleys[-1]
                slope = (v2_val - v1_val) / (v2_idx - v1_idx)
                neckline = v1_val + slope * (i - v1_idx)
                if prev_p >= neckline > cur_p: df.at[i, 'sell_signal'] = "標準三重頂跌破"
        return df


# ==============================================================================
# 3. 交易執行模組
# ==============================================================================
class GroupExecutionEngine:
    def __init__(self, initial_capital=10000000):
        self.capital, self.fee, self.tax, self.risk_pct = initial_capital, 0.001425, 0.003, 0.25

    def execute_simulation(self, stock_code, df):
        cash, position, trade_log, equity_curve = self.capital, None, [], []
        print(
            f"三重頂底戰略部署 -> 標的: {stock_code}\n" + "-" * 125 + f"\n{'交易日期':<12} | {'動作':<4} | {'成交價格':<8} | {'異動股數':<8} | {'目前停損/停利防線':<18} | {'帳戶總淨值':<12} | {'型態觸發原因'}\n" + "-" * 125)

        for i, row in df.iterrows():
            close, high, date = row['c'], row['h'], row['date']

            if pd.isna(row['ATR']):
                equity_curve.append(cash if not position else cash + (position['shares'] * close))
                continue

            # ------ 三重底買進 (還原 ATR 動態配資) ------
            if not position and row['buy_signal'] == "標準三重底突破":
                risk_space = 2 * row['ATR']  # 💡 講義標準：初始風險設為 2 * ATR
                if risk_space > 0:
                    # 💡 基於 5% 帳戶風險動態計算應買進之股數
                    shares = int((cash * self.risk_pct) // risk_space)
                    while (shares * close * (1 + self.fee)) > cash: shares -= 100

                    if shares > 0:
                        cash -= (shares * close * (1 + self.fee))
                        position = {
                            'entry_p': close, 'shares': shares, 'sl': close - risk_space,
                            'target_2r': close + (2 * risk_space), 'high_p': close, 'half_taken': False
                        }
                        print(
                            f"{date:<12} | {'買進':<4} | {close:<8.2f} | {shares:<8,.0f} | 停損:{position['sl']:<6.1f} | ${cash + (shares * close):<12,.0f} | {row['buy_signal']}")
                        trade_log.append({'type': 'BUY', 'date': date, 'profit': 0})

            # ------ 持有波段與 ATR 風控出場 ------
            elif position:
                position['high_p'] = max(position['high_p'], close)

                # 💡 2R 分批減倉落袋 (賺取 4 * ATR 幅度時平倉一半)
                if high >= position['target_2r'] and not position['half_taken']:
                    sell_s = position['shares'] // 2
                    if sell_s > 0:
                        cash += (sell_s * close) * (1 - self.fee - self.tax)
                        position['shares'] -= sell_s
                        position['half_taken'] = True
                        position['sl'] = position['entry_p']  # 防守點上調至成本價
                        print(
                            f"{date:<12} | {'半倉':<4} | {close:<8.2f} | {sell_s:<8,.0f} | 停損鎖定成本價   | ${cash + (position['shares'] * close):<12,.0f} | 滿足三重底2R停利")

                # 計算 ATR 追蹤跟蹤停損 (最高價 - 2.5 * ATR)
                atr_trailing = position['high_p'] - (2.5 * row['ATR'])
                act_stop = max(position['sl'], atr_trailing)

                exit_flag, reason = close < act_stop, f"跌破移動防守線({act_stop:.1f})"
                if not exit_flag and row['sell_signal'] == "標準三重頂跌破": exit_flag, reason = True, "波段結構破壞: 三重頂跌破"

                if exit_flag:
                    rev = position['shares'] * close
                    cash += rev * (1 - self.fee - self.tax)
                    profit = rev * (1 - self.fee - self.tax) - (
                                position['shares'] * position['entry_p'] * (1 + self.fee))
                    print(
                        f"{date:<12} | {'清倉':<4} | {close:<8.2f} | {position['shares']:<8,.0f} | {'--':<18} | ${cash:<12,.0f} | {reason} [{(profit / (position['shares'] * position['entry_p'])) * 100:+.2f}%]")
                    trade_log.append({'type': 'SELL', 'date': date, 'profit': profit})
                    position = None

            equity_curve.append(cash if not position else cash + (position['shares'] * close))

        # 期末強制平倉
        if position:
            rev = position['shares'] * df.iloc[-1]['c']
            cash += rev * (1 - self.fee - self.tax)
            profit = rev * (1 - self.fee - self.tax) - (position['shares'] * position['entry_p'] * (1 + self.fee))
            print(
                f"{df.iloc[-1]['date'] :<12} | {'平倉':<4} | {df.iloc[-1]['c']:<8.2f} | {position['shares']:<8,.0f} | {'--':<18} | ${cash:<12,.0f} | 回測期滿終止")
            trade_log.append({'type': 'SELL', 'date': df.iloc[-1]['date'], 'profit': profit})
            equity_curve[-1] = cash

        return cash, trade_log, equity_curve


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
            '採行量化策略': "標準三重頂底反轉",
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
    START_PERIOD, END_PERIOD, CAPITAL = '2024-01-01', '2026-01-02', 10000000

    db_service = AzureDataService()
    backtest_engine = GroupExecutionEngine(initial_capital=CAPITAL)
    group_master_df = db_service.fetch_group_stocks(WEB_DROPDOWN_POOL, START_PERIOD, END_PERIOD)

    if group_master_df is not None and not group_master_df.empty:
        summary_box = []
        for symbol in WEB_DROPDOWN_POOL:
            sub_df = group_master_df[group_master_df['stock_code'].astype(str) == str(symbol)].copy()
            if len(sub_df) < 40: continue

            sub_df = TriplePatternDetector.calculate_indicators(sub_df)
            sub_df = TriplePatternDetector.extract_strict_signals(sub_df)

            # 2. 進行回測模擬
            end_cash, log_entries, eq_line = backtest_engine.execute_simulation(symbol, sub_df)
            summary_box.append(ProjectReportGenerator.compile_summary(symbol, end_cash, CAPITAL, eq_line))

        print(f"\n三重頂底型態回測總表 ({START_PERIOD} ~ {END_PERIOD})")
        print(pd.DataFrame(summary_box).to_string(index=False, justify='left') + "\n" + "=" * 115)