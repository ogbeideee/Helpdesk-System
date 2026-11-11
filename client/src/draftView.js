const TTL = 12 * 60 * 60 * 1000;
export const draftKey = (account, ticket) => `td_draft:${account}:${ticket}`;
export function readDraft(storage, key, now = Date.now()) {
  try {
    const data = JSON.parse(storage.getItem(key) || 'null');
    if (!data || now - data.at > TTL || data.at > now || !['public', 'internal'].includes(data.mode)) {
      storage.removeItem(key); return { public: '', internal: '', mode: 'public' };
    }
    return { public: String(data.public || ''), internal: String(data.internal || ''), mode: data.mode };
  } catch { return { public: '', internal: '', mode: 'public' }; }
}
export function saveDraft(storage, key, data, now = Date.now()) {
  try {
    if (!data.public && !data.internal) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ ...data, at: now }));
    return true;
  } catch { return false; }
}
