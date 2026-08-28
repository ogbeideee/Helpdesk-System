import { useEffect, useMemo, useState } from 'react';
import { api, getToken } from './api.js';
import { avatarHue } from './components/ui.jsx';
import Login from './components/Login.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Dashboard from './components/Dashboard.jsx';
import TicketsPage from './components/TicketsPage.jsx';
import TicketDetail from './components/TicketDetail.jsx';
import TicketForm from './components/TicketForm.jsx';
import AgentsPage from './components/AgentsPage.jsx';
import RoutingPage from './components/RoutingPage.jsx';
import GroupsPage from './components/GroupsPage.jsx';
import SimulateEmailPage from './components/SimulateEmailPage.jsx';
import AvailabilityControl from './components/AvailabilityControl.jsx';
import HandoversPage from './components/HandoversPage.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';

const EMAIL_SIMULATOR_ENABLED = import.meta.env.VITE_ENABLE_EMAIL_SIMULATOR !== 'false';

function NavIcon({ name }) {
  const props = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'dashboard':
      return <svg {...props}><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>;
    case 'tickets':
      return <svg {...props}><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7"/><circle cx="12.5" cy="11.5" r="1.5"/></svg>;
    case 'handovers':
      return <svg {...props}><path d="M2 8h11M9.5 4.5L13 8l-3.5 3.5"/><path d="M14 8h-2"/></svg>;
    case 'agents':
      return <svg {...props}><circle cx="6" cy="6" r="2.5"/><path d="M2 13c.5-2 2-3 4-3s3.5 1 4 3"/><circle cx="11.5" cy="5.5" r="1.8"/><path d="M10 9.5c1.5 0 3 1 3.5 2.5"/></svg>;
    case 'routing':
      return <svg {...props}><circle cx="3" cy="8" r="1.5"/><path d="M4.5 8h3M11.5 8H8"/><circle cx="13" cy="8" r="1.5"/><path d="M6 8l2-3M10 8L8 5M6 8l2 3M10 8l-2 3"/></svg>;
    case 'groups':
      return <svg {...props}><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>;
    case 'mail':
      return <svg {...props}><rect x="2" y="3.5" width="12" height="9" rx="1"/><path d="M2.5 4l5.5 4 5.5-4"/></svg>;
    default:
      return null;
  }
}

export default function App() {
  const [me, setMe] = useState(undefined);
  const [route, setRoute] = useState(() => parseHash());
  const [handoverCount, setHandoverCount] = useState(0);

  useEffect(() => {
    if (!getToken()) {
      setMe(null);
      return;
    }
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!me) return undefined;
    let cancelled = false;
    const poll = () =>
      api
        .handoverInbox()
        .then((d) => { if (!cancelled) setHandoverCount(d.pending.length); })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, [me]);

  const isAdmin = me?.role === 'admin';

  const navGroups = useMemo(() => {
    const operations = [
      { path: '/', label: 'Dashboard', icon: 'dashboard' },
      { path: '/tickets', label: 'Tickets', icon: 'tickets' },
      { path: '/handovers', label: 'Handovers', icon: 'handovers', badge: handoverCount },
    ];
    const admin = isAdmin
      ? [
          { path: '/agents', label: 'Agents', icon: 'agents' },
          { path: '/routing', label: 'Routing Rules', icon: 'routing' },
        ]
      : [];
    const workspace = [{ path: '/groups', label: 'Assignment Groups', icon: 'groups' }];
    const dev = EMAIL_SIMULATOR_ENABLED
      ? [{ path: '/simulate-email', label: 'Simulate Email', icon: 'mail', dev: true }]
      : [];
    return [
      { label: 'Operations', items: operations },
      ...(admin.length ? [{ label: 'Administration', items: admin }] : []),
      { label: 'Workspace', items: workspace },
      ...(dev.length ? [{ label: 'Development', items: dev, dev: true }] : []),
    ];
  }, [isAdmin, handoverCount]);

  function navigate(path) {
    window.location.hash = path;
  }

  function handleLogout() {
    api.logout();
    setMe(null);
    navigate('/');
  }

  if (me === undefined) return <div className="boot-screen"><span className="spinner" /></div>;
  if (me === null) return <Login onLogin={setMe} />;

  let content;
  switch (route.name) {
    case 'list':
      content = <TicketsPage onOpen={(id) => navigate(`/tickets/${id}`)} />;
      break;
    case 'detail':
      content = <TicketDetail id={route.id} me={me} onChanged={refreshSignal} />;
      break;
    case 'new':
      content = (
        <TicketForm
          onSaved={(t) => navigate(`/tickets/${t.id}`)}
          onCancel={() => navigate('/tickets')}
        />
      );
      break;
    case 'edit':
      content = (
        <TicketForm
          ticketId={route.id}
          onSaved={() => navigate(`/tickets/${route.id}`)}
          onCancel={() => navigate(`/tickets/${route.id}`)}
        />
      );
      break;
    case 'handovers':
      content = <HandoversPage me={me} onCountChange={setHandoverCount} />;
      break;
    case 'agents':
      content = isAdmin ? <AgentsPage me={me} /> : <Denied />;
      break;
    case 'routing':
      content = isAdmin ? <RoutingPage /> : <Denied />;
      break;
    case 'groups':
      content = <GroupsPage />;
      break;
    case 'simulate-email':
      content = EMAIL_SIMULATOR_ENABLED ? (
        <SimulateEmailPage onOpen={(id) => navigate(`/tickets/${id}`)} />
      ) : (
        <Denied />
      );
      break;
    default:
      content = <Dashboard onOpen={(id) => navigate(`/tickets/${id}`)} />;
  }

  function refreshSignal() {
    window.dispatchEvent(new CustomEvent('td:changed'));
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand" onClick={() => navigate('/')} role="button" tabIndex={0}>
          <span className="brand-mark">IT</span>
          <span className="brand-text">
            <strong>Helpdesk</strong>
            <small>Service Console</small>
          </span>
        </div>
        <nav className="side-nav">
          {navGroups.map((group) => (
            <div key={group.label} className={`side-group ${group.dev ? 'is-dev' : ''}`}>
              <div className="side-group-label">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.path}
                  className={`nav-item ${currentPath(route) === item.path ? 'active' : ''}`}
                  onClick={() => navigate(item.path)}
                >
                  <span className="nav-icon" aria-hidden="true"><NavIcon name={item.icon} /></span>
                  <span>{item.label}</span>
                  {item.badge > 0 && <span className="nav-badge">{item.badge}</span>}
                  {item.dev && <span className="chip-dev">DEV</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <AvailabilityControl me={me} onChanged={setMe} />
          <div className="sidebar-row">
            <span className="sidebar-row-label">Theme</span>
            <ThemeToggle />
          </div>
          <div className="user-card">
            <span className="avatar avatar-lg" style={{ '--avatar-h': avatarHue(me.name || me.email) }}>
              {String(me.name || me.email || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
            </span>
            <span className="user-meta">
              <strong>{me.name || me.email}</strong>
              <small>{isAdmin ? 'Administrator' : me.team?.name || 'Agent'}</small>
            </span>
          </div>
          <button className="btn btn-ghost btn-block" onClick={handleLogout}>Sign out</button>
        </div>
      </aside>

      <main className="content">
        <ErrorBoundary key={route.name + (route.id ?? '')}>{content}</ErrorBoundary>
      </main>
    </div>
  );
}

function Denied() {
  return (
    <div className="page">
      <div className="callout callout-error">
        <div>
          <strong>Access denied.</strong>
          <div className="muted">Your account does not have permission to view this area.</div>
        </div>
      </div>
    </div>
  );
}

function parseHash() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const detailMatch = /^\/tickets\/(\d+)$/.exec(hash);
  if (detailMatch) return { name: 'detail', id: Number(detailMatch[1]), path: `/tickets/${detailMatch[1]}` };
  const editMatch = /^\/tickets\/(\d+)\/edit$/.exec(hash);
  if (editMatch) return { name: 'edit', id: Number(editMatch[1]), path: `/tickets/${editMatch[1]}` };
  switch (hash) {
    case '/tickets': return { name: 'list', path: '/tickets' };
    case '/tickets/new': return { name: 'new', path: '/tickets' };
    case '/handovers': return { name: 'handovers', path: '/handovers' };
    case '/agents': return { name: 'agents', path: '/agents' };
    case '/routing': return { name: 'routing', path: '/routing' };
    case '/groups': return { name: 'groups', path: '/groups' };
    case '/simulate-email': return { name: 'simulate-email', path: '/simulate-email' };
    default: return { name: 'dashboard', path: '/' };
  }
}

function currentPath(route) {
  if (route.name === 'new') return '/tickets/new';
  return route.path || '/';
}
