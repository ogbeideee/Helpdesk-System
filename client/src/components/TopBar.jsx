import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { CATEGORIES } from '../constants.js';
import { Icon, Avatar, usePopover, avatarHue, initials, timeAgo, StateBadge } from './ui.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import NotificationBell from './NotificationBell.jsx';

/* ------------------------------------------------------------------ */
/* Global search                                                       */
/* ------------------------------------------------------------------ */

/**
 * One search field for the whole console. Tickets come from the ticket list
 * endpoint (the same one the queue uses, so the same matching rules apply);
 * people and categories are matched locally against reference data the
 * dashboard already returns.
 *
 * Choosing a person or a category does not invent a view — it opens the ticket
 * queue with that filter already applied.
 */
function GlobalSearch({ people, onFirstUse }) {
  const [q, setQ] = useState('');
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const { open, setOpen, close, anchorProps } = usePopover();
  const inputRef = useRef(null);

  // Ctrl/Cmd-K focuses the field from anywhere, matching the hint shown in it.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
        onFirstUse();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen, onFirstUse]);

  const term = q.trim();

  useEffect(() => {
    if (term.length < 2) {
      setTickets([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .listTickets({ q: term, limit: 6 })
        .then((list) => { if (!cancelled) setTickets(list); })
        .catch(() => { if (!cancelled) setTickets([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [term]);

  const results = useMemo(() => {
    if (term.length < 2) return [];
    const needle = term.toLowerCase();
    const out = tickets.slice(0, 6).map((t) => ({
      kind: 'ticket',
      key: `t${t.id}`,
      href: `#/tickets/${t.id}`,
      ticket: t,
    }));
    for (const p of people) {
      if (out.length >= 12) break;
      const hay = `${p.name} ${p.email || ''}`.toLowerCase();
      if (hay.includes(needle)) {
        out.push({
          kind: 'person',
          key: `p${p.agentId}`,
          href: `#/tickets?agentId=${p.agentId}`,
          person: p,
        });
      }
    }
    for (const c of CATEGORIES) {
      if (c.toLowerCase().includes(needle)) {
        out.push({
          kind: 'category',
          key: `c${c}`,
          href: `#/tickets?category=${encodeURIComponent(c)}`,
          category: c,
        });
      }
    }
    return out;
  }, [term, tickets, people]);

  useEffect(() => { setActive(0); }, [term, results.length]);

  function go(item) {
    if (!item) return;
    window.location.hash = item.href.replace(/^#/, '');
    setQ('');
    close();
    inputRef.current?.blur();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { setQ(''); close(); inputRef.current?.blur(); return; }
    if (!results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % results.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + results.length) % results.length); }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
  }

  const showPanel = open && term.length > 0;

  return (
    <div {...anchorProps} className={`${anchorProps.className} global-search`}>
      <div className={`search-field search-field-global ${open ? 'is-open' : ''}`}>
        <span className="search-icon"><Icon name="search" size={15} /></span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="global-search-results"
          aria-autocomplete="list"
          placeholder="Search tickets, users, categories…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); onFirstUse(); }}
          onKeyDown={onKeyDown}
          aria-label="Search tickets, users and categories"
        />
        <kbd className="kbd-hint" aria-hidden="true">Ctrl K</kbd>
      </div>

      {showPanel && (
        <div className="menu menu-search" id="global-search-results" role="listbox">
          {term.length < 2 ? (
            <div className="menu-empty"><Icon name="search" size={16} /><span>Keep typing…</span></div>
          ) : loading && !results.length ? (
            <div className="menu-empty"><span className="spinner spinner-sm" /><span>Searching…</span></div>
          ) : !results.length ? (
            <div className="menu-empty"><Icon name="inbox" size={16} /><span>No match for “{term}”.</span></div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.key}
                type="button"
                role="option"
                aria-selected={i === active}
                className={`search-result ${i === active ? 'is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(r)}
              >
                {r.kind === 'ticket' && (
                  <>
                    <span className="search-kind mono-sm">{r.ticket.ticketNumber}</span>
                    <span className="search-main">
                      <span className="search-title">{r.ticket.shortDescription}</span>
                      <span className="search-sub">{r.ticket.requesterName || r.ticket.requesterEmail}</span>
                    </span>
                    <StateBadge state={r.ticket.state} />
                    <span className="search-age tnum">{timeAgo(r.ticket.createdAt)}</span>
                  </>
                )}
                {r.kind === 'person' && (
                  <>
                    <Avatar name={r.person.name} size={22} />
                    <span className="search-main">
                      <span className="search-title">{r.person.name}</span>
                      <span className="search-sub">{r.person.email}</span>
                    </span>
                    <span className="search-tag">{r.person.openTickets} open</span>
                  </>
                )}
                {r.kind === 'category' && (
                  <>
                    <span className="search-kind-icon"><Icon name="folder" size={15} /></span>
                    <span className="search-main">
                      <span className="search-title">{r.category}</span>
                      <span className="search-sub">Open the queue filtered to this category</span>
                    </span>
                  </>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Account menu                                                        */
/* ------------------------------------------------------------------ */

function AccountMenu({ me, isAdmin, onLogout }) {
  const { open, toggle, close, anchorProps } = usePopover();
  const label = me.name || me.email;

  function go(path) {
    window.location.hash = path;
    close();
  }

  return (
    <div {...anchorProps}>
      <button
        type="button"
        className="account-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${label}`}
        onClick={toggle}
      >
        <span className="avatar" style={{ width: 30, height: 30, fontSize: 11.5, '--avatar-h': avatarHue(label) }}>
          {initials(label)}
        </span>
      </button>

      {open && (
        <div className="menu menu-right" role="menu">
          <div className="menu-identity">
            <Avatar name={label} size={34} />
            <div className="menu-identity-text">
              <strong>{label}</strong>
              <small>{me.email}</small>
              <span className={`chip chip-role-${isAdmin ? 'admin' : me.role || 'agent'}`}>
                {isAdmin ? 'Administrator' : me.team?.name || 'Agent'}
              </span>
            </div>
          </div>
          <div className="menu-sep" />
          <button type="button" role="menuitem" className="menu-item" onClick={() => go(`/tickets?agentId=${me.id}`)}>
            <Icon name="tickets" size={15} className="menu-item-icon" />
            <span>My tickets</span>
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => go('/handovers')}>
            <Icon name="handovers" size={15} className="menu-item-icon" />
            <span>Handovers</span>
          </button>
          <div className="menu-sep" />
          <button type="button" role="menuitem" className="menu-item is-danger" onClick={() => { close(); onLogout(); }}>
            <Icon name="logout" size={15} className="menu-item-icon" />
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

export default function TopBar({ title, subtitle, dev, me, isAdmin, onLogout }) {
  const [people, setPeople] = useState([]);
  const peopleAsked = useRef(false);

  /* People are only needed once someone actually reaches for search, so the
     reference data is fetched then rather than on every navigation. */
  const loadPeople = useCallback(() => {
    if (peopleAsked.current) return;
    peopleAsked.current = true;
    api.dashboard().then((d) => setPeople(d.ticketsPerAgent || [])).catch(() => {});
  }, []);

  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>
          {title}
          {dev && <span className="chip-dev topbar-dev">DEV</span>}
        </h1>
        {subtitle && <p>{subtitle}</p>}
      </div>

      <GlobalSearch people={people} onFirstUse={loadPeople} />

      <div className="topbar-actions">
        <ThemeToggle />
        <NotificationBell />
        <AccountMenu me={me} isAdmin={isAdmin} onLogout={onLogout} />
      </div>
    </header>
  );
}
