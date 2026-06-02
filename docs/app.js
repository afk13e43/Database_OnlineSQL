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

// 型態線（折線 + 頸線）：預設隱藏，只畫在偵測到的型態區間內、不延伸全圖
const wmLineOpt = { color: '#5e35b1', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: false };
const triLineOpt = { color: '#00838f', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: false };
const wmPolySeries = chart.addLineSeries(wmLineOpt);
const wmNeckSeries = chart.addLineSeries({ ...wmLineOpt, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed });
const triPolySeries = chart.addLineSeries(triLineOpt);
const triNeckSeries = chart.addLineSeries({ ...triLineOpt, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed });

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

chart.timeScale().subscribeVisibleLogicalRangeChange(updateRebal);

// ── hw12 型態：W底/M頭(5點)、三重頂/底(7點)。用 DB 寫入的真 Trend 切段（與 hw12 一致）──
const WM_DIFF = 0.10;     // W/M 的 b、d 兩點價差上限（沿用 hw12）

function findSegments(d) {            // 依連續相同 Trend 切段 → [[s,e,trend], ...]
  const segs = []; let i = 0;
  while (i < d.length) {
    let j = i; const tr = d[i].trend == null ? null : d[i].trend;
    while (j + 1 < d.length && (d[j + 1].trend == null ? null : d[j + 1].trend) === tr) j++;
    segs.push([i, j, tr]); i = j + 1;
  }
  return segs;
}

function segmentTurningPoints(d, segs) {   // 上漲→peak(最高) / 下跌→valley(最低) / 橫盤→flat(最近中位數)
  const pts = [];
  for (const [s, e, t] of segs) {
    if (t === 'U') { let b = s; for (let k = s; k <= e; k++) if (d[k].high > d[b].high) b = k;
      pts.push({ type: 'peak', i: b, time: d[b].time, price: d[b].high, close: d[b].close }); }
    else if (t === 'D') { let b = s; for (let k = s; k <= e; k++) if (d[k].low < d[b].low) b = k;
      pts.push({ type: 'valley', i: b, time: d[b].time, price: d[b].low, close: d[b].close }); }
    else { const cs = []; for (let k = s; k <= e; k++) cs.push(d[k].close);
      const so = cs.slice().sort((a, b) => a - b);
      const med = so.length % 2 ? so[(so.length - 1) / 2] : (so[so.length / 2 - 1] + so[so.length / 2]) / 2;
      let b = s, bd = Infinity; for (let k = s; k <= e; k++) { const dd = Math.abs(d[k].close - med); if (dd < bd) { bd = dd; b = k; } }
      pts.push({ type: 'flat', i: b, time: d[b].time, price: d[b].close, close: d[b].close }); }
  }
  return pts;
}

function zigzagFilter(pts) {          // 去掉同方向多餘轉折點（hw12 zigzag）
  if (pts.length < 2) return pts.slice();
  const segs = []; let seg = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const c = pts[i], pv = pts[i - 1];
    if ((c.price - pv.price) * (pv.price - seg[0].price) >= 0) seg.push(c);
    else { if (seg.length >= 2) segs.push([seg[0], seg[seg.length - 1]]); seg = [pv, c]; }
  }
  if (seg.length >= 2) segs.push([seg[0], seg[seg.length - 1]]);
  const zz = new Map();
  for (const [a, b] of segs) { zz.set(a.time, a); zz.set(b.time, b); }
  return [...zz.values()];
}

function detectWM(piv) {       // W底(峰谷峰谷峰·突破頸線) / M頭(谷峰谷峰谷·跌破頸線)；b/d 可為 flat
  const out = [];
  for (let i = 0; i + 4 < piv.length; i++) {
    const p = piv.slice(i, i + 5), t = p.map(x => x.type), pr = p.map(x => x.price);
    const neck = pr[2], diff = Math.abs(pr[1] - pr[3]) / pr[1];
    if (t[0] === 'valley' && t[2] === 'valley' && t[4] === 'valley' && ['peak', 'flat'].includes(t[1]) && ['peak', 'flat'].includes(t[3])) {
      if (diff <= WM_DIFF && pr[0] <= pr[2] && pr[4] < neck) out.push({ kind: 'M', p, neck });
    } else if (t[0] === 'peak' && t[2] === 'peak' && t[4] === 'peak' && ['valley', 'flat'].includes(t[1]) && ['valley', 'flat'].includes(t[3])) {
      if (diff <= WM_DIFF && pr[0] >= pr[2] && pr[4] > neck) out.push({ kind: 'W', p, neck });
    }
  }
  return out;
}

function detectTriple(piv) {   // 頸線過 p3/p5 斜線投影到 p7，p7 收盤突破/跌破才成立；p2/4/6 可為 flat
  const out = [];
  for (let i = 0; i + 6 < piv.length; i++) {
    const p = piv.slice(i, i + 7), t = p.map(x => x.type);
    const odd = [t[0], t[2], t[4], t[6]], ev = [t[1], t[3], t[5]];
    const x3 = p[2].i, x5 = p[4].i, x7 = p[6].i, y3 = p[2].price, y5 = p[4].price;
    const slope = x5 !== x3 ? (y5 - y3) / (x5 - x3) : 0, proj = y3 + slope * (x7 - x3);
    if (odd.every(x => x === 'valley') && ev.every(x => ['peak', 'flat'].includes(x))) {
      if (p[6].close < proj) out.push({ kind: 'TopT', p });
    } else if (odd.every(x => x === 'peak') && ev.every(x => ['valley', 'flat'].includes(x))) {
      if (p[6].close > proj) out.push({ kind: 'BotT', p });
    }
  }
  return out;
}

function nonOverlap(pats) {     // 貪婪取不重疊（間隔≥1列，方便畫線斷開）
  const s = pats.slice().sort((a, b) => a.p[0].i - b.p[0].i);
  const out = []; let lastEnd = -2;
  for (const x of s) if (x.p[0].i > lastEnd + 1) { out.push(x); lastEnd = x.p[x.p.length - 1].i; }
  return out;
}

function lineData(pats, ptsFn) {   // 串成單一 line series，型態間插 whitespace 斷線（限制延伸範圍）
  const data = []; let prevEnd = -2;
  for (const pat of pats) {
    if (data.length && rows[prevEnd + 1]) data.push({ time: rows[prevEnd + 1].time });   // 斷線
    for (const pt of ptsFn(pat)) data.push(pt);
    prevEnd = pat.p[pat.p.length - 1].i;
  }
  return data;
}

function buildPatterns() {
  const piv = zigzagFilter(segmentTurningPoints(rows, findSegments(rows)));
  const wm = detectWM(piv), tri = detectTriple(piv);

  // 標記（型態完成點，附文字標籤）
  const uniq = (a) => { const s = new Set(); return a.filter(m => { const k = m.text + m.time; return s.has(k) ? false : (s.add(k), true); }); };
  wmMarkers = uniq(wm.map(x => x.kind === 'W'
    ? { time: x.p[4].time, position: 'belowBar', color: '#1565c0', shape: 'arrowUp', text: 'W底' }
    : { time: x.p[4].time, position: 'aboveBar', color: '#e65100', shape: 'arrowDown', text: 'M頭' }));
  tripleMarkers = uniq(tri.map(x => x.kind === 'BotT'
    ? { time: x.p[6].time, position: 'belowBar', color: '#1565c0', shape: 'arrowUp', text: '三重底' }
    : { time: x.p[6].time, position: 'aboveBar', color: '#e65100', shape: 'arrowDown', text: '三重頂' }));

  // 線（折線 + 頸線）：取不重疊型態，各自限制在型態區間內
  const wmN = nonOverlap(wm), triN = nonOverlap(tri);
  wmPolySeries.setData(lineData(wmN, pat => pat.p.map(x => ({ time: x.time, value: x.price }))));
  wmNeckSeries.setData(lineData(wmN, pat => [{ time: pat.p[0].time, value: pat.neck }, { time: pat.p[4].time, value: pat.neck }]));
  triPolySeries.setData(lineData(triN, pat => pat.p.map(x => ({ time: x.time, value: x.price }))));
  triNeckSeries.setData(lineData(triN, pat => {
    const x3 = pat.p[2].i, x5 = pat.p[4].i, y3 = pat.p[2].price, y5 = pat.p[4].price;
    const sl = x5 !== x3 ? (y5 - y3) / (x5 - x3) : 0;
    return [{ time: pat.p[0].time, value: y3 + sl * (pat.p[0].i - x3) }, { time: pat.p[6].time, value: y3 + sl * (pat.p[6].i - x3) }];
  }));
}

function refreshMarkers() {     // 合併「再平衡買賣點 + 已勾選的型態標記」一起標到 K 線
  let m = rebalMarkers.slice();
  const wm = document.getElementById('wm-toggle'), tri = document.getElementById('triple-toggle');
  if (wm && wm.checked) m = m.concat(wmMarkers);
  if (tri && tri.checked) m = m.concat(tripleMarkers);
  m.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  candle.setMarkers(m);
}

function patternsRefresh() {    // 依勾選顯示/隱藏型態線，並更新標記
  const wmOn = !!(document.getElementById('wm-toggle') && document.getElementById('wm-toggle').checked);
  const triOn = !!(document.getElementById('triple-toggle') && document.getElementById('triple-toggle').checked);
  wmPolySeries.applyOptions({ visible: wmOn });
  wmNeckSeries.applyOptions({ visible: wmOn });
  triPolySeries.applyOptions({ visible: triOn });
  triNeckSeries.applyOptions({ visible: triOn });
  refreshMarkers();
}

async function loadStock(code, name) {
  const data = await (await fetch(`data/${code}.json?v=${Date.now()}`)).json();
  rows = data.rows;
  rowMap = new Map();
  rows.forEach((r, i) => rowMap.set(r.time, i));
  curName = name;
  buildPatterns();                 // 偵測 W底/M頭、三重頂底（真 Trend 切段，依勾選顯示線與標記）

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
  patternsRefresh();               // 依勾選顯示型態線與標記
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
  if (el) el.addEventListener('change', patternsRefresh);
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
