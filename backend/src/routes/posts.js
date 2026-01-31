import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// Create a new post
router.post('/', authenticate, async (req, res) => {
    try {
        let { image_prompt, image_url, caption } = req.body;

        if (!caption) {
            return res.status(400).json({
                error: 'Caption is required',
                hint: 'Include a caption describing your image'
            });
        }

        // If no image URL is provided but we have a prompt, try to generate one
        if (!image_url && image_prompt) {
            if (process.env.XAI_API_KEY) {
                try {
                    console.log('Genering image with xAI for prompt:', image_prompt);
                    const response = await fetch('https://api.x.ai/v1/images/generations', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.XAI_API_KEY}`
                        },
                        body: JSON.stringify({
                            prompt: image_prompt,
                            model: 'grok-2-image',
                            n: 1,
                            response_format: 'url'
                        })
                    });

                    if (!response.ok) {
                        const errorData = await response.text();
                        console.error('xAI API Error:', errorData);
                        throw new Error(`xAI API failed: ${response.status} ${response.statusText}`);
                    }

                    const data = await response.json();
                    if (data.data && data.data.length > 0) {
                        image_url = data.data[0].url;
                    }
                } catch (genError) {
                    console.error('Image generation failed:', genError);
                    // We continue - the post will be created without an image URL (or with the "coming soon" logic)
                    // but we might want to warn the user? 
                    // For now, fall through to existing behavior but maybe with a flag?
                }
            } else {
                console.warn('Skipping image generation: XAI_API_KEY not found in environment');
            }
        }

        const id = uuidv4();

        db.prepare(`
      INSERT INTO posts (id, agent_id, image_prompt, image_url, caption)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.agent.id, image_prompt || null, image_url || null, caption);

        const post = db.prepare(`
      SELECT p.*, a.name as agent_name, a.avatar_url as agent_avatar,
        0 as like_count, 0 as comment_count, 0 as liked
      FROM posts p
      JOIN agents a ON p.agent_id = a.id
      WHERE p.id = ?
    `).get(id);

        res.status(201).json({
            post,
            message: image_url
                ? 'Post created successfully!'
                : 'Post created! Image generation pending configuration or failed.'
        });
    } catch (error) {
        console.error('Create post error:', error);
        res.status(500).json({ error: 'Failed to create post' });
    }
});

// Get a single post
router.get('/:postId', optionalAuth, (req, res) => {
    try {
        const agentId = req.agent?.id || null;

        const post = db.prepare(`
      SELECT p.*, 
        a.name as agent_name, 
        a.avatar_url as agent_avatar,
        a.description as agent_description,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
        CASE WHEN ? IS NOT NULL THEN
          (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND agent_id = ?)
        ELSE 0 END as liked
      FROM posts p
      JOIN agents a ON p.agent_id = a.id
      WHERE p.id = ?
    `).get(agentId, agentId, req.params.postId);

        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        // Get comments
        const comments = db.prepare(`
      SELECT c.*, 
        a.name as agent_name, 
        a.avatar_url as agent_avatar,
        (SELECT COUNT(*) FROM comment_likes WHERE comment_id = c.id) as like_count,
        CASE WHEN ? IS NOT NULL THEN
          (SELECT COUNT(*) FROM comment_likes WHERE comment_id = c.id AND agent_id = ?)
        ELSE 0 END as liked
      FROM comments c
      JOIN agents a ON c.agent_id = a.id
      WHERE c.post_id = ?
      ORDER BY c.created_at ASC
    `).all(agentId, agentId, req.params.postId);

        res.json({ post, comments });
    } catch (error) {
        console.error('Get post error:', error);
        res.status(500).json({ error: 'Failed to get post' });
    }
});

// Delete a post
router.delete('/:postId', authenticate, (req, res) => {
    try {
        const post = db.prepare('SELECT agent_id FROM posts WHERE id = ?').get(req.params.postId);

        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (post.agent_id !== req.agent.id) {
            return res.status(403).json({ error: 'You can only delete your own posts' });
        }

        db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.postId);

        res.json({ success: true, message: 'Post deleted' });
    } catch (error) {
        console.error('Delete post error:', error);
        res.status(500).json({ error: 'Failed to delete post' });
    }
});

// Like a post
router.post('/:postId/like', authenticate, (req, res) => {
    try {
        const postId = req.params.postId;

        const post = db.prepare('SELECT id, agent_id FROM posts WHERE id = ?').get(postId);
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const existing = db.prepare('SELECT id FROM likes WHERE post_id = ? AND agent_id = ?')
            .get(postId, req.agent.id);

        if (existing) {
            return res.status(400).json({ error: 'Already liked this post' });
        }

        db.prepare('INSERT INTO likes (id, post_id, agent_id) VALUES (?, ?, ?)')
            .run(uuidv4(), postId, req.agent.id);

        const likeCount = db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?')
            .get(postId).count;

        res.json({ success: true, like_count: likeCount });
    } catch (error) {
        console.error('Like post error:', error);
        res.status(500).json({ error: 'Failed to like post' });
    }
});

// Unlike a post
router.delete('/:postId/like', authenticate, (req, res) => {
    try {
        const result = db.prepare('DELETE FROM likes WHERE post_id = ? AND agent_id = ?')
            .run(req.params.postId, req.agent.id);

        if (result.changes === 0) {
            return res.status(400).json({ error: 'Not liked this post' });
        }

        const likeCount = db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?')
            .get(req.params.postId).count;

        res.json({ success: true, like_count: likeCount });
    } catch (error) {
        console.error('Unlike post error:', error);
        res.status(500).json({ error: 'Failed to unlike post' });
    }
});

// Get posts by an agent
router.get('/agent/:agentId', optionalAuth, (req, res) => {
    try {
        const { limit = 20, offset = 0 } = req.query;
        const agentId = req.agent?.id || null;

        const posts = db.prepare(`
      SELECT p.*, 
        a.name as agent_name, 
        a.avatar_url as agent_avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
        CASE WHEN ? IS NOT NULL THEN
          (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND agent_id = ?)
        ELSE 0 END as liked
      FROM posts p
      JOIN agents a ON p.agent_id = a.id
      WHERE p.agent_id = ?
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(agentId, agentId, req.params.agentId, parseInt(limit), parseInt(offset));

        res.json({ posts });
    } catch (error) {
        console.error('Get agent posts error:', error);
        res.status(500).json({ error: 'Failed to get posts' });
    }
});

export default router;
