// Lógica del calendario (Google Calendar) para Vercel.
// Variables de entorno (Vercel → Settings → Environment Variables):
//   GOOGLE_SERVICE_ACCOUNT  contenido completo del JSON de la cuenta de servicio
//   CALENDAR_ID             ID de tu calendario "Citas J&J"
const crypto = require('node:crypto');

const TZ = 'America/Bogota';   // UTC-5 todo el año, sin horario de verano
const OFFSET = '-05:00';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
let tokenCache = { value: null, exp: 0 };
const hits = new Map();        // límite simple por IP (por instancia)

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.value && tokenCache.exp - 60 > now) return tokenCache.value;
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key);
  const jwt = head + '.' + claim + '.' + b64url(sig);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  if (!r.ok) throw new Error('token ' + r.status);
  const j = await r.json();
  tokenCache = { value: j.access_token, exp: now + (j.expires_in || 3600) };
  return tokenCache.value;
}

const dayStartMs = (fecha) => Date.parse(fecha + 'T00:00:00' + OFFSET);
const validFecha = (f) => typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) && !isNaN(dayStartMs(f));
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

async function busyBetween(env, fromMs, toMs) {
  const t = await accessToken(env);
  const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), timeZone: TZ, items: [{ id: env.CALENDAR_ID }] }),
  });
  if (!r.ok) throw new Error('freebusy ' + r.status);
  const j = await r.json();
  const cal = (j.calendars && j.calendars[env.CALENDAR_ID]) || {};
  if (cal.errors && cal.errors.length) throw new Error('calendar ' + JSON.stringify(cal.errors));
  return (cal.busy || []).map((b) => [Date.parse(b.start), Date.parse(b.end)]);
}

const configured = (env) => !!(env.GOOGLE_SERVICE_ACCOUNT && env.CALENDAR_ID);

// -> [status, objeto]
async function disponibilidad(env, fecha) {
  if (!configured(env)) return [503, { error: 'sin-configurar' }];
  if (!validFecha(fecha)) return [400, { error: 'fecha' }];
  const a = dayStartMs(fecha), b = a + 86400000;
  const busy = await busyBetween(env, a, b);
  const ocupado = busy
    .map(([s, e]) => [Math.max(0, Math.round((s - a) / 60000)), Math.min(1440, Math.round((e - a) / 60000))])
    .filter(([s, e]) => e > s);
  return [200, { fecha, ocupado }];
}

async function reservar(env, d, ip) {
  if (!configured(env)) return [503, { error: 'sin-configurar' }];
  if (!d || typeof d !== 'object') return [400, { error: 'json' }];
  if (d.web) return [200, { ok: true }];                           // trampa para bots
  const n = (hits.get(ip) || []).filter((t) => Date.now() - t < 3600000);
  if (n.length >= 10) return [429, { error: 'limite' }];
  n.push(Date.now()); hits.set(ip, n);
  const inicio = Number(d.inicioMin), dur = Number(d.durMin);
  if (!validFecha(d.fecha) || !Number.isInteger(inicio) || inicio < 0 || inicio > 1439 || !Number.isInteger(dur) || dur < 30 || dur > 1440) return [400, { error: 'datos' }];
  if (!Array.isArray(d.nombres) || !d.nombres.length || d.nombres.length > 8) return [400, { error: 'nombres' }];
  const startMs = dayStartMs(d.fecha) + inicio * 60000, endMs = startMs + dur * 60000;
  const ahora = Date.now();
  if (startMs < ahora - 3600000 || startMs > ahora + 120 * 86400000) return [400, { error: 'fecha' }];
  const busy = await busyBetween(env, startMs, endMs);
  if (busy.some(([s, e]) => startMs < e && endMs > s)) return [409, { error: 'ocupado' }];
  const nombres = d.nombres.map((x) => clean(x, 60)).filter(Boolean);
  const lugar = [clean(d.direccion, 120), clean(d.barrio, 60), 'Barranquilla'].filter(Boolean).join(', ');
  const t = await accessToken(env);
  const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(env.CALENDAR_ID) + '/events', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: 'PENDIENTE · ' + nombres.join(', ') + (/^JJ-[0-9A-Z-]{3,12}$/.test(String(d.codigo || '')) ? ' · ' + d.codigo : ''),
      description: clean(d.resumen, 2000) + '\n\n(Solicitud hecha desde la página. Confirma o cancela por WhatsApp.)',
      location: lugar,
      status: 'tentative',
      start: { dateTime: new Date(startMs).toISOString(), timeZone: TZ },
      end: { dateTime: new Date(endMs).toISOString(), timeZone: TZ },
      reminders: { useDefault: true },
    }),
  });
  if (!r.ok) return [502, { error: 'calendario' }];
  return [200, { ok: true }];
}

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

module.exports = { disponibilidad, reservar, sameOrigin };
