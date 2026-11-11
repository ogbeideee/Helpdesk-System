// Send only changed fields: an unchanged assignment group must never trigger
// routing, assignment or its audit as a side effect of saving priority.
export function ticketPropertyChanges(ticket, values, isAdmin) {
  return {
    ...(values.priority !== ticket.priority ? { priority: values.priority } : {}),
    ...(values.category !== ticket.category ? { category: values.category } : {}),
    ...(isAdmin && values.group !== (ticket.team?.key || '') ? { assignmentGroup: values.group || null } : {}),
  };
}
