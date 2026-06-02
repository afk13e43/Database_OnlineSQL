-- Database_OnlineSQL — 趨勢分段預存程序（移植自課程 hw7 sp_CalculateTrend）
-- 對 dbo.StockTrading_Live 計算每日 [Trend]（上漲趨勢/下跌趨勢/橫盤整理）並寫回。
-- 作法：選定均線(@MAType)逐日與前一日比 → 近 @LookbackDays 天的上升/下降天數
--       ≥ @ThresholdDays → 上漲/下跌；否則橫盤。Trend 欄位不存在會自動新增。
-- 在 SSMS 連到 DatabasePJ（用管理員）整檔執行即可（含底部對 9 檔的 EXEC）。

CREATE OR ALTER PROCEDURE dbo.sp_CalculateTrend
    @StockCode    NVARCHAR(50),
    @MAType       NVARCHAR(20),   -- 'MA5'/'MA10'/'MA20'/'MA60'/'MA120'/'MA240'
    @LookbackDays INT,            -- 往回看的天數（含當天）
    @ThresholdDays INT            -- 判定趨勢的天數門檻
AS
BEGIN
    SET NOCOUNT ON;

    -- 1) 確保 Trend 欄位存在
    IF NOT EXISTS (SELECT 1 FROM sys.columns
                   WHERE object_id = OBJECT_ID(N'dbo.StockTrading_Live') AND name = N'Trend')
        ALTER TABLE dbo.StockTrading_Live ADD Trend NVARCHAR(20) NULL;

    -- 2) 動態 SQL（Window Function 的範圍需用變數帶入）
    DECLARE @Sql NVARCHAR(MAX);
    DECLARE @Preceding INT = @LookbackDays - 1;
    IF @Preceding < 0 SET @Preceding = 0;

    SET @Sql = N'
    WITH MACalculation AS (
        SELECT [date], StockCode,
            CASE @MAType
                WHEN ''MA5''   THEN MA5   WHEN ''MA10''  THEN MA10
                WHEN ''MA20''  THEN MA20  WHEN ''MA60''  THEN MA60
                WHEN ''MA120'' THEN MA120 WHEN ''MA240'' THEN MA240
                ELSE NULL END AS MA_Value
        FROM dbo.StockTrading_Live
        WHERE StockCode = @StockCode
    ),
    DailyDirection AS (
        SELECT [date], StockCode,
            CASE WHEN MA_Value > LAG(MA_Value) OVER (ORDER BY [date]) THEN 1 ELSE 0 END AS IsUp,
            CASE WHEN MA_Value < LAG(MA_Value) OVER (ORDER BY [date]) THEN 1 ELSE 0 END AS IsDown
        FROM MACalculation
    ),
    RollingSum AS (
        SELECT [date], StockCode,
            SUM(IsUp)   OVER (ORDER BY [date] ROWS BETWEEN ' + CAST(@Preceding AS NVARCHAR) + N' PRECEDING AND CURRENT ROW) AS UpDaysCnt,
            SUM(IsDown) OVER (ORDER BY [date] ROWS BETWEEN ' + CAST(@Preceding AS NVARCHAR) + N' PRECEDING AND CURRENT ROW) AS DownDaysCnt
        FROM DailyDirection
    )
    UPDATE t
    SET t.Trend = CASE
            WHEN r.UpDaysCnt   >= @ThresholdDays THEN N''上漲趨勢''
            WHEN r.DownDaysCnt >= @ThresholdDays THEN N''下跌趨勢''
            ELSE N''橫盤整理'' END
    FROM dbo.StockTrading_Live t
    INNER JOIN RollingSum r ON t.[date] = r.[date] AND t.StockCode = r.StockCode
    WHERE t.StockCode = @StockCode;';

    EXEC sp_executesql @Sql,
        N'@StockCode NVARCHAR(50), @MAType NVARCHAR(20), @ThresholdDays INT',
        @StockCode = @StockCode, @MAType = @MAType, @ThresholdDays = @ThresholdDays;
END;
GO

-- ── 對全部 9 檔執行（hw12 設定：MA5 / 近5日 / 門檻3日）──
EXEC dbo.sp_CalculateTrend '0050','MA5',5,3;
EXEC dbo.sp_CalculateTrend '2303','MA5',5,3;
EXEC dbo.sp_CalculateTrend '2317','MA5',5,3;
EXEC dbo.sp_CalculateTrend '2330','MA5',5,3;
EXEC dbo.sp_CalculateTrend '2382','MA5',5,3;
EXEC dbo.sp_CalculateTrend '2412','MA5',5,3;
EXEC dbo.sp_CalculateTrend '2454','MA5',5,3;
EXEC dbo.sp_CalculateTrend '2881','MA5',5,3;
EXEC dbo.sp_CalculateTrend 'TWII','MA5',5,3;
GO

-- 驗證：看各趨勢分佈
SELECT StockCode, Trend, COUNT(*) AS 天數
FROM dbo.StockTrading_Live GROUP BY StockCode, Trend ORDER BY StockCode, Trend;
