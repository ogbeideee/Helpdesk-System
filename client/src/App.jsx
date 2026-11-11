import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { api, getToken, refreshPageReads } from './api.js';
import { startPageRefresh } from './refreshScheduler.js';
import { PageHeaderContext } from './pageHeader.js';
import { Avatar, Icon } from './components/ui.jsx';
import Login from './components/Login.jsx';
import StatusPage from './components/StatusPage.jsx';
import ConfirmResolutionPage from './components/ConfirmResolutionPage.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Dashboard from './components/Dashboard.jsx';
import TicketsPage from './components/TicketsPage.jsx';
import AvailabilityControl from './components/AvailabilityControl.jsx';
import TopBar from './components/TopBar.jsx';

// Everything below the first screen loads on demand: each screen is its own
// chunk, fetched the first time its route is opened. The shell — Login,
// Dashboard, the ticket list and the sidebar — stays in the entry bundle.
const screenImports = {
  WeeklyReportPage: () => import('./components/WeeklyReportPage.jsx'),
  TicketDetail: () => import('./components/TicketDetail.jsx'),
  TicketForm: () => import('./components/TicketForm.jsx'),
  AgentsPage: () => import('./components/AgentsPage.jsx'),
  RoutingPage: () => import('./components/RoutingPage.jsx'),
  SlaSettingsPage: () => import('./components/SlaSettingsPage.jsx'),
  SlaReportsPage: () => import('./components/SlaReportsPage.jsx'),
  ReportsPage: () => import('./components/ReportsPage.jsx'),
  AuditTrailPage: () => import('./components/AuditTrailPage.jsx'),
  GroupsPage: () => import('./components/GroupsPage.jsx'),
  HandoversPage: () => import('./components/HandoversPage.jsx'),
  EmailRulesPage: () => import('./components/EmailRulesPage.jsx'),
  Microsoft365Page: () => import('./components/Microsoft365Page.jsx'),
  SettingsPage: () => import('./components/SettingsPage.jsx'),
};
const TicketDetail = lazy(screenImports.TicketDetail);
const TicketForm = lazy(screenImports.TicketForm);
const AgentsPage = lazy(screenImports.AgentsPage);
const RoutingPage = lazy(screenImports.RoutingPage);
const SlaSettingsPage = lazy(screenImports.SlaSettingsPage);
const SlaReportsPage = lazy(screenImports.SlaReportsPage);
const ReportsPage = lazy(screenImports.ReportsPage);
const WeeklyReportPage = lazy(screenImports.WeeklyReportPage);
const AuditTrailPage = lazy(screenImports.AuditTrailPage);
const GroupsPage = lazy(screenImports.GroupsPage);
const HandoversPage = lazy(screenImports.HandoversPage);
const EmailRulesPage = lazy(screenImports.EmailRulesPage);
const Microsoft365Page = lazy(screenImports.Microsoft365Page);
const SettingsPage = lazy(screenImports.SettingsPage);
const NAV_SCREENS = {
  '/weekly-report': 'WeeklyReportPage',
  '/handovers': 'HandoversPage', '/agents': 'AgentsPage', '/reports': 'ReportsPage',
  '/routing': 'RoutingPage', '/email-rules': 'EmailRulesPage', '/m365': 'Microsoft365Page',
  '/sla-settings': 'SlaSettingsPage', '/sla-reports': 'SlaReportsPage',
  '/audit': 'AuditTrailPage', '/groups': 'GroupsPage',
};
function preloadScreen(path) {
  const load = screenImports[NAV_SCREENS[path]];
  if (load) load().catch(() => {});
}
// The email simulator is no longer exposed in the client: live mail arrives
// through the real M365-to-Gmail IMAP path, not a dev route.
const SIDEBAR_KEY = 'td_sidebar';
/* Which navigation sections the user has opened or closed. Only an explicit
   choice is stored, so a section added in a later release arrives open rather
   than silently hidden behind a control nobody has touched. */
const NAV_GROUPS_KEY = 'td_nav_groups';
function readNavGroups() {
  try {
    const raw = localStorage.getItem(NAV_GROUPS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
/* The width below which the navigation rail becomes a drawer. Kept in step
   with the `max-width: 768px` block in index.css — change both together. */
const MOBILE_NAV_QUERY = '(max-width: 768px)';

/**
 * Default header text per route. A screen with something better to say — a live
 * count, the ticket it is showing — overrides it through `usePageHeader`.
 */
const ROUTE_META = {
  'weekly-report': {title:'My Weekly Report',subtitle:'Record activities, review your week and export to Excel.'},
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
  const [openNavGroups, setOpenNavGroups] = useState(readNavGroups);

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
    return startPageRefresh({ window, document, refresh: refreshPageReads });
  }, [me]);

  useEffect(() => {
    if (!me) return undefined;
    let cancelled = false;
    let pending = false;
    const poll = () => {
      if (document.hidden || pending) return;
      pending = true;
      return api
        .handoverInbox()
        .then((d) => { if (!cancelled) setHandoverCount(d.pending.length); })
        .catch(() => {})
        .finally(() => { pending = false; });
    };
    poll();
    const updated = event => { if (event.detail?.path === '/handovers/inbox') poll(); };
    window.addEventListener('td:refresh-page', poll);
    window.addEventListener('td:read-updated', updated);
    return () => {
      cancelled = true;
      window.removeEventListener('td:refresh-page', poll);
      window.removeEventListener('td:read-updated', updated);
    };
  }, [me]);

  const isAdmin = me?.role === 'admin';

  const navGroups = useMemo(() => {
    const operations = [
      { path: '/', label: 'Dashboard', icon: 'dashboard' },
      { path: '/tickets', label: 'Tickets', icon: 'tickets' },
      { path: '/handovers', label: 'Handovers', icon: 'handovers', badge: handoverCount },
      { path: '/weekly-report', label: 'My Weekly Report', icon: 'reports' },
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
    /* Operations is never collapsible: it is where the work is, and it should
       not be possible to hide it. Administration starts closed — eight items
       already force the rail to scroll — and Workspace stays open for its one
       entry, which nobody benefits from folding away. */
    return [
      { key: 'operations', label: 'Operations', items: operations },
      ...(admin.length
        ? [{ key: 'administration', label: 'Administration', items: admin, collapsible: true, defaultOpen: false }]
        : []),
      { key: 'workspace', label: 'Workspace', items: workspace, collapsible: true, defaultOpen: true },
    ];
  }, [isAdmin, handoverCount]);

  /** A section is open unless the user has said otherwise (or it defaults shut). */
  const navGroupOpen = (group) => openNavGroups[group.key] ?? group.defaultOpen ?? true;

  function toggleNavGroup(group) {
    const next = !navGroupOpen(group);
    setOpenNavGroups((current) => {
      const updated = { ...current, [group.key]: next };
      try { localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(updated)); } catch { /* storage blocked */ }
      return updated;
    });
  }

  function navigate(path) {
    window.location.hash = path;
    // A drawer that stays open hides the screen it just navigated to.
    setNavOpen(false);
  }

  async function handleLogout() {
    try { await api.logout(); }
    catch { window.alert('Sign-out could not be completed. Please retry while connected.'); return; }
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
  if (route.name === 'confirm') return <ConfirmResolutionPage token={route.token} />;
  if (me === undefined) return <div className="boot-screen"><span className="spinner" /></div>;
  if (me === null) return <Login onLogin={setMe} />;

  let content;
  switch (route.name) {
    case 'list':
      content = <TicketsPage agent={me} initialFilters={route.query} onOpen={(id) => navigate(`/tickets/${id}`)} />;
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
    case 'weekly-report':
      content = ['agent','admin'].includes(me.role) ? <WeeklyReportPage me={me} /> : <Denied />;
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
          {navGroups.map((group) => {
            // An icon-only rail has no room for a section header, so sections
            // are always open there — and the stored preference resumes the
            // moment the rail is expanded again. Otherwise a collapsed section
            // would hide its items behind a control that is not on screen.
            const open = collapsed ? true : navGroupOpen(group);
            // A collapsed section still holds the page you are on: without this
            // dot, closing Administration while viewing Routing Rules leaves
            // the rail looking like nothing is selected.
            const holdsCurrent = group.items.some((item) => currentPath(route) === item.path);
            return (
              <div key={group.key} className={`side-group ${group.dev ? 'is-dev' : ''}`}>
                {group.collapsible ? (
                  <button
                    type="button"
                    className="side-group-toggle"
                    aria-expanded={open}
                    aria-controls={`nav-group-${group.key}`}
                    onClick={() => toggleNavGroup(group)}
                  >
                    <span className="side-group-label">{group.label}</span>
                    {!open && holdsCurrent && <span className="side-group-active" aria-hidden="true" />}
                    <span className={`side-group-chevron ${open ? 'is-open' : ''}`} aria-hidden="true">
                      <Icon name="chevronDown" size={13} />
                    </span>
                  </button>
                ) : (
                  <div className="side-group-label">{group.label}</div>
                )}
                <div id={`nav-group-${group.key}`} className="side-group-items" hidden={!open}>
                  {group.items.map((item) => {
                    const active = currentPath(route) === item.path;
                    return (
                      <button
                        key={item.path}
                        className={`nav-item ${active ? 'active' : ''}`}
                        onClick={() => navigate(item.path)}
                        onMouseEnter={() => preloadScreen(item.path)}
                        onFocus={() => preloadScreen(item.path)}
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
              </div>
            );
          })}
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
          <button
            className="btn btn-ghost btn-block sidebar-signout"
            onClick={handleLogout}
            /* The visible label is hidden when the rail collapses to icons, so
               the name has to live on the button itself. */
            aria-label="Sign out"
          >
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
  // Public resolution confirmation — the "Yes, it's resolved" link in the
  // resolve email. Same signed token, one deliberate POST on the page.
  const confirmMatch = /^\/confirm\/([A-Za-z0-9._~-]+)$/.exec(hash);
  if (confirmMatch) return { name: 'confirm', token: confirmMatch[1], path: '/confirm', search, query };

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
    case '/weekly-report': return { ...base, name: 'weekly-report', path: '/weekly-report' };
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
