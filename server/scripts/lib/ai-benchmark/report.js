/* Terminal report for the classification benchmark.
 *
 * Pure formatting of runner output — the focused test asserts on the exact
 * lines it emits. Only case metadata, scores, latency and the model's own
 * classification fields are printed: never prompts, never full email bodies,
 * never anything credential-shaped. */

function fmtConfidence(c) {
  return typeof c === 'number' ? c.toFixed(2) : ' — ';
}

/* PASS = parseable, schema-valid response with the expected category and (a
 * determinable) expected priority. Everything else is a FAIL. */
function casePassed(r) {
  return r.outcome.valid && r.score.categoryOk && r.score.priorityOk !== false;
}

function providerBlock(p) {
  const t = p.tally;
  const lines = [
    `Provider: ${p.label}${p.model ? ` (${p.model})` : ''}`,
    `  Category accuracy: ${t.categoryCorrect}/${t.total}` +
      (t.priorityTotal < t.total ? `  (priority denominator: ${t.priorityTotal} case(s) with a determinable priority)` : ''),
    `  Priority accuracy: ${t.priorityCorrect}/${t.priorityTotal}`,
    `  Combined (category AND priority): ${t.combinedCorrect}/${t.total}`,
    `  Valid JSON: ${t.valid}/${t.total}  (invalid responses: ${t.invalid})`,
    `  Misleading-keyword cases (incidental keywords ignored): ${t.adversarialPassed}/${t.adversarialTotal}` +
      (t.fellForTrap ? `  — fell for the trap keyword in ${t.fellForTrap}` : ''),
    `  Avg latency: ${t.avgLatencyMs === null ? '—' : `${t.avgLatencyMs} ms`}   Median latency: ${t.medianLatencyMs === null ? '—' : `${t.medianLatencyMs} ms`}`,
    `  Errors (timeout/transport/HTTP): ${t.errors}`,
    `  Avg confidence: ${t.avgConfidence === null ? '—' : t.avgConfidence.toFixed(2)}` +
      `  (on correct: ${t.avgConfidenceOnCorrect === null ? '—' : t.avgConfidenceOnCorrect.toFixed(2)}` +
      `, on incorrect: ${t.avgConfidenceOnIncorrect === null ? '—' : t.avgConfidenceOnIncorrect.toFixed(2)}` +
      ')  — informational only, never proof of correctness',
  ];
  lines.push('  Per-case (expected -> actual):');
  for (const r of p.results) {
    const expectedPri = r.case.expected.priority || '(n/d)';
    const id = r.case.id.padEnd(2);
    const lat = `${String(r.latencyMs).padStart(6)} ms`;
    if (r.outcome.error) {
      lines.push(`    ${id}  ${lat}  conf  —   exp ${r.case.expected.category}/${expectedPri} -> ERROR  FAIL`);
      lines.push(`        error: ${r.outcome.error}`);
    } else if (!r.outcome.valid) {
      lines.push(`    ${id}  ${lat}  conf  —   exp ${r.case.expected.category}/${expectedPri} -> INVALID  FAIL`);
      lines.push(`        invalid: ${(r.outcome.problems || []).join('; ')}`);
    } else {
      const v = r.outcome.value;
      const mark = casePassed(r) ? 'PASS' : 'FAIL';
      lines.push(
        `    ${id}  ${lat}  conf ${fmtConfidence(v.confidence)}  exp ${r.case.expected.category}/${expectedPri}` +
          ` -> ${v.category}/${v.priority}  ${mark}`,
      );
      if (!casePassed(r) && v.reason) lines.push(`        reason: ${v.reason}`);
    }
  }
  return lines.join('\n');
}

function mismatchSection(run) {
  const blocks = [];
  for (const p of run.providers) {
    for (const r of p.results) {
      const failedCategory = !r.score.categoryOk;
      const failedPriority = r.score.priorityOk === false;
      if (!failedCategory && !failedPriority && r.outcome.valid && !r.outcome.error) continue;

      const lines = [`[${p.label}] ${r.case.id}. ${r.case.name}`];
      const expectedPriority = r.case.expected.priority || '(not determinable)';
      if (r.outcome.error) {
        lines.push(`  expected: ${r.case.expected.category} / ${expectedPriority}`);
        lines.push(`  actual:   ERROR — ${r.outcome.error} (confidence —, ${r.latencyMs} ms)`);
      } else if (!r.outcome.valid) {
        lines.push(`  expected: ${r.case.expected.category} / ${expectedPriority}`);
        lines.push(
          `  actual:   INVALID RESPONSE — ${r.outcome.problems.join('; ')} (confidence —, ${r.latencyMs} ms)`,
        );
      } else {
        const v = r.outcome.value;
        lines.push(`  expected: ${r.case.expected.category} / ${expectedPriority}`);
        lines.push(
          `  actual:   ${v.category} / ${v.priority}` +
            ` (confidence ${fmtConfidence(v.confidence)}, ${r.latencyMs} ms)`,
        );
        if (v.reason) lines.push(`  reason:   ${v.reason}`);
        if (v.signals && v.signals.length) lines.push(`  signals:  ${v.signals.join(', ')}`);
      }
      if (r.score.fellForTrap && r.case.trap) {
        lines.push(`  trap:     ${r.case.trap.detail}`);
      }
      blocks.push(lines.join('\n'));
    }
  }
  return blocks;
}

/* The final side-by-side comparison, one block per provider in the run. */
function comparisonSection(run) {
  const lines = [
    '='.repeat(72),
    ' FINAL COMPARISON',
    '='.repeat(72),
  ];
  for (const p of run.providers) {
    const t = p.tally;
    lines.push(
      `${p.label}${p.model ? ` (${p.model})` : ''}`,
      `- Category: ${t.categoryCorrect}/${t.total}`,
      `- Priority: ${t.priorityCorrect}/${t.priorityTotal}`,
      `- Combined: ${t.combinedCorrect}/${t.total}`,
      `- Valid JSON: ${t.valid}/${t.total}`,
      `- Misleading-keyword accuracy: ${t.adversarialPassed}/${t.adversarialTotal}`,
      `- Average latency: ${t.avgLatencyMs === null ? '—' : `${t.avgLatencyMs} ms`}` +
        (t.medianLatencyMs === null ? '' : ` (median ${t.medianLatencyMs} ms)`),
      `- Failures: ${t.errors + t.invalid} (${t.errors} API error(s), ${t.invalid} invalid response(s))`,
      '',
    );
  }
  return lines;
}

function formatReport(run) {
  const out = [
    '='.repeat(72),
    ' AI ticket-classification benchmark — provider selection',
    ` ran at ${run.ranAt}`,
    ' scoring is against expected results, never against model confidence',
    '='.repeat(72),
    '',
  ];
  for (const p of run.providers) {
    out.push(providerBlock(p), '');
  }
  const mismatches = mismatchSection(run);
  out.push('-'.repeat(72), ' Mismatched / failed cases', '-'.repeat(72));
  if (mismatches.length === 0) {
    out.push(' none — every provider matched every expectation');
  } else {
    out.push(...mismatches);
  }
  out.push('', ...comparisonSection(run));
  return out.join('\n');
}

module.exports = { formatReport, casePassed };
