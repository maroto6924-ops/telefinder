// api/analyze.js
//
// CRITICAL: Vercel's free/hobby tier kills serverless functions after
// 10 seconds by default. If the model takes longer, the function is
// terminated and the app never gets a response - it just hangs.
//
// This config raises the limit. On Hobby plan max is 60s; if you are on
// Hobby and still hit limits, the streaming approach below also helps by
// returning as soon as the model finishes.

export const config = {
  maxDuration: 60
};

export default async function handler(req, res) {
  // CORS / preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'Falta ANTHROPIC_API_KEY en las variables de entorno de Vercel' } });
  }

  try {
    // Body may arrive parsed or as a string depending on config
    let payload = req.body;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
    }

    const { model, max_tokens, system, messages } = payload || {};

    const body = {
      model: model || 'claude-sonnet-4-6',
      max_tokens: Math.min(max_tokens || 1600, 2000),
      messages: messages || []
    };
    if (system) body.system = system;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const text = await r.text();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    // Pass through the exact status and body from Anthropic
    return res.status(r.status).send(text);

  } catch (err) {
    return res.status(500).json({ error: { message: 'Error en el servidor: ' + (err.message || 'desconocido') } });
  }
}
