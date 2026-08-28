import { useEffect, useState } from 'react';
import { api, getToken } from './api.js';
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

const EMAIL_SIMULATOR_ENABLED = import.meta.env.VITE_ENABLE_EMAIL_SIMULATOR !== 'false';

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = checking, null = signed out
  const [route, setRoute] = useState(() => parseHash());
  // Handover requests waiting for this person to answer, shown on the nav.
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

  // Handovers expire and queued ones activate on their own, so the badge is
  // refreshed on a timer rather than only on navigation.
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

  const isAdmin = me.role === 'admin';
  const nav = [
    { path: '/', label: 'Dashboard', icon: '▤' },
    { path: '/tickets', label: 'Tickets', icon: '🎫' },
    { path: '/handovers', label: 'Handovers', icon: '🤝', badge: handoverCount },
    ...(isAdmin
      ? [
          { path: '/agents', label: 'Agents', icon: '👤' },
          { path: '/routing', label: 'Routing Rules', icon: '⇄' },
        ]
      : []),
    { path: '/groups', label: 'Assignment Groups', icon: '⛁' },
    ...(EMAIL_SIMULATOR_ENABLED
      ? [{ path: '/simulate-email', label: 'Simulate Email', icon: '✉️', dev: true }]
      : []),
  ];

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
    // detail page notifies listeners (e.g. dashboard counts) via storage bump;
    // simple approach: dispatch a custom event other views may ignore.
    window.dispatchEvent(new CustomEvent('td:changed'));
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand" onClick={() => navigate('/')} role="button" tabIndex={0}>
          <span className="brand-mark">IT</span>
          <span className="brand-text">
            <strong>IT HELPDESK</strong>
            <small>Service Desk</small>
          </span>
        </div>
        <nav className="side-nav">
          {nav.map((item) => (
            <button
              key={item.path}
              className={`nav-item ${currentPath(route) === item.path ? 'active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
              {item.badge > 0 && <span className="nav-badge">{item.badge}</span>}
              {item.dev && <span className="chip chip-dev">DEV</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <AvailabilityControl me={me} onChanged={setMe} />
          <div className="user-card">
            <span className={`avatar avatar-lg`} style={{ background: 'hsl(212 45% 26%)', color: 'hsl(212 90% 78%)' }}>
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
        {/* keyed by route so navigating away clears a previous page error */}
        <ErrorBoundary key={route.name + (route.id ?? '')}>{content}</ErrorBoundary>
      </main>
    </div>
  );
}

function Denied() {
  return (
    <div className="page">
      <div className="callout callout-error">
        <strong>Access denied.</strong>
        <div className="muted">Your account does not have permission to view this area.</div>
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
