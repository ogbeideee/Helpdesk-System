import { createReadCache } from './readCache.js';
import { queuePath } from './ticketQueueView.js';
import { mutationInvalidates } from './readInvalidation.js';
const BASE = '/api';
const TOKEN_KEY = 'td_token';
const COOKIE_SESSION = 'cookie-session';
export function authHeaders() {
  const token = getToken();
  return token && !token.startsWith(COOKIE_SESSION) ? { Authorization: `Bearer ${token}` } : {};
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
  reads.clear();
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function networkRequest(path, options = {}) {
  const token = getToken();
  const res = await fetch(BASE + path, {
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    ...options,
  });
  if (token !== getToken()) throw new Error('Session changed');
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    setToken(null);
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || data.errors?.join(', ') || `Request failed (${res.status})`);
  }
  const data = await res.json();
  if (options.method && options.method !== 'GET') reads.invalidate(mutationInvalidates(path));
  return data;
}

const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
const reads = createReadCache({
  fetcher: (path) => networkRequest(path),
  onUpdate: (path) => emit('td:read-updated', { path }),
  onStatus: (status) => emit('td:read-status', status),
});
if (typeof window !== 'undefined') window.addEventListener('td:changed', () => {
  emit('td:refresh-page');
});
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key === TOKEN_KEY) { reads.clear(); window.location.reload(); }
});
let readToken;
function syncSession() {
  const token = getToken();
  if (token !== readToken) { reads.clear(); readToken = token; }
}
export function peekRead(path) { if (typeof localStorage === 'undefined') return null; syncSession(); return reads.peek(path); }
export function refreshPageReads() { reads.age(); emit('td:refresh-page'); }
function request(path, options = {}) {
  syncSession();
  // Public confirmations, session validation and assignment decisions always
  // consult the server. Cache only authenticated display data.
  const cached = !options.method && getToken() && !/^\/(auth|public)\//.test(path)
    && !/assignment-candidates|availability\/preview|notifications|\/tickets\?.*q=/.test(path);
  return cached ? reads.read(path) : networkRequest(path, options);
}

const body = (payload) => ({ method: 'POST', body: JSON.stringify(payload) });
const patch = (payload) => ({ method: 'PATCH', body: JSON.stringify(payload) });

export const api = {
  weeklyReport: week => request(`/weekly-reports?week=${encodeURIComponent(week)}`),
  saveWeeklyReport: ({data,...payload}) => {
    const {generated,...inputs}=data;
    return request('/weekly-reports', {method:'PUT',body:JSON.stringify({...payload,data:inputs})});
  },
  saveWeeklyActivity: payload => request('/weekly-reports/activities', body(payload)),
  saveWeeklyPreferences: payload => request('/weekly-reports/preferences',{method:'PUT',body:JSON.stringify(payload)}),
  generateWeeklyReport: payload => request('/weekly-reports/generate', body(payload)),
  editWeeklyDraft: payload => request('/weekly-reports/draft', {method:'PUT',body:JSON.stringify(payload)}),
  previousWeeklyReport: week => request(`/weekly-reports/previous?week=${encodeURIComponent(week)}`),
  uploadWeeklyReference: file => networkRequest('/weekly-reports/reference',{method:'POST',headers:{'Content-Type':'application/octet-stream',...authHeaders()},body:file}),
  clearWeeklyReference: () => request('/weekly-reports/reference',{method:'DELETE'}),
  async exportWeeklyReport(week) {
    const res = await fetch(`${BASE}/weekly-reports/export?week=${encodeURIComponent(week)}`, {headers:authHeaders()});
    if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error || 'Export failed');
    const url = URL.createObjectURL(await res.blob());
    const filename = res.headers.get('content-disposition')?.match(/filename="([\w.-]+)"/)?.[1];
    const link = document.createElement('a'); link.href=url; link.download=filename || `${week}_WEEKLY_REPORT.xlsx`; link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  },
  operations: () => request('/admin/operations'),
  updateIntakeSettings: payload => request('/admin/operations/settings', patch(payload)),
  previewGreeting: greeting => request('/admin/operations/greeting-preview', body({ greeting })),
  retryDelivery: id => request(`/admin/operations/deliveries/${id}/retry`, body({})),
  diagnostics: () => request('/admin/diagnostics'),
  // ---- auth ----
  async login(email, password) {
    const data = await request('/auth/login', body({ email, password, session: 'cookie' }));
    setToken(data.session === 'cookie' ? `${COOKIE_SESSION}:${crypto.randomUUID()}` : data.token);
    return data.agent;
  },
  async logout() {
    await networkRequest('/auth/logout', body({}));
    // Drafts belong to this browser tab/account and must not survive sign-out.
    try { Object.keys(sessionStorage).filter(key => key.startsWith('td_draft:')).forEach(key => sessionStorage.removeItem(key)); } catch { /* storage blocked */ }
    setToken(null);
  },
  async me() {
    const agent = await request('/auth/me');
    if (getToken() && !getToken().startsWith(COOKIE_SESSION)) {
      await networkRequest('/auth/session', body({}));
      setToken(`${COOKIE_SESSION}:${crypto.randomUUID()}`);
    }
    return agent;
  },
  updateProfile: (payload) => request('/profile', patch(payload)),
  changePassword: (payload) => request('/profile/password', body(payload)),

  // ---- public (no session — the emailed self-service status link) ----
  ticketStatus: (token) => request(`/public/ticket-status?token=${encodeURIComponent(token)}`),
  // The "Yes, it's resolved" button on the confirmation page.
  confirmResolution: (token) => request('/public/confirm-resolution', body({ token })),

  // ---- reference / analytics ----
  teams: () => request('/teams'),
  agents: () => request('/agents'),
  groups: () => request('/assignment-groups'),
  assignmentPools: () => request('/assignment-pools'),
  dashboard: () => request('/dashboard'),
  people: () => request('/tickets/people'),
  ticketQueue: (params = {}) => request(queuePath(params)),
  stats: () => request('/stats'),

  // ---- tickets ----
  listTickets: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries({ summary: '1', ...params }).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    ).toString();
    return request(`/tickets${qs ? `?${qs}` : ''}`);
  },
  getTicket: (id, allHistory = false) => request(`/tickets/${id}${allHistory ? '' : '?history=recent'}`),
  markConversationRead: (id, through) => request(`/tickets/${id}/conversation/read`, { method: 'POST', body: JSON.stringify({ through }) }),
  moveThreadReply: (id, commentId, data) => request(`/tickets/${id}/conversation/${commentId}/move`, { method: 'POST', body: JSON.stringify(data) }),
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

  // ---- remote access sessions (application-side foundation only) ----
  remoteAccessSessions: (ticketId) => request(`/remote-access/ticket/${ticketId}`),
  requestRemoteAccess: (payload) => request('/remote-access', body(payload)),
  startRemoteAccess: (id) => request(`/remote-access/${id}/start`, body({})),
  endRemoteAccess: (id, payload = {}) => request(`/remote-access/${id}/end`, body(payload)),
  cancelRemoteAccess: (id, payload = {}) => request(`/remote-access/${id}/cancel`, body(payload)),

  // ---- routing rules (admin) ----
  routingRules: () => request('/routing/rules'),
  routingGroups: () => request('/routing/groups'),
  createRoutingRule: (payload) => request('/routing/rules', body(payload)),
  updateRoutingRule: (id, payload) => request(`/routing/rules/${id}`, patch(payload)),
  deleteRoutingRule: (id) => request(`/routing/rules/${id}`, { method: 'DELETE' }),
  updateAssignmentGroup: (id, payload) => request(`/routing/groups/${id}`, patch(payload)),
  createAssignmentGroup: (payload) => request('/routing/groups', body(payload)),
  deleteAssignmentGroup: (id) => request(`/routing/groups/${id}`, { method: 'DELETE' }),
  routingAudit: () => request('/routing/audit'),
  previewRouting: (payload) => request('/routing/preview', body(payload)),

  // ---- email parsing rules (admin) ----
  emailRules: () => request('/email-rules'),
  createEmailRule: (payload) => request('/email-rules', body(payload)),
  updateEmailRule: (id, payload) => request(`/email-rules/${id}`, patch(payload)),
  deleteEmailRule: (id) => request(`/email-rules/${id}`, { method: 'DELETE' }),

  // ---- email relevance triage (admin; settings + monitoring) ----
  emailTriageManagement: () => request('/email-triage/management'),
  updateEmailTriageSettings: (payload) => request('/email-triage/settings', patch(payload)),
  disableEmailTriageAutoSkip: () => request('/email-triage/kill-switch', body({})),
  testEmailTriageProvider: () => request('/email-triage/test', body({})),

  // ---- Microsoft 365 integration (admin; status + explicit credential check) ----
  m365: () => request('/microsoft-365'),
  verifyM365: () => request('/microsoft-365/verify', body({})),

  // ---- agent administration ----
  createAgent: (payload) => request('/agents', body(payload)),
  updateAgent: (id, payload) => request(`/agents/${id}`, patch(payload)),
  addAgentMembership: (id, teamId) => request(`/agents/${id}/memberships`, body({ teamId })),
  removeAgentMembership: (id, teamId) => request(`/agents/${id}/memberships/${teamId}`, { method: 'DELETE' }),

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
