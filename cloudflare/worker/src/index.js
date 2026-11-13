const EMPTY_DOCUMENT = { entries: [], pet: null, entryTombstones: {}, petUpdatedAt: 0 };
const MAX_DOCUMENT_BYTES = 1_700_000;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404, cors);
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) return json({ error: 'Origin not allowed' }, 403, cors);
    try {
      if (url.pathname === '/api/data' && request.method === 'GET') {
        const identity = await authenticate(request, env);
        const row = await accountForIdentity(identity, env.DB);
        return json({ revision: row.revision, data: JSON.parse(row.document) }, 200, cors);
      }
      if (url.pathname === '/api/data' && request.method === 'PUT') {
        const identity = await authenticate(request, env);
        const row = await accountForIdentity(identity, env.DB);
        const body = await readJson(request);
        if (!Number.isInteger(body.revision) || !isDocument(body.data)) return json({ error: 'Invalid document' }, 400, cors);
        const serialized = JSON.stringify(body.data);
        if (new TextEncoder().encode(serialized).byteLength > MAX_DOCUMENT_BYTES) return json({ error: 'Document too large' }, 413, cors);
        if (body.revision !== row.revision) return json({ error: 'Revision conflict', revision: row.revision, data: JSON.parse(row.document) }, 409, cors);
        const updatedAt = Date.now();
        const result = await env.DB.prepare('UPDATE account_data SET document = ?, revision = revision + 1, updated_at = ? WHERE account_id = ? AND revision = ?')
          .bind(serialized, updatedAt, row.account_id, row.revision).run();
        if (!result.meta.changes) {
          const latest = await env.DB.prepare('SELECT revision, document FROM account_data WHERE account_id = ?').bind(row.account_id).first();
          return json({ error: 'Revision conflict', revision: latest.revision, data: JSON.parse(latest.document) }, 409, cors);
        }
        return json({ revision: row.revision + 1, updatedAt }, 200, cors);
      }
      if (url.pathname === '/api/link' && request.method === 'POST') {
        const primary = await authenticate(request, env);
        const secondary = await authenticateToken(request.headers.get('X-Link-Token'), request.headers.get('X-Link-Provider'), env);
        if (primary.provider === secondary.provider || primary.subject === secondary.subject) return json({ error: 'Two different sign-in methods are required' }, 400, cors);
        const primaryRow = await accountForIdentity(primary, env.DB);
        const secondaryRow = await accountForIdentity(secondary, env.DB);
        const canonicalId = primaryRow.account_id;
        const secondaryId = secondaryRow.account_id;
        if (canonicalId !== secondaryId) {
          const merged = mergeDocuments(JSON.parse(primaryRow.document), JSON.parse(secondaryRow.document));
          const serialized = JSON.stringify(merged);
          if (new TextEncoder().encode(serialized).byteLength > MAX_DOCUMENT_BYTES) return json({ error: 'Merged document too large' }, 413, cors);
          const now = Date.now();
          await env.DB.batch([
            env.DB.prepare('UPDATE account_data SET document = ?, revision = revision + 1, updated_at = ? WHERE account_id = ?')
              .bind(serialized, now, canonicalId),
            env.DB.prepare('UPDATE identities SET account_id = ? WHERE account_id = ?').bind(canonicalId, secondaryId),
            env.DB.prepare('DELETE FROM account_data WHERE account_id = ?').bind(secondaryId)
          ]);
        }
        const row = await env.DB.prepare('SELECT revision, document FROM account_data WHERE account_id = ?').bind(canonicalId).first();
        return json({ linked: true, revision: row.revision, data: JSON.parse(row.document) }, 200, cors);
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (error) {
      const status = error.status || 500;
      if (status === 500) console.error('Daily Sequence sync error:', error);
      return json({ error: status === 500 ? 'Internal server error' : error.message }, status, cors);
    }
  }
};

function corsHeaders(request, env) {
  const headers = new Headers({ 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Link-Token, X-Link-Provider', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' });
  if (request.headers.get('Origin') === env.ALLOWED_ORIGIN) headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN);
  return headers;
}

function json(value, status, cors) {
  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(value), { status, headers });
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_DOCUMENT_BYTES + 1024) throw httpError(413, 'Request too large');
  try { return await request.json(); } catch { throw httpError(400, 'Invalid JSON'); }
}

function isDocument(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.entries) &&
    (value.pet === null || (value.pet && typeof value.pet === 'object' && !Array.isArray(value.pet))) &&
    value.entryTombstones && typeof value.entryTombstones === 'object' && !Array.isArray(value.entryTombstones) &&
    Number.isFinite(value.petUpdatedAt);
}

async function authenticate(request, env) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  if (!match) throw httpError(401, 'Missing access token');
  return authenticateToken(match[1], request.headers.get('X-Auth-Provider'), env);
}

async function authenticateToken(token, provider, env) {
  if (!token || !['google', 'line'].includes(provider)) throw httpError(401, 'Invalid credentials');
  if (provider === 'google') return verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
  return verifyLineToken(token, env.LINE_LOGIN_CHANNEL_ID);
}

async function verifyFirebaseToken(token, projectId) {
  const parts = token.split('.');
  if (parts.length !== 3) throw httpError(401, 'Invalid Google token');
  let header, claims;
  try { header = decodePart(parts[0]); claims = decodePart(parts[1]); } catch { throw httpError(401, 'Invalid Google token'); }
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256' || !header.kid || claims.iss !== `https://securetoken.google.com/${projectId}` || claims.aud !== projectId ||
      typeof claims.sub !== 'string' || !claims.sub || claims.exp <= now || claims.iat > now + 60 ||
      claims.firebase?.sign_in_provider !== 'google.com') throw httpError(401, 'Invalid Google token');
  const keys = await googleSigningKeys();
  const jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) throw httpError(401, 'Unknown Google signing key');
  const publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, base64UrlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw httpError(401, 'Invalid Google token signature');
  return { provider: 'google', subject: claims.sub };
}

async function googleSigningKeys() {
  const cache = caches.default;
  const keyUrl = new Request('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  let response = await cache.match(keyUrl);
  if (!response) {
    response = await fetch(keyUrl);
    if (!response.ok) throw httpError(503, 'Google token verification unavailable');
    const cached = new Response(response.clone().body, { headers: { 'Cache-Control': 'public, max-age=3600' } });
    await cache.put(keyUrl, cached);
  }
  return (await response.json()).keys;
}

async function verifyLineToken(token, channelId) {
  const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: token, client_id: channelId })
  });
  if (!response.ok) throw httpError(401, 'Invalid LINE token');
  const claims = await response.json();
  if (typeof claims.sub !== 'string' || !claims.sub) throw httpError(401, 'Invalid LINE token');
  return { provider: 'line', subject: claims.sub };
}

function decodePart(part) { return JSON.parse(new TextDecoder().decode(base64UrlBytes(part))); }
function base64UrlBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function accountForIdentity(identity, db) {
  let row = await db.prepare('SELECT a.account_id, a.document, a.revision FROM identities i JOIN account_data a ON a.account_id = i.account_id WHERE i.provider = ? AND i.subject = ?')
    .bind(identity.provider, identity.subject).first();
  if (row) return row;
  const accountId = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO account_data (account_id, document, revision, updated_at) VALUES (?, ?, 0, ?)')
      .bind(accountId, JSON.stringify(EMPTY_DOCUMENT), now),
    db.prepare('INSERT OR IGNORE INTO identities (provider, subject, account_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(identity.provider, identity.subject, accountId, now)
  ]);
  row = await db.prepare('SELECT a.account_id, a.document, a.revision FROM identities i JOIN account_data a ON a.account_id = i.account_id WHERE i.provider = ? AND i.subject = ?')
    .bind(identity.provider, identity.subject).first();
  return row;
}

function mergeDocuments(first, second) {
  const tombstones = { ...(first.entryTombstones || {}), ...(second.entryTombstones || {}) };
  for (const [id, time] of Object.entries(first.entryTombstones || {})) tombstones[id] = Math.max(Number(time) || 0, Number(tombstones[id]) || 0);
  for (const [id, time] of Object.entries(second.entryTombstones || {})) tombstones[id] = Math.max(Number(time) || 0, Number(tombstones[id]) || 0);
  const items = new Map();
  for (const entry of [...(second.entries || []), ...(first.entries || [])]) {
    if (!entry?.id) continue;
    const current = items.get(entry.id);
    if (!current || (Number(entry.updatedAt) || 0) > (Number(current.updatedAt) || 0)) items.set(entry.id, entry);
  }
  const entries = [...items.values()].filter(entry => (Number(tombstones[entry.id]) || 0) < (Number(entry.updatedAt) || 0));
  const firstPetTime = Number(first.petUpdatedAt) || 0;
  const secondPetTime = Number(second.petUpdatedAt) || 0;
  return { entries, entryTombstones: tombstones, pet: firstPetTime >= secondPetTime ? first.pet : second.pet, petUpdatedAt: Math.max(firstPetTime, secondPetTime) };
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
