// FoodFluencer Bot — telemetry ingest Worker
//
// Public routes (no auth) — write-only, called from the extension when the
// user opts in to "Diagnostics & Sharing" in Settings:
//   POST /v1/feedback   { installId, ts, photos: [...] }
//   POST /v1/logs       { installId, ts, entries: [...] }
//
// Admin routes — require `Authorization: Bearer <ADMIN_TOKEN>` (a Worker
// secret that is NEVER shipped in the extension), used by the developer to
// inspect aggregated data:
//   GET /admin/installs                 — list install IDs with counts
//   GET /admin/logs?installId=...       — recent tech_logs for an install
//   GET /admin/feedback?installId=...   — recent image_feedback for an install
//
// Deploy: see cloud/README.md

const MAX_PHOTOS_PER_BATCH = 10;
const MAX_LOG_ENTRIES_PER_BATCH = 50;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function isValidInstallId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
}

function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

async function handleFeedback(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !isValidInstallId(body.installId) || !Array.isArray(body.photos)) {
    return json({ error: 'invalid payload' }, 400);
  }

  const photos = body.photos.slice(0, MAX_PHOTOS_PER_BATCH);
  const ts = typeof body.ts === 'string' ? body.ts : new Date().toISOString();

  const stmt = env.DB.prepare(
    `INSERT INTO image_feedback
       (install_id, ts, source, width, height, blur, brightness, contrast,
        saturation, colorfulness, warmth, center_focus, appeal, rank_score, kept)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const batch = photos.map(p => stmt.bind(
    body.installId, ts,
    String(p.source || '').slice(0, 32),
    Number(p.width)  || 0,
    Number(p.height) || 0,
    Number(p.blur)         || 0,
    Number(p.brightness)   || 0,
    Number(p.contrast)     || 0,
    Number(p.saturation)   || 0,
    Number(p.colorfulness) || 0,
    Number(p.warmth)       || 0,
    Number(p.centerFocus)  || 0,
    Number(p.appeal)       || 0,
    Number(p.rankScore)    || 0,
    p.kept ? 1 : 0,
  ));

  if (batch.length) await env.DB.batch(batch);
  return json({ ok: true, stored: batch.length });
}

async function handleLogs(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !isValidInstallId(body.installId) || !Array.isArray(body.entries)) {
    return json({ error: 'invalid payload' }, 400);
  }

  const entries = body.entries.slice(0, MAX_LOG_ENTRIES_PER_BATCH);

  const stmt = env.DB.prepare(
    `INSERT INTO tech_logs
       (install_id, entry_id, ts, level, source, category, action, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const batch = entries.map(e => stmt.bind(
    body.installId,
    String(e.id || '').slice(0, 64),
    String(e.ts || '').slice(0, 32),
    String(e.level || 'info').slice(0, 8),
    String(e.source || '').slice(0, 16),
    String(e.category || '').slice(0, 16),
    String(e.action || '').slice(0, 64),
    JSON.stringify(e).slice(0, 4000),
  ));

  if (batch.length) await env.DB.batch(batch);
  return json({ ok: true, stored: batch.length });
}

async function handleAdminInstalls(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT install_id,
            MAX(ts) AS last_seen,
            COUNT(*) AS log_count
       FROM tech_logs
      GROUP BY install_id
      ORDER BY last_seen DESC
      LIMIT 200`
  ).all();
  return json({ installs: results });
}

async function handleAdminLogs(request, env, url) {
  const installId = url.searchParams.get('installId');
  if (!isValidInstallId(installId)) return json({ error: 'invalid installId' }, 400);
  const level = url.searchParams.get('level');

  let query = `SELECT * FROM tech_logs WHERE install_id = ?`;
  const params = [installId];
  if (level && ['info', 'warn', 'error'].includes(level)) {
    query += ` AND level = ?`;
    params.push(level);
  }
  query += ` ORDER BY created_at DESC LIMIT 500`;

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json({ logs: results });
}

async function handleAdminFeedback(request, env, url) {
  const installId = url.searchParams.get('installId');
  if (!isValidInstallId(installId)) return json({ error: 'invalid installId' }, 400);

  const { results } = await env.DB.prepare(
    `SELECT * FROM image_feedback WHERE install_id = ? ORDER BY created_at DESC LIMIT 500`
  ).bind(installId).all();
  return json({ feedback: results });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/v1/feedback') {
      return handleFeedback(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/v1/logs') {
      return handleLogs(request, env);
    }

    if (url.pathname.startsWith('/admin/')) {
      if (!requireAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
      if (url.pathname === '/admin/installs')  return handleAdminInstalls(request, env);
      if (url.pathname === '/admin/logs')      return handleAdminLogs(request, env, url);
      if (url.pathname === '/admin/feedback')  return handleAdminFeedback(request, env, url);
    }

    return json({ error: 'not found' }, 404);
  },
};
