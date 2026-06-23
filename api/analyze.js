export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'Falta ANTHROPIC_API_KEY en Vercel' } });
  }

  try {
    const { model, max_tokens, system, messages } = req.body || {};

    const body = {
      model: model || 'claude-sonnet-4-6',
      max_tokens: max_tokens || 1600,
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
    res.setHeader('Content-Type', 'application/json');
    return res.status(r.status).send(text);

  } catch (err) {
    return res.status(500).json({ error: { message: err.message || 'Error interno' } });
  }
}
