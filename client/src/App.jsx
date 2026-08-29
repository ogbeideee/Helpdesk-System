import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getToken } from './api.js';
import { PageHeaderContext } from './pageHeader.js';
import { Avatar, Icon } from './components/ui.jsx';
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
import TopBar from './components/TopBar.jsx';

const EMAIL_SIMULATOR_ENABLED = import.meta.env.VITE_ENABLE_EMAIL_SIMULATOR !== 'false';
const SIDEBAR_KEY = 'td_sidebar';

/**
 * Default header text per route. A screen with something better to say — a live
 * count, the ticket it is showing — overrides it through `usePageHeader`.
 */
const ROUTE_META = {
  dashboard: { title: 'Service Desk Overview', subtitle: 'Live operations view of the IT helpdesk' },
  list: { title: 'Tickets', subtitle: 'Every request in the queue' },
  detail: { title: 'Ticket', subtitle: null },
  new: { title: 'New Ticket', subtitle: 'Log a walk-up or phone request — the assignment engine routes it automatically.' },
  edit: { title: 'Edit Ticket', subtitle: 'Subject and description can be corrected here.' },
  handovers: { title: 'Handovers', subtitle: 'A handover is an offer — the ticket only changes owner when you accept it.' },
  agents: { title: 'Agents', subtitle: 'Availability, skill and workload for the assignment engine.' },
  routing: { title: 'Routing Rules', subtitle: 'Evaluated in order — the lowest priority number that matches wins.' },
  groups: { title: 'Assignment Groups', subtitle: 'Routing targets for the assignment engine.' },
  'simulate-email': {
    title: 'Simulate Incoming Email',
    subtitle: 'Stands in for the Microsoft 365 mailbox. Submission runs the production intake pipeline.',
    dev: true,
  },
};

export default function App() {
  const [me, setMe] = useState(undefined);
  const [route, setRoute] = useState(() => parseHash());
  const [handoverCount, setHandoverCount] = useState(0);
  const [pageMeta, setPageMeta] = useState(null);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
  });

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

  function toggleSidebar() {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* storage blocked */ }
      return next;
    });
  }

  const refreshSignal = useCallback(() => {
    window.dispatchEvent(new CustomEvent('td:changed'));
  }, []);

  if (me === undefined) return <div className="boot-screen"><span className="spinner" /></div>;
  if (me === null) return <Login onLogin={setMe} />;

  let content;
  switch (route.name) {
    case 'list':
      content = <TicketsPage initialFilters={route.query} onOpen={(id) => navigate(`/tickets/${id}`)} />;
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
      content = <Dashboard me={me} handoverCount={handoverCount} onOpen={(id) => navigate(`/tickets/${id}`)} />;
  }

  const meta = ROUTE_META[route.name] || ROUTE_META.dashboard;
  const title = pageMeta?.title || meta.title;
  const subtitle = pageMeta?.subtitle ?? meta.subtitle;
  const userLabel = me.name || me.email;

  return (
    <div className={`shell ${collapsed ? 'is-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand" onClick={() => navigate('/')} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') navigate('/'); }}>
            <span className="brand-mark">IT</span>
            <span className="brand-text">
              <strong>Helpdesk</strong>
              <small>Service Console</small>
            </span>
          </div>
          <button
            type="button"
            className="sidebar-collapse"
            onClick={toggleSidebar}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            <Icon name="collapse" size={16} />
          </button>
        </div>

        <nav className="side-nav">
          {navGroups.map((group) => (
            <div key={group.label} className={`side-group ${group.dev ? 'is-dev' : ''}`}>
              <div className="side-group-label">{group.label}</div>
              {group.items.map((item) => {
                const active = currentPath(route) === item.path;
                return (
                  <button
                    key={item.path}
                    className={`nav-item ${active ? 'active' : ''}`}
                    onClick={() => navigate(item.path)}
                    aria-current={active ? 'page' : undefined}
                    title={collapsed ? item.label : undefined}
                  >
                    <span className="nav-icon" aria-hidden="true"><Icon name={item.icon} size={16} /></span>
                    <span className="nav-label">{item.label}</span>
                    {item.badge > 0 && <span className="nav-badge">{item.badge}</span>}
                    {item.dev && <span className="chip-dev">DEV</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <AvailabilityControl me={me} onChanged={setMe} />
          <div className="user-card">
            <Avatar name={userLabel} size={32} />
            <span className="user-meta">
              <strong>{userLabel}</strong>
              <small>{isAdmin ? 'Administrator' : me.team?.name || 'Agent'}</small>
            </span>
          </div>
          <button className="btn btn-ghost btn-block sidebar-signout" onClick={handleLogout}>
            <Icon name="logout" size={15} />
            <span className="nav-label">Sign out</span>
          </button>
        </div>
      </aside>

      <div className="workspace">
        <TopBar
          title={title}
          subtitle={subtitle}
          dev={!pageMeta?.title && meta.dev}
          me={me}
          isAdmin={isAdmin}
          onLogout={handleLogout}
        />
        <main className="content">
          <PageHeaderContext.Provider value={setPageMeta}>
            <ErrorBoundary key={route.name + (route.id ?? '') + (route.search || '')}>{content}</ErrorBoundary>
          </PageHeaderContext.Provider>
        </main>
      </div>
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

/**
 * Hash routing, with an optional query string so a link can carry queue
 * filters — `#/tickets?agentId=4`. The path in front of `?` is what decides
 * the screen and the active navigation item.
 */
function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const qIndex = raw.indexOf('?');
  const hash = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const search = qIndex === -1 ? '' : raw.slice(qIndex + 1);
  const query = Object.fromEntries(new URLSearchParams(search));

  const detailMatch = /^\/tickets\/(\d+)$/.exec(hash);
  if (detailMatch) return { name: 'detail', id: Number(detailMatch[1]), path: `/tickets/${detailMatch[1]}`, search, query };
  const editMatch = /^\/tickets\/(\d+)\/edit$/.exec(hash);
  if (editMatch) return { name: 'edit', id: Number(editMatch[1]), path: `/tickets/${editMatch[1]}`, search, query };

  const base = { search, query };
  switch (hash) {
    case '/tickets': return { ...base, name: 'list', path: '/tickets' };
    case '/tickets/new': return { ...base, name: 'new', path: '/tickets' };
    case '/handovers': return { ...base, name: 'handovers', path: '/handovers' };
    case '/agents': return { ...base, name: 'agents', path: '/agents' };
    case '/routing': return { ...base, name: 'routing', path: '/routing' };
    case '/groups': return { ...base, name: 'groups', path: '/groups' };
    case '/simulate-email': return { ...base, name: 'simulate-email', path: '/simulate-email' };
    default: return { ...base, name: 'dashboard', path: '/' };
  }
}

function currentPath(route) {
  if (route.name === 'new') return '/tickets/new';
  return route.path || '/';
}
