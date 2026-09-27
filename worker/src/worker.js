// Mosaic - shared world pixel canvas. One pixel per user per day, permanent.
const CANVAS = 10000;          // canvas side in pixels
const TILE = 250;              // tile side in pixels
const TILES_PER_SIDE = CANVAS / TILE; // 40
const OVERVIEW = 1000;         // overview image side
const BLOCK = CANVAS / OVERVIEW; // 10 canvas pixels per overview cell
const PALETTE_SIZE = 40;       // 32 free + 8 premium
const FREE_COLORS = 32;
const TILE_BYTES = TILE * TILE;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}
function b64uFromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uFromString(str) {
  return b64uFromBytes(new TextEncoder().encode(str));
}
function bytesFromB64u(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- session tokens (HMAC-SHA256 signed) ----------
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signSession(env, payload) {
  const header = b64uFromString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64uFromString(JSON.stringify(payload));
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(header + '.' + body));
  return header + '.' + body + '.' + b64uFromBytes(new Uint8Array(sig));
}
async function readSession(request, env) {
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  try {
    const key = await hmacKey(env.SESSION_SECRET);
    const ok = await crypto.subtle.verify('HMAC', key, bytesFromB64u(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(bytesFromB64u(parts[1])));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}

// ---------- Google ID token verification ----------
let jwksCache = { keys: null, exp: 0 };
async function googleKeys() {
  const now = Date.now();
  if (jwksCache.keys && jwksCache.exp > now) return jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new Error('jwks fetch failed');
  const cc = res.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  const ttl = m ? parseInt(m[1], 10) * 1000 : 3600000;
  const data = await res.json();
  jwksCache = { keys: data.keys, exp: now + ttl };
  return data.keys;
}
async function verifyGoogleCredential(credential, clientId) {
  const parts = credential.split('.');
  if (parts.length !== 3) return null;
  const header = JSON.parse(new TextDecoder().decode(bytesFromB64u(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(bytesFromB64u(parts[1])));
  if (header.alg !== 'RS256') return null;
  const keys = await googleKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytesFromB64u(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== clientId) return null;
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') return null;
  if (!payload.exp || payload.exp < nowSec) return null;
  return payload; // { sub, email, name, picture }
}

// ---------- canvas storage ----------
async function recomputeTile(env, tx, ty) {
  const x0 = tx * TILE, y0 = ty * TILE;
  const { results } = await env.DB.prepare(
    'SELECT x, y, color FROM pixels WHERE x >= ? AND x < ? AND y >= ? AND y < ? AND removed_at IS NULL'
  ).bind(x0, x0 + TILE, y0, y0 + TILE).all();
  const data = new Uint8Array(TILE_BYTES);
  for (const r of results) data[(r.y - y0) * TILE + (r.x - x0)] = r.color + 1;
  await env.DB.prepare('INSERT INTO tiles (tx, ty, data) VALUES (?, ?, ?) ON CONFLICT(tx, ty) DO UPDATE SET data = excluded.data')
    .bind(tx, ty, data).run();
  return data;
}
async function getOverview(env) {
  const row = await env.DB.prepare('SELECT data FROM overview WHERE id = 1').first();
  if (row && row.data) return new Uint8Array(row.data);
  return new Uint8Array(OVERVIEW * OVERVIEW);
}
async function updateOverviewCell(env, x, y) {
  const bx0 = Math.floor(x / BLOCK) * BLOCK, by0 = Math.floor(y / BLOCK) * BLOCK;
  const latest = await env.DB.prepare(
    'SELECT color FROM pixels WHERE x >= ? AND x < ? AND y >= ? AND y < ? AND removed_at IS NULL ORDER BY ts DESC LIMIT 1'
  ).bind(bx0, bx0 + BLOCK, by0, by0 + BLOCK).first();
  const ov = await getOverview(env);
  ov[(by0 / BLOCK) * OVERVIEW + (bx0 / BLOCK)] = latest ? latest.color + 1 : 0;
  await env.DB.prepare('INSERT INTO overview (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
    .bind(ov).run();
}

function isAdmin(env, email) {
  if (!email) return false;
  const list = (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(email).toLowerCase());
}
function utcDay() { return new Date().toISOString().slice(0, 10); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/api/config') {
        return json({
          googleClientId: env.GOOGLE_CLIENT_ID || '',
          canvas: CANVAS, tile: TILE, overview: OVERVIEW,
          paletteSize: PALETTE_SIZE, freeColors: FREE_COLORS,
        });
      }

      if (path === '/api/auth/verify' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body || !body.credential) return json({ error: 'missing credential' }, 400);
        if (!env.GOOGLE_CLIENT_ID) return json({ error: 'login not configured' }, 503);
        const g = await verifyGoogleCredential(body.credential, env.GOOGLE_CLIENT_ID);
        if (!g) return json({ error: 'invalid google token' }, 401);
        const email = (g.email || '').toLowerCase();
        await env.DB.prepare(
          'INSERT INTO users (sub, email, name, picture) VALUES (?, ?, ?, ?) ON CONFLICT(sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture'
        ).bind(g.sub, email, g.name || '', g.picture || '').run();
        const user = await env.DB.prepare('SELECT id, sub, email, name, picture, is_premium, created_at FROM users WHERE sub = ?').bind(g.sub).first();
        const token = await signSession(env, {
          uid: user.id, sub: g.sub, name: user.name, picture: user.picture,
          admin: isAdmin(env, email), exp: Math.floor(Date.now() / 1000) + 7 * 86400,
        });
        return json({ token, user: { id: user.id, name: user.name, picture: user.picture, is_premium: !!user.is_premium } });
      }

      if (path === '/api/me') {
        const s = await readSession(request, env);
        if (!s) return json({ user: null });
        const user = await env.DB.prepare('SELECT id, name, picture, is_premium, created_at FROM users WHERE id = ?').bind(s.uid).first();
        if (!user) return json({ user: null });
        const day = utcDay();
        const placed = await env.DB.prepare('SELECT id FROM pixels WHERE user_id = ? AND day = ?').bind(user.id, day).first();
        const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM pixels WHERE user_id = ?').bind(user.id).first();
        return json({ user: { ...user, is_premium: !!user.is_premium, total_pixels: count.c, placed_today: !!placed } });
      }

      if (path === '/api/place' && request.method === 'POST') {
        const s = await readSession(request, env);
        if (!s) return json({ error: 'not signed in' }, 401);
        const body = await request.json().catch(() => null);
        const x = body && Number.isInteger(body.x) ? body.x : -1;
        const y = body && Number.isInteger(body.y) ? body.y : -1;
        const color = body && Number.isInteger(body.color) ? body.color : -1;
        if (x < 0 || x >= CANVAS || y < 0 || y >= CANVAS) return json({ error: 'out of bounds' }, 400);
        if (color < 0 || color >= PALETTE_SIZE) return json({ error: 'bad color' }, 400);
        const user = await env.DB.prepare('SELECT id, is_premium FROM users WHERE id = ?').bind(s.uid).first();
        if (!user) return json({ error: 'not signed in' }, 401);
        if (color >= FREE_COLORS && !user.is_premium) return json({ error: 'premium color' }, 403);
        const day = utcDay();
        const used = await env.DB.prepare('SELECT id FROM pixels WHERE user_id = ? AND day = ?').bind(user.id, day).first();
        if (used) return json({ error: 'already placed today', next_day_utc: true }, 429);
        const taken = await env.DB.prepare('SELECT id FROM pixels WHERE x = ? AND y = ? AND removed_at IS NULL').bind(x, y).first();
        if (taken) return json({ error: 'pixel taken', pixel_id: taken.id }, 409);
        try {
          await env.DB.prepare('INSERT INTO pixels (x, y, color, user_id, day) VALUES (?, ?, ?, ?, ?)')
            .bind(x, y, color, user.id, day).run();
        } catch (e) {
          const msg = String(e);
          if (msg.includes('idx_pixels_user_day')) return json({ error: 'already placed today' }, 429);
          if (msg.includes('idx_pixels_xy')) return json({ error: 'pixel taken' }, 409);
          throw e;
        }
        const placed = await env.DB.prepare('SELECT id, ts FROM pixels WHERE x = ? AND y = ? AND removed_at IS NULL').bind(x, y).first();
        await recomputeTile(env, Math.floor(x / TILE), Math.floor(y / TILE));
        await updateOverviewCell(env, x, y);
        return json({ ok: true, pixel: { id: placed.id, x, y, color, ts: placed.ts } });
      }

      const tileMatch = path.match(/^\/api\/tile\/(\d+)\/(\d+)$/);
      if (tileMatch) {
        const tx = parseInt(tileMatch[1], 10), ty = parseInt(tileMatch[2], 10);
        if (tx < 0 || tx >= TILES_PER_SIDE || ty < 0 || ty >= TILES_PER_SIDE) return json({ error: 'bad tile' }, 400);
        const row = await env.DB.prepare('SELECT data FROM tiles WHERE tx = ? AND ty = ?').bind(tx, ty).first();
        const data = row && row.data ? new Uint8Array(row.data) : new Uint8Array(TILE_BYTES);
        return new Response(data, {
          headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=5' },
        });
      }

      if (path === '/api/overview') {
        const ov = await getOverview(env);
        return new Response(ov, {
          headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=10' },
        });
      }

      if (path === '/api/feed') {
        const before = parseInt(url.searchParams.get('before') || '0', 10);
        let q = 'SELECT p.id, p.x, p.y, p.color, p.ts, u.id AS uid, u.name, u.picture FROM pixels p JOIN users u ON u.id = p.user_id WHERE p.removed_at IS NULL';
        if (before > 0) q += ' AND p.id < ' + before;
        q += ' ORDER BY p.id DESC LIMIT 50';
        const { results } = await env.DB.prepare(q).all();
        return json({ feed: results });
      }

      if (path === '/api/stats') {
        const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM pixels WHERE removed_at IS NULL').first();
        const users = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
        const today = await env.DB.prepare('SELECT COUNT(*) AS c FROM pixels WHERE day = ?').bind(utcDay()).first();
        const last = await env.DB.prepare('SELECT MAX(ts) AS t FROM pixels WHERE removed_at IS NULL').first();
        return json({
          total_pixels: total.c, total_users: users.c, today: today.c, last_pixel_at: last.t,
          canvas: CANVAS, fill_pct: Math.round((total.c / (CANVAS * CANVAS)) * 1000000) / 10000,
        });
      }

      if (path === '/api/histogram') {
        const { results } = await env.DB.prepare(
          "SELECT day, COUNT(*) AS c FROM pixels WHERE removed_at IS NULL GROUP BY day ORDER BY day"
        ).all();
        return json({ days: results });
      }

      if (path === '/api/history') {
        const to = url.searchParams.get('to');
        const from = url.searchParams.get('from');
        let q = 'SELECT id, x, y, color, ts FROM pixels WHERE removed_at IS NULL';
        const binds = [];
        if (to) { q += ' AND ts <= ?'; binds.push(to); }
        if (from) { q += ' AND ts >= ?'; binds.push(from); }
        q += ' ORDER BY id LIMIT 5000';
        const { results } = await env.DB.prepare(q).bind(...binds).all();
        let countQ = 'SELECT COUNT(*) AS c FROM pixels WHERE removed_at IS NULL';
        const cb = [];
        if (to) { countQ += ' AND ts <= ?'; cb.push(to); }
        if (from) { countQ += ' AND ts >= ?'; cb.push(from); }
        const total = await env.DB.prepare(countQ).bind(...cb).first();
        return json({ pixels: results, total: total.c, truncated: total.c > results.length });
      }

      const pixelMatch = path.match(/^\/api\/pixel\/(\d+)$/);
      if (pixelMatch) {
        const id = parseInt(pixelMatch[1], 10);
        const p = await env.DB.prepare(
          'SELECT p.id, p.x, p.y, p.color, p.ts, p.removed_at, u.id AS uid, u.name, u.picture FROM pixels p JOIN users u ON u.id = p.user_id WHERE p.id = ?'
        ).bind(id).first();
        if (!p) return json({ error: 'not found' }, 404);
        return json({ pixel: p });
      }

      const coordMatch = path.match(/^\/api\/at\/(\d+)\/(\d+)$/);
      if (coordMatch) {
        const x = parseInt(coordMatch[1], 10), y = parseInt(coordMatch[2], 10);
        const p = await env.DB.prepare(
          'SELECT p.id, p.x, p.y, p.color, p.ts, u.id AS uid, u.name, u.picture FROM pixels p JOIN users u ON u.id = p.user_id WHERE p.x = ? AND p.y = ? AND p.removed_at IS NULL'
        ).bind(x, y).first();
        return json({ pixel: p || null });
      }

      const userMatch = path.match(/^\/api\/user\/(\d+)$/);
      if (userMatch) {
        const uid = parseInt(userMatch[1], 10);
        const u = await env.DB.prepare('SELECT id, name, picture, created_at, is_premium FROM users WHERE id = ?').bind(uid).first();
        if (!u) return json({ error: 'not found' }, 404);
        const { results } = await env.DB.prepare(
          'SELECT id, x, y, color, ts FROM pixels WHERE user_id = ? AND removed_at IS NULL ORDER BY id LIMIT 10000'
        ).bind(uid).all();
        return json({ user: { ...u, is_premium: !!u.is_premium }, pixels: results });
      }

      if (path === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ error: 'empty' }, 400);
        const idm = q.match(/^#?(\d+)$/);
        if (idm) {
          const p = await env.DB.prepare(
            'SELECT p.id, p.x, p.y, p.color, p.ts, u.id AS uid, u.name FROM pixels p JOIN users u ON u.id = p.user_id WHERE p.id = ?'
          ).bind(parseInt(idm[1], 10)).first();
          return json({ type: 'pixel', pixel: p || null });
        }
        const cm = q.match(/^(\d{1,5})\s*[, ]\s*(\d{1,5})$/);
        if (cm) {
          const x = Math.min(parseInt(cm[1], 10), CANVAS - 1), y = Math.min(parseInt(cm[2], 10), CANVAS - 1);
          return json({ type: 'region', x, y });
        }
        const { results } = await env.DB.prepare(
          'SELECT u.id, u.name, u.picture, COUNT(p.id) AS pixels FROM users u LEFT JOIN pixels p ON p.user_id = u.id AND p.removed_at IS NULL WHERE u.name LIKE ? GROUP BY u.id ORDER BY pixels DESC LIMIT 20'
        ).bind('%' + q + '%').all();
        return json({ type: 'users', users: results });
      }

      // Admin: illegal-content removal only. Pixels stay permanent otherwise.
      if (path === '/api/admin/pixel/remove' && request.method === 'POST') {
        const s = await readSession(request, env);
        if (!s || !s.admin) return json({ error: 'forbidden' }, 403);
        const body = await request.json().catch(() => null);
        const x = body && Number.isInteger(body.x) ? body.x : -1;
        const y = body && Number.isInteger(body.y) ? body.y : -1;
        if (x < 0 || x >= CANVAS || y < 0 || y >= CANVAS) return json({ error: 'out of bounds' }, 400);
        await env.DB.prepare("UPDATE pixels SET removed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE x = ? AND y = ? AND removed_at IS NULL")
          .bind(x, y).run();
        await recomputeTile(env, Math.floor(x / TILE), Math.floor(y / TILE));
        await updateOverviewCell(env, x, y);
        return json({ ok: true });
      }

      if (path === '/api/admin/rebuild' && request.method === 'POST') {
        const s = await readSession(request, env);
        if (!s || !s.admin) return json({ error: 'forbidden' }, 403);
        const { results } = await env.DB.prepare(
          'SELECT x, y, color FROM pixels WHERE removed_at IS NULL ORDER BY ts'
        ).all();
        const ov = new Uint8Array(OVERVIEW * OVERVIEW);
        for (const r of results) ov[Math.floor(r.y / BLOCK) * OVERVIEW + Math.floor(r.x / BLOCK)] = r.color + 1;
        await env.DB.prepare('INSERT INTO overview (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
          .bind(ov).run();
        return json({ ok: true, pixels: results.length });
      }

      if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);

      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('mosaic worker ok', { headers: { 'content-type': 'text/plain' } });
    } catch (e) {
      return json({ error: 'internal', detail: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
