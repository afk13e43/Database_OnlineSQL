"""
build_site.py — 從 Azure SQL 讀股價，產生 GitHub Pages 用的靜態 JSON（docs/data/）

- 讀 dbo.StockTrading_Live，每檔輸出最近 DAYS 個交易日的 OHLC + 量 + MA5/20/60
- 產生 docs/data/<code>.json 與 docs/data/index.json（清單 + 最後更新）
- 連線走環境變數 DB_SERVER/DB_DATABASE/DB_USER/DB_PASSWORD（與 fetch_daily 相同；唯讀帳號即可）

用法：python build_site.py            # 預設匯出全部歷史（2015 起）
      DAYS=500 python build_site.py   # 只取最近 500 個交易日
"""

import os
import json
import datetime
import pymssql

_REQUIRED = ['DB_SERVER', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD']
_missing = [k for k in _REQUIRED if not os.environ.get(k)]
if _missing:
    raise SystemExit(f"缺少環境變數：{', '.join(_missing)}")

DB = dict(server=os.environ['DB_SERVER'], user=os.environ['DB_USER'],
          password=os.environ['DB_PASSWORD'], database=os.environ['DB_DATABASE'])
DAYS = int(os.environ.get('DAYS', '0'))      # 0 = 全部歷史；>0 則只取最近 N 個交易日

NAMES = {'0050': '元大台灣50', '2303': '聯電', '2317': '鴻海', '2330': '台積電',
         '2382': '廣達', '2412': '中華電', '2454': '聯發科', '2881': '富邦金', 'TWII': '加權指數'}

# Trend 文字 → 單字母代碼（U 上漲 / D 下跌 / F 橫盤），減少 JSON 體積
TREND_CODE = {'上漲趨勢': 'U', '下跌趨勢': 'D', '橫盤整理': 'F'}

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'docs', 'data')


def _num(v):
    return None if v is None else round(float(v), 4)


def main():
    os.makedirs(OUT, exist_ok=True)
    conn = pymssql.connect(**DB)
    cur = conn.cursor()
    cur.execute("SELECT DISTINCT StockCode FROM dbo.StockTrading_Live")
    codes = sorted(r[0] for r in cur.fetchall())

    index = {'updated_utc': datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC'), 'stocks': []}
    for code in codes:
        top = f"TOP ({DAYS}) " if DAYS > 0 else ""
        cur.execute(
            f"SELECT {top}[date],[Open],[High],[Low],[Close],Volume,MA5,MA20,MA60,MA120,MA240,Trend "
            "FROM dbo.StockTrading_Live WHERE StockCode=%s ORDER BY [date] DESC", (code,))
        recs = cur.fetchall()[::-1]                       # 由舊到新
        if not recs:
            continue
        rows = []
        for d, o, h, l, c, v, m5, m20, m60, m120, m240, tr in recs:
            rows.append({'time': d.strftime('%Y-%m-%d'),
                         'open': _num(o), 'high': _num(h), 'low': _num(l), 'close': _num(c),
                         'volume': None if v is None else int(v),
                         'ma5': _num(m5), 'ma20': _num(m20), 'ma60': _num(m60),
                         'ma120': _num(m120), 'ma240': _num(m240),
                         'trend': TREND_CODE.get(tr)})
        name = NAMES.get(code, code)
        with open(os.path.join(OUT, f'{code}.json'), 'w', encoding='utf-8') as f:
            json.dump({'code': code, 'name': name, 'rows': rows}, f, ensure_ascii=False)
        last, prev = rows[-1], (rows[-2] if len(rows) > 1 else rows[-1])
        chg = round((last['close'] - prev['close']) / prev['close'] * 100, 2) \
            if (last['close'] is not None and prev['close']) else None
        index['stocks'].append({'code': code, 'name': name, 'last_date': last['time'],
                                'last_close': last['close'], 'change_pct': chg})
    conn.close()

    index['stocks'].sort(key=lambda s: (s['code'] == 'TWII', s['code']))   # 大盤排最後
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=0)

    print(f"完成：{len(index['stocks'])} 檔 → {OUT}")
    for s in index['stocks']:
        print(f"  {s['code']:<5} {s['name']:<9} 最後 {s['last_date']} 收 {s['last_close']} ({s['change_pct']}%)")


if __name__ == '__main__':
    main()
