# CLAUDE.md

小組共用的台股資料庫 + 每日更新的靜態圖表網站。GitHub Actions 每日抓台股日線寫進
Azure SQL，組員連同一張表跑各自策略；同時匯出 JSON 給 GitHub Pages 畫圖。

## 架構（資料流）

```
GitHub Actions（週一~五 12:00 UTC / 台灣 20:00 cron）
  ① fetch_daily.py  → yfinance 抓日線、算 MA → upsert 進 Azure SQL
  ② build_site.py   → 從 SQL 讀回 → 寫 docs/data/*.json + index.json
  ③ upload-pages-artifact + deploy-pages → 用 GitHub Actions 部署 Pages（不再 push 回 repo）
        ▼
☁️ Azure SQL: DatabasePJ.dbo.StockTrading_Live   ← 單一資料源
        ├─ 組員唯讀帳號連線跑策略
        └─ 純靜態網站 docs/（不含任何帳密）
```

## 關鍵檔案

| 檔案 | 作用 |
|------|------|
| `db.py` | Azure SQL 連線共用模組：讀 `DB_*` 環境變數 + `db_connect()`（對 Serverless 冷啟動 40613 等暫時性錯誤退避重試）。`fetch_daily.py` / `build_site.py` 都 import 它 |
| `fetch_daily.py` | 抓 9 檔（0050/2303/2317/2330/2382/2412/2454/2881 + 大盤 `TWII`）日線，算 MA5~MA240，以 `(date, StockCode)` upsert。預設只寫最近 30 天；`BACKFILL=true` 回填 2015 起全史 |
| `build_site.py` | 從 SQL 匯出 `docs/data/<code>.json` + `index.json`；Trend 文字壓成單字母 U/D/F 省體積 |
| `schema_live.sql` | 建表 DDL，主鍵 `(date, StockCode)`。**不用 `USE`**（Azure SQL 不支援切庫） |
| `sp_calculate_trend.sql` | 趨勢分段預存程序（移植課程 hw7）：MA5 近 5 日漲/跌天數 ≥ 3 → 上漲/下跌/橫盤，寫回 `Trend` 欄。在 SSMS 連 DatabasePJ 整檔執行 |
| `docs/` | 純前端網站：`index.html` + `app.js`（lightweight-charts v4）+ `style.css`。資料只讀同目錄 `data/*.json` |
| `.github/workflows/daily-update.yml` | 串起 ①②③ 的每日排程 |

## 常用指令

```powershell
# 本機跑資料抓取/匯出（需先設 4 個 DB_* 環境變數）
python fetch_daily.py                  # 每日增量（最近 30 天）
$env:BACKFILL="true"; python fetch_daily.py   # 全量回填 2015 起
python build_site.py                   # 匯出全部歷史到 docs/data
$env:DAYS="500"; python build_site.py  # 只匯出最近 500 個交易日

python -m http.server -d docs          # 本機預覽網站 → http://localhost:8000
```

DB 連線一律走環境變數 `DB_SERVER` / `DB_DATABASE` / `DB_USER` / `DB_PASSWORD`
（CI 走 GitHub Secrets，本機自行設）。

## 慣例與注意事項

- **資料從 2015-01-05 起，不是 2014**。`fetch_daily.py` 從 2014 抓只是讓 MA240 暖機，
  `CUTOFF` 只寫入 2015-01-01 之後 → DB/網站都不會有 2014 資料。
- **帳密絕不進 repo / commit**。組員一律用唯讀帳號（`db_datareader`），保護共用資料。
- 台股慣例 **紅漲綠跌**（`RED=#d50000` / `GREEN=#00897b`），改色票時別反掉。
- yfinance ticker 對應：台股 `code.TW`，大盤特例 `^TWII`，DB 內大盤代碼存成 `TWII`。
- `docs/app.js` 是純前端、無建置步驟，直接改檔即可；改完可 `node --check app.js` 檢查語法。策略面板（50/50 再平衡、0050 風控波段、三重頂底反轉、葛蘭碧八大法則、葛蘭碧最佳參數）都在 app.js 內，移植自組員的 `strategy/*.py`。
- **`strategy/` 是組員的策略參考腳本（被 `.gitignore` 排除）**：裡面 `*.py` 有**硬編碼 DB 帳密**，public repo 不能 commit；網站邏輯已用前端 JS 重寫。若要納入版控，須先比照 `db.py` 改走 `DB_*` 環境變數、移除明碼帳密。
- lightweight-charts 的 `timeScale.minBarSpacing` 預設 0.5px/根，2700+ 根會塞不下而
  砍掉左邊最舊資料 → 需設小值（目前 0.04）才能「全部」完整顯示自 2015。
- **Pages 改用 GitHub Actions 部署**（Settings → Pages 來源＝GitHub Actions，非 `/docs` 分支）。CI 在 runner 內現算 `docs/data` 後直接部署，**不再 commit 回 repo** → repo 裡 commit 的 `docs/data/*.json` 只是歷史殘留、非線上資料源（要本機預覽才需自己跑 `build_site.py`）。
- **部署觸發**：每日排程（抓 DB→建→部署）／手動 `workflow_dispatch`／**push 到 `docs/**` 或 `build_site.py`**（push 時跳過寫 DB，只重建+部署，前端改動推上去就上線）。CI 會在部署前用 `sed` 給 `index.html` 的 `app.js`/`style.css` 加上 commit SHA 版本參數（`?v=<sha>`）破快取，**原始檔不動**（本機預覽看到的是無參數版）。
- **`main` 有分支保護**：協作者改 `main` 要走 PR + 1 審核；repo 管理員（owner）不強制、仍可直接 push。CI 不直推 `main`（見上），故與保護相容。
