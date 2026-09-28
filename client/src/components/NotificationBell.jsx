import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon, usePopover, timeAgo } from './ui.jsx';
import {
  isNotificationSupported,
  getNotificationPermission,
  requestNotificationPermission,
  showDesktopNotification,
  playNotificationChime,
} from '../desktopNotification.js';

/**
 * The notification feed, in the application header.
 *
 * Supports native desktop push notifications (Chrome/Edge/Firefox) and
 * audio chimes so agents are alerted even when working in another tab or app.
 */
export default function NotificationBell() {
  const [feed, setFeed] = useState({ unread: 0, notifications: [] });
  const [perm, setPerm] = useState(() => getNotificationPermission());
  const { open, toggle, close, anchorProps } = usePopover();

  // Track the set of notification IDs we've already seen/notified for
  const initialLoadRef = useRef(true);
  const knownIdsRef = useRef(new Set());

  const handleEnableDesktop = async () => {
    const res = await requestNotificationPermission();
    setPerm(res);
  };

  const load = useCallback(() => {
    api
      .notifications()
      .then((data) => {
        setFeed(data);
        const list = data.notifications || [];

        if (initialLoadRef.current) {
          // On first page boot, record existing IDs so we only alert for genuinely new ones
          initialLoadRef.current = false;
          list.forEach((n) => knownIdsRef.current.add(n.id));
          return;
        }

        // Identify new unread notifications that arrived since last poll
        const newUnread = list.filter((n) => !n.readAt && !knownIdsRef.current.has(n.id));

        if (newUnread.length > 0) {
          playNotificationChime();

          newUnread.forEach((n) => {
            knownIdsRef.current.add(n.id);
            showDesktopNotification({
              title: n.title,
              body: n.body,
              ticketId: n.ticket?.id,
              onClick: () => {
                if (n.ticket?.id) {
                  window.location.hash = `#/tickets/${n.ticket.id}`;
                }
              },
            });
          });
        }

        // Always ensure known list is tracking all returned IDs
        list.forEach((n) => knownIdsRef.current.add(n.id));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const unread = feed.unread || 0;
  const list = feed.notifications || [];
  const canPromptDesktop = isNotificationSupported() && perm === 'default';

  return (
    <div {...anchorProps}>
      <button
        type="button"
        className="icon-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={() => {
          toggle();
          if (!open) load();
        }}
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
                onClick={async () => {
                  await api.markNotificationsRead().catch(() => {});
                  load();
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {canPromptDesktop && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                margin: '4px 8px 8px 8px',
                background: 'var(--surface-sunken)',
                borderRadius: 6,
                fontSize: 12,
              }}
            >
              <span>Enable desktop alerts for new tickets</span>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}
                onClick={handleEnableDesktop}
              >
                Enable
              </button>
            </div>
          )}

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

