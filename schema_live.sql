-- Database_OnlineSQL — 共用股票日線表（Azure SQL / 本機 SQL Server 皆適用）
-- 註：不用 USE，改由連線指定資料庫，相容 Azure SQL（Azure 不支援 USE 切換資料庫）。

IF OBJECT_ID('dbo.StockTrading_Live') IS NULL
CREATE TABLE dbo.StockTrading_Live (
    [date]    DATE         NOT NULL,
    StockCode NVARCHAR(20) NOT NULL,        -- 台股代號；大盤存成 'TWII'
    [Open]    FLOAT,
    [High]    FLOAT,
    [Low]     FLOAT,
    [Close]   FLOAT,
    Volume    BIGINT,                        -- yfinance 成交股數
    MA5   FLOAT, MA10  FLOAT, MA20  FLOAT,
    MA60  FLOAT, MA120 FLOAT, MA240 FLOAT,
    CONSTRAINT PK_StockTrading_Live PRIMARY KEY ([date], StockCode)
);
GO
