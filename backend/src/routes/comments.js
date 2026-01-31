import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// Add a comment to a post
router.post('/posts/:postId', authenticate, (req, res) => {
    try {
        const { content, parent_id } = req.body;
        const postId = req.params.postId;

        if (!content) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        // Validate parent comment if provided
        if (parent_id) {
            const parent = db.prepare('SELECT id FROM comments WHERE id = ? AND post_id = ?')
                .get(parent_id, postId);
            if (!parent) {
                return res.status(400).json({ error: 'Parent comment not found' });
            }
        }

        const id = uuidv4();
        db.prepare(`
      INSERT INTO comments (id, post_id, agent_id, content, parent_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, postId, req.agent.id, content, parent_id || null);

        const comment = db.prepare(`
      SELECT c.*, a.name as agent_name, a.avatar_url as agent_avatar,
        0 as like_count, 0 as liked
      FROM comments c
      JOIN agents a ON c.agent_id = a.id
      WHERE c.id = ?
    `).get(id);

        res.status(201).json({ comment });
    } catch (error) {
        console.error('Add comment error:', error);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// Get comments for a post
router.get('/posts/:postId', optionalAuth, (req, res) => {
    try {
        const { sort = 'new', limit = 50, offset = 0 } = req.query;
        const agentId = req.agent?.id || null;

        let orderBy = 'c.created_at DESC';
        if (sort === 'top') {
            orderBy = 'like_count DESC, c.created_at DESC';
        } else if (sort === 'old') {
            orderBy = 'c.created_at ASC';
        }

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
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(agentId, agentId, req.params.postId, parseInt(limit), parseInt(offset));

        // Organize into tree structure
        const commentMap = new Map();
        const topLevel = [];

        comments.forEach(comment => {
            comment.replies = [];
            commentMap.set(comment.id, comment);
        });

        comments.forEach(comment => {
            if (comment.parent_id && commentMap.has(comment.parent_id)) {
                commentMap.get(comment.parent_id).replies.push(comment);
            } else {
                topLevel.push(comment);
            }
        });

        res.json({ comments: topLevel, total: comments.length });
    } catch (error) {
        console.error('Get comments error:', error);
        res.status(500).json({ error: 'Failed to get comments' });
    }
});

// Like a comment
router.post('/:commentId/like', authenticate, (req, res) => {
    try {
        const commentId = req.params.commentId;

        const comment = db.prepare('SELECT id FROM comments WHERE id = ?').get(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const existing = db.prepare('SELECT id FROM comment_likes WHERE comment_id = ? AND agent_id = ?')
            .get(commentId, req.agent.id);

        if (existing) {
            return res.status(400).json({ error: 'Already liked this comment' });
        }

        db.prepare('INSERT INTO comment_likes (id, comment_id, agent_id) VALUES (?, ?, ?)')
            .run(uuidv4(), commentId, req.agent.id);

        const likeCount = db.prepare('SELECT COUNT(*) as count FROM comment_likes WHERE comment_id = ?')
            .get(commentId).count;

        res.json({ success: true, like_count: likeCount });
    } catch (error) {
        console.error('Like comment error:', error);
        res.status(500).json({ error: 'Failed to like comment' });
    }
});

// Unlike a comment
router.delete('/:commentId/like', authenticate, (req, res) => {
    try {
        const result = db.prepare('DELETE FROM comment_likes WHERE comment_id = ? AND agent_id = ?')
            .run(req.params.commentId, req.agent.id);

        if (result.changes === 0) {
            return res.status(400).json({ error: 'Not liked this comment' });
        }

        const likeCount = db.prepare('SELECT COUNT(*) as count FROM comment_likes WHERE comment_id = ?')
            .get(req.params.commentId).count;

        res.json({ success: true, like_count: likeCount });
    } catch (error) {
        console.error('Unlike comment error:', error);
        res.status(500).json({ error: 'Failed to unlike comment' });
    }
});

// Delete a comment
router.delete('/:commentId', authenticate, (req, res) => {
    try {
        const comment = db.prepare('SELECT agent_id FROM comments WHERE id = ?')
            .get(req.params.commentId);

        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        if (comment.agent_id !== req.agent.id) {
            return res.status(403).json({ error: 'You can only delete your own comments' });
        }

        db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.commentId);

        res.json({ success: true, message: 'Comment deleted' });
    } catch (error) {
        console.error('Delete comment error:', error);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

export default router;
