import { useState, useEffect, useRef } from 'react';
import { draftKey, readDraft, saveDraft } from './draftView.js';
export function useReplyDraft(account, ticket) {
  const key = draftKey(account, ticket);
  const [draft, setDraft] = useState(() => { try { return readDraft(sessionStorage, key); } catch { return readDraft(null, key); } });
  const [saved, setSaved] = useState(true);
  const latest = useRef(draft);
  function update(change) {
      const next = { ...latest.current, ...change };
      latest.current = next;
      let ok = false;
      try { ok = saveDraft(sessionStorage, key, next); } catch { /* storage unavailable */ }
      setSaved(ok); setDraft(next);
  }
  useEffect(() => {
    const beforeLeave = event => {
      if (saved || !(draft.public || draft.internal)) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeLeave);
    return () => window.removeEventListener('beforeunload', beforeLeave);
  }, [saved, draft]);
  return { text: draft[draft.mode], mode: draft.mode, saved,
    setText: text => update({ [draft.mode]: text }), setMode: mode => update({ mode }),
    clearSent: (mode, sentText) => { if (latest.current[mode] === sentText) update({ [mode]: '' }); } };
}
