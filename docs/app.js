// 小組共用股票資料庫 — 股價趨勢圖（lightweight-charts v4）
// 純前端：只讀同目錄 data/*.json，不含任何資料庫帳密。

const chartEl = document.getElementById('chart');
const chart = LightweightCharts.createChart(chartEl, {
  layout: { background: { color: '#ffffff' }, textColor: '#333' },
  grid: { vertLines: { color: '#f3f3f3' }, horzLines: { color: '#f3f3f3' } },
  rightPriceScale: { borderColor: '#ddd' },
  timeScale: { borderColor: '#ddd' },
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
let rebalMarkers = [], wmMarkers = [], tripleMarkers = [];

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
    if (c) setPie(c.stock, c.cash, c === rebalEnd ? '期末 ' + rebalEnd.time : '當日 ' + c.time);
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
  const comp = [];                                   // 每日（收盤後、含當日再平衡）的股票/現金
  for (const r of slice) {
    const p = r.close, eq = cash + shares * p;
    if (Math.abs(shares * p / eq - RB_TARGET) >= RB_DRIFT) rebal(p, r.time);   // 摸到 ±5% 就再平衡
    comp.push({ time: r.time, stock: shares * p, cash });
    const eq2 = cash + shares * p;
    if (eq2 > peak) peak = eq2;
    if ((eq2 - peak) / peak < maxDD) maxDD = (eq2 - peak) / peak;
  }
  const lastClose = slice[slice.length - 1].close;
  const finStock = shares * lastClose, finCash = cash, fin = finStock + finCash;
  return { start: slice[0].time, end: slice[slice.length - 1].time, days: slice.length,
           fin, finStock, finCash, ret: (fin - INIT_CASH) / INIT_CASH * 100, maxDD: maxDD * 100,
           fee, tax, cost: fee + tax, trades, comp };
}

// 更新右側圓餅（股票:現金）；label 標示是哪一天
function setPie(stock, cash, label) {
  const disc = document.getElementById('pieDisc'), leg = document.getElementById('pieLegend'), cap = document.getElementById('pieCap');
  if (!disc || !leg) return;
  const tot = stock + cash, sp = tot > 0 ? stock / tot * 100 : 0, cp = 100 - sp;
  disc.style.background = `conic-gradient(#1976d2 0 ${sp}%, #b0bec5 ${sp}% 100%)`;
  leg.innerHTML =
    `<div><span class="dot stock"></span>股票 ${sp.toFixed(1)}%　${money(stock)}</div>` +
    `<div><span class="dot cash"></span>現金 ${cp.toFixed(1)}%　${money(cash)}</div>`;
  if (cap) cap.textContent = label;
}

function updateRebal() {
  if (!rebalEl || !rows.length) return;
  const vr = chart.timeScale().getVisibleLogicalRange();
  if (!vr) return;
  const from = Math.max(0, Math.ceil(vr.from)), to = Math.min(rows.length - 1, Math.floor(vr.to));
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
  const rc = r.ret >= 0 ? 'up' : 'down';
  rebalEl.innerHTML =
    `<div class="rb-main">` +
      `<div class="rb-hd">50/50 再平衡（${curName} : 現金）· 偏離 ±5% 自動再平衡</div>` +
      `<div class="rb-sub">期間 ${r.start} ~ ${r.end}（${r.days} 個交易日）· 初始金額 ${money(INIT_CASH)}　·　交易點 <span class="up">▲買</span> / <span class="down">▼賣</span></div>` +
      `<div class="rb-grid">` +
        `<div><span class="rb-lbl">最終總金額</span><b>${money(r.fin)}</b></div>` +
        `<div><span class="rb-lbl">報酬率</span><b class="${rc}">${r.ret >= 0 ? '+' : ''}${r.ret.toFixed(2)}%</b></div>` +
        `<div><span class="rb-lbl">最大回撤</span><b class="down">${r.maxDD.toFixed(2)}%</b></div>` +
        `<div><span class="rb-lbl">交易成本</span><b>${money(r.cost)}</b></div>` +
      `</div>` +
      `<div class="rb-cost">交易手續費 <b>${money(r.fee)}</b>（0.1425%·買賣各收）　＋　證交稅 <b>${money(r.tax)}</b>（0.3%·賣出收）　·　以收盤價模擬、現金不計息</div>` +
    `</div>` +
    `<div class="rb-pie">` +
      `<div class="pie" id="pieDisc"></div>` +
      `<div class="pie-legend" id="pieLegend"></div>` +
      `<div class="pie-cap" id="pieCap"></div>` +
    `</div>`;
  rebalDaily = new Map(r.comp.map(c => [c.time, c]));
  rebalEnd = r.comp[r.comp.length - 1];
  setPie(rebalEnd.stock, rebalEnd.cash, '期末 ' + rebalEnd.time);   // 預設顯示期末，滑鼠移到某天再變
}

chart.timeScale().subscribeVisibleLogicalRangeChange(updateRebal);

// ── hw12 型態：W底/M頭(5點視窗)、三重頂/底(7點視窗)。以 ZigZag 擺動點取代趨勢切段 ──
const ZZ_PCT = 0.10;      // ZigZag 反轉門檻（擺動點靈敏度；越大→點越少、型態越大）
const WM_DIFF = 0.10;     // W/M 的 b、d 兩點價差上限（沿用 hw12）

function zigzag(data, pct) {
  const n = data.length; if (n < 2) return [];
  const piv = []; let dir = 0, li = 0, lp = data[0].close;
  for (let i = 1; i < n; i++) {
    const p = data[i].close;
    if (dir <= 0) {
      if (p <= lp) { lp = p; li = i; }
      else if (p >= lp * (1 + pct)) { piv.push({ i: li, time: data[li].time, price: data[li].close, type: 'valley' }); dir = 1; lp = p; li = i; }
    } else {
      if (p >= lp) { lp = p; li = i; }
      else if (p <= lp * (1 - pct)) { piv.push({ i: li, time: data[li].time, price: data[li].close, type: 'peak' }); dir = -1; lp = p; li = i; }
    }
  }
  piv.push({ i: li, time: data[li].time, price: data[li].close, type: dir > 0 ? 'peak' : 'valley' });
  return piv;
}

function detectWM(piv) {       // W底(峰谷峰谷峰·突破頸線) / M頭(谷峰谷峰谷·跌破頸線)
  const out = [];
  for (let i = 0; i + 4 < piv.length; i++) {
    const p = piv.slice(i, i + 5), t = p.map(x => x.type), pr = p.map(x => x.price);
    const neck = pr[2], diff = Math.abs(pr[1] - pr[3]) / pr[1];
    if (t[0] === 'valley' && t[2] === 'valley' && t[4] === 'valley' && t[1] === 'peak' && t[3] === 'peak') {
      if (diff <= WM_DIFF && pr[0] <= pr[2] && pr[4] < neck) out.push({ kind: 'M', e: p[4] });
    } else if (t[0] === 'peak' && t[2] === 'peak' && t[4] === 'peak' && t[1] === 'valley' && t[3] === 'valley') {
      if (diff <= WM_DIFF && pr[0] >= pr[2] && pr[4] > neck) out.push({ kind: 'W', e: p[4] });
    }
  }
  return out;
}

function detectTriple(piv) {   // 頸線過 p3/p5 斜線投影到 p7，p7 突破/跌破才成立
  const out = [];
  for (let i = 0; i + 6 < piv.length; i++) {
    const p = piv.slice(i, i + 7), t = p.map(x => x.type);
    const odd = [t[0], t[2], t[4], t[6]], ev = [t[1], t[3], t[5]];
    const x3 = p[2].i, x5 = p[4].i, x7 = p[6].i, y3 = p[2].price, y5 = p[4].price;
    const slope = x5 !== x3 ? (y5 - y3) / (x5 - x3) : 0, proj = y3 + slope * (x7 - x3);
    if (odd.every(x => x === 'valley') && ev.every(x => x === 'peak')) {
      if (p[6].price < proj) out.push({ kind: 'TopT', g: p[6] });
    } else if (odd.every(x => x === 'peak') && ev.every(x => x === 'valley')) {
      if (p[6].price > proj) out.push({ kind: 'BotT', g: p[6] });
    }
  }
  return out;
}

function buildPatternMarkers() {
  const piv = zigzag(rows, ZZ_PCT);
  const uniq = (a) => { const s = new Set(); return a.filter(m => { const k = m.text + m.time; return s.has(k) ? false : (s.add(k), true); }); };
  wmMarkers = uniq(detectWM(piv).map(x => x.kind === 'W'
    ? { time: x.e.time, position: 'belowBar', color: '#1565c0', shape: 'arrowUp', text: 'W底' }
    : { time: x.e.time, position: 'aboveBar', color: '#e65100', shape: 'arrowDown', text: 'M頭' }));
  tripleMarkers = uniq(detectTriple(piv).map(x => x.kind === 'BotT'
    ? { time: x.g.time, position: 'belowBar', color: '#1565c0', shape: 'arrowUp', text: '三重底' }
    : { time: x.g.time, position: 'aboveBar', color: '#e65100', shape: 'arrowDown', text: '三重頂' }));
}

function refreshMarkers() {     // 合併「再平衡買賣點 + 已勾選的型態」一起標到 K 線
  let m = rebalMarkers.slice();
  const wm = document.getElementById('wm-toggle'), tri = document.getElementById('triple-toggle');
  if (wm && wm.checked) m = m.concat(wmMarkers);
  if (tri && tri.checked) m = m.concat(tripleMarkers);
  m.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  candle.setMarkers(m);
}

async function loadStock(code, name) {
  const data = await (await fetch(`data/${code}.json?v=${Date.now()}`)).json();
  rows = data.rows;
  rowMap = new Map();
  rows.forEach((r, i) => rowMap.set(r.time, i));
  curName = name;
  buildPatternMarkers();           // 偵測 W底/M頭、三重頂底（全史，依勾選顯示）

  candle.setData(rows.map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close })));
  for (const k of ['ma5', 'ma20', 'ma60', 'ma120', 'ma240'])
    ma[k].setData(rows.filter(r => r[k] != null).map(r => ({ time: r.time, value: r[k] })));
  const bb = bollinger(rows, 20, 2);
  bbUpper.setData(bb.up);
  bbLower.setData(bb.lo);
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
['wm-toggle', 'triple-toggle'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', refreshMarkers);
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
