// api/notify.js - avisa por Telegram cuando alguien se registra.
// Variables en Vercel: TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID.
const FIREBASE_API_KEY = 'AIzaSyB9mSF3RsWs1iYoShocPkI3nXl3UCUMh8E'; // clave publica de la web

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!body.idToken) return res.status(400).json({ error: 'sin token' });

    // Comprueba con Google que el token es real y de una cuenta recien creada
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: body.idToken })
    });
    const j = await r.json();
    const u = j.users && j.users[0];
    if (!u) return res.status(401).json({ error: 'token no valido' });
    if (!token || !chat) return res.status(200).json({ skipped: 'telegram sin configurar' });

    // Alguien pulsa "Avisarme cuando este Pro": una sola vez por persona y arranque del servidor
    if (body.type === 'pro') {
      if (!u.emailVerified) return res.status(200).json({ skipped: 'sin verificar' });
      globalThis.__proAsked = globalThis.__proAsked || new Set();
      if (globalThis.__proAsked.has(u.localId)) return res.status(200).json({ skipped: 'repetido' });
      globalThis.__proAsked.add(u.localId);
      const who = String(u.displayName || 'Sin nombre').slice(0, 40);
      await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: 'Quiere PHONEFINDER Pro\n' + who + '\n' + u.email })
      });
      return res.status(200).json({ ok: true });
    }

    if (Date.now() - Number(u.createdAt) > 10 * 60 * 1000) return res.status(200).json({ skipped: 'cuenta antigua' });

    const name = String(body.name || u.displayName || 'Sin nombre').slice(0, 40);
    const text = 'Nuevo registro en PHONEFINDER\n' + name + '\n' + u.email;
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text })
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ skipped: 'error' });
  }
}
