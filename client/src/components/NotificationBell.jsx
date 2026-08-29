import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon, usePopover, timeAgo } from './ui.jsx';

/**
 * The notification feed, in the application header.
 *
 * It used to hang off the sidebar availability switch, which put an unrelated
 * inbox inside a control about accepting work. The feed itself is unchanged:
 * the same endpoint, the same read semantics.
 */
export default function NotificationBell() {
  const [feed, setFeed] = useState({ unread: 0, notifications: [] });
  const { open, toggle, close, anchorProps } = usePopover();

  const load = useCallback(() => {
    api.notifications().then(setFeed).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const unread = feed.unread || 0;
  const list = feed.notifications || [];

  return (
    <div {...anchorProps}>
      <button
        type="button"
        className="icon-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={() => { toggle(); if (!open) load(); }}
      >
        <Icon name="bell" size={17} />
        {unread > 0 && <span className="icon-btn-badge tnum">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <div className="menu menu-right menu-wide" role="dialog" aria-label="Notifications">
          <div className="menu-head">
            <span className="menu-label">Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                className="btn-link"
                onClick={async () => { await api.markNotificationsRead().catch(() => {}); load(); }}
              >
                Mark all read
              </button>
            )}
          </div>

          {list.length === 0 ? (
            <div className="menu-empty">
              <Icon name="inbox" size={18} />
              <span>Nothing yet.</span>
            </div>
          ) : (
            <ul className="notif-feed">
              {list.map((n) => (
                <li key={n.id} className={`notif-entry ${n.readAt ? 'is-read' : ''}`}>
                  <span className="notif-marker" aria-hidden="true" />
                  <div className="notif-body">
                    <strong>{n.title}</strong>
                    {n.body && <span className="notif-text">{n.body}</span>}
                    <span className="notif-meta">
                      {n.ticket && (
                        <a
                          href={`#/tickets/${n.ticket.id}`}
                          onClick={close}
                          className="notif-link mono-sm"
                        >
                          {n.ticket.ticketNumber}
                        </a>
                      )}
                      {n.createdAt && <span className="muted">{timeAgo(n.createdAt)}</span>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
