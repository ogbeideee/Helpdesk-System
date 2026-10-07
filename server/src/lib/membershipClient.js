// Preserve the public Agent DTO (teamId/team) while primary membership is stored
// ONLY in TeamMembership.isPrimary. Query translation is centralized here so
// services, nested ticket relations and transaction clients share one projection.
// This adapter contains no assignment or authorization decisions.
const { Prisma } = require('@prisma/client');
const models = new Map(Prisma.dmmf.datamodel.models.map(m => [m.name, m]));
const cache = new WeakMap();
function primaryWhere(value) {
  if (value === null) return { memberships: { none: { isPrimary: true } } };
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && value.not === null) return { memberships: { some: { isPrimary: true } } };
  return { memberships: { some: { isPrimary: true, teamId: value } } };
}
function where(model, value) {
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(v => where(model, v));
  const result = {};
  const primary = [];
  for (const [key, item] of Object.entries(value)) {
    if (model === 'Agent' && key === 'teamId') {
      primary.push(primaryWhere(item));
    } else if (['AND', 'OR', 'NOT', 'some', 'none', 'every', 'is', 'isNot'].includes(key)) {
      result[key] = where(model, item);
    } else {
      const field = models.get(model)?.fields.find(f => f.name === key);
      result[key] = field?.kind === 'object' ? where(field.type, item) : item;
    }
  }
  if (primary.length) result.AND = [...(Array.isArray(result.AND) ? result.AND : result.AND ? [result.AND] : []), ...primary];
  return result;
}
function needsProjection(model, args) {
  if (model === 'Agent') return true;
  for (const mode of ['include', 'select']) for (const [name, spec] of Object.entries(args[mode] || {})) {
    const field = models.get(model)?.fields.find(f => f.name === name);
    if (field?.kind === 'object' && spec && needsProjection(field.type, spec === true ? {} : spec)) return true;
  }
  // Agent relation filters may carry the derived primary-group field even
  // when no Agent is selected. Use the translated where shape as the signal.
  return JSON.stringify(args.where) !== JSON.stringify(where(model, args.where));
}
function selection(model, args = {}) {
  const result = { ...args };
  if (args.where) result.where = where(model, args.where);
  for (const mode of ['select', 'include']) {
    if (!args[mode]) continue;
    result[mode] = {};
    for (const [name, spec] of Object.entries(args[mode])) {
      if (model === 'Agent' && ['teamId', 'team'].includes(name)) continue;
      const field = models.get(model)?.fields.find(f => f.name === name);
      result[mode][name] = field?.kind === 'object' && spec
        ? selection(field.type, spec === true ? {} : spec) : spec;
    }
  }
  if (model === 'Agent') {
    // Group selections share the canonical membership rows. Callers do not
    // filter this relation; supporting memberships are kept intact.
    const mode = result.select ? 'select' : 'include';
    result[mode] ||= {};
    const membershipSpec = result[mode].memberships;
    result[mode].memberships = { ...(membershipSpec || {}), ...(membershipSpec?.select ? { select: { ...membershipSpec.select, isPrimary: true, teamId: true, team: true } } : { include: { ...(membershipSpec?.include || {}), team: true } }) };
  }
  return result;
}
function project(model, value, original = {}) {
  if (Array.isArray(value)) return value.map(v => project(model, v, original));
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  if (model === 'Agent') {
    const primary = result.memberships?.find(m => m.isPrimary);
    if (!original.include?.memberships && !original.select?.memberships) delete result.memberships;
    if (!original.select || original.select.teamId) result.teamId = primary?.teamId ?? null;
    if (original.include?.team || original.select?.team) result.team = primary?.team ?? null;
    if (original.select && !original.select.id) delete result.id;
  }
  for (const field of models.get(model)?.fields || []) {
    if (field.kind === 'object' && result[field.name] !== undefined) {
      const spec = original.include?.[field.name] || original.select?.[field.name] || {};
      result[field.name] = project(field.type, result[field.name], spec === true ? {} : spec);
    }
  }
  return result;
}
function wrap(client) {
  if (cache.has(client)) return cache.get(client);
  const delegates = new Map();
  const proxy = new Proxy(client, { get(target, key) {
    if (key === '$transaction') return (task, options) => typeof task === 'function'
      ? target.$transaction(tx => task(wrap(tx)), options) : target.$transaction(task, options);
    const model = [...models.keys()].find(name => name[0].toLowerCase() + name.slice(1) === key);
    if (!model) return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    if (!delegates.has(key)) delegates.set(key, new Proxy(target[key], { get(delegate, method) {
      if (typeof delegate[method] !== 'function') return delegate[method];
      return (args = {}) => {
        if (!needsProjection(model, args)) return delegate[method](args);
        return (async () => {
        const original = args;
        if (model === 'Agent' && method === 'upsert' && (Object.hasOwn(args.create || {}, 'teamId') || Object.hasOwn(args.update || {}, 'teamId'))) {
          const operation = async tx => {
            const present = await tx.agent.findUnique({ where: args.where });
            return wrap(tx).agent[present ? 'update' : 'create']({
              ...(present ? { where: args.where } : {}), data: present ? args.update : args.create,
              include: args.include, select: args.select,
            });
          };
          return target.$transaction ? target.$transaction(operation) : operation(target);
        }
        let transformed = selection(model, args);
        const isResult = !['count', 'aggregate', 'groupBy', 'createMany', 'updateMany', 'deleteMany'].includes(method);
        if (!isResult) { delete transformed.include; delete transformed.select; }
        const order = model === 'Agent' ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]).filter(Boolean) : [];
        if (order.some(o => o.teamId)) {
          transformed.orderBy = order.filter(o => !o.teamId);
          delete transformed.skip;
          delete transformed.take;
        }
        if (model === 'Agent' && args.data && Object.hasOwn(args.data, 'teamId')) {
          const teamId = args.data.teamId;
          transformed.data = { ...args.data };
          delete transformed.data.teamId;
          if (transformed.select) transformed.select.id = true;
          if (['create', 'update'].includes(method)) {
            const operation = async tx => {
              const row = await tx.agent[method](transformed);
              await require('../services/groupMembershipService').setPrimary({ agentId: row.id, teamId }, wrap(tx));
              return tx.agent.findUnique(selection('Agent', { where: { id: row.id }, select: args.select, include: args.include }));
            };
            const row = target.$transaction ? await target.$transaction(operation) : await operation(target);
            return project(model, row, original);
          }
          throw new Error('Primary group writes require individual agent create/update');
        }
        const value = await delegate[method](transformed);
        const result = isResult ? project(model, value, original) : value;
        if (Array.isArray(result) && order.some(o => o.teamId)) result.sort((a, b) => {
          for (const item of order) {
            const [field, direction] = Object.entries(item)[0];
            const comparison = typeof a[field] === 'string' ? a[field].localeCompare(b[field]) : (a[field] ?? Infinity) - (b[field] ?? Infinity);
            if (comparison) return direction === 'desc' ? -comparison : comparison;
          }
          return 0;
        });
        return Array.isArray(result) && order.some(o => o.teamId)
          ? result.slice(args.skip || 0, args.take === undefined ? undefined : (args.skip || 0) + args.take)
          : result;
        })();
      };
    } }));
    return delegates.get(key);
  } });
  cache.set(client, proxy);
  return proxy;
}
module.exports = { wrap, primaryWhere };
