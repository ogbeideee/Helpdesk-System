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
  setStatus: (id, payload) => request(`/tickets/${id}/status`, body(payload)),
  resolveTicket: (id, payload) => request(`/tickets/${id}/resolve`, body(payload)),
  closeTicket: (id, payload = {}) => request(`/tickets/${id}/close`, body(payload)),
  addNote: (id, text, isInternal = false) =>
    request(`/tickets/${id}/notes`, body({ body: text, isInternal })),
  simulateEmail: (payload) => request('/tickets/from-email', body(payload)),

  // ---- agent administration ----
  createAgent: (payload) => request('/agents', body(payload)),
  updateAgent: (id, payload) => request(`/agents/${id}`, patch(payload)),
};
