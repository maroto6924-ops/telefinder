// api/analyze.js - Vercel serverless function (latency-optimized)
//
// KEY OPTIMIZATIONS:
// 1. maxDuration raised so the function is never killed mid-request
// 2. Runs in iad1 (US East) - closest Vercel region to Anthropic's API,
//    which removes cross-region network latency (often 1-3s saved)
// 3. Caps max_tokens to avoid runaway generation time
// 4. Returns a Server-Timing header so you can SEE the upstream time
//    in the browser Network tab

export const config = {
  maxDuration: 60,
  regions: ['iad1']   // US East - nearest to api.anthropic.com
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY no configurada en Vercel' } });
  }

  const started = Date.now();

  try {
    const { model, max_tokens, system, messages } = req.body || {};

    const body = {
      model: model || 'claude-sonnet-4-6',
      max_tokens: Math.min(max_tokens || 2200, 3000),
      messages: messages || []
    };
    if (system) body.system = system;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    const upstreamStart = Date.now();
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
    const upstreamMs = Date.now() - upstreamStart;

    const data = await r.json();

    // Expose timing so you can diagnose in the browser Network tab
    res.setHeader('Server-Timing', `upstream;dur=${upstreamMs}, total;dur=${Date.now() - started}`);

    if (!r.ok) {
      return res.status(r.status).json(data);
    }
    return res.status(200).json(data);

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: { message: 'La IA tardo demasiado (timeout). Reintenta con menos fotos.' } });
    }
    return res.status(500).json({ error: { message: err.message || 'Error interno del servidor' } });
  }
}
