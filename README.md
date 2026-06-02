# Database_OnlineSQL — 小組共用股票資料庫

每日由 GitHub Actions 自動抓台股日線，寫進一個 **Azure SQL** 雲端資料庫。
小組成員不必各自抓 yfinance，直接連這個資料庫、讀同一張 `dbo.StockTrading_Live`，
在上面跑各自的策略。

```
   GitHub Actions（每日 cron）
        │  python fetch_daily.py → yfinance 抓當日股價
        ▼
   ☁️ Azure SQL：dbo.StockTrading_Live   ← 單一資料源、每天自動更新
        ▲           ▲            ▲
       組員A        組員B         組員C    ← 各自連線讀同一張表，跑自己的策略
```

---

## 資料表：`dbo.StockTrading_Live`

| 欄位 | 型別 | 說明 |
|------|------|------|
| `date` | DATE | 交易日（主鍵之一）|
| `StockCode` | NVARCHAR(20) | 股票代號；大盤存成 `TWII`（主鍵之一）|
| `Open` / `High` / `Low` / `Close` | FLOAT | 開高低收 |
| `Volume` | BIGINT | 成交股數 |
| `MA5` / `MA10` / `MA20` / `MA60` / `MA120` / `MA240` | FLOAT | 移動平均（已算好）|

預設標的：`0050, 2303, 2317, 2330, 2382, 2412, 2454, 2881` + 大盤 `TWII`，2015 年起。

---

## 給組員：如何連線讀資料

連線資訊（**密碼請向組長索取，不要寫進任何檔案或 commit**）：

| 項目 | 值 |
|------|-----|
| 伺服器 | `dbpj.database.windows.net` |
| 資料庫 | `DatabasePJ` |
| 帳號 | 用組長提供的**唯讀帳號**（不要用管理員帳號）|

### Python（pymssql + pandas）

```python
import pymssql, pandas as pd

conn = pymssql.connect(
    server='dbpj.database.windows.net',
    user='groupreader',          # 組長提供的唯讀帳號
    password='...',              # 私下取得，勿寫進 repo
    database='DatabasePJ',
)
df = pd.read_sql(
    "SELECT [date],[Open],[High],[Low],[Close],Volume,MA5,MA20,MA60 "
    "FROM dbo.StockTrading_Live WHERE StockCode=%s ORDER BY [date]",
    conn, params=('2330',))
print(df.tail())
```

### SSMS / Azure Data Studio

連 `dbpj.database.windows.net`、SQL 驗證、用唯讀帳號，即可下 SQL：

```sql
-- 看每檔資料範圍
SELECT StockCode, COUNT(*) AS 筆數, MIN([date]) AS 起, MAX([date]) AS 迄
FROM dbo.StockTrading_Live GROUP BY StockCode ORDER BY StockCode;

-- 取單檔近一年
SELECT * FROM dbo.StockTrading_Live
WHERE StockCode='2330' AND [date] >= DATEADD(year,-1,GETDATE())
ORDER BY [date];
```

> 首次連線若被防火牆擋（`Client with IP ... is not allowed`），請組長在 Azure SQL 防火牆放行（本專案採開放防火牆，理論上不會擋）。Serverless 閒置會暫停，第一次連可能要等幾秒喚醒。

---

## 給維護者（repo 擁有者）：設定步驟

### 1. GitHub Secrets
repo → **Settings → Secrets and variables → Actions**，新增 4 個：

| Secret | 值 |
|--------|-----|
| `DB_SERVER` | `dbpj.database.windows.net` |
| `DB_DATABASE` | `DatabasePJ` |
| `DB_USER` | `dbpjadmin`（或 `dbpjadmin@dbpj`）|
| `DB_PASSWORD` | 你的管理員密碼 |

### 2. Azure SQL 防火牆（開放模式）
Azure Portal → SQL server → **網路 / 防火牆規則** → 新增一條允許所有 IP：
`0.0.0.0` ~ `255.255.255.255`（GitHub runner 的 IP 每次都變，故開放；靠密碼保護）。

### 3. 首次全量回填
到 **Actions → Daily stock update → Run workflow**，把 **backfill 勾起來** 跑一次
（會寫入 2015 起全部歷史）。之後排程每天自動只補最近 30 天。
也可本機跑：`BACKFILL=true python fetch_daily.py`（需先設 4 個 `DB_*` 環境變數）。

### 4. 建唯讀帳號給組員（建議）
別把管理員帳號給組員（避免誤刪表）。在 SSMS 連雲端後：

```sql
-- (1) 連到 master 資料庫執行：
CREATE LOGIN groupreader WITH PASSWORD = '取一個強密碼';

-- (2) 連到 DatabasePJ 執行：
CREATE USER groupreader FOR LOGIN groupreader;
ALTER ROLE db_datareader ADD MEMBER groupreader;   -- 只能讀、不能改
```

把 `groupreader` 的帳密私下給組員。

---

## 排程時間
`.github/workflows/daily-update.yml` 設每週一~五 **12:00 UTC（台灣 20:00）** 跑。
要改時間就改 `cron`（注意是 UTC）。

## 安全須知
- **密碼只放 GitHub Secrets / 私下傳遞**，絕不寫進程式或 commit。
- 採開放防火牆 + 密碼保護；**建議把這個 repo 設為 private**，避免連線資訊外流。
- 組員一律用**唯讀帳號**，保護共用資料不被誤改。
