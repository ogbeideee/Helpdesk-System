// Unknown writes retain conservative full invalidation. Session boundaries
// always clear everything in api.js. Prefixes match a resource, not a substring.
export function mutationInvalidates(path) {
  const resource = path.split('?')[0];
  const matches = prefixes => key => prefixes.some(prefix => key === prefix || key.startsWith(prefix + '/') || key.startsWith(prefix + '?'));
  if (/^\/tickets\/\d+\/conversation\/read$/.test(resource)) {
    const ticket = resource.split('/')[2];
    return key => key.startsWith(`/tickets/${ticket}?`) || key === `/tickets/${ticket}` || key.startsWith('/tickets?') || key.startsWith('/tickets/queue');
  }
  if (resource === '/workload/notifications/read') return matches(['/workload/notifications']);
  if (resource.startsWith('/tickets') || resource.startsWith('/handovers')) {
    const id = resource.match(/^\/tickets\/(\d+)(?:\/|$)/)?.[1];
    const dependent = matches(['/dashboard', '/stats', '/workload', '/handovers', '/assignment-pools', '/reports', '/sla', '/weekly-reports', '/audit']);
    const tickets = matches(['/tickets']);
    const onlyOneTicket = id && !resource.endsWith('/move');
    return key => dependent(key) || (tickets(key) && (!onlyOneTicket
      || !/^\/tickets\/\d+(?:[/?]|$)/.test(key)
      || matches([`/tickets/${id}`])(key)));
  }
  if (resource.startsWith('/remote-access')) return matches(['/remote-access', '/tickets']);
  return () => true;
}
