"""db.py — Azure SQL 連線共用模組（環境變數設定 + Serverless 冷啟動退避重試）

供 fetch_daily.py / build_site.py 共用：
    from db import DB, db_connect
連線資訊一律走環境變數 DB_SERVER / DB_DATABASE / DB_USER / DB_PASSWORD。
"""

import os
import time
import pymssql

_REQUIRED = ['DB_SERVER', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD']
_missing = [k for k in _REQUIRED if not os.environ.get(k)]
if _missing:
    raise SystemExit(f"缺少環境變數：{', '.join(_missing)}（CI 請設 GitHub Secrets，本機請自行 export）")

DB = dict(
    server=os.environ['DB_SERVER'],
    user=os.environ['DB_USER'],
    password=os.environ['DB_PASSWORD'],
    database=os.environ['DB_DATABASE'],
)

# DB 連線重試：Azure SQL Serverless 閒置會暫停，第一次連常吃 40613「資料庫尚未就緒」需等喚醒
DB_CONNECT_RETRIES = int(os.environ.get('DB_CONNECT_RETRIES', '6'))
DB_CONNECT_BACKOFF = int(os.environ.get('DB_CONNECT_BACKOFF', '15'))   # 每次重試前等待秒數（會逐次遞增）
# 視為「暫時性、值得重試」的錯誤特徵（含 Serverless 喚醒中、限流、連線逾時）
_TRANSIENT_HINTS = ('40613', '40197', '40501', '49918', '49919', '49920', '11001',
                    'not currently available', 'Adaptive Server connection failed',
                    'Login timeout', 'timed out', 'Server is busy')


def db_connect():
    """連 Azure SQL；遇 Serverless 冷啟動(40613)等暫時性錯誤就退避重試，等資料庫喚醒。"""
    last = None
    for attempt in range(1, DB_CONNECT_RETRIES + 1):
        try:
            return pymssql.connect(**DB)
        except Exception as e:                     # pymssql.OperationalError 等
            last = e
            transient = any(h in str(e) for h in _TRANSIENT_HINTS)
            if attempt == DB_CONNECT_RETRIES or not transient:
                raise
            wait = DB_CONNECT_BACKOFF * attempt    # 15s, 30s, 45s… 給 Serverless 時間恢復
            print(f"  DB 連線第 {attempt}/{DB_CONNECT_RETRIES} 次失敗，{wait}s 後重試…（{str(e)[:90]}）")
            time.sleep(wait)
    raise last                                     # 理論上不會走到，保險用
