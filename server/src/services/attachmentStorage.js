// Private object storage for inbound email attachments.
//
// The provider sits behind this small factory so it can be replaced later
// (S3, Azure Blob, ...) without touching the ingestion pipeline or the
// download endpoint. The default provider is the local filesystem: a private
// directory that is never web-served, with server-generated keys — it plays
// the role of a bucket for self-hosted deployments.
//
// Guarantees every provider must keep:
//   - keys are generated HERE, server-side, and never derive from the
//     filename (no user input ever reaches a storage path)
//   - the bucket/directory is private: nothing in it is reachable without
//     going through the authorized download endpoint
//   - put/get are injectable, so tests run against in-memory or temp storage
//     without any real object-storage credentials
//
// Credentials, bucket names and storage keys are never logged here.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Display-name sanitizer. The result is used ONLY in Content-Disposition and
 * UI labels — never for storage paths. It strips path components, separators,
 * control characters and Windows-reserved names, caps the length and always
 * yields something usable.
 */
function sanitizeFilename(name) {
  let out = String(name ?? '');
  // Take only the last path segment for every common separator.
  out = out.split(/[/\\]/).pop() || '';
  // Drop control characters and the characters Windows forbids in names.
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '');
  // Dot-segments never survive (traversal defense in depth).
  out = out.replace(/^\.+/, '').trim();
  if (out.length > 200) {
    const ext = path.extname(out).slice(0, 20);
    out = out.slice(0, 200 - ext.length) + ext;
  }
  // Reserved device names are not safe as display names either.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out = `_${out}`;
  return out || 'attachment.bin';
}

/** Server-generated storage key. Contains nothing user-supplied. */
function generateStorageKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `att/${y}/${m}/${crypto.randomUUID()}`;
}

/** Filesystem provider. The directory is created on demand, mode 0700. */
function createLocalStorage({ rootDir, logger = console } = {}) {
  return {
    kind: 'local',
    async put(key, buffer) {
      const target = path.join(rootDir, key);
      await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(target, buffer, { mode: 0o600 });
      return { key, size: buffer.length };
    },
    async get(key) {
      const target = path.join(rootDir, key);
      // The key is server-generated, but the join is still guarded: anything
      // that escapes the root is treated as a missing object, not a read.
      const resolved = path.resolve(target);
      const root = path.resolve(rootDir);
      if (!resolved.startsWith(root + path.sep)) {
        const err = new Error('attachment not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      try {
        return await fs.promises.readFile(resolved);
      } catch (err) {
        if (err.code === 'ENOENT') {
          const notFound = new Error('attachment not found');
          notFound.code = 'NOT_FOUND';
          throw notFound;
        }
        throw err;
      }
    },
    async delete(key) {
      const target = path.join(rootDir, key);
      await fs.promises.rm(target, { force: true }).catch(() => {});
    },
  };
}

/** In-memory provider for tests: same contract, no filesystem. */
function createMemoryStorage(initial = {}) {
  const objects = new Map(Object.entries(initial));
  return {
    kind: 'memory',
    objects,
    async put(key, buffer) {
      objects.set(key, Buffer.from(buffer));
      return { key, size: buffer.length };
    },
    async get(key) {
      const buf = objects.get(key);
      if (!buf) {
        const err = new Error('attachment not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      return Buffer.from(buf);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/**
 * Create the attachment storage. Defaults to the private local directory;
 * `options.storage` replaces the whole provider (tests), and env vars choose
 * the location of the default one.
 */
function createAttachmentStorage(options = {}) {
  if (options.storage) return options.storage;
  const kind = options.kind || String(process.env.ATTACHMENT_STORAGE || 'local');
  if (kind !== 'local') {
    throw new Error(`Unknown ATTACHMENT_STORAGE kind "${kind}" — only "local" is built in`);
  }
  const rootDir = options.rootDir
    || process.env.ATTACHMENT_STORAGE_DIR
    || path.join(__dirname, '..', '..', 'data', 'attachments');
  return createLocalStorage({ rootDir, logger: options.logger });
}

// Process-wide default for API-route usage (the download endpoint).
let defaultStorage = null;
function getAttachmentStorage() {
  if (!defaultStorage) defaultStorage = createAttachmentStorage();
  return defaultStorage;
}

/** Limits, read once at module load per the server's env conventions. */
const LIMITS = {
  maxBytes: (() => {
    const raw = Number(process.env.ATTACHMENT_MAX_BYTES);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 26214400; // 25 MB
  })(),
  maxPerMessage: (() => {
    const raw = Number(process.env.ATTACHMENT_MAX_PER_MESSAGE);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10;
  })(),
  maxTotalBytes: (() => {
    const raw = Number(process.env.ATTACHMENT_MAX_TOTAL_BYTES);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 104857600; // 100 MB
  })(),
};

module.exports = {
  sanitizeFilename,
  generateStorageKey,
  createAttachmentStorage,
  createLocalStorage,
  createMemoryStorage,
  getAttachmentStorage,
  LIMITS,
};
