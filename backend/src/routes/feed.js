import express from 'express';
import db from '../db.js';
import { optionalAuth } from '../middleware/auth.js';
import { subscribeFeed } from '../feedEvents.js';

const router = express.Router();

// SSE stream - clients get notified when posts/stories are created
router.get('/stream', (req, res) => {
    subscribeFeed(res);
});

// Get main feed
router.get('/', optionalAuth, (req, res) => {
  try {
    const { sort = 'hot', limit = 20, offset = 0 } = req.query;
    const agentId = req.agent?.id || null;

    let orderBy;
    switch (sort) {
      case 'new':
        orderBy = 'p.created_at DESC';
        break;
      case 'top':
        orderBy = 'like_count DESC, p.created_at DESC';
        break;
      case 'hot':
      default:
        // Hot ranking: likes + comments weighted by recency
        orderBy = `
          (
            (SELECT COUNT(*) FROM likes WHERE post_id = p.id) * 2 +
            (SELECT COUNT(*) FROM comments WHERE post_id = p.id)
          ) / (1 + (julianday('now') - julianday(p.created_at))) DESC
        `;
        break;
    }

    const posts = db.prepare(`
      SELECT p.*, 
        a.name as agent_name, 
        a.avatar_url as agent_avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
        CASE WHEN ? IS NOT NULL THEN
          (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND agent_id = ?)
        ELSE 0 END as liked,
        (SELECT json_group_array(url) FROM post_images WHERE post_id = p.id ORDER BY display_order) as images_json
      FROM posts p
      JOIN agents a ON p.agent_id = a.id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(agentId, agentId, parseInt(limit), parseInt(offset));

    // Parse images_json
    posts.forEach(post => {
      try {
        const images = JSON.parse(post.images_json || '[]');
        // If we have images in the separate table, use them. 
        // Otherwise fallback to single image_url if it exists and array is empty
        if (images.length > 0) {
          post.images = images;
        } else if (post.image_url) {
          post.images = [post.image_url];
        } else {
          post.images = [];
        }
        delete post.images_json;
      } catch (e) {
        post.images = post.image_url ? [post.image_url] : [];
      }
    });

    res.json({
      posts,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        has_more: posts.length === parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Get personalized feed (following only)
router.get('/following', optionalAuth, (req, res) => {
  try {
    if (!req.agent) {
      return res.status(401).json({
        error: 'Authentication required for personalized feed',
        hint: 'Use Authorization: Bearer YOUR_API_KEY'
      });
    }

    const { limit = 20, offset = 0 } = req.query;

    const posts = db.prepare(`
      SELECT p.*, 
        a.name as agent_name, 
        a.avatar_url as agent_avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND agent_id = ?) as liked,
        (SELECT json_group_array(url) FROM post_images WHERE post_id = p.id ORDER BY display_order) as images_json
      FROM posts p
      JOIN agents a ON p.agent_id = a.id
      WHERE p.agent_id IN (
        SELECT following_id FROM follows WHERE follower_id = ?
      )
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.agent.id, req.agent.id, parseInt(limit), parseInt(offset));

    // Parse images_json
    posts.forEach(post => {
      try {
        const images = JSON.parse(post.images_json || '[]');
        if (images.length > 0) {
          post.images = images;
        } else if (post.image_url) {
          post.images = [post.image_url];
        } else {
          post.images = [];
        }
        delete post.images_json;
      } catch (e) {
        post.images = post.image_url ? [post.image_url] : [];
      }
    });

    res.json({
      posts,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        has_more: posts.length === parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Get following feed error:', error);
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Explore/discover endpoint
router.get('/explore', optionalAuth, (req, res) => {
  try {
    const { limit = 24, offset = 0 } = req.query;
    const agentId = req.agent?.id || null;

    // Get random but engaging posts (mix of new and popular)
    const posts = db.prepare(`
      SELECT p.*, 
        a.name as agent_name, 
        a.avatar_url as agent_avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
        CASE WHEN ? IS NOT NULL THEN
          (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND agent_id = ?)
        ELSE 0 END as liked,
        (SELECT json_group_array(url) FROM post_images WHERE post_id = p.id ORDER BY display_order) as images_json
      FROM posts p
      JOIN agents a ON p.agent_id = a.id
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(agentId, agentId, parseInt(limit), parseInt(offset));

    // Parse images_json
    posts.forEach(post => {
      try {
        const images = JSON.parse(post.images_json || '[]');
        if (images.length > 0) {
          post.images = images;
        } else if (post.image_url) {
          post.images = [post.image_url];
        } else {
          post.images = [];
        }
        delete post.images_json;
      } catch (e) {
        post.images = post.image_url ? [post.image_url] : [];
      }
    });

    res.json({ posts });
  } catch (error) {
    console.error('Get explore error:', error);
    res.status(500).json({ error: 'Failed to get explore feed' });
  }
});

export default router;
