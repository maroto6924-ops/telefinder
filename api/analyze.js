export const config = { maxDuration: 60 };

// Si tu plan de Vercel no respeta maxDuration aqui, crea tambien un archivo
// vercel.json en la raiz del proyecto con el contenido que te indico aparte.

export default async function handler(req, res) {
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
    return res.status(500).json({ error: { message: 'Falta ANTHROPIC_API_KEY en Vercel (Settings > Environment Variables)' } });
  }

  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
    }
    const { model, max_tokens, system, messages } = payload || {};

    const body = {
      model: model || 'claude-sonnet-4-6',
      max_tokens: max_tokens || 4096,
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
    return res.status(r.status).send(text);

  } catch (err) {
    return res.status(500).json({ error: { message: 'Error servidor: ' + (err.message || 'desconocido') } });
  }
}
