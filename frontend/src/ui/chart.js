import { formatSigned } from './format.js';

/**
 * Time-series chart: monthly anomalies (thin), yearly anomalies (dots),
 * fitted trend (line) and its 95% range (fan). Plain SVG, no library.
 *
 * Anomaly = value minus that place's own average for the same calendar month,
 * which removes the seasonal cycle before looking for a trend.
 */
const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

export function monthlyAnomalies(values) {
  const sums = new Array(12).fill(0);
  const counts = new Array(12).fill(0);
  values.forEach((v, i) => {
    if (v === null || v === undefined) return;
    sums[i % 12] += v;
    counts[i % 12] += 1;
  });
  const clim = sums.map((s, m) => (counts[m] ? s / counts[m] : null));
  return values.map((v, i) => (v === null || v === undefined || clim[i % 12] === null ? null : v - clim[i % 12]));
}

export function renderTrendChart(container, { monthly, startYear, annual, years, rec, accent }) {
  container.replaceChildren();
  // Draw at the container's real width so text stays legible on phones.
  const width = Math.max(300, Math.round(container.clientWidth || 380));
  const height = Math.round(Math.min(260, Math.max(190, width * 0.55)));
  const pad = { top: 14, right: 12, bottom: 26, left: 44 };
  const W = width - pad.left - pad.right;
  const H = height - pad.top - pad.bottom;

  const anomalies = monthlyAnomalies(monthly);
  const t0 = startYear;
  const t1 = startYear + anomalies.length / 12;
  const tMid = (t0 + t1) / 2;
  const finite = anomalies.filter((v) => v !== null);
  if (!finite.length) {
    container.textContent = 'No data to chart.';
    return;
  }

  // y-range covers data and the trend fan, symmetric about zero.
  const span = (t1 - t0) / 2;
  const fanEdge = rec?.available ? Math.max(Math.abs(rec.ciLow), Math.abs(rec.ciHigh), Math.abs(rec.slope)) * (span / 10) : 0;
  const yMax = Math.max(...finite.map(Math.abs), fanEdge) * 1.08 || 1;
  const x = (t) => pad.left + ((t - t0) / (t1 - t0)) * W;
  const y = (v) => pad.top + H / 2 - (v / yMax) * (H / 2);

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img' });
  svg.setAttribute(
    'aria-label',
    rec?.available
      ? `${rec.variable.label} anomalies ${t0}–${Math.floor(t1 - 1)}, fitted trend ${formatSigned(rec.slope, rec.variable.decimals)} ${rec.variable.unit} per decade`
      : 'Anomaly chart',
  );

  // grid: zero line + two ticks each side
  const ticks = niceTicks(yMax);
  for (const tv of ticks) {
    svg.append(el('line', { x1: pad.left, x2: width - pad.right, y1: y(tv), y2: y(tv), class: tv === 0 ? 'axis-zero' : 'grid' }));
    const label = el('text', { x: pad.left - 6, y: y(tv) + 4, class: 'tick', 'text-anchor': 'end' });
    label.textContent = tv === 0 ? '0' : formatSigned(tv, decimalsFor(yMax));
    svg.append(label);
  }
  for (let yr = Math.ceil(t0 / 5) * 5; yr < t1; yr += 5) {
    const label = el('text', { x: x(yr), y: height - 8, class: 'tick', 'text-anchor': 'middle' });
    label.textContent = String(yr);
    svg.append(label);
  }

  // trend fan + line
  if (rec?.available) {
    const lo = rec.ciLow / 10;
    const hi = rec.ciHigh / 10;
    // Fan = the area between the two 95% lines, both pivoting on the middle year.
    const fan = el('path', {
      d: `M${x(t0)},${y(lo * (t0 - tMid))} L${x(t1)},${y(lo * (t1 - tMid))} L${x(t1)},${y(hi * (t1 - tMid))} L${x(t0)},${y(hi * (t0 - tMid))} Z`,
      class: 'trend-fan',
      fill: accent,
    });
    svg.append(fan);
  }

  // Swing band: trend ± rolling 2-year standard deviation of what is left after
  // removing the trend. A widening band is what the Erratic detector measures.
  if (rec?.available) {
    const s = rec.slope / 10;
    const resid = anomalies.map((v, i) => (v === null ? null : v - s * (t0 + (i + 0.5) / 12 - tMid)));
    const half = 12;
    const upper = [];
    const lower = [];
    for (let i = half; i < resid.length - half; i += 3) {
      const win = resid.slice(i - half, i + half).filter((v) => v !== null);
      if (win.length < 12) continue;
      const mean = win.reduce((a, b) => a + b, 0) / win.length;
      const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / (win.length - 1));
      const t = t0 + (i + 0.5) / 12;
      const base = s * (t - tMid);
      upper.push(`${x(t).toFixed(1)},${y(base + sd).toFixed(1)}`);
      lower.unshift(`${x(t).toFixed(1)},${y(base - sd).toFixed(1)}`);
    }
    if (upper.length > 2) svg.append(el('path', { d: `M${upper.join('L')}L${lower.join('L')}Z`, class: 'swing-band' }));
  }

  // monthly anomalies
  let d = '';
  anomalies.forEach((v, i) => {
    if (v === null) return;
    const t = t0 + (i + 0.5) / 12;
    d += `${d && anomalies[i - 1] !== null ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
  });
  svg.append(el('path', { d, class: 'series-monthly' }));

  // yearly dots
  years.forEach((yr, i) => {
    const v = annual[i];
    if (v === null || v === undefined) return;
    svg.append(el('circle', { cx: x(yr + 0.5), cy: y(v), r: 4, class: 'series-annual' }));
  });

  if (rec?.available) {
    const s = rec.slope / 10;
    svg.append(el('line', { x1: x(t0), y1: y(s * (t0 - tMid)), x2: x(t1), y2: y(s * (t1 - tMid)), class: 'trend-line', stroke: accent }));
  }

  // hover: nearest year
  const cursor = el('line', { y1: pad.top, y2: pad.top + H, class: 'cursor', visibility: 'hidden' });
  const hit = el('rect', { x: pad.left, y: pad.top, width: W, height: H, class: 'hit' });
  svg.append(cursor, hit);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;

  const showAt = (clientX) => {
    const box = svg.getBoundingClientRect();
    const t = t0 + ((clientX - box.left) / box.width * width - pad.left) / W * (t1 - t0);
    const i = Math.max(0, Math.min(years.length - 1, Math.floor(t - t0)));
    const v = annual[i];
    cursor.setAttribute('x1', x(years[i] + 0.5));
    cursor.setAttribute('x2', x(years[i] + 0.5));
    cursor.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<strong>${years[i]}</strong> ${formatSigned(v, rec?.variable?.decimals ?? 2)} ${rec?.variable?.unit ?? ''} vs normal`;
    const px = ((x(years[i] + 0.5)) / width) * box.width;
    tip.style.left = `${Math.min(box.width - 140, Math.max(0, px - 70))}px`;
  };
  hit.addEventListener('pointermove', (e) => showAt(e.clientX));
  hit.addEventListener('pointerdown', (e) => showAt(e.clientX));
  hit.addEventListener('pointerleave', () => {
    cursor.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });

  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.append(svg, tip);
  container.append(wrap);
}

function niceTicks(max) {
  const step = niceStep(max / 2);
  const out = [];
  for (let v = -Math.floor(max / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function decimalsFor(max) {
  return max >= 10 ? 0 : max >= 1 ? 1 : max >= 0.1 ? 2 : 3;
}
