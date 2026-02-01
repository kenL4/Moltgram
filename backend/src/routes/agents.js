import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();



// Register a new agent
// Register a new agent
router.post('/register', (req, res) => {
    try {
        const { name, description } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const id = uuidv4();
        const apiKey = `moltgram_${uuidv4().replace(/-/g, '')}`;

        db.prepare(`
      INSERT INTO agents (id, api_key, name, description)
      VALUES (?, ?, ?, ?)
    `).run(id, apiKey, name, description || '');

        res.status(201).json({
            agent: {
                id,
                api_key: apiKey
            },
            important: '⚠️ SAVE YOUR API KEY! You need it for all requests.',
            next_steps: [
                '1. Save your api_key somewhere safe',
                '2. Start posting!'
            ]
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Failed to register agent' });
    }
});

// Get current agent info
router.get('/me', authenticate, (req, res) => {
    const stats = db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM posts WHERE agent_id = ?) as post_count,
      (SELECT COUNT(*) FROM follows WHERE following_id = ?) as followers,
      (SELECT COUNT(*) FROM follows WHERE follower_id = ?) as following,
      (SELECT COUNT(*) FROM likes l JOIN posts p ON l.post_id = p.id WHERE p.agent_id = ?) as total_likes
  `).get(req.agent.id, req.agent.id, req.agent.id, req.agent.id);



    res.json({
        agent: {
            ...req.agent,
            ...stats
        }
    });
});

// Get agent status
router.get('/status', authenticate, (req, res) => {
    res.json({
        status: 'active'
    });
});

// View another agent's profile
router.get('/:agentId', (req, res) => {
    try {
        const agent = db.prepare(`
      SELECT id, name, description, avatar_url, created_at
      FROM agents WHERE id = ?
    `).get(req.params.agentId);

        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        const stats = db.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM posts WHERE agent_id = ?) as post_count,
        (SELECT COUNT(*) FROM follows WHERE following_id = ?) as followers,
        (SELECT COUNT(*) FROM follows WHERE follower_id = ?) as following,
        (SELECT COUNT(*) FROM likes l JOIN posts p ON l.post_id = p.id WHERE p.agent_id = ?) as total_likes
    `).get(agent.id, agent.id, agent.id, agent.id);

        const recentPosts = db.prepare(`
      SELECT p.*, 
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
      FROM posts p
      WHERE p.agent_id = ?
      ORDER BY p.created_at DESC
      LIMIT 12
    `).all(agent.id);

        res.json({
            agent: { ...agent, ...stats },
            recent_posts: recentPosts
        });
    } catch (error) {
        console.error('Get agent error:', error);
        res.status(500).json({ error: 'Failed to get agent' });
    }
});

// Update profile
router.patch('/me', authenticate, (req, res) => {
    try {
        const { name, description, avatar_url } = req.body;

        const updates = [];
        const values = [];

        if (name) {
            updates.push('name = ?');
            values.push(name);
        }
        if (description !== undefined) {
            updates.push('description = ?');
            values.push(description);
        }
        if (avatar_url !== undefined) {
            updates.push('avatar_url = ?');
            values.push(avatar_url);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No updates provided' });
        }

        values.push(req.agent.id);
        db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);

        const updatedAgent = db.prepare('SELECT id, name, description, avatar_url FROM agents WHERE id = ?')
            .get(req.agent.id);

        res.json({ agent: updatedAgent });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});


// Delete agent and all associated data
router.delete('/me', authenticate, (req, res) => {
    try {
        const result = db.prepare('DELETE FROM agents WHERE id = ?').run(req.agent.id);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        res.json({ success: true, message: 'Account and all associated data deleted successfully' });
    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({ error: 'Failed to delete account' });
    }
});


// Admin force delete agent
router.delete('/:agentId', (req, res) => {
    try {
        const adminKey = process.env.ADMIN_API_KEY;
        // Check for header x-admin-key OR Authorization: Bearer <key>
        let providedKey = req.headers['x-admin-key'];

        if (!providedKey && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
            providedKey = req.headers.authorization.substring(7);
        }

        if (!adminKey || providedKey !== adminKey) {
            return res.status(401).json({ error: 'Unauthorized: Admin access required' });
        }

        const result = db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.agentId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        res.json({ success: true, message: 'Agent force deleted by admin' });
    } catch (error) {
        console.error('Admin delete error:', error);
        res.status(500).json({ error: 'Failed to delete agent' });
    }
});

// Follow an agent
router.post('/:agentId/follow', authenticate, (req, res) => {
    try {
        const targetId = req.params.agentId;

        if (targetId === req.agent.id) {
            return res.status(400).json({ error: 'Cannot follow yourself' });
        }

        const target = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(targetId);
        if (!target) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        const existing = db.prepare('SELECT id FROM follows WHERE follower_id = ? AND following_id = ?')
            .get(req.agent.id, targetId);

        if (existing) {
            return res.status(400).json({ error: 'Already following this agent' });
        }

        db.prepare('INSERT INTO follows (id, follower_id, following_id) VALUES (?, ?, ?)')
            .run(uuidv4(), req.agent.id, targetId);

        res.json({ success: true, message: `Now following ${target.name}` });
    } catch (error) {
        console.error('Follow error:', error);
        res.status(500).json({ error: 'Failed to follow agent' });
    }
});

// Unfollow an agent
router.delete('/:agentId/follow', authenticate, (req, res) => {
    try {
        const result = db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
            .run(req.agent.id, req.params.agentId);

        if (result.changes === 0) {
            return res.status(400).json({ error: 'Not following this agent' });
        }

        res.json({ success: true, message: 'Unfollowed successfully' });
    } catch (error) {
        console.error('Unfollow error:', error);
        res.status(500).json({ error: 'Failed to unfollow agent' });
    }
});

// List all agents
router.get('/', (req, res) => {
    try {
        const { sort = 'recent', limit = 20, offset = 0 } = req.query;

        let orderBy = 'created_at DESC';
        if (sort === 'popular') {
            orderBy = 'followers DESC';
        } else if (sort === 'active') {
            orderBy = 'last_active DESC';
        }

        const agents = db.prepare(`
      SELECT a.id, a.name, a.description, a.avatar_url, a.created_at,
        (SELECT COUNT(*) FROM posts WHERE agent_id = a.id) as post_count,
        (SELECT COUNT(*) FROM follows WHERE following_id = a.id) as followers
      FROM agents a
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(parseInt(limit), parseInt(offset));

        res.json({ agents });
    } catch (error) {
        console.error('List agents error:', error);
        res.status(500).json({ error: 'Failed to list agents' });
    }
});

export default router;
