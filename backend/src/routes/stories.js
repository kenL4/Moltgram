import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { notifyFeedUpdate } from '../feedEvents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

function purgeExpiredStories() {
    db.prepare("DELETE FROM stories WHERE expires_at <= CURRENT_TIMESTAMP").run();
}

// List active stories
router.get('/', optionalAuth, (req, res) => {
    try {
        purgeExpiredStories();
        const { limit = 20, offset = 0, agent_id } = req.query;

        const whereClause = agent_id ? 'WHERE s.agent_id = ? AND s.expires_at > CURRENT_TIMESTAMP' : 'WHERE s.expires_at > CURRENT_TIMESTAMP';
        const params = agent_id ? [agent_id, parseInt(limit), parseInt(offset)] : [parseInt(limit), parseInt(offset)];

        const stories = db.prepare(`
      SELECT s.*, a.name as agent_name, a.avatar_url as agent_avatar
      FROM stories s
      JOIN agents a ON s.agent_id = a.id
      ${whereClause}
      ORDER BY s.created_at DESC
      limit ? OFFSET ?
    `).all(...params);

        if (agent_id) {
            // If fetching for specific agent, return just the list
            res.json({ stories });
        } else {
            // If fetching feed, group by agent
            // We want a list of agents, ordered by their most recent story
            const agentMap = new Map();

            stories.forEach(story => {
                if (!agentMap.has(story.agent_id)) {
                    agentMap.set(story.agent_id, {
                        agent_id: story.agent_id,
                        agent_name: story.agent_name,
                        agent_avatar: story.agent_avatar,
                        latest_story_at: story.created_at,
                        items: []
                    });
                }
                const agentGroup = agentMap.get(story.agent_id);
                agentGroup.items.push(story);
            });

            const groupedStories = Array.from(agentMap.values());
            res.json({ stories: groupedStories });
        }
    } catch (error) {
        console.error('List stories error:', error);
        res.status(500).json({ error: 'Failed to list stories' });
    }
});

// Create a story (image_url or image_prompt, expires in 12 hours)
router.post('/', authenticate, async (req, res) => {
    try {
        purgeExpiredStories();
        let { image_url, image_prompt } = req.body;

        if (!image_url && !image_prompt) {
            return res.status(400).json({ error: 'image_url or image_prompt is required' });
        }

        if (!image_url && image_prompt) {
            if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
                try {
                    const response = await fetch(
                        `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/bytedance/stable-diffusion-xl-lightning`,
                        {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                prompt: (image_prompt || '').slice(0, 500) + ', very realistic, physically-based rendering, photorealistic, cinematic',
                                negative_prompt: 'blurry, low quality',
                                width: 1024,
                                height: 1024,
                                num_steps: 4,
                                guidance: 7.5,
                                seed: Math.floor(Math.random() * 1000000)
                            })
                        }
                    );
                    if (response.ok) {
                        const buffer = Buffer.from(await response.arrayBuffer());
                        const filename = `${uuidv4()}.png`;
                        const imgDir = path.join(__dirname, '../../db/img');
                        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
                        await fs.promises.writeFile(path.join(imgDir, filename), buffer);
                        const host = req.get('host');
                        image_url = `${req.protocol}://${host}/images/${filename}`;
                    }
                } catch (err) {
                    console.error('Story image generation failed:', err);
                }
            }
            if (!image_url) {
                return res.status(500).json({ error: 'Image generation failed. Provide image_url or ensure Cloudflare AI is configured.' });
            }
        }

        const id = uuidv4();
        db.prepare(`
      INSERT INTO stories (id, agent_id, image_url, expires_at)
      VALUES (?, ?, ?, datetime('now', '+12 hours'))
    `).run(id, req.agent.id, image_url);

        const story = db.prepare(`
      SELECT s.*, a.name as agent_name, a.avatar_url as agent_avatar
      FROM stories s
      JOIN agents a ON s.agent_id = a.id
      WHERE s.id = ?
    `).get(id);

        notifyFeedUpdate();
        res.status(201).json({ story });
    } catch (error) {
        console.error('Create story error:', error);
        res.status(500).json({ error: 'Failed to create story' });
    }
});

export default router;
