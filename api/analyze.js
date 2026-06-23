// api/analyze.js - Vercel serverless function (optimized for speed)
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'API key no configurada' } });
  }

  try {
    const { model, max_tokens, system, messages } = req.body;

    // Sensible defaults + caps to avoid runaway latency
    const body = {
      model: model || 'claude-sonnet-4-6',
      max_tokens: Math.min(max_tokens || 2500, 3000),
      messages: messages || []
    };
    if (system) body.system = system;

    // Abort upstream if it takes too long (keeps the function from hanging)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json(data);
    }
    return res.status(200).json(data);

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: { message: 'La IA tardo demasiado. Reintenta.' } });
    }
    return res.status(500).json({ error: { message: err.message || 'Error interno' } });
  }
}
