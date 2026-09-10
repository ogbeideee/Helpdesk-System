/* JSON export of a benchmark run — the bridge between the runner and the
 * comparison-chart generator.
 *
 * Deliberately narrow: case metadata, scores, latency and the model's own
 * classification fields only. Prompts, email subjects and bodies never enter
 * the export (the same rule the terminal report follows), and nothing is ever
 * written to a database. */
function runToJson(run, mode) {
  return {
    schema: 1,
    ranAt: run.ranAt,
    mode: mode === 'mock' ? 'mock' : 'live',
    providers: run.providers.map((p) => ({
      id: p.id,
      label: p.label,
      model: p.model,
      remote: Boolean(p.remote),
      tally: p.tally,
      cases: p.results.map((r) => ({
        id: r.case.id,
        name: r.case.name,
        adversarial: Boolean(r.case.trap),
        expected: { category: r.case.expected.category, priority: r.case.expected.priority },
        actual: r.outcome.valid
          ? {
              category: r.outcome.value.category,
              priority: r.outcome.value.priority,
              confidence: r.outcome.value.confidence,
              reason: r.outcome.value.reason,
              signals: r.outcome.value.signals,
            }
          : null,
        valid: r.outcome.valid,
        error: r.outcome.error || null,
        problems: r.outcome.error ? [] : r.outcome.problems || [],
        latencyMs: r.latencyMs,
        categoryOk: r.score.categoryOk,
        priorityOk: r.score.priorityOk,
        trapIgnored: r.score.trapIgnored,
        fellForTrap: r.score.fellForTrap,
      })),
    })),
  };
}

module.exports = { runToJson };
