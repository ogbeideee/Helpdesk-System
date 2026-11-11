// Session-memory reads only. No ticket data is persisted in browser storage.
export function createReadCache({ fetcher, onUpdate = () => {}, onStatus = () => {}, now = Date.now,
  ttl = 15000, maxAge = 300000, maxEntries = 100 }) {
  const values = new Map();
  const pending = new Map();
  const revisions = new Map();
  let generation = 0;
  const copy = (value) => structuredClone(value);

  function clear() {
    generation += 1;
    values.clear();
    pending.clear();
    revisions.clear();
  }
  function invalidate(matches) {
    for (const key of new Set([...values.keys(), ...pending.keys()])) {
      if (!matches(key)) continue;
      values.delete(key);
      revisions.set(key, (revisions.get(key) || 0) + 1);
      pending.delete(key);
    }
    // Revisions also fence older requests; bound their metadata across many edits.
    if (revisions.size > maxEntries * 2) clear();
  }
  function peek(key) {
    const entry = values.get(key);
    return entry && now() - entry.at < maxAge ? copy(entry.value) : null;
  }
  function network(key, background) {
    if (pending.has(key)) return pending.get(key);
    const version = generation;
    const revision = revisions.get(key) || 0;
    onStatus({ key, pending: true });
    const promise = Promise.resolve().then(() => fetcher(key)).then((value) => {
      // A mutation completed while this read was in flight. Join/start the
      // new generation rather than allowing the old response onto a screen.
      if (generation !== version || (revisions.get(key) || 0) !== revision) return network(key, background);
      if (generation === version) {
        values.delete(key);
        values.set(key, { value: copy(value), at: now() });
        while (values.size > maxEntries) values.delete(values.keys().next().value);
        if (background) onUpdate(key);
      }
      return value;
    }).finally(() => {
      if (pending.get(key) === promise) pending.delete(key);
      onStatus({ key, pending: false });
    });
    pending.set(key, promise);
    return promise;
  }
  function read(key) {
    const entry = values.get(key);
    if (entry && now() - entry.at < maxAge) {
      if (now() - entry.at >= ttl) {
        network(key, true).catch(() => onStatus({ key, error: true }));
      }
      return Promise.resolve(copy(entry.value));
    }
    return network(key, false).then(copy);
  }
  function age() { for (const entry of values.values()) entry.at = Math.min(entry.at, now() - ttl); }
  return { read, peek, clear, age, invalidate };
}
