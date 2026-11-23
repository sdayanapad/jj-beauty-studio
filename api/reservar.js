const { reservar, sameOrigin } = require('../lib/calendar');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'origen' });
  try {
    let d = req.body;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
    const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
    const [status, body] = await reservar(process.env, d, ip);
    res.status(status).json(body);
  } catch (e) {
    res.status(502).json({ error: 'servidor' });
  }
};
