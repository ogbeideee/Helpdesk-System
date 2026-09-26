import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { api, getToken } from './api.js';
import { PageHeaderContext } from './pageHeader.js';
import { Avatar, Icon } from './components/ui.jsx';
import Login from './components/Login.jsx';
import StatusPage from './components/StatusPage.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Dashboard from './components/Dashboard.jsx';
import TicketsPage from './components/TicketsPage.jsx';
import AvailabilityControl from './components/AvailabilityControl.jsx';
import TopBar from './components/TopBar.jsx';

// Everything below the first screen loads on demand: each screen is its own
// chunk, fetched the first time its route is opened. The shell — Login,
// Dashboard, the ticket list and the sidebar — stays in the entry bundle.
const TicketDetail = lazy(() => import('./components/TicketDetail.jsx'));
const TicketForm = lazy(() => import('./components/TicketForm.jsx'));
const AgentsPage = lazy(() => import('./components/AgentsPage.jsx'));
const RoutingPage = lazy(() => import('./components/RoutingPage.jsx'));
const SlaSettingsPage = lazy(() => import('./components/SlaSettingsPage.jsx'));
const SlaReportsPage = lazy(() => import('./components/SlaReportsPage.jsx'));
const ReportsPage = lazy(() => import('./components/ReportsPage.jsx'));
const AuditTrailPage = lazy(() => import('./components/AuditTrailPage.jsx'));
const GroupsPage = lazy(() => import('./components/GroupsPage.jsx'));
const HandoversPage = lazy(() => import('./components/HandoversPage.jsx'));
const EmailRulesPage = lazy(() => import('./components/EmailRulesPage.jsx'));
const Microsoft365Page = lazy(() => import('./components/Microsoft365Page.jsx'));
const SettingsPage = lazy(() => import('./components/SettingsPage.jsx'));
// The email simulator is no longer exposed in the client: live mail arrives
// through the real M365-to-Gmail IMAP path, not a dev route.
const SIDEBAR_KEY = 'td_sidebar';
/* The width below which the navigation rail becomes a drawer. Kept in step
   with the `max-width: 768px` block in index.css — change both together. */
const MOBILE_NAV_QUERY = '(max-width: 768px)';

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
  settings: { title: 'Settings', subtitle: 'Your account and, for administrators, system controls.' },
  agents: { title: 'Agents', subtitle: 'Availability, skill and workload for the assignment engine.' },
  routing: { title: 'Routing Rules', subtitle: 'Evaluated in order — the lowest priority number that matches wins.' },
  'sla-settings': { title: 'SLA Settings', subtitle: 'Targets, working calendar and public holidays. Applies to SLA cycles started after saving.' },
  'sla-reports': { title: 'SLA Reports', subtitle: 'Completed-cycle performance and the current live state, served by the reporting API.' },
  reports: { title: 'Reports', subtitle: 'Operational reporting over tickets and SLA — every figure served by the reports API.' },
  audit: { title: 'Audit Trail', subtitle: 'The unified record of important system actions — served read-only by the audit API.' },
  'email-rules': { title: 'Email Parsing Rules', subtitle: 'Keyword rules the parser evaluates on inbound email — a rule only sets the ticket fields it names.' },
  m365: { title: 'Microsoft 365', subtitle: 'Graph email integration status and configuration — a real tenant is connected later through environment values, never through this console.' },
  groups: { title: 'Assignment Groups', subtitle: 'Routing targets for the assignment engine.' },
};

export default function App() {
  const [me, setMe] = useState(undefined);
  const [route, setRoute] = useState(() => parseHash());
  const [handoverCount, setHandoverCount] = useState(0);
  const [pageMeta, setPageMeta] = useState(null);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
  });
  // Phone-only state: the rail slides over the workspace instead of taking a
  // column of its own. It never applies on a wide viewport.
  const [navOpen, setNavOpen] = useState(false);

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

  const closeNav = useCallback(() => setNavOpen(false), []);

  /* Leaving the phone layout closes the drawer, so returning to a wide window
     never leaves the rail in a state the wide layout cannot show. */
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_NAV_QUERY);
    const onChange = () => { if (!mq.matches) setNavOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  /* While the drawer is open: Escape closes it, and the page behind it stays
     put — on a phone a scrolling background reads as a broken overlay. */
  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('is-nav-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('is-nav-open');
    };
  }, [navOpen]);

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
          { path: '/reports', label: 'Reports', icon: 'reports' },
          { path: '/routing', label: 'Routing Rules', icon: 'routing' },
          { path: '/email-rules', label: 'Email Rules', icon: 'mail' },
          { path: '/m365', label: 'Microsoft 365', icon: 'cloud' },
          { path: '/sla-settings', label: 'SLA Settings', icon: 'clock' },
          { path: '/sla-reports', label: 'SLA Reports', icon: 'activity' },
          { path: '/audit', label: 'Audit Trail', icon: 'trail' },
        ]
      : [];
    const workspace = [{ path: '/groups', label: 'Assignment Groups', icon: 'groups' }];
    return [
      { label: 'Operations', items: operations },
      ...(admin.length ? [{ label: 'Administration', items: admin }] : []),
      { label: 'Workspace', items: workspace },
    ];
  }, [isAdmin, handoverCount]);

  function navigate(path) {
    window.location.hash = path;
    // A drawer that stays open hides the screen it just navigated to.
    setNavOpen(false);
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

  // The requester status page is public: it renders without a session and
  // without the staff shell — and without waiting on /api/auth/me.
  if (route.name === 'status') return <StatusPage token={route.token} />;
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
    case 'settings':
      content = <SettingsPage me={me} onUpdated={setMe} />;
      break;
    case 'agents':
      content = isAdmin ? <AgentsPage me={me} /> : <Denied />;
      break;
    case 'email-rules':
      content = isAdmin ? <EmailRulesPage /> : <Denied />;
      break;
    case 'm365':
      content = isAdmin ? <Microsoft365Page /> : <Denied />;
      break;
    case 'routing':
      content = isAdmin ? <RoutingPage /> : <Denied />;
      break;
    case 'sla-settings':
      content = isAdmin ? <SlaSettingsPage /> : <Denied />;
      break;
    case 'sla-reports':
      content = isAdmin ? <SlaReportsPage /> : <Denied />;
      break;
    case 'reports':
      content = isAdmin ? <ReportsPage /> : <Denied />;
      break;
    case 'audit':
      content = isAdmin ? <AuditTrailPage /> : <Denied />;
      break;
    case 'groups':
      content = <GroupsPage />;
      break;
    default:
      content = <Dashboard me={me} handoverCount={handoverCount} onOpen={(id) => navigate(`/tickets/${id}`)} />;
  }

  const meta = ROUTE_META[route.name] || ROUTE_META.dashboard;
  const title = pageMeta?.title || meta.title;
  const subtitle = pageMeta?.subtitle ?? meta.subtitle;
  const userLabel = me.name || me.email;

  return (
    <div className={`shell ${collapsed ? 'is-collapsed' : ''} ${navOpen ? 'is-nav-open' : ''}`}>
      {/* The scrim exists at every width — CSS only shows it while the drawer is
          open on a phone. As a button it is reachable by keyboard, and
          `visibility: hidden` keeps it out of the tab order when closed. */}
      <button
        type="button"
        className="nav-scrim"
        aria-label="Close navigation"
        tabIndex={navOpen ? 0 : -1}
        onClick={closeNav}
      />
      <aside className="sidebar" id="app-nav">
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
          navOpen={navOpen}
          onOpenNav={() => setNavOpen(true)}
          onLogout={handleLogout}
          routeKey={`${route.name}:${route.path}:${route.search}`}
        />
        <main className="content">
          <PageHeaderContext.Provider value={setPageMeta}>
            <ErrorBoundary key={route.name + (route.id ?? '') + (route.search || '')}>
              <Suspense fallback={<div className="page"><span className="spinner" /></div>}>{content}</Suspense>
            </ErrorBoundary>
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
  // Public requester status lookup — the signed link from helpdesk emails.
  const statusMatch = /^\/status\/([A-Za-z0-9._~-]+)$/.exec(hash);
  if (statusMatch) return { name: 'status', token: statusMatch[1], path: '/status', search, query };

  const base = { search, query };
  switch (hash) {
    case '/tickets': return { ...base, name: 'list', path: '/tickets' };
    case '/tickets/new': return { ...base, name: 'new', path: '/tickets' };
    case '/handovers': return { ...base, name: 'handovers', path: '/handovers' };
    case '/settings': return { ...base, name: 'settings', path: '/settings' };
    case '/agents': return { ...base, name: 'agents', path: '/agents' };
    case '/routing': return { ...base, name: 'routing', path: '/routing' };
    case '/sla-settings': return { ...base, name: 'sla-settings', path: '/sla-settings' };
    case '/sla-reports': return { ...base, name: 'sla-reports', path: '/sla-reports' };
    case '/reports': return { ...base, name: 'reports', path: '/reports' };
    case '/audit': return { ...base, name: 'audit', path: '/audit' };
    case '/email-rules': return { ...base, name: 'email-rules', path: '/email-rules' };
    case '/m365': return { ...base, name: 'm365', path: '/m365' };
    case '/groups': return { ...base, name: 'groups', path: '/groups' };
    default: return { ...base, name: 'dashboard', path: '/' };
  }
}

function currentPath(route) {
  if (route.name === 'new') return '/tickets/new';
  return route.path || '/';
}
