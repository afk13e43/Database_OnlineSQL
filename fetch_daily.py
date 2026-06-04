"""
Database_OnlineSQL — 每日抓台股日線寫進 Azure SQL（小組共用資料源）

- 標的：0050 相關 8 檔 + 台股大盤 ^TWII（可用環境變數 STOCK_CODES 覆寫）
- 由 GitHub Actions 每日排程執行，寫入 dbo.StockTrading_Live
- DB 連線全部走「環境變數」（CI 走 GitHub Secrets；本機自行 export）

用法：
    python fetch_daily.py                 # 每日更新：只寫最近 WRITE_TAIL_DAYS 天（預設 30）
    BACKFILL=true python fetch_daily.py   # 首次全量回填（寫入 2015 起全部歷史）

需要的環境變數：DB_SERVER / DB_DATABASE / DB_USER / DB_PASSWORD
"""

import os
import datetime as dt
import pandas as pd
import yfinance as yf

from db import DB, db_connect   # 共用連線（含 Serverless 冷啟動退避重試）

# ──────────────────────────── 設定 ────────────────────────────
# 標的：預設 0050 相關 8 檔；可用 STOCK_CODES="2330,2317,..." 覆寫，大盤 TWII 一律自動納入
DEFAULT_CODES = ['0050', '2303', '2317', '2330', '2382', '2412', '2454', '2881']
CODES = [c.strip() for c in os.environ.get('STOCK_CODES', ','.join(DEFAULT_CODES)).split(',') if c.strip()]
CODES = list(dict.fromkeys(CODES + ['TWII']))   # 大盤必抓、去重

FETCH_START = '2014-01-01'                 # 從這天抓（多抓一年讓 MA240 在 2015 初就有值）
CUTOFF = dt.date(2014, 12, 31)             # 只寫入此日之後（2015-01-01 起）的資料
MA_WINDOWS = [5, 10, 20, 60, 120, 240]

# 寫入策略：預設每日只 upsert 最近 N 天（省 Azure 用量、夠涵蓋修正/延遲）；BACKFILL=true 則全量
BACKFILL = os.environ.get('BACKFILL', '').lower() in ('1', 'true', 'yes')
WRITE_TAIL_DAYS = int(os.environ.get('WRITE_TAIL_DAYS', '30'))


# ──────────────────────────── 工具 ────────────────────────────
def _ticker(code):
    """內部代碼 → yfinance ticker（台股一律 code.TW，大盤特例 ^TWII）"""
    return '^TWII' if code == 'TWII' else f'{code}.TW'


def init_schema():
    """建立 dbo.StockTrading_Live（若不存在）。schema_live.sql 不含 USE，相容 Azure SQL。"""
    sql_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'schema_live.sql')
    with open(sql_path, encoding='utf-8') as f:
        batches = [b for b in f.read().split('\nGO') if b.strip()]
    conn = db_connect(); conn.autocommit(True); cur = conn.cursor()
    for b in batches:
        cur.execute(b)
    conn.close()


def fetch_one(code, ticker):
    """抓單一標的自 FETCH_START 起的日線，算好 MA，回傳只含 CUTOFF 之後、欄位齊全的 DataFrame"""
    raw = yf.download(ticker, start=FETCH_START, progress=False, auto_adjust=False)
    if raw.empty:
        return pd.DataFrame()
    if isinstance(raw.columns, pd.MultiIndex):           # 單標的也可能是 MultiIndex，壓平
        raw.columns = raw.columns.get_level_values(0)
    df = raw[['Open', 'High', 'Low', 'Close', 'Volume']].copy()
    df = df.dropna(subset=['Close'])
    for w in MA_WINDOWS:
        df[f'MA{w}'] = df['Close'].rolling(w).mean()     # MA 用全歷史算，才正確
    df = df.reset_index().rename(columns={'Date': 'date'})
    df['date'] = pd.to_datetime(df['date']).dt.date
    df['StockCode'] = code
    df = df[df['date'] > CUTOFF]
    return df


def upsert(df):
    """以 (date, StockCode) upsert：先刪同股票同區間，再批次插入"""
    if df.empty:
        return 0
    code = df['StockCode'].iloc[0]
    dmin, dmax = df['date'].min(), df['date'].max()
    cols = ['date', 'StockCode', 'Open', 'High', 'Low', 'Close', 'Volume',
            'MA5', 'MA10', 'MA20', 'MA60', 'MA120', 'MA240']

    def cell(v):
        return None if pd.isna(v) else float(v)

    rows = []
    for _, r in df.iterrows():
        rows.append((
            str(r['date']), code,
            cell(r['Open']), cell(r['High']), cell(r['Low']), cell(r['Close']),
            None if pd.isna(r['Volume']) else int(r['Volume']),
            cell(r['MA5']), cell(r['MA10']), cell(r['MA20']),
            cell(r['MA60']), cell(r['MA120']), cell(r['MA240']),
        ))

    conn = db_connect(); conn.autocommit(False); cur = conn.cursor()
    cur.execute("DELETE FROM dbo.StockTrading_Live WHERE StockCode=%s AND [date] BETWEEN %s AND %s",
                (code, str(dmin), str(dmax)))
    cur.executemany(
        f"INSERT INTO dbo.StockTrading_Live ([{'],['.join(cols)}]) "
        f"VALUES ({','.join(['%s'] * len(cols))})", rows)
    conn.commit(); conn.close()
    return len(rows)


def main():
    init_schema()
    mode = '全量回填' if BACKFILL else f'每日更新（最近 {WRITE_TAIL_DAYS} 天）'
    print(f"目標：{DB['server']} / {DB['database']}")
    print(f"標的：{', '.join(CODES)}")
    print(f"模式：{mode}\n")
    total = 0
    for code in CODES:
        ticker = _ticker(code)
        try:
            df = fetch_one(code, ticker)
            if not BACKFILL and not df.empty:            # 每日模式：只留最近 N 天再寫
                tail_from = df['date'].max() - dt.timedelta(days=WRITE_TAIL_DAYS)
                df = df[df['date'] >= tail_from]
            n = upsert(df)
            total += n
            rng = f"{df['date'].min()} ~ {df['date'].max()}" if n else "—"
            print(f"  {code:<5} ({ticker:<8}) 寫入 {n:>4} 筆  {rng}")
        except Exception as e:
            print(f"  {code:<5} ({ticker:<8}) 失敗：{e}")
    print(f"\n完成，共寫入 {total} 筆到 dbo.StockTrading_Live")


if __name__ == '__main__':
    main()
