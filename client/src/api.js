const BASE = '/api';
const TOKEN_KEY = 'td_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(BASE + path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    setToken(null);
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || data.errors?.join(', ') || `Request failed (${res.status})`);
  }
  return res.json();
}

const body = (payload) => ({ method: 'POST', body: JSON.stringify(payload) });
const patch = (payload) => ({ method: 'PATCH', body: JSON.stringify(payload) });

export const api = {
  // ---- auth ----
  async login(email, password) {
    const data = await request('/auth/login', body({ email, password }));
    setToken(data.token);
    return data.agent;
  },
  logout() {
    setToken(null);
  },
  me: () => request('/auth/me'),

  // ---- reference / analytics ----
  teams: () => request('/teams'),
  agents: () => request('/agents'),
  groups: () => request('/assignment-groups'),
  assignmentPools: () => request('/assignment-pools'),
  dashboard: () => request('/dashboard'),
  stats: () => request('/stats'),

  // ---- tickets ----
  listTickets: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    ).toString();
    return request(`/tickets${qs ? `?${qs}` : ''}`);
  },
  getTicket: (id) => request(`/tickets/${id}`),
  createTicket: (payload) => request('/tickets', body(payload)),
  updateTicket: (id, payload) => request(`/tickets/${id}`, patch(payload)),
  deleteTicket: (id) => request(`/tickets/${id}`, { method: 'DELETE' }),
  assignTicket: (id, payload) => request(`/tickets/${id}/assign`, body(payload)),
  reassignTicket: (id, payload) => request(`/tickets/${id}/reassign`, body(payload)),
  assignmentCandidates: (id) => request(`/tickets/${id}/assignment-candidates`),
  startTicket: (id) => request(`/tickets/${id}/start`, body({})),
  setStatus: (id, payload) => request(`/tickets/${id}/status`, body(payload)),
  resolveTicket: (id, payload) => request(`/tickets/${id}/resolve`, body(payload)),
  closeTicket: (id, payload = {}) => request(`/tickets/${id}/close`, body(payload)),
  addNote: (id, text, isInternal = false) =>
    request(`/tickets/${id}/notes`, body({ body: text, isInternal })),
  simulateEmail: (payload) => request('/tickets/from-email', body(payload)),

  // ---- workload, availability, notifications ----
  workload: () => request('/workload'),
  myWorkload: () => request('/workload/me'),
  availabilityPreview: () => request('/workload/availability/preview'),
  setAvailability: (payload) => request('/workload/availability', body(payload)),
  // Three-state availability: { state: 'online'|'unavailable'|'offline', agentId? }.
  // Self-service online/unavailable follows the classic guarded flow; offline
  // and other-agent changes are administrator actions.
  setAvailabilityState: (payload) => request('/workload/availability', body(payload)),
  // Agent Unavailability Timeline (read-only). The wide view is admin-only;
  // a single agent's history is open to the agent themselves and to admins.
  availabilityHistory: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    ).toString();
    return request(`/workload/availability-history${qs ? `?${qs}` : ''}`);
  },
  agentAvailabilityHistory: (agentId) => request(`/workload/availability-history/${agentId}`),
  notifications: () => request('/workload/notifications'),
  markNotificationsRead: (ids) => request('/workload/notifications/read', body(ids ? { ids } : {})),
  rebalance: (payload = {}) => request('/workload/rebalance', body(payload)),
  takeTicket: (id) => request(`/tickets/${id}/take`, body({})),

  // ---- handovers ----
  requestHandover: (ticketId, payload) => request(`/tickets/${ticketId}/handover`, body(payload)),
  ticketHandovers: (ticketId) => request(`/tickets/${ticketId}/handovers`),
  handoverInbox: () => request('/handovers/inbox'),
  handoverOutbox: () => request('/handovers/outbox'),
  acceptHandover: (id, payload = {}) => request(`/handovers/${id}/accept`, body(payload)),
  declineHandover: (id, payload = {}) => request(`/handovers/${id}/decline`, body(payload)),
  suggestHandover: (id, payload) => request(`/handovers/${id}/suggest`, body(payload)),
  cancelHandover: (id, payload = {}) => request(`/handovers/${id}/cancel`, body(payload)),
  overrideHandover: (id) => request(`/handovers/${id}/override`, body({})),
  handoverSettings: () => request('/handovers/settings'),
  updateHandoverSettings: (payload) => request('/handovers/settings', patch(payload)),

  // ---- routing rules (admin) ----
  routingRules: () => request('/routing/rules'),
  routingGroups: () => request('/routing/groups'),
  createRoutingRule: (payload) => request('/routing/rules', body(payload)),
  updateRoutingRule: (id, payload) => request(`/routing/rules/${id}`, patch(payload)),
  deleteRoutingRule: (id) => request(`/routing/rules/${id}`, { method: 'DELETE' }),
  updateAssignmentGroup: (id, payload) => request(`/routing/groups/${id}`, patch(payload)),
  routingAudit: () => request('/routing/audit'),
  previewRouting: (payload) => request('/routing/preview', body(payload)),

  // ---- email parsing rules (admin) ----
  emailRules: () => request('/email-rules'),
  createEmailRule: (payload) => request('/email-rules', body(payload)),
  updateEmailRule: (id, payload) => request(`/email-rules/${id}`, patch(payload)),
  deleteEmailRule: (id) => request(`/email-rules/${id}`, { method: 'DELETE' }),

  // ---- Microsoft 365 integration (admin; status + explicit credential check) ----
  m365: () => request('/microsoft-365'),
  verifyM365: () => request('/microsoft-365/verify', body({})),

  // ---- agent administration ----
  createAgent: (payload) => request('/agents', body(payload)),
  updateAgent: (id, payload) => request(`/agents/${id}`, patch(payload)),

  // ---- SLA settings (admin) ----
  slaSettings: () => request('/sla/settings'),
  updateSlaSettings: (payload) => request('/sla/settings', patch(payload)),
  addSlaHoliday: (payload) => request('/sla/holidays', body(payload)),
  deleteSlaHoliday: (id) => request(`/sla/holidays/${id}`, { method: 'DELETE' }),

  // ---- SLA reports (admin, read-only) ----
  slaReport: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    ).toString();
    return request(`/sla/report${qs ? `?${qs}` : ''}`);
  },

  // ---- audit trail (admin, read-only; filtering + pagination server-side) ----
  auditEvents: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    ).toString();
    return request(`/audit${qs ? `?${qs}` : ''}`);
  },

  // ---- operational reports (admin, read-only; date filtering server-side) ----
  reports: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    ).toString();
    return request(`/reports${qs ? `?${qs}` : ''}`);
  },
};
