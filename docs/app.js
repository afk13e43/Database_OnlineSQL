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
  ma5:  chart.addLineSeries({ color: '#42a5f5', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
  ma20: chart.addLineSeries({ color: '#ff9800', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
  ma60: chart.addLineSeries({ color: '#ab47bc', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
};
const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false });
vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

const sel = document.getElementById('stock');
const statEl = document.getElementById('stat');

async function loadStock(code, name) {
  const data = await (await fetch(`data/${code}.json?v=${Date.now()}`)).json();
  const rows = data.rows;

  candle.setData(rows.map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close })));
  for (const k of ['ma5', 'ma20', 'ma60'])
    ma[k].setData(rows.filter(r => r[k] != null).map(r => ({ time: r.time, value: r[k] })));
  vol.setData(rows.map(r => ({
    time: r.time, value: r.volume || 0,
    color: (r.close >= r.open) ? 'rgba(213,0,0,.35)' : 'rgba(0,137,123,.35)',
  })));
  chart.timeScale().fitContent();

  const last = rows[rows.length - 1], prev = rows[rows.length - 2] || last;
  const chg = prev.close ? ((last.close - prev.close) / prev.close * 100) : 0;
  const cls = chg >= 0 ? 'up' : 'down', sign = chg >= 0 ? '▲' : '▼';
  statEl.innerHTML = `${name} <b>${last.close}</b> <span class="${cls}">${sign}${Math.abs(chg).toFixed(2)}%</span> <small>(${last.time})</small>`;
}

document.querySelectorAll('.ma-toggles input').forEach(cb => {
  cb.addEventListener('change', () => ma[cb.dataset.ma].applyOptions({ visible: cb.checked }));
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
    const maxW = box.parentElement.clientWidth;          // 不超過版面寬，才能維持置中
    const w = Math.min(maxW, Math.max(320, sw + dx * 2)); // ×2：左右各擴 dx → 對稱
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
