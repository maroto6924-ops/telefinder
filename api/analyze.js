// api/analyze.js - puerta de entrada a la IA de PHONEFINDER.
// Exige sesion, cuenta las tasaciones por usuario y dia, y protege tu cuenta de Anthropic.
//
// Variables en Vercel (Settings > Environment Variables):
//   ANTHROPIC_API_KEY          (ya la tienes)
//   FIREBASE_SERVICE_ACCOUNT   (el JSON de la cuenta de servicio de Firebase, entero)
// Opcionales:
//   FREE_DAILY      tasaciones al dia del plan gratis (por defecto 3)
//   REQUIRE_VERIFIED=0   para no exigir el correo confirmado
// Plan gratis: 3 tasaciones al dia y sin lotes. Plan Pro (o el administrador): sin limite practico.
import crypto from 'node:crypto';

export const config = { maxDuration: 60 };

const FIREBASE_API_KEY = 'AIzaSyB9mSF3RsWs1iYoShocPkI3nXl3UCUMh8E'; // clave publica de la web
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'maroto6924@gmail.com').toLowerCase();
const FREE_DAILY = Number(process.env.FREE_DAILY) || 3;   // tasaciones al dia, plan gratis
const PRO_DAILY = 150;                                     // uso razonable, plan Pro
const FREE_EXTRAS = 25;                                    // consultas menores al dia (ficha, preguntas...), plan gratis
const PRO_EXTRAS = 600;
const REQUIRE_VERIFIED = process.env.REQUIRE_VERIFIED !== '0';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_IMAGES = 12;
const DEDUPE_MS = 15 * 60 * 1000;                          // repetir la misma foto en 15 min no vuelve a contar

const err = (res, status, type, message, extra) =>
  res.status(status).json(Object.assign({ error: { type, message } }, extra || {}));

// ---------- Google: sesion y Firestore con la cuenta de servicio ----------
let _sa = null, _tok = null;
function serviceAccount() {
  if (_sa) return _sa;
  let raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  if (raw[0] !== '{') raw = Buffer.from(raw, 'base64').toString('utf8');
  _sa = JSON.parse(raw);
  return _sa;
}
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
async function accessToken() {
  if (_tok && _tok.exp - 60000 > Date.now()) return _tok.v;
  const sa = serviceAccount();
  const iat = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + b64u(sig)
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token de servicio');
  _tok = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return _tok.v;
}
async function fs(path, body) {
  const sa = serviceAccount();
  const r = await fetch('https://firestore.googleapis.com/v1/projects/' + sa.project_id + '/databases/(default)/documents:' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await accessToken() },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('firestore ' + r.status);
  return r.json();
}
const docName = (c, id) => 'projects/' + serviceAccount().project_id + '/databases/(default)/documents/' + c + '/' + id;
const num = (f) => Number((f && f.integerValue) || 0) || 0;

async function whoIs(idToken) {
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  const j = await r.json();
  const u = j.users && j.users[0];
  if (!u || u.disabled) return null;
  return { uid: u.localId, email: String(u.email || '').toLowerCase(), verified: !!u.emailVerified };
}
function madridDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
async function readState(user, day) {
  const uName = docName('users', user.uid), gName = docName('usage', user.uid + '_' + day);
  const rows = await fs('batchGet', { documents: [uName, gName] });
  let profile = {}, usage = {};
  rows.forEach((x) => {
    if (x.found && x.found.name === uName) profile = x.found.fields || {};
    if (x.found && x.found.name === gName) usage = x.found.fields || {};
  });
  const pro = user.email === ADMIN_EMAIL || (profile.plan && profile.plan.stringValue === 'pro');
  return {
    plan: pro ? 'pro' : 'free',
    n: num(usage.n), x: num(usage.x),
    recent: (usage.r && usage.r.mapValue && usage.r.mapValue.fields) || {},
    limit: pro ? PRO_DAILY : FREE_DAILY,
    xLimit: pro ? PRO_EXTRAS : FREE_EXTRAS
  };
}
// Suma (o resta) al contador del dia. Devuelve el valor resultante.
async function bump(user, day, field, by, fp) {
  const name = docName('usage', user.uid + '_' + day);
  const fields = { d: { stringValue: day }, u: { stringValue: user.uid } };
  const mask = ['d', 'u'];
  if (fp) {
    mask.push('r.' + fp);
    if (by > 0) fields.r = { mapValue: { fields: { [fp]: { integerValue: String(Date.now()) } } } };
  }
  const out = await fs('commit', { writes: [{ update: { name, fields }, updateMask: { fieldPaths: mask }, updateTransforms: [{ fieldPath: field, increment: { integerValue: String(by) } }] }] });
  const tr = out.writeResults && out.writeResults[0] && out.writeResults[0].transformResults;
  return num(tr && tr[0]);
}

// ---------- Que cuenta como una tasacion ----------
function fingerprint(messages, all) {
  const h = crypto.createHash('sha1');
  let seen = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c && c.type === 'image' && c.source && typeof c.source.data === 'string') {
        const d = c.source.data;
        h.update(d.length + ':' + d.slice(0, 3000) + d.slice(-500));
        seen++;
        if (!all) return 'h' + h.digest('hex').slice(0, 24);
      }
    }
  }
  if (!seen) {
    for (const m of messages) {
      if (typeof m.content === 'string') h.update(m.content.slice(0, 400));
      else if (Array.isArray(m.content)) m.content.forEach((c) => { if (c && c.type === 'text') h.update(String(c.text).slice(0, 400)); });
    }
  }
  return 'h' + h.digest('hex').slice(0, 24);
}
function countImages(messages) {
  let n = 0;
  messages.forEach((m) => { if (Array.isArray(m.content)) m.content.forEach((c) => { if (c && c.type === 'image') n++; }); });
  return n;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'GET') return err(res, 405, 'method', 'Method not allowed');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return err(res, 500, 'pf_config', 'Falta ANTHROPIC_API_KEY en Vercel (Settings > Environment Variables)');
  let sa = null;
  try { sa = serviceAccount(); } catch (e) { sa = null; }
  if (!sa || !sa.private_key || !sa.client_email || !sa.project_id) {
    return err(res, 503, 'pf_config', 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel');
  }

  try {
    // 1. Quien es
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
    const user = m ? await whoIs(m[1]) : null;
    if (!user) return err(res, 401, 'pf_auth', 'Inicia sesion para tasar');

    const day = madridDay();
    const st = await readState(user, day);
    const info = { 'x-pf-plan': st.plan, 'x-pf-used': String(st.n), 'x-pf-limit': String(st.limit), 'x-pf-verified': user.verified ? '1' : '0', 'x-pf-day': day };
    const setInfo = (o) => Object.keys(o).forEach((k) => res.setHeader(k, o[k]));
    setInfo(info);

    // Consulta del consumo (no gasta nada)
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, plan: st.plan, used: st.n, limit: st.limit, extras: st.x, extrasLimit: st.xLimit, verified: user.verified, day, email: user.email });
    }

    if (REQUIRE_VERIFIED && !user.verified) {
      return err(res, 403, 'pf_verify', 'Confirma tu correo para tasar. Te enviamos un enlace al registrarte.');
    }

    // 2. Peticion
    let payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
    payload = payload || {};
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (!messages.length) return err(res, 400, 'bad', 'Peticion vacia');
    const images = countImages(messages);
    if (images > MAX_IMAGES) return err(res, 400, 'bad', 'Demasiadas fotos en una peticion');
    const kind = ['main', 'lot', 'enrich', 'extra'].includes(payload.pf_kind) ? payload.pf_kind : 'main';

    // Herramientas de Pro: el lote solo con Pro
    if (kind === 'lot' && st.plan !== 'pro') {
      return res.status(402).json({ error: { type: 'pf_pro', message: 'Tasar un lote es de PHONEFINDER Pro', feature: 'Tasar un lote' } });
    }

    // 3. Cobro
    let charged = 0, fp = '', field = 'n', refund = 0;
    if (kind === 'enrich' || kind === 'extra') {
      if (st.x >= st.xLimit) return err(res, 429, 'pf_extras', 'Has llegado al limite de consultas de hoy. Vuelve manana.', { pf: { used: st.n, limit: st.limit, plan: st.plan } });
      field = 'x'; charged = 1;
    } else {
      fp = fingerprint(messages, kind === 'lot');
      const cost = kind === 'lot' ? Math.max(1, images) : 1;
      const seenAt = num(st.recent[fp]);
      if (seenAt && Date.now() - seenAt < DEDUPE_MS) {
        charged = 0; fp = '';                       // reintento de la misma foto: gratis
      } else {
        if (st.n + cost > st.limit) {
          return err(res, 429, 'pf_limit', st.plan === 'free'
            ? 'Has usado tus ' + st.limit + ' tasaciones gratis de hoy. Vuelven manana.'
            : 'Has llegado al limite de uso razonable de hoy.', { pf: { used: st.n, limit: st.limit, plan: st.plan, need: cost } });
        }
        charged = cost;
      }
    }
    if (charged || fp) {
      const now = await bump(user, day, field, charged, fp);
      refund = charged;
      const cap = field === 'x' ? st.xLimit : st.limit;
      if (now > cap) {                               // dos peticiones a la vez: la segunda se echa atras
        await bump(user, day, field, -charged, fp).catch(() => {});
        return err(res, 429, field === 'x' ? 'pf_extras' : 'pf_limit', 'Has llegado al limite de hoy.', { pf: { used: st.n, limit: st.limit, plan: st.plan } });
      }
      if (field === 'n') res.setHeader('x-pf-used', String(now));
    }

    // 4. IA
    const body = { model: MODEL, max_tokens: Math.min(Number(payload.max_tokens) || 2000, MAX_TOKENS), messages };
    if (payload.system) body.system = payload.system;
    let r, text;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      });
      text = await r.text();
    } catch (e) { r = null; }
    if (!r || !r.ok) {                               // si la IA falla, no te cuesta una tasacion
      if (refund) await bump(user, day, field, -refund, fp).catch(() => {});
      if (field === 'n') res.setHeader('x-pf-used', String(Math.max(0, st.n)));
      if (!r) return err(res, 502, 'pf_upstream', 'No se pudo contactar con la IA');
    }
    res.setHeader('Content-Type', 'application/json');
    return res.status(r.status).send(text);
  } catch (e) {
    return err(res, 503, 'pf_config', 'Error del servidor: ' + (e.message || 'desconocido'));
  }
}
