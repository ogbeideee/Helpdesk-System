import { useEffect, useState } from 'react';
import { refreshPageReads } from '../api.js';
import { Icon } from './ui.jsx';

export default function ReadStatus() {
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const listener = ({ detail }) => {
      if (detail.error) setFailed(true);
      else if (detail.pending) { setPending(count => count + 1); setFailed(false); }
      else setPending(count => Math.max(0, count - 1));
    };
    window.addEventListener('td:read-status', listener);
    return () => window.removeEventListener('td:read-status', listener);
  }, []);
  const label = pending > 0 ? 'Refreshing…' : failed ? 'Refresh failed · Retry' : 'Refresh this page';
  return (
    <button type="button" className="icon-btn" onClick={refreshPageReads}
      disabled={pending > 0} aria-label={label} title={label}>
      {pending > 0 ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
    </button>
  );
}
