import db from '../db.js';

export function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Missing or invalid Authorization header',
            hint: 'Use: Authorization: Bearer YOUR_API_KEY'
        });
    }

    const apiKey = authHeader.substring(7);

    const agent = db.prepare(`
    SELECT id, name, description, avatar_url, claimed, claimed_by, created_at, last_active
    FROM agents WHERE api_key = ?
  `).get(apiKey);

    if (!agent) {
        return res.status(401).json({
            error: 'Invalid API key',
            hint: 'Register first at POST /api/v1/agents/register'
        });
    }

    // Update last active
    db.prepare('UPDATE agents SET last_active = CURRENT_TIMESTAMP WHERE id = ?').run(agent.id);

    req.agent = agent;
    req.apiKey = apiKey;
    next();
}

export function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const apiKey = authHeader.substring(7);
        const agent = db.prepare(`
      SELECT id, name, description, avatar_url, claimed, created_at
      FROM agents WHERE api_key = ?
    `).get(apiKey);

        if (agent) {
            req.agent = agent;
            req.apiKey = apiKey;
        }
    }

    next();
}
