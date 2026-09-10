/* Comparison charts for benchmark runs — turns one or more JSON exports
 * (serialize.js) into a single self-contained HTML page: inline SVG only,
 * no external scripts, no network, nothing phoned home.
 *
 * The page is for provider selection: accuracy/validity/adversarial charts,
 * latency, confidence, a per-case outcome matrix and per-case latency. As
 * everywhere in this benchmark, scores are judged against expected results —
 * model confidence is displayed, never ranked. */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PALETTE = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#db2777', '#0d9488'];
const BASELINE_COLOR = '#64748b';

function providerColor(id, index) {
  return id === 'keyword-baseline' ? BASELINE_COLOR : PALETTE[index % PALETTE.length];
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

/** Merge provider sets from several JSON exports; later files win on id. */
function mergeRuns(runs) {
  const byId = new Map();
  const order = [];
  for (const run of runs) {
    for (const p of run.providers) {
      if (!byId.has(p.id)) order.push(p.id);
      byId.set(p.id, { ...p, mode: run.mode, ranAt: run.ranAt });
    }
  }
  const providers = order.map((id, i) => ({ ...byId.get(id), color: providerColor(id, i) }));
  const caseIds = [];
  for (const p of providers) {
    for (const c of p.cases) if (!caseIds.includes(c.id)) caseIds.push(c.id);
  }
  return { runs, providers, caseIds };
}

/* ------------------------------------------------------------------ */
/* SVG primitives                                                      */
/* ------------------------------------------------------------------ */

function niceMax(max) {
  if (max <= 0) return 100;
  for (const step of [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000]) {
    if (max <= step * 5) return step * Math.ceil(max / step);
  }
  return Math.ceil(max / 10000) * 10000;
}

/**
 * Vertical grouped bars. groups: [{label}], series: [{label, color, values[]}]
 * where values are numbers or null (no bar). yMax fixed for % charts.
 */
function groupedBars({ groups, series, unit, fixedMax = null, decimals = 0 }) {
  const W = 1000;
  const L = 52;
  const R = 8;
  const T = 16;
  const B = 42;
  const innerW = W - L - R;
  const innerH = 300;
  const H = T + innerH + B;
  const maxVal = fixedMax ?? niceMax(Math.max(1, ...series.flatMap((s) => s.values.filter((v) => v !== null))));
  const band = innerW / groups.length;
  const span = Math.min(band * 0.72, series.length * 46);
  const barW = span / series.length;

  const parts = [`<svg viewBox="0 0 ${W} ${H}" role="img" class="chart">`];
  // Gridlines + y labels.
  for (let i = 0; i <= 4; i += 1) {
    const v = (maxVal / 4) * i;
    const y = T + innerH - (innerH * i) / 4;
    parts.push(
      `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" class="grid"/>`,
      `<text x="${L - 8}" y="${y + 4}" class="tick" text-anchor="end">${decimals ? v.toFixed(decimals) : Math.round(v)}${unit}</text>`,
    );
  }
  groups.forEach((g, gi) => {
    const cx = L + band * gi + band / 2;
    const x0 = cx - span / 2;
    parts.push(`<text x="${cx}" y="${H - 20}" class="tick" text-anchor="middle">${esc(g.label)}</text>`);
    series.forEach((s, si) => {
      const v = s.values[gi];
      if (v === null || v === undefined) return;
      const h = Math.max(2, (v / maxVal) * innerH);
      const x = x0 + si * barW + barW * 0.08;
      const w = barW * 0.84;
      const y = T + innerH - h;
      const label = decimals ? v.toFixed(decimals) : Math.round(v);
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${s.color}"><title>${esc(s.label)} — ${esc(g.label)}: ${label}${unit}</title></rect>`,
        `<text x="${(x + w / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" class="barval" text-anchor="middle">${label}${unit}</text>`,
      );
    });
  });
  parts.push('</svg>');
  return parts.join('\n');
}

function legend(series) {
  return `<div class="legend">${series
    .map((s) => `<span class="lg"><span class="sw" style="background:${s.color}"></span>${esc(s.label)}</span>`)
    .join('')}</div>`;
}

/** Horizontal bars for single-value-per-provider metrics (latency…). */
function hBars({ rows, unit, decimals = 0 }) {
  const W = 1000;
  const L = 190;
  const R = 90;
  const rowH = 38;
  const H = rows.length * rowH + 8;
  const maxVal = Math.max(1, ...rows.map((r) => r.value).filter((v) => v !== null));
  const parts = [`<svg viewBox="0 0 ${W} ${H}" role="img" class="chart">`];
  rows.forEach((r, i) => {
    const y = i * rowH + 8;
    if (r.value === null) {
      parts.push(
        `<text x="${L - 10}" y="${y + 15}" class="rowlab" text-anchor="end">${esc(r.label)}</text>`,
        `<text x="${L}" y="${y + 15}" class="rowval muted">n/a</text>`,
      );
      return;
    }
    const w = Math.max(3, ((r.value / maxVal) * (W - L - R)) | 0);
    const label = decimals ? r.value.toFixed(decimals) : Math.round(r.value);
    parts.push(
      `<text x="${L - 10}" y="${y + 15}" class="rowlab" text-anchor="end">${esc(r.label)}</text>`,
      `<rect x="${L}" y="${y}" width="${w}" height="20" rx="3" fill="${r.color}"><title>${esc(r.label)}: ${label}${unit}</title></rect>`,
      `<text x="${L + w + 8}" y="${y + 15}" class="rowval">${label}${unit}</text>`,
    );
  });
  parts.push('</svg>');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* Page sections                                                       */
/* ------------------------------------------------------------------ */

function metricsTable(providers) {
  // best === max unless dir === 'min'; null dir → shown, never highlighted.
  const rows = [
    { label: 'Category accuracy', dir: 'max', get: (p) => [p.tally.categoryCorrect, p.tally.total] },
    { label: 'Priority accuracy', dir: 'max', get: (p) => [p.tally.priorityCorrect, p.tally.priorityTotal] },
    { label: 'Valid structured responses', dir: 'max', get: (p) => [p.tally.valid, p.tally.total] },
    { label: 'Adversarial passed (trap ignored)', dir: 'max', get: (p) => [p.tally.adversarialPassed, p.tally.adversarialTotal] },
    { label: 'Fell for the trap keyword', dir: 'min', get: (p) => [p.tally.fellForTrap, p.tally.adversarialTotal] },
    { label: 'Errors (timeout/transport/HTTP)', dir: 'min', get: (p) => [p.tally.errors, p.tally.total] },
  ];
  const head = providers
    .map(
      (p) =>
        `<th><span class="sw inline" style="background:${p.color}"></span>${esc(p.label)}${p.mode === 'mock' ? ' <em class="tag-mock">mock</em>' : ''}<small>${esc(p.model || '')}${p.remote ? '' : ' · local'}</small></th>`,
    )
    .join('');
  const body = rows
    .map((row) => {
      const pcts = providers.map((p) => {
        const [n, d] = row.get(p);
        return { n, d, v: pct(n, d) };
      });
      const vals = pcts.map((x) => x.v).filter((v) => v !== null);
      const best = vals.length ? (row.dir === 'max' ? Math.max(...vals) : Math.min(...vals)) : null;
      const cells = pcts
        .map((x) => {
          const isBest = row.dir && x.v !== null && x.v === best && providers.length > 1;
          // Only non-best cells get a delta, and every delta is a gap to the
          // best performer — red whether the metric is max- or min-ranked.
          const delta = isBest || x.v === null || best === null ? '' : `<small class="worse">${x.v > best ? '+' : ''}${x.v - best} pt</small>`;
          return `<td class="${isBest ? 'best' : ''}">${x.n}/${x.d} · ${x.v === null ? '—' : `${x.v}%`}${delta}</td>`;
        })
        .join('');
      return `<tr><th>${esc(row.label)}</th>${cells}</tr>`;
    })
    .join('');

  const latRow = (() => {
    const vals = providers.map((p) => p.tally.avgLatencyMs).filter((v) => v !== null);
    const best = vals.length ? Math.min(...vals) : null;
    return `<tr><th>Avg latency</th>${providers
      .map((p) => {
        const v = p.tally.avgLatencyMs;
        if (v === null) return '<td>—</td>';
        const isBest = v === best && providers.length > 1;
        const delta = isBest || best === null ? '' : `<small class="worse">+${v - best} ms</small>`;
        return `<td class="${isBest ? 'best' : ''}">${v} ms${delta}</td>`;
      })
      .join('')}</tr>`;
  })();

  // Confidence is informational only — displayed, never ranked.
  const confRow = `<tr><th>Avg confidence <small>(informational)</small></th>${providers
    .map((p) => `<td>${p.tally.avgConfidence === null ? '—' : p.tally.avgConfidence.toFixed(2)}</td>`)
    .join('')}</tr>`;

  return `<table class="metrics"><thead><tr><th>Metric</th>${head}</tr></thead><tbody>${body}${latRow}${confRow}</tbody></table>`;
}

const CELL = {
  ok: { mark: '✓', cls: 'ok', label: 'correct' },
  miss: { mark: '✗', cls: 'miss', label: 'wrong' },
  invalid: { mark: '◆', cls: 'invalid', label: 'invalid response' },
  error: { mark: '✕', cls: 'error', label: 'error' },
};

function cellKind(c) {
  if (c.error) return 'error';
  if (!c.valid) return 'invalid';
  if (c.categoryOk && (c.priorityOk === null || c.priorityOk)) return 'ok';
  return 'miss';
}

function outcomeMatrix(merged) {
  const { providers, caseIds } = merged;
  const head = providers.map((p) => `<th title="${esc(p.label)}">${esc(p.label)}</th>`).join('');
  const rows = caseIds.map((id) => {
    const first = providers.map((p) => p.cases.find((c) => c.id === id)).find(Boolean);
    if (!first) return '';
    const trapTag = first.adversarial ? ' <em class="tag-trap" title="adversarial — incidental keyword trap">!</em>' : '';
    const cells = providers
      .map((p) => {
        const c = p.cases.find((x) => x.id === id);
        if (!c) return '<td class="cell"></td>';
        const kind = cellKind(c);
        const meta = CELL[kind];
        const detail =
          kind === 'error'
            ? esc(c.error)
            : kind === 'invalid'
              ? esc(c.problems.join('; ') || 'invalid')
              : `${esc(c.actual.category)} / ${esc(c.actual.priority)}${c.fellForTrap ? ' — fell for the trap keyword' : ''}`;
        return `<td class="cell ${meta.cls}" title="${kind === 'ok' || kind === 'miss' ? esc(c.actual.category + ' / ' + c.actual.priority) : detail} · ${c.latencyMs} ms · conf ${c.actual && c.actual.confidence !== null && c.actual.confidence !== undefined ? c.actual.confidence.toFixed(2) : '—'}"><span class="mk">${meta.mark}</span><small>${c.latencyMs} ms</small></td>`;
      })
      .join('');
    const expected = `${first.expected.category} / ${first.expected.priority || '—'}`;
    return `<tr><td class="case">${esc(id)}. ${esc(first.name)}${trapTag}</td><td class="exp">${esc(expected)}</td>${cells}</tr>`;
  });
  return `<table class="matrix"><thead><tr><th>Case</th><th>Expected</th>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>
  <div class="legend">
    <span class="lg"><span class="sw sq ok"></span>correct</span>
    <span class="lg"><span class="sw sq miss"></span>wrong answer</span>
    <span class="lg"><span class="sw sq invalid"></span>invalid response</span>
    <span class="lg"><span class="sw sq error"></span>error / timeout</span>
    <span class="lg"><em class="tag-trap">!</em> adversarial trap case</span>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Page assembly                                                       */
/* ------------------------------------------------------------------ */

function buildComparisonHtml(runs) {
  const merged = mergeRuns(runs);
  const { providers } = merged;
  const series = providers.map((p) => ({
    label: p.mode === 'mock' ? `${p.label} (mock)` : p.label,
    color: p.color,
    provider: p,
  }));

  const pctGroups = ['Category', 'Priority', 'Valid JSON', 'Adversarial'].map((label) => ({ label }));
  const pctSeries = series.map((s) => ({
    label: s.label,
    color: s.color,
    values: [
      pct(s.provider.tally.categoryCorrect, s.provider.tally.total),
      pct(s.provider.tally.priorityCorrect, s.provider.tally.priorityTotal),
      pct(s.provider.tally.valid, s.provider.tally.total),
      pct(s.provider.tally.adversarialPassed, s.provider.tally.adversarialTotal),
    ],
  }));

  const latRows = series.map((s) => ({
    label: s.label,
    value: s.provider.tally.avgLatencyMs,
    color: s.color,
  }));
  const confRows = series.map((s) => ({
    label: s.label,
    value: s.provider.tally.avgConfidence,
    color: s.color,
  }));

  const perCaseGroups = merged.caseIds.map((id) => ({ label: id }));
  const perCaseSeries = series.map((s) => ({
    label: s.label,
    color: s.color,
    values: merged.caseIds.map((id) => {
      const c = s.provider.cases.find((x) => x.id === id);
      return c ? c.latencyMs : null;
    }),
  }));

  const anyMock = runs.some((r) => r.mode === 'mock');
  const sources = runs
    .map((r) => `<span class="src ${r.mode}">${r.mode === 'mock' ? 'MOCK' : 'LIVE'} · ${esc(r.ranAt)}</span>`)
    .join(' ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI classification benchmark — provider comparison</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px 64px; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #0f172a; background: #f8fafc; }
  main { max-width: 1060px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 40px 0 12px; }
  .sub { color: #475569; margin: 0 0 8px; }
  .note { color: #64748b; font-size: 12px; margin: 0; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin-top: 14px; }
  .banner { background: #fef3c7; border: 1px solid #f59e0b; color: #92400e; border-radius: 8px; padding: 10px 14px; margin: 14px 0; font-size: 13px; }
  .src { display: inline-block; font-size: 11px; font-weight: 600; letter-spacing: .04em; border-radius: 999px; padding: 2px 10px; margin-right: 6px; }
  .src.mock { background: #fef3c7; color: #92400e; border: 1px solid #f59e0b; }
  .src.live { background: #dcfce7; color: #166534; border: 1px solid #16a34a; }
  table { border-collapse: collapse; width: 100%; }
  .metrics th, .metrics td { padding: 9px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; vertical-align: top; }
  .metrics th:first-child, .metrics td:first-child { text-align: left; }
  .metrics thead th { font-size: 12px; color: #334155; }
  .metrics thead th small { display: block; font-weight: 400; color: #94a3b8; }
  .metrics td { font-variant-numeric: tabular-nums; }
  .metrics td small { display: block; font-size: 11px; }
  .metrics td.best { background: #f0fdf4; font-weight: 600; }
  .small-better, .better { color: #16a34a; } .worse { color: #dc2626; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: baseline; }
  .sw.inline { margin-right: 4px; }
  .sw.sq { border-radius: 3px; }
  .sw.sq.ok { background: #bbf7d0; } .sw.sq.miss { background: #fecaca; } .sw.sq.invalid { background: #fde68a; } .sw.sq.error { background: #cbd5e1; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 10px; font-size: 12px; color: #475569; }
  .chart { width: 100%; height: auto; display: block; }
  .grid { stroke: #e2e8f0; stroke-width: 1; }
  .tick { font-size: 11px; fill: #64748b; }
  .barval { font-size: 11px; font-weight: 600; fill: #334155; }
  .rowlab { font-size: 12px; fill: #334155; }
  .rowval { font-size: 12px; font-weight: 600; fill: #334155; }
  .rowval.muted, .muted { fill: #94a3b8; }
  .matrix th, .matrix td { border-bottom: 1px solid #eef2f7; padding: 7px 10px; text-align: left; }
  .matrix thead th { font-size: 12px; color: #334155; background: #f8fafc; }
  .matrix td.case { font-weight: 600; white-space: nowrap; }
  .matrix td.exp { color: #64748b; font-size: 12px; white-space: nowrap; }
  .matrix .cell { text-align: center; white-space: nowrap; }
  .matrix .cell small { display: block; font-size: 10px; color: #94a3b8; font-variant-numeric: tabular-nums; }
  .mk { font-weight: 700; }
  .cell.ok .mk { color: #15803d; } .cell.ok { background: #f0fdf4; }
  .cell.miss .mk { color: #b91c1c; } .cell.miss { background: #fef2f2; }
  .cell.invalid .mk { color: #b45309; } .cell.invalid { background: #fffbeb; }
  .cell.error .mk { color: #475569; } .cell.error { background: #f1f5f9; }
  .tag-trap { display: inline-block; background: #fee2e2; color: #b91c1c; border-radius: 4px; font-size: 10px; font-weight: 700; font-style: normal; padding: 0 5px; margin-left: 4px; }
  .tag-mock { font-size: 10px; font-style: normal; background: #fef3c7; color: #92400e; border-radius: 4px; padding: 1px 5px; vertical-align: middle; }
</style>
</head>
<body>
<main>
  <h1>AI ticket-classification benchmark — provider comparison</h1>
  <p class="sub">Generated ${esc(new Date().toISOString())} · sources: ${sources}</p>
  <p class="note">Scoring is against expected results, never against model confidence. Confidence is informational.</p>
  ${anyMock ? '<div class="banner"><strong>Mock data present.</strong> Providers tagged “mock” ran against a scripted responder, not a real API — their numbers demonstrate the charts, not provider quality.</div>' : ''}

  <h2>Key metrics</h2>
  <div class="card">${metricsTable(providers)}</div>

  <h2>Accuracy &amp; validity (% of cases)</h2>
  <div class="card">
    ${groupedBars({ groups: pctGroups, series: pctSeries, unit: '%', fixedMax: 100 })}
    ${legend(pctSeries)}
  </div>

  <h2>Average latency</h2>
  <div class="card">${hBars({ rows: latRows, unit: ' ms' })}</div>

  <h2>Average confidence (informational, not scored)</h2>
  <div class="card">${hBars({ rows: confRows, unit: '', decimals: 2 })}</div>

  <h2>Per-case outcomes</h2>
  <div class="card">${outcomeMatrix(merged)}</div>

  <h2>Per-case latency (ms)</h2>
  <div class="card">
    ${groupedBars({ groups: perCaseGroups, series: perCaseSeries, unit: ' ms' })}
    ${legend(perCaseSeries)}
  </div>
</main>
</body>
</html>`;
}

module.exports = { buildComparisonHtml, mergeRuns };
