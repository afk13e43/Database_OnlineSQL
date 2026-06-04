// 小組共用股票資料庫 — 股價趨勢圖（lightweight-charts v4）
// 純前端：只讀同目錄 data/*.json，不含任何資料庫帳密。

const chartEl = document.getElementById('chart');
const chart = LightweightCharts.createChart(chartEl, {
  layout: { background: { color: '#ffffff' }, textColor: '#333' },
  grid: { vertLines: { color: '#f3f3f3' }, horzLines: { color: '#f3f3f3' } },
  rightPriceScale: { borderColor: '#ddd' },
  // minBarSpacing 預設 0.5px/根，2700+ 根會塞不下而砍掉左邊最舊資料（「全部」只到 2019）；調小即可完整顯示自 2015 起
  // fixLeftEdge/fixRightEdge：禁止拖曳到沒有資料的左右空白區
  timeScale: { borderColor: '#ddd', minBarSpacing: 0.04, fixLeftEdge: true, fixRightEdge: true },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  autoSize: true,
});

const RED = '#d50000', GREEN = '#00897b';   // 台股：紅漲綠跌
const candle = chart.addCandlestickSeries({
  upColor: RED, downColor: GREEN, borderUpColor: RED, borderDownColor: GREEN,
  wickUpColor: RED, wickDownColor: GREEN,
});
const ma = {
  ma5:   chart.addLineSeries({ color: '#42a5f5', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
  ma20:  chart.addLineSeries({ color: '#ff9800', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
  ma60:  chart.addLineSeries({ color: '#ab47bc', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
  ma120: chart.addLineSeries({ color: '#ec407a', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, visible: false }),
  ma240: chart.addLineSeries({ color: '#8d6e63', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, visible: false }),
};
const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false });
vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

// 布林通道 (20, 2σ) 上下軌：預設隱藏、勾選才顯示（中軌＝MA20，沿用 MA20 開關）
const BB_COLOR = '#607d8b';
const bbOpt = { color: BB_COLOR, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
                priceLineVisible: false, lastValueVisible: false, visible: false };
const bbUpper = chart.addLineSeries(bbOpt);
const bbLower = chart.addLineSeries(bbOpt);

function bollinger(rows, period, mult) {
  const up = [], lo = [];
  for (let i = period - 1; i < rows.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += rows[j].close;
    const mean = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (rows[j].close - mean) ** 2;
    const sd = Math.sqrt(v / period);              // 母體標準差（經典布林定義）
    up.push({ time: rows[i].time, value: +(mean + mult * sd).toFixed(2) });
    lo.push({ time: rows[i].time, value: +(mean - mult * sd).toFixed(2) });
  }
  return { up, lo };
}

// 雙擊圖表 → 縮放回「顯示全部資料」
chartEl.addEventListener('dblclick', () => chart.timeScale().fitContent());

const sel = document.getElementById('stock');
const statEl = document.getElementById('stat');
const legendEl = document.getElementById('legend');
const yearsEl = document.getElementById('years');

let rows = [], rowMap = new Map(), curName = '', yearsBuilt = false, rebalDaily = null, rebalEnd = null;

// ── 策略買賣點標記：兩個固定插槽（上方/下方），各可獨立選擇顯示的策略 ──
const stratTrades   = {};              // 策略 id → [{time, type:'buy'|'sell'}]
const stratRegistry = {};             // 策略 id → 顯示名稱（供下拉選單使用）
const stratSlots    = ['rebal', null]; // [上方插槽 id, 下方插槽 id]；null = 不顯示

function setStrategyTrades(id, trades) {
  stratTrades[id] = trades || [];
  refreshMarkers();
}

// 注冊策略名稱並更新下拉選單（名稱未變則跳過，避免捲動時頻繁重建 DOM）
function registerStrategy(id, label) {
  if (stratRegistry[id] === label) return;
  stratRegistry[id] = label;
  refreshSlotSelects();
}

function refreshSlotSelects() {
  const opts = Object.entries(stratRegistry)
    .map(([id, lbl]) => `<option value="${id}">${lbl}</option>`).join('');
  ['slot-top', 'slot-bot'].forEach((elId, slot) => {
    const sel = document.getElementById(elId);
    if (!sel) return;
    sel.innerHTML = `<option value="">（不顯示）</option>${opts}`;
    sel.value = stratSlots[slot] || '';
  });
}

// 把 crosshair 回傳的時間統一成 'YYYY-MM-DD' 字串，用來查當天那一列
function timeKey(t) {
  if (t == null) return null;
  if (typeof t === 'string') return t;
  if (typeof t === 'object' && t.year)
    return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  return String(t);
}

function fmtVol(v) { return v == null ? '—' : Number(v).toLocaleString('en-US'); }

// 更新左上角資訊列為第 idx 列那一天的詳細資料
function updateLegend(idx) {
  const r = rows[idx];
  if (!r) { legendEl.innerHTML = ''; return; }
  const prev = rows[idx - 1];
  const chg = (prev && prev.close) ? (r.close - prev.close) / prev.close * 100 : 0;
  const cls = chg >= 0 ? 'up' : 'down', sign = chg >= 0 ? '▲' : '▼';
  const v = (k) => r[k] == null ? '—' : r[k];
  legendEl.innerHTML =
    `<span class="nm">${curName}</span>　<span class="lbl">${r.time}</span>　` +
    `開 ${r.open}　高 ${r.high}　低 ${r.low}　收 <b>${r.close}</b> ` +
    `<span class="${cls}">${sign}${Math.abs(chg).toFixed(2)}%</span>　量 ${fmtVol(r.volume)}　` +
    `<span class="c5">MA5 ${v('ma5')}</span>　<span class="c20">MA20 ${v('ma20')}</span>　<span class="c60">MA60 ${v('ma60')}</span>`;
}

// 滑鼠移到某一天 → 顯示那天；移出圖表 → 顯示最新一天
chart.subscribeCrosshairMove(param => {
  const key = timeKey(param.time);
  const i = key != null ? rowMap.get(key) : undefined;
  updateLegend(i == null ? rows.length - 1 : i);
  // 圓餅跟著游標日期：停在某天顯示那天，移出圖表回到期末
  if (rebalDaily) {
    const c = (key != null && rebalDaily.get(key)) || rebalEnd;
    if (c) showDay(c, c === rebalEnd);
  }
});

// 年份快捷列：點某年 → 聚焦該年（左右＝該年第一筆~最後一筆交易日）
function setActiveYearBtn(btn) {
  yearsEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
}

function focusYear(y, btn) {
  if (!rows.length) return;
  let from = -1, to = -1;
  for (let i = 0; i < rows.length; i++) {
    if (+rows[i].time.slice(0, 4) === y) { if (from < 0) from = i; to = i; }
  }
  if (from < 0) return;                       // 該年無資料
  chart.timeScale().setVisibleLogicalRange({ from, to });   // 精準對齊該年首尾交易日，不多留前後一天
  setActiveYearBtn(btn);
}

function buildYears() {
  if (yearsBuilt || !rows.length) return;
  const minY = +rows[0].time.slice(0, 4), maxY = +rows[rows.length - 1].time.slice(0, 4);
  yearsEl.innerHTML = '';
  for (let y = minY; y <= maxY; y++) {
    const b = document.createElement('button');
    b.textContent = y;
    b.addEventListener('click', () => focusYear(y, b));
    yearsEl.appendChild(b);
  }
  const all = document.createElement('button');
  all.textContent = '全部';
  all.addEventListener('click', () => { chart.timeScale().fitContent(); setActiveYearBtn(all); });
  yearsEl.appendChild(all);
  yearsBuilt = true;
}

// ── 50/50（當前股票 : 現金）再平衡模擬：用「目前可視範圍」當回測區間 ──
const FEE_RATE = 0.001425;   // 交易手續費（買賣各收）
const TAX_RATE = 0.003;      // 證交稅（僅賣出收）
const INIT_CASH = 10000000;  // 初始金額 1000 萬
const RB_TARGET = 0.5;       // 股票目標權重 50%
const RB_DRIFT = 0.05;       // 偏離 ±5% 觸發再平衡（±10% 較適合槓桿 ETF）
const rebalEl = document.getElementById('rebal');

// 固定回測區間：勾選後用 rb-start / rb-end 指定的日期當回測範圍，縮放/平移圖表都不影響
const lockCb = document.getElementById('lock-range');
const startEl = document.getElementById('rb-start');
const endEl = document.getElementById('rb-end');

function findStartIdx(d) {                          // 第一個 >= d 的交易日（找不到→最後一筆）
  for (let i = 0; i < rows.length; i++) if (rows[i].time >= d) return i;
  return rows.length - 1;
}
function findEndIdx(d) {                            // 最後一個 <= d 的交易日（找不到→第一筆）
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].time <= d) return i;
  return 0;
}

function money(x) { return Math.round(x).toLocaleString('en-US'); }

function simulateRebalance(slice) {
  if (!slice || slice.length < 2) return null;
  let cash = INIT_CASH, shares = 0, fee = 0, tax = 0;
  const trades = [];
  const rebal = (price, time) => {
    const eq = cash + shares * price;
    const delta = RB_TARGET * eq - shares * price;   // 目標股票市值 − 目前股票市值
    if (delta > 0) {                                 // 買進（收手續費）
      const f = delta * FEE_RATE;
      shares += delta / price; cash -= delta + f; fee += f;
      trades.push({ time, type: 'buy' });
    } else if (delta < 0) {                          // 賣出（收手續費 + 證交稅）
      const v = -delta, f = v * FEE_RATE, t = v * TAX_RATE;
      shares -= v / price; cash += v - f - t; fee += f; tax += t;
      trades.push({ time, type: 'sell' });
    }
  };
  rebal(slice[0].close, slice[0].time);              // 首日建立 50/50
  let peak = -Infinity, maxDD = 0;
  const comp = [];                                   // 每日（收盤後、含當日再平衡）累積指標
  for (const r of slice) {
    const p = r.close;
    let eq = cash + shares * p;
    if (Math.abs(shares * p / eq - RB_TARGET) >= RB_DRIFT) rebal(p, r.time);   // 摸到 ±5% 就再平衡
    eq = cash + shares * p;
    if (eq > peak) peak = eq;
    if ((eq - peak) / peak < maxDD) maxDD = (eq - peak) / peak;
    comp.push({ time: r.time, stock: shares * p, cash, equity: eq, fee, tax,
                maxDD: maxDD * 100, ret: (eq - INIT_CASH) / INIT_CASH * 100 });
  }
  const lastClose = slice[slice.length - 1].close;
  const finStock = shares * lastClose, finCash = cash, fin = finStock + finCash;
  return { start: slice[0].time, end: slice[slice.length - 1].time, days: slice.length,
           fin, finStock, finCash, ret: (fin - INIT_CASH) / INIT_CASH * 100, maxDD: maxDD * 100,
           fee, tax, cost: fee + tax, trades, comp };
}

// 圓餅（股票:現金）
function setPie(stock, cash) {
  const disc = document.getElementById('pieDisc'), leg = document.getElementById('pieLegend');
  if (!disc || !leg) return;
  const tot = stock + cash, sp = tot > 0 ? stock / tot * 100 : 0, cp = 100 - sp;
  disc.style.background = `conic-gradient(#b0bec5 0 ${cp}%, #1976d2 ${cp}% 100%)`;   // 先現金(右)後股票(左)
  leg.innerHTML =
    `<div><span class="dot stock"></span>股票 ${sp.toFixed(1)}%　${money(stock)}</div>` +
    `<div><span class="dot cash"></span>現金 ${cp.toFixed(1)}%　${money(cash)}</div>`;
}

// 用某一天的累積指標更新面板數字 + 圓餅（isEnd=true 代表期末）
function showDay(c, isEnd) {
  if (!c) return;
  const g = id => document.getElementById(id);
  setPie(c.stock, c.cash);
  const tag = (isEnd ? '期末 ' : '當日 ') + c.time;
  if (g('pieCap')) g('pieCap').textContent = tag;
  if (g('rbAsof')) g('rbAsof').textContent = tag;
  if (g('rbFinLbl')) g('rbFinLbl').textContent = isEnd ? '最終總金額' : '當日總金額';
  if (g('rbFin')) g('rbFin').textContent = money(c.equity);
  const ret = g('rbRet'); if (ret) { ret.textContent = (c.ret >= 0 ? '+' : '') + c.ret.toFixed(2) + '%'; ret.className = c.ret >= 0 ? 'up' : 'down'; }
  if (g('rbMDD')) { g('rbMDD').textContent = c.maxDD.toFixed(2) + '%'; g('rbMDD').className = 'down'; }
  if (g('rbCost')) g('rbCost').textContent = money(c.fee + c.tax);
  if (g('rbFee')) g('rbFee').textContent = money(c.fee);
  if (g('rbTax')) g('rbTax').textContent = money(c.tax);
}

function updateRebal() {
  if (!rebalEl || !rows.length) return;
  let from, to;
  if (lockCb && lockCb.checked && startEl.value && endEl.value) {
    from = findStartIdx(startEl.value);            // 區間已鎖定：用日期輸入框決定範圍
    to = findEndIdx(endEl.value);
    if (from > to) [from, to] = [to, from];
  } else {
    const vr = chart.timeScale().getVisibleLogicalRange();   // 未鎖定：跟著目前可視範圍
    if (!vr) return;
    from = Math.max(0, Math.ceil(vr.from));
    to = Math.min(rows.length - 1, Math.floor(vr.to));
    if (startEl && rows[from] && rows[to]) {                 // 日期框即時反映目前圖表的起迄
      startEl.value = rows[from].time; endEl.value = rows[to].time;
    }
  }
  const r = simulateRebalance(rows.slice(from, to + 1));
  if (!r) {
    setStrategyTrades('rebal', []);
    rebalDaily = null;
    rebalEl.innerHTML = '<div class="rb-hd">50/50 再平衡</div><div class="rb-note">可視範圍太小，請拉大圖表範圍</div>';
    return;
  }
  setStrategyTrades('rebal', r.trades);   // r.trades = [{time, type:'buy'|'sell'}]，顯示與否由勾選決定
  rebalEl.innerHTML =
    `<div class="rb-main">` +
      `<div class="rb-hd">50/50 再平衡（${curName} : 現金）· 偏離 ±5% 自動再平衡</div>` +
      `<div class="rb-sub">期間 ${r.start} ~ ${r.end}（${r.days} 個交易日）· 初始金額 ${money(INIT_CASH)}　·　交易點 <span class="up">▲買</span> / <span class="down">▼賣</span>　·　<span id="rbAsof"></span></div>` +
      `<div class="rb-grid">` +
        `<div><span class="rb-lbl" id="rbFinLbl">最終總金額</span><b id="rbFin"></b></div>` +
        `<div><span class="rb-lbl">報酬率</span><b id="rbRet"></b></div>` +
        `<div><span class="rb-lbl">最大回撤</span><b id="rbMDD"></b></div>` +
        `<div><span class="rb-lbl">交易成本</span><b id="rbCost"></b></div>` +
      `</div>` +
      `<div class="rb-cost">交易手續費 <b id="rbFee"></b>（0.1425%·買賣各收）　＋　證交稅 <b id="rbTax"></b>（0.3%·賣出收）　·　以收盤價模擬、現金不計息</div>` +
    `</div>` +
    `<div class="rb-pie">` +
      `<div class="pie" id="pieDisc"></div>` +
      `<div class="pie-legend" id="pieLegend"></div>` +
      `<div class="pie-cap" id="pieCap"></div>` +
    `</div>`;
  rebalDaily = new Map(r.comp.map(c => [c.time, c]));
  rebalEnd = r.comp[r.comp.length - 1];
  showDay(rebalEnd, true);   // 預設顯示期末；滑鼠移到某天會改成「到那天為止」的數字
}

// ── 0050 風控波段策略（移植 stock_0050_backtest.py）──
// 大盤濾網(0050 收盤 > MA60 才進場) × 5% 風險倉位(每股風險 2·ATR) × +2R 減半獲利 + 2.5·ATR 移動停損
// 含交易手續費(買賣各收 0.1425%) + 證交稅(賣出 0.3%)，與 50/50、葛蘭碧共用 FEE_RATE/TAX_RATE/INIT_CASH 同基準
const ATR_PERIOD = 14, RISK_PCT = 0.05;

// 平均真實波幅 ATR(14)：TR = max(高-低, |高-昨收|, |低-昨收|)，再取 14 日均值（對應 .py 的 rolling(14).mean()）
function computeATR(rows, period = ATR_PERIOD) {
  const n = rows.length, tr = new Array(n).fill(null), atr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const h = rows[i].high, l = rows[i].low;
    if (h == null || l == null) continue;
    if (i === 0) { tr[i] = h - l; continue; }   // 首日無昨收 → 僅 高-低（同 pandas concat max 忽略 NaN）
    const pc = rows[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += tr[i] || 0;
    if (i >= period) sum -= tr[i - period] || 0;
    if (i >= period - 1) atr[i] = sum / period;   // 不足 14 天 → null
  }
  return atr;
}

// ATR 跟 rows 走（與可視範圍無關）→ 換股票才重算，scroll/縮放沿用快取
let _atrRowsRef = null, _atrArr = null;
function atrCached() {
  if (_atrRowsRef === rows && _atrArr) return _atrArr;
  _atrArr = computeATR(rows); _atrRowsRef = rows;
  return _atrArr;
}

// 大盤濾網：以 0050 當日「收盤 > MA60」視為多頭（移植 .py 的 build_market_regime_filter）。
// 非同步載入一次後快取；未就緒前 update05 視為不過濾（同 .py 找不到日期時 default True）。
let _market0050 = null;   // Map<dateStr, boolean>
function loadMarketFilter() {
  fetch(`data/0050.json?v=${Date.now()}`).then(r => r.json()).then(data => {
    const m = new Map();
    for (const r of data.rows) m.set(r.time, r.ma60 != null ? r.close > r.ma60 : false);
    _market0050 = m;
    update05();                                 // 濾網就緒後重算一次，補上進場過濾
  }).catch(() => { _market0050 = new Map(); });
}

// 回測模擬：逐日跑「大盤濾網 × 5%風險 × 2R 分批 × ATR 移動停損」；含手續費(買賣)+證交稅(賣)
function simulate0050(slice, atrSlice, market) {
  if (!slice || slice.length < 2) return null;
  const INIT = INIT_CASH;
  let cash = INIT, shares = 0, inPos = false;
  let entry = 0, stopLoss = 0, target2R = 0, highest = 0, scaledHalf = false;
  let fee = 0, tax = 0, buyCount = 0, sellCount = 0, totalTrades = 0, winTrades = 0;
  const trades = [], equity = [];
  for (let i = 1; i < slice.length; i++) {
    const row = slice[i], prev = slice[i - 1];
    const close = row.close, high = row.high, time = row.time;
    const ma20 = row.ma20, ma60 = row.ma60, atr = atrSlice[i];
    if (ma20 == null || ma60 == null || atr == null) continue;   // 暖機不足 → 跳過（不計入資產曲線，同 .py continue）
    const isBull = market ? (market.get(time) !== false) : true;  // 濾網未就緒或查無當日 → 預設多頭

    if (!inPos) {
      // 進場：昨收 ≤ 昨 MA20 且 今收 > 今 MA20（向上突破），且大盤多頭
      const breakout = prev.ma20 != null && prev.close <= prev.ma20 && close > ma20;
      if (isBull && breakout) {
        const riskPerShare = 2 * atr;                              // 每股風險 = 2·ATR
        if (riskPerShare <= 0) continue;
        let qty = Math.floor((cash * RISK_PCT) / riskPerShare);    // 5% 風險倉位反推股數
        while (qty * close * (1 + FEE_RATE) > cash) qty -= 100;    // 現金不足則逐步減 100 股
        if (qty > 0) {
          const cost = qty * close, f = cost * FEE_RATE;
          cash -= cost + f; fee += f; shares = qty;
          entry = close; highest = close;
          stopLoss = entry - riskPerShare;                         // 初始停損 = 進場 − 2·ATR
          target2R = entry + 2 * riskPerShare;                     // 獲利目標 = 進場 + 2R
          scaledHalf = false; inPos = true;
          trades.push({ time, type: 'buy' }); buyCount++;
        }
      }
    } else {
      if (close > highest) highest = close;
      if (high >= target2R && !scaledHalf) {                       // 觸及 +2R → 減倉一半、停損上移到成本
        const sell = Math.floor(shares / 2);
        if (sell > 0) {
          const rev = sell * close, f = rev * FEE_RATE, t = rev * TAX_RATE;
          cash += rev - f - t; fee += f; tax += t;
          shares -= sell; scaledHalf = true; stopLoss = entry;
          trades.push({ time, type: 'sell' }); sellCount++;
        }
      }
      const stop = Math.max(stopLoss, highest - 2.5 * atr);        // 移動停損 = max(固定停損, 波段高點 − 2.5·ATR)
      if (close < stop) {                                          // 跌破 → 全數出場
        const rev = shares * close, f = rev * FEE_RATE, t = rev * TAX_RATE;
        cash += rev - f - t; fee += f; tax += t;
        const net = rev - shares * entry - shares * entry * FEE_RATE - f - t;
        trades.push({ time, type: 'sell' }); sellCount++;
        totalTrades++; if (net > 0) winTrades++;
        shares = 0; inPos = false;
      }
    }
    equity.push(cash + shares * close);                            // 每日收盤後的總資產淨值（算 MDD 用）
  }
  if (inPos) {                                                     // 期末強制平倉
    const finClose = slice[slice.length - 1].close;
    const rev = shares * finClose, f = rev * FEE_RATE, t = rev * TAX_RATE;
    cash += rev - f - t; fee += f; tax += t;
    const net = rev - shares * entry - shares * entry * FEE_RATE - f - t;
    trades.push({ time: slice[slice.length - 1].time, type: 'sell' }); sellCount++;
    totalTrades++; if (net > 0) winTrades++;
    if (equity.length) equity[equity.length - 1] = cash;          // 最後一天淨值更新為平倉後現金
    shares = 0; inPos = false;
  }
  let peak = -Infinity, maxDD = 0;
  for (const e of equity) { if (e > peak) peak = e; if (peak > 0 && (e - peak) / peak < maxDD) maxDD = (e - peak) / peak; }
  return { start: slice[0].time, end: slice[slice.length - 1].time, days: slice.length,
           fin: cash, ret: (cash - INIT) / INIT * 100, maxDD: maxDD * 100,
           fee, tax, cost: fee + tax, trades, buyCount, sellCount,
           totalTrades, winRate: totalTrades > 0 ? winTrades / totalTrades * 100 : 0 };
}

const bt05El = document.getElementById('bt05');

function update05() {
  if (!bt05El || !rows.length) return;
  let from, to;
  if (lockCb && lockCb.checked && startEl.value && endEl.value) {
    from = findStartIdx(startEl.value); to = findEndIdx(endEl.value);
    if (from > to) [from, to] = [to, from];
  } else {
    const vr = chart.timeScale().getVisibleLogicalRange();
    if (!vr) return;
    from = Math.max(0, Math.ceil(vr.from));
    to = Math.min(rows.length - 1, Math.floor(vr.to));
  }
  if (to - from < 1) {
    setStrategyTrades('bt05', []);
    bt05El.innerHTML = '<div class="rb-hd">0050 風控波段策略</div><div class="rb-note">可視範圍太小，請拉大圖表範圍</div>';
    return;
  }
  const atrFull = atrCached();
  const r = simulate0050(rows.slice(from, to + 1), atrFull.slice(from, to + 1), _market0050);
  if (!r) {
    setStrategyTrades('bt05', []);
    bt05El.innerHTML = '<div class="rb-hd">0050 風控波段策略</div><div class="rb-note">可視範圍太小，請拉大圖表範圍</div>';
    return;
  }
  setStrategyTrades('bt05', r.trades);
  const mk = _market0050 ? '0050 收盤 &gt; MA60' : '尚未載入·暫不過濾';
  bt05El.innerHTML =
    `<div class="rb-main">` +
      `<div class="rb-hd">0050 風控波段策略（${curName}）· 交易點 <span class="up">▲買</span> / <span class="down">▼賣</span></div>` +
      `<div class="rb-sub">期間 ${r.start} ~ ${r.end}（${r.days} 個交易日）· 初始金額 ${money(INIT_CASH)} · 大盤濾網：${mk} 才進場</div>` +
      `<div class="rb-grid">` +
        `<div><span class="rb-lbl">最終總金額</span><b>${money(r.fin)}</b></div>` +
        `<div><span class="rb-lbl">報酬率</span><b class="${r.ret >= 0 ? 'up' : 'down'}">${(r.ret >= 0 ? '+' : '') + r.ret.toFixed(2)}%</b></div>` +
        `<div><span class="rb-lbl">最大回撤</span><b class="down">${r.maxDD.toFixed(2)}%</b></div>` +
        `<div><span class="rb-lbl">交易次數</span><b>${r.totalTrades}</b></div>` +
        `<div><span class="rb-lbl">勝率</span><b>${r.winRate.toFixed(2)}%</b></div>` +
        `<div><span class="rb-lbl">交易成本</span><b>${money(r.cost)}</b></div>` +
      `</div>` +
      `<div class="rb-cost">交易手續費 <b>${money(r.fee)}</b>（0.1425%·買賣各收）　＋　證交稅 <b>${money(r.tax)}</b>（0.3%·賣出收）　·　5% 風險倉位、2·ATR 停損、+2R 減半、2.5·ATR 移動停損</div>` +
    `</div>`;
}

// 鎖定時把可視範圍夾在 [起,迄] 之間：拖出去就拉回來（保持寬度），裡面仍可縮放看細節
function clampToLock(vr) {
  if (!vr || !rows.length || !startEl.value || !endEl.value) return;
  let f = findStartIdx(startEl.value), t = findEndIdx(endEl.value);
  if (f > t) [f, t] = [t, f];
  const EPS = 0.01, width = vr.to - vr.from;
  let nf = vr.from, nt = vr.to;
  if (nf < f - EPS) { nf = f; nt = f + width; }    // 拖過左界 → 整段往右貼齊
  if (nt > t + EPS) { nt = t; nf = t - width; }     // 拖過右界 → 整段往左貼齊
  if (nf < f) nf = f;                               // 視窗比鎖定區還寬 → 貼齊整段
  if (Math.abs(nf - vr.from) > EPS || Math.abs(nt - vr.to) > EPS)
    chart.timeScale().setVisibleLogicalRange({ from: nf, to: nt });
}

chart.timeScale().subscribeVisibleLogicalRangeChange((vr) => {
  if (lockCb && lockCb.checked) { clampToLock(vr); return; }   // 鎖定：只夾範圍、不重算回測
  updateRebal();
  update05();
  updateGranville();
});

// 勾「固定回測區間」→ 以目前可視範圍的起迄日當預設，並鎖定（之後可微調日期框）
if (lockCb) {
  lockCb.addEventListener('change', () => {
    const on = lockCb.checked;
    startEl.disabled = endEl.disabled = !on;
    if (on && rows.length) {
      const vr = chart.timeScale().getVisibleLogicalRange();
      if (vr) {
        const f = Math.max(0, Math.ceil(vr.from)), t = Math.min(rows.length - 1, Math.floor(vr.to));
        startEl.value = rows[f].time;              // 凍結「目前畫面」的起迄
        endEl.value = rows[t].time;
        chart.timeScale().setVisibleLogicalRange({ from: f, to: t });   // 貼齊鎖定範圍
      }
    }
    updateRebal();
    update05();
    updateGranville();
  });
  // 鎖定狀態下手動改日期 → 同步把上方圖表縮放到該日期範圍（updateRebal 也跟著重算）
  function syncChartToDates() {
    if (!rows.length || !startEl.value || !endEl.value) return;
    let f = findStartIdx(startEl.value), t = findEndIdx(endEl.value);
    if (f > t) [f, t] = [t, f];
    chart.timeScale().setVisibleLogicalRange({ from: f, to: t });   // 精準對齊所選起迄，不多留前一天
    updateRebal();
    update05();
    updateGranville();
  }
  startEl.addEventListener('change', syncChartToDates);
  endEl.addEventListener('change', syncChartToDates);
}

// ── 葛蘭碧八大法則策略 ──

// 複製 sp_CalculateTrend 邏輯：依指定 MA 欄位動態計算趨勢，不使用 JSON 內建的 MA5 固定趨勢
function computeTrendDynamic(rows, maKey, lookback = 5, threshold = 3) {
  const n = rows.length;
  const isUp = new Array(n).fill(0), isDown = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const cur = rows[i][maKey], prev = rows[i - 1][maKey];
    if (cur != null && prev != null) {
      if (cur > prev) isUp[i] = 1;
      else if (cur < prev) isDown[i] = 1;
    }
  }
  const trend = new Array(n).fill('F');
  for (let i = 0; i < n; i++) {
    let up = 0, down = 0;
    for (let j = Math.max(0, i - lookback + 1); j <= i; j++) { up += isUp[j]; down += isDown[j]; }
    if (up >= threshold) trend[i] = 'U';
    else if (down >= threshold) trend[i] = 'D';
  }
  return trend;
}

// 完整實作 sp_GranvilleEightRules 的十個訊號（法則 1-8、44、88）
function computeGranvilleSignals(rows, trendArr, params) {
  const { maKey, toleranceDays, devLow, devHigh, daysThreshold, priceRange } = params;
  const n = rows.length;
  const signals = [];
  const dev = rows.map(r => (r[maKey] != null && r[maKey] !== 0) ? (r.close - r[maKey]) / r[maKey] * 100 : null);

  for (let i = 1; i < n; i++) {
    const r = rows[i], p = rows[i - 1];
    const ma = r[maKey], pma = p[maKey];
    const tr = trendArr[i], ptr = trendArr[i - 1];
    if (ma == null || pma == null) continue;

    // 成交量倍數（20日均量）
    let sumV = 0, cntV = 0;
    for (let j = Math.max(0, i - 19); j <= i; j++) { if (rows[j].volume) { sumV += rows[j].volume; cntV++; } }
    const avgV = cntV > 0 ? sumV / cntV : null;
    const sv = avgV > 0 && r.volume != null && r.volume / avgV >= 1.5;

    // 前 7 天在 MA 上方/下方的天數（對應 SQL ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING）
    let dAbove = 0, dUnder = 0;
    for (let j = Math.max(0, i - 7); j < i; j++) {
      if (rows[j][maKey] != null) {
        if (rows[j].close > rows[j][maKey]) dAbove++;
        else if (rows[j].close < rows[j][maKey]) dUnder++;
      }
    }

    // 法則 1（買）：趨勢由下跌轉上漲
    if (ptr === 'D' && tr === 'U')
      signals.push({ time: r.time, type: 'buy', rule: 1, strength: sv ? '強勢買入訊號(突破)' : '一般訊號' });

    // 法則 5（賣）：趨勢由上漲轉下跌
    if (ptr === 'U' && tr === 'D')
      signals.push({ time: r.time, type: 'sell', rule: 5, strength: sv ? '強勢賣出訊號(跌破)' : '一般訊號' });

    // 穿越均線判斷
    const downCross = p.close > pma && r.close < ma;
    const upCross   = p.close < pma && r.close > ma;
    if (downCross || upCross) {
      // 取容忍天數內的最後一天（對應 SQL TOP 1 ... ORDER BY RowNum DESC）
      const tk = Math.min(n - 1, i + toleranceDays);
      const fClose = rows[tk].close, fMa = rows[tk][maKey];
      // 法則 2（買）：假跌破，在容忍天數內站回均線上方
      if (downCross && tr === 'U' && fMa != null && fClose > fMa && dAbove >= daysThreshold)
        signals.push({ time: r.time, type: 'buy', rule: 2, strength: sv ? '強勢買入訊號(假跌破)' : '一般訊號' });
      // 法則 6（賣）：假突破，在容忍天數內跌回均線下方
      if (upCross && tr === 'D' && fMa != null && fClose < fMa && dUnder >= daysThreshold)
        signals.push({ time: r.time, type: 'sell', rule: 6, strength: sv ? '強勢賣出訊號(假突破)' : '一般訊號' });
    }

    // 法則 3（買）：上漲趨勢 + 前日收黑接近均線後今日收紅反彈（支撐）
    if (tr === 'U' && p.close < p.open && r.close > r.open && r.close > p.close &&
        ((p.low - pma <= priceRange && p.low - pma >= 0) ||
         (p.close - pma <= priceRange && p.close - pma >= 0)))
      signals.push({ time: r.time, type: 'buy', rule: 3, strength: sv ? '強支撐反彈買入' : '一般訊號' });

    // 法則 7（賣）：下跌趨勢 + 前日收紅接近均線後今日收黑（反壓）
    if (tr === 'D' && p.close > p.open && r.close < r.open && r.close < p.close &&
        ((pma - p.high <= priceRange && p.high <= pma) ||
         (pma - p.close <= priceRange && p.close <= pma)))
      signals.push({ time: r.time, type: 'sell', rule: 7, strength: sv ? '強反壓力道賣出' : '一般訊號' });

    // 法則 4 & 44（買）：下跌趨勢 + 負乖離
    const d = dev[i], pd = dev[i - 1];
    if (tr === 'D' && d != null && d < 0) {
      if (pd != null && d > pd && pd <= devLow)
        signals.push({ time: r.time, type: 'buy', rule: 44, strength: '抄底反彈-負乖離率開始縮小' });
      else if (d <= devLow)
        signals.push({ time: r.time, type: 'buy', rule: 4, strength: d <= devLow * 1.5 ? '抄底機會!!' : '一般訊號' });
    }

    // 法則 8 & 88（賣）：上漲趨勢 + 正乖離
    if (tr === 'U' && d != null && d > 0) {
      if (pd != null && d < pd && pd >= devHigh)
        signals.push({ time: r.time, type: 'sell', rule: 88, strength: '正乖離開始縮小' });
      else if (d >= devHigh)
        signals.push({ time: r.time, type: 'sell', rule: 8, strength: d >= devHigh * 1.5 ? '超買回檔賣出(反轉)' : '一般訊號' });
    }
  }
  return signals;
}

// 回測模擬（參照 stock_granville_backtest.py 的部位比例設計）；含交易手續費 + 證交稅，與 50/50 同基準
function simulateGranvilleBacktest(slice, signals) {
  if (!slice || slice.length < 2 || !signals.length) return null;
  const INIT = INIT_CASH;
  const buyR  = { 1: 1.0, 2: 0.8, 44: 0.6, 3: 0.5, 4: 0.3 };
  const sellR = { 5: 1.0, 6: 0.8, 88: 0.6, 7: 0.5, 8: 0.3 };
  let cash = INIT, shares = 0, fee = 0, tax = 0, peak = -Infinity, maxDD = 0;
  const trades = [];
  const sigMap = new Map();
  for (const s of signals) { if (!sigMap.has(s.time)) sigMap.set(s.time, []); sigMap.get(s.time).push(s); }
  for (const r of slice) {
    for (const s of (sigMap.get(r.time) || [])) {
      if (s.type === 'buy') {
        const budget = cash * (buyR[s.rule] ?? 0.5);
        const n = Math.floor(budget / (r.close * (1 + FEE_RATE)));   // 預留手續費，確保現金夠付
        if (n <= 0) continue;
        const cost = n * r.close, f = cost * FEE_RATE;
        cash -= cost + f; shares += n; fee += f;
        trades.push({ time: r.time, type: 'buy' });
      } else if (s.type === 'sell' && shares > 0) {
        const n = Math.max(1, Math.floor(shares * (sellR[s.rule] ?? 0.5)));
        const proceeds = n * r.close, f = proceeds * FEE_RATE, t = proceeds * TAX_RATE;
        cash += proceeds - f - t; shares -= n; fee += f; tax += t;
        trades.push({ time: r.time, type: 'sell' });
      }
    }
    const eq = cash + shares * r.close;
    if (eq > peak) peak = eq;
    if (peak > 0 && (eq - peak) / peak < maxDD) maxDD = (eq - peak) / peak;
  }
  const fin = cash + shares * slice[slice.length - 1].close;
  return { start: slice[0].time, end: slice[slice.length - 1].time, days: slice.length,
           fin, ret: (fin - INIT) / INIT * 100, maxDD: maxDD * 100, trades,
           fee, tax, cost: fee + tax,
           buyCount: trades.filter(t => t.type === 'buy').length,
           sellCount: trades.filter(t => t.type === 'sell').length };
}

function getGranParams() {
  return {
    maKey:        document.getElementById('gran-ma')?.value     || 'ma20',
    toleranceDays:parseInt(document.getElementById('gran-tol')?.value   || '5'),
    devLow:       parseFloat(document.getElementById('gran-dev-lo')?.value || '-15'),
    devHigh:      parseFloat(document.getElementById('gran-dev-hi')?.value || '15'),
    daysThreshold: 6,
    priceRange:   30.0,
  };
}

const GRAN_RULE = { 1:'法則1', 2:'法則2', 3:'法則3', 4:'法則4', 44:'法則44',
                    5:'法則5', 6:'法則6', 7:'法則7', 8:'法則8', 88:'法則88' };

// 葛蘭碧訊號只跟 rows + 參數有關（與可視範圍無關）→ 快取，scroll/縮放時不再重算全表
let _granRowsRef = null, _granParamsKey = '', _granAllSigs = null;
function granvilleSignalsCached(params) {
  const pk = `${params.maKey}|${params.toleranceDays}|${params.devLow}|${params.devHigh}|${params.daysThreshold}|${params.priceRange}`;
  if (_granRowsRef === rows && _granParamsKey === pk && _granAllSigs) return _granAllSigs;   // 命中快取
  const trendArr = computeTrendDynamic(rows, params.maKey);
  _granAllSigs = computeGranvilleSignals(rows, trendArr, params);
  _granRowsRef = rows; _granParamsKey = pk;   // 換股票(rows 換新陣列)或改參數時才會失效重算
  return _granAllSigs;
}

function updateGranville() {
  const granEl = document.getElementById('gran');
  if (!granEl || !rows.length) return;
  let from, to;
  if (lockCb && lockCb.checked && startEl.value && endEl.value) {
    from = findStartIdx(startEl.value); to = findEndIdx(endEl.value);
    if (from > to) [from, to] = [to, from];
  } else {
    const vr = chart.timeScale().getVisibleLogicalRange();
    if (!vr) return;
    from = Math.max(0, Math.ceil(vr.from));
    to   = Math.min(rows.length - 1, Math.floor(vr.to));
  }
  if (to - from < 1) {
    setStrategyTrades('gran', []);
    granEl.innerHTML = '<div class="rb-hd">葛蘭碧八大法則</div><div class="rb-note">可視範圍太小，請拉大圖表範圍</div>';
    return;
  }
  const params = getGranParams();
  const allSigs   = granvilleSignalsCached(params);
  const sliceSet  = new Set(rows.slice(from, to + 1).map(r => r.time));
  const signals   = allSigs.filter(s => sliceSet.has(s.time));
  setStrategyTrades('gran', signals.map(s => ({ time: s.time, type: s.type })));
  const r = simulateGranvilleBacktest(rows.slice(from, to + 1), signals);
  const maLbl = params.maKey.toUpperCase();
  if (!r) {
    granEl.innerHTML =
      `<div class="rb-hd">葛蘭碧八大法則（${maLbl}）</div>` +
      `<div class="rb-note">回測期間無訊號</div>`;
  } else {
    const cnt = {};
    for (const s of signals) cnt[s.rule] = (cnt[s.rule] || 0) + 1;
    granEl.innerHTML =
      `<div class="rb-main">` +
        `<div class="rb-hd">葛蘭碧八大法則（${maLbl}）· 交易點 <span class="up">▲買</span> / <span class="down">▼賣</span></div>` +
        `<div class="rb-sub">期間 ${r.start} ~ ${r.end}（${r.days} 個交易日）· 初始金額 ${money(10000000)} · 共 ${signals.length} 個訊號</div>` +
        `<div class="rb-grid">` +
          `<div><span class="rb-lbl">最終總金額</span><b>${money(r.fin)}</b></div>` +
          `<div><span class="rb-lbl">報酬率</span><b class="${r.ret >= 0 ? 'up' : 'down'}">${(r.ret >= 0 ? '+' : '') + r.ret.toFixed(2)}%</b></div>` +
          `<div><span class="rb-lbl">最大回撤</span><b class="down">${r.maxDD.toFixed(2)}%</b></div>` +
          `<div><span class="rb-lbl">買入訊號</span><b>${r.buyCount}</b></div>` +
          `<div><span class="rb-lbl">賣出訊號</span><b>${r.sellCount}</b></div>` +
          `<div><span class="rb-lbl">交易成本</span><b>${money(r.cost)}</b></div>` +
        `</div>` +
        `<div class="rb-cost">交易手續費 <b>${money(r.fee)}</b>（0.1425%·買賣各收）　＋　證交稅 <b>${money(r.tax)}</b>（0.3%·賣出收）　·　以收盤價模擬、現金不計息</div>` +
        `<div class="gran-rules">${Object.entries(cnt).sort(([a],[b])=>+a-+b).map(([rule,n])=>`<span class="gran-tag">${GRAN_RULE[rule]||'法則'+rule} ×${n}</span>`).join('')}</div>` +
      `</div>`;
  }
}

// ── 葛蘭碧最佳參數搜尋（訊號移植 find_parameter02.py，按鈕觸發、不隨縮放被動更新）──
// 全進全出：法則1/2/4 買、5/8 賣；MA 在「目前區間」內滾動計算；含交易手續費(買賣)+證交稅(賣)
function runGranvilleOptBacktest(slice, maWindow, devLow, devHigh) {
  const closes = slice.map(r => r.close);
  const n = closes.length;
  const MA = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i];
    if (i >= maWindow) sum -= closes[i - maWindow];
    if (i >= maWindow - 1) MA[i] = sum / maWindow;        // 不足 maWindow 天 → null（對應 pandas NaN）
  }
  let cash = INIT_CASH, shares = 0, fee = 0, tax = 0, peak = -Infinity, maxDD = 0;
  const trades = [];                                      // 記錄買/賣點（供圖表標記用）
  for (let i = 0; i < n; i++) {
    const price = closes[i];
    const ma = MA[i], pma = i > 0 ? MA[i - 1] : null;
    const trend = (ma != null && pma != null && ma > pma) ? 1 : -1;
    const ptrend = i > 0 ? ((MA[i - 1] != null && MA[i - 2] != null && MA[i - 1] > MA[i - 2]) ? 1 : -1) : 0;
    const dev = (ma != null && ma !== 0) ? (price - ma) / ma * 100 : null;
    const aboveMA = ma != null && price > ma, belowMA = ma != null && price < ma;
    const buy  = (trend === 1 && ptrend === -1 && aboveMA) ||                       // 法則1
                 (trend === 1 && pma != null && closes[i - 1] < pma && aboveMA) ||  // 法則2
                 (trend === -1 && dev != null && dev <= devLow);                    // 法則4
    const sell = (trend === -1 && ptrend === 1 && belowMA) ||                       // 法則5
                 (trend === 1 && dev != null && dev >= devHigh);                    // 法則8
    let target = null;                                     // 目標部位（ffill 語意）
    if (buy) target = 1;
    if (sell) target = 0;                                  // 賣出優先（對應 .py 先設買=1 再設賣=0）
    if (target === 1 && shares === 0) {                    // 空手 → 全進（預留手續費）
      const q = Math.floor(cash / (price * (1 + FEE_RATE)));
      if (q > 0) { const cost = q * price, f = cost * FEE_RATE; cash -= cost + f; shares = q; fee += f;
        trades.push({ time: slice[i].time, type: 'buy' }); }
    } else if (target === 0 && shares > 0) {               // 持有 → 全出（手續費 + 證交稅）
      const proceeds = shares * price, f = proceeds * FEE_RATE, t = proceeds * TAX_RATE;
      cash += proceeds - f - t; fee += f; tax += t; shares = 0;
      trades.push({ time: slice[i].time, type: 'sell' });
    }
    const eq = cash + shares * price;
    if (eq > peak) peak = eq;
    if (peak > 0 && (eq - peak) / peak < maxDD) maxDD = (eq - peak) / peak;
  }
  const fin = cash + shares * closes[n - 1];
  return { ret: (fin - INIT_CASH) / INIT_CASH, maxDD: maxDD * 100, fin, fee, tax, trades };
}

// 對「目前區間」逐一試算全部參數組合，回傳依報酬由高到低排序的結果
function optimizeGranville(slice) {
  const maWindows = [20, 60], devLows = [-5, -10, -15, -20], devHighs = [5, 10, 15, 20];
  const results = [];
  for (const ma of maWindows)
    for (const dl of devLows)
      for (const dh of devHighs)
        results.push({ ma, devLow: dl, devHigh: dh, ...runGranvilleOptBacktest(slice, ma, dl, dh) });
  results.sort((a, b) => b.ret - a.ret);
  return results;
}

const granOptEl = document.getElementById('gran-opt');

function resetGranOpt() {           // 切股票時清空（避免顯示上一檔的結果）；不自動重算
  if (granOptEl) granOptEl.innerHTML =
    '<div class="rb-hd">葛蘭碧最佳參數搜尋</div><div class="rb-note">按上方按鈕，計算「目前圖表範圍」報酬最高的參數組合</div>';
  setStrategyTrades('granopt', []);   // 清掉舊的最佳組合買賣點標記
}

function runGranvilleOpt() {        // 按鈕觸發
  if (!granOptEl || !rows.length) return;
  let from, to;
  if (lockCb && lockCb.checked && startEl.value && endEl.value) {
    from = findStartIdx(startEl.value); to = findEndIdx(endEl.value);
    if (from > to) [from, to] = [to, from];
  } else {
    const vr = chart.timeScale().getVisibleLogicalRange();
    if (!vr) return;
    from = Math.max(0, Math.ceil(vr.from));
    to   = Math.min(rows.length - 1, Math.floor(vr.to));
  }
  const slice = rows.slice(from, to + 1);
  if (slice.length < 2) {
    setStrategyTrades('granopt', []);
    granOptEl.innerHTML = '<div class="rb-hd">葛蘭碧最佳參數搜尋</div><div class="rb-note">可視範圍太小，請拉大圖表範圍</div>';
    return;
  }
  const results = optimizeGranville(slice);
  const best = results[0];
  setStrategyTrades('granopt', best.trades);   // 把最佳組合的買賣點餵給圖表（選到插槽才會顯示）
  const fmtPct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
  granOptEl.innerHTML =
    `<div class="rb-main">` +
      `<div class="rb-hd">葛蘭碧最佳參數搜尋（${curName}）· 全進全出</div>` +
      `<div class="rb-sub">期間 ${slice[0].time} ~ ${slice[slice.length - 1].time}（${slice.length} 個交易日）· 初始金額 ${money(INIT_CASH)} · 共試 ${results.length} 組</div>` +
      `<div class="rb-grid">` +
        `<div><span class="rb-lbl">最終總資產</span><b>${money(best.fin)}</b></div>` +
        `<div><span class="rb-lbl">總報酬</span><b class="${best.ret >= 0 ? 'up' : 'down'}">${fmtPct(best.ret)}</b></div>` +
        `<div><span class="rb-lbl">最大回撤</span><b class="down">${best.maxDD.toFixed(2)}%</b></div>` +
        `<div><span class="rb-lbl">最佳均線</span><b>MA${best.ma}</b></div>` +
        `<div><span class="rb-lbl">負乖離買</span><b>${best.devLow}%</b></div>` +
        `<div><span class="rb-lbl">正乖離賣</span><b>+${best.devHigh}%</b></div>` +
      `</div>` +
      `<div class="rb-cost">交易手續費 <b>${money(best.fee)}</b>（0.1425%·買賣各收）　＋　證交稅 <b>${money(best.tax)}</b>（0.3%·賣出收）　·　以收盤價、全進全出模擬</div>` +
    `</div>`;
}

// 自訂買賣箭頭（lightweight-charts primitive）：內建 marker 的 size 會連寬一起放大，
// 改用 primitive 自畫一個「原本大小、指向當天 K 線」的精簡箭頭三角，並可調離 K 線的高度。
const ARROW_HW = 5;      // 箭頭半寬(px)
const ARROW_HH = 9;      // 箭頭高(px)
const ARROW_GAP = 16;    // 箭尖與 K 線高/低點的間距(px) — 想更高就調大

class TradeArrowsRenderer {
  constructor(src) { this._src = src; }
  draw(target) {
    const s = this._src;
    if (!s._chart || !s._series || !s._items.length) return;
    const ts = s._chart.timeScale();
    target.useMediaCoordinateSpace(scope => {
      const ctx = scope.context;
      ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
      for (const it of s._items) {
        const x = ts.timeToCoordinate(it.time);
        const yRef = s._series.priceToCoordinate(it.price);
        if (x == null || yRef == null) continue;
        const above = it.dir === 'down';               // 上方組：在高點上方、箭頭朝下
        const tip = above ? yRef - ARROW_GAP : yRef + ARROW_GAP;   // 箭尖（靠近 K 線那端）
        const base = above ? tip - ARROW_HH : tip + ARROW_HH;      // 箭尾兩角
        ctx.fillStyle = it.color;
        ctx.beginPath();
        ctx.moveTo(x, tip);
        ctx.lineTo(x - ARROW_HW, base);
        ctx.lineTo(x + ARROW_HW, base);
        ctx.closePath(); ctx.fill();
        ctx.textBaseline = above ? 'bottom' : 'top';   // 買/賣 標在箭尾外側
        ctx.fillText(it.text, x, base + (above ? -2 : 2));
      }
    });
  }
}
class TradeArrows {                 // ISeriesPrimitive
  constructor() { this._items = []; this._chart = null; this._series = null; this._req = null;
    this._view = { renderer: () => new TradeArrowsRenderer(this), zOrder: () => 'top' }; }
  setItems(items) { this._items = items; if (this._req) this._req(); }
  attached(p) { this._chart = p.chart; this._series = p.series; this._req = p.requestUpdate; }
  detached() { this._chart = this._series = this._req = null; }
  updateAllViews() {}
  paneViews() { return [this._view]; }
}
const tradeArrows = new TradeArrows();
candle.attachPrimitive(tradeArrows);

function refreshMarkers() {     // 依插槽設定產生箭頭（插槽0在 K 線上方朝下、插槽1在下方朝上）
  const items = [];
  stratSlots.forEach((id, slot) => {
    if (!id) return;
    const down = slot === 0;
    for (const t of (stratTrades[id] || [])) {
      const r = rows[rowMap.get(t.time)];
      if (!r) continue;
      items.push({ time: t.time, dir: down ? 'down' : 'up',
        price: down ? r.high : r.low,            // 上方箭頭貼最高價、下方箭頭貼最低價
        color: t.type === 'buy' ? '#d50000' : '#00897b',
        text: t.type === 'buy' ? '買' : '賣' });
    }
  });
  tradeArrows.setItems(items);
}

async function loadStock(code, name) {
  const data = await (await fetch(`data/${code}.json?v=${Date.now()}`)).json();
  rows = data.rows;
  rowMap = new Map();
  rows.forEach((r, i) => rowMap.set(r.time, i));
  curName = name;

  candle.setData(rows.map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close })));
  for (const k of ['ma5', 'ma20', 'ma60', 'ma120', 'ma240'])
    ma[k].setData(rows.filter(r => r[k] != null).map(r => ({ time: r.time, value: r[k] })));
  const bb = bollinger(rows, 20, 2);
  bbUpper.setData(bb.up);
  bbLower.setData(bb.lo);
  if (startEl && rows.length) {                    // 固定區間的日期選擇限制在這檔資料範圍內
    const lo = rows[0].time, hi = rows[rows.length - 1].time;
    startEl.min = endEl.min = lo; startEl.max = endEl.max = hi;
  }
  vol.setData(rows.map(r => ({
    time: r.time, value: r.volume || 0,
    color: (r.close >= r.open) ? 'rgba(213,0,0,.35)' : 'rgba(0,137,123,.35)',
  })));
  // 預設只顯示最近約 120 個交易日 → 畫面外仍有歷史，可往左拖曳捲動（雙擊圖表看全部）
  const n = rows.length, N = 120;
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - N), to: n + 2 });

  const last = rows[rows.length - 1], prev = rows[rows.length - 2] || last;
  const chg = prev.close ? ((last.close - prev.close) / prev.close * 100) : 0;
  const cls = chg >= 0 ? 'up' : 'down', sign = chg >= 0 ? '▲' : '▼';
  statEl.innerHTML = `${name} <b>${last.close}</b> <span class="${cls}">${sign}${Math.abs(chg).toFixed(2)}%</span> <small>(${last.time})</small>`;
  updateLegend(rows.length - 1);   // 預設先顯示最新一天，滑鼠移到某天再更新
  buildYears();                    // 建立年份快捷列（只建一次）
  setActiveYearBtn(null);          // 切股票回到近 120 天，清除年份高亮
  updateRebal();                   // 依目前可視範圍重算 50/50 再平衡
  update05();                      // 依目前可視範圍重算 0050 風控波段策略
  updateGranville();               // 依目前可視範圍重算葛蘭碧策略
  resetGranOpt();                  // 最佳參數搜尋：切股票清空、等按鈕觸發（不被動更新）
}

document.querySelectorAll('.ma-toggles input[data-ma]').forEach(cb => {
  cb.addEventListener('change', () => ma[cb.dataset.ma].applyOptions({ visible: cb.checked }));
});
const bbCb = document.getElementById('bb-toggle');
bbCb.addEventListener('change', () => {
  bbUpper.applyOptions({ visible: bbCb.checked });
  bbLower.applyOptions({ visible: bbCb.checked });
});
const volCb = document.getElementById('vol-toggle');
volCb.addEventListener('change', () => vol.applyOptions({ visible: volCb.checked }));

['gran-ma', 'gran-tol', 'gran-dev-lo', 'gran-dev-hi'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', updateGranville);
});

const granOptBtn = document.getElementById('gran-opt-run');
if (granOptBtn) granOptBtn.addEventListener('click', runGranvilleOpt);

// 初始化策略插槽下拉選單（未來新增策略只需呼叫 registerStrategy 即可自動出現在選單中）
(function initStrategySlots() {
  registerStrategy('rebal',  '50/50 再平衡');
  registerStrategy('bt05',    '0050 風控波段');
  registerStrategy('gran',    '葛蘭碧八大法則');
  registerStrategy('granopt', '葛蘭碧最佳參數');   // 按「計算最佳參數」後才有買賣點
  ['slot-top', 'slot-bot'].forEach((elId, slot) => {
    const sel = document.getElementById(elId);
    if (!sel) return;
    sel.addEventListener('change', () => {
      const chosen = sel.value || null;
      // 若兩個插槽選了同一策略，清空另一個
      const other = 1 - slot;
      if (chosen && chosen === stratSlots[other]) {
        stratSlots[other] = null;
        const otherSel = document.getElementById(slot === 0 ? 'slot-bot' : 'slot-top');
        if (otherSel) otherSel.value = '';
      }
      stratSlots[slot] = chosen;
      refreshMarkers();
    });
  });
})();

(async function init() {
  loadMarketFilter();   // 先非同步載入 0050 大盤濾網（就緒後自動重算 0050 風控波段策略）
  const idx = await (await fetch(`data/index.json?v=${Date.now()}`)).json();
  document.getElementById('updated').textContent =
    `資料日期 ${idx.stocks[0] ? idx.stocks[0].last_date : '—'}（每週一~五自動更新）`;

  for (const s of idx.stocks) {
    const o = document.createElement('option');
    o.value = s.code;
    o.textContent = `${s.code}　${s.name}`;
    o.dataset.name = s.name;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => loadStock(sel.value, sel.selectedOptions[0].dataset.name));

  const def = [...sel.options].find(o => o.value === '2330') || sel.options[0];
  if (def) { sel.value = def.value; loadStock(def.value, def.dataset.name); }
})();

// 自訂縮放把手：拖右下角 → 寬度左右對稱外擴、高度往下延伸；圖表 autoSize 自動重繪
(function () {
  const box = document.getElementById('chart-box');
  const grip = document.getElementById('grip');
  if (!box || !grip) return;
  let sx, sy, sw, sh;
  function move(e) {
    const dx = e.clientX - sx, dy = e.clientY - sy;
    const maxW = Math.round(window.innerWidth * 0.96);    // 最大可拉到接近整個視窗寬
    const w = Math.min(maxW, Math.max(320, sw + dx * 2)); // ×2：左右各擴 dx → 對稱外擴
    const h = Math.max(240, sh + dy);
    box.style.width = w + 'px';
    box.style.height = h + 'px';
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  }
  grip.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    sx = e.clientX; sy = e.clientY;
    sw = box.offsetWidth; sh = box.offsetHeight;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
})();
