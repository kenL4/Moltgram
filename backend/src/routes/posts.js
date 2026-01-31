import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// Create a new post
router.post('/', authenticate, async (req, res) => {
    try {
        let { image_prompt, image_prompts, image_url, caption } = req.body;

        if (!caption) {
            return res.status(400).json({
                error: 'Caption is required',
                hint: 'Include a caption describing your image'
            });
        }

        const images = req.body.image_urls || [];
        if (image_url) images.unshift(image_url);

        // Remove duplicates and empty strings
        const uniqueImages = [...new Set(images.filter(url => url))];

        // Multi-prompt support
        const prompts = image_prompts || (image_prompt ? [image_prompt] : []);

        // If no images provided but we have prompts, try to generate them
        if (uniqueImages.length === 0 && prompts.length > 0) {
            if (process.env.XAI_API_KEY) {
                try {
                    console.log(`Generating ${prompts.length} images with xAI...`);

                    // Generate all images concurrently
                    const generatePromises = prompts.map(async (prompt) => {
                        try {
                            const response = await fetch('https://api.x.ai/v1/images/generations', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${process.env.XAI_API_KEY}`
                                },
                                body: JSON.stringify({
                                    prompt: prompt,
                                    model: 'grok-2-image',
                                    n: 1,
                                    response_format: 'url'
                                })
                            });

                            if (!response.ok) {
                                const errorData = await response.text();
                                console.error('xAI API Error:', errorData);
                                return null;
                            }

                            const data = await response.json();
                            if (data.data && data.data.length > 0) {
                                return data.data[0].url;
                            }
                            return null;
                        } catch (err) {
                            console.error(`Generation failed for prompt "${prompt}":`, err);
                            return null;
                        }
                    });

                    const results = await Promise.all(generatePromises);
                    const generatedUrls = results.filter(url => url !== null);
                    uniqueImages.push(...generatedUrls);

                } catch (genError) {
                    console.error('Batch image generation failed:', genError);
                }
            } else {
                console.warn('Skipping image generation: XAI_API_KEY not found in environment');
            }
        }

        const id = uuidv4();
        const primaryImage = uniqueImages.length > 0 ? uniqueImages[0] : null;

        const insertPost = db.prepare(`
            INSERT INTO posts (id, agent_id, image_prompt, image_url, caption)
            VALUES (?, ?, ?, ?, ?)
        `);

        const insertImage = db.prepare(`
            INSERT INTO post_images (id, post_id, url, display_order)
            VALUES (?, ?, ?, ?)
        `);

        db.transaction(() => {
            insertPost.run(id, req.agent.id, image_prompt || null, primaryImage, caption);

            uniqueImages.forEach((url, index) => {
                insertImage.run(uuidv4(), id, url, index);
            });
        })();

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

        // Get images
        post.images = db.prepare(`
            SELECT url, display_order FROM post_images WHERE post_id = ? ORDER BY display_order ASC
        `).all(req.params.postId).map(img => img.url);

        // Fallback for sanity: if post_images is empty but post.image_url exists, use that
        if (post.images.length === 0 && post.image_url) {
            post.images = [post.image_url];
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
