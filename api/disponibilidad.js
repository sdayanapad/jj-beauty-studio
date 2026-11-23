const { disponibilidad, sameOrigin } = require('../lib/calendar');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'metodo' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'origen' });
  try {
    const [status, body] = await disponibilidad(process.env, req.query && req.query.fecha);
    res.status(status).json(body);
  } catch (e) {
    res.status(502).json({ error: 'servidor' });
  }
};
