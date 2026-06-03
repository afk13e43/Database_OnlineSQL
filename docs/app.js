// 小組共用股票資料庫 — 股價趨勢圖（lightweight-charts v4）
// 純前端：只讀同目錄 data/*.json，不含任何資料庫帳密。

const chartEl = document.getElementById('chart');
const chart = LightweightCharts.createChart(chartEl, {
  layout: { background: { color: '#ffffff' }, textColor: '#333' },
  grid: { vertLines: { color: '#f3f3f3' }, horzLines: { color: '#f3f3f3' } },
  rightPriceScale: { borderColor: '#ddd' },
  // minBarSpacing 預設 0.5px/根，2700+ 根會塞不下而砍掉左邊最舊資料（「全部」只到 2019）；調小即可完整顯示自 2015 起
  timeScale: { borderColor: '#ddd', minBarSpacing: 0.04 },
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
let rebalMarkers = [];

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
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, from - 1), to: to + 1 });
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
  disc.style.background = `conic-gradient(#1976d2 0 ${sp}%, #b0bec5 ${sp}% 100%)`;
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
    rebalMarkers = []; refreshMarkers();
    rebalDaily = null;
    rebalEl.innerHTML = '<div class="rb-hd">50/50 再平衡</div><div class="rb-note">可視範圍太小，請拉大圖表範圍</div>';
    return;
  }
  // 收集再平衡買/賣交易點（紅▲買、綠▼賣），與型態標記合併顯示
  rebalMarkers = r.trades.map(t => ({
    time: t.time,
    position: t.type === 'buy' ? 'belowBar' : 'aboveBar',
    color: t.type === 'buy' ? '#d50000' : '#00897b',
    shape: t.type === 'buy' ? 'arrowUp' : 'arrowDown',
    text: t.type === 'buy' ? '買' : '賣',
  }));
  refreshMarkers();
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

chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
  if (lockCb && lockCb.checked) return;            // 區間已鎖定，縮放/平移不重算回測
  updateRebal();
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
      }
    }
    updateRebal();
  });
  // 鎖定狀態下手動改日期 → 同步把上方圖表縮放到該日期範圍（updateRebal 也跟著重算）
  function syncChartToDates() {
    if (!rows.length || !startEl.value || !endEl.value) return;
    let f = findStartIdx(startEl.value), t = findEndIdx(endEl.value);
    if (f > t) [f, t] = [t, f];
    chart.timeScale().setVisibleLogicalRange({ from: f, to: t });   // 精準對齊所選起迄，不多留前一天
    updateRebal();
  }
  startEl.addEventListener('change', syncChartToDates);
  endEl.addEventListener('change', syncChartToDates);
}

function refreshMarkers() {     // 把再平衡買/賣交易點標到 K 線
  const m = rebalMarkers.slice();
  m.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  candle.setMarkers(m);
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
}

document.querySelectorAll('.ma-toggles input[data-ma]').forEach(cb => {
  cb.addEventListener('change', () => ma[cb.dataset.ma].applyOptions({ visible: cb.checked }));
});
const bbCb = document.getElementById('bb-toggle');
bbCb.addEventListener('change', () => {
  bbUpper.applyOptions({ visible: bbCb.checked });
  bbLower.applyOptions({ visible: bbCb.checked });
});

(async function init() {
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
