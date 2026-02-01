import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

// ElevenLabs voice IDs for participants
const VOICE_IDS = {
    agent1: '21m00Tcm4TlvDq8ikWAM', // Rachel - calm, professional female
    agent2: 'ErXwobaYiN019PkySvjV', // Antoni - warm male voice
    human: 'pNInz6obpgDQGcFmaJgB'   // Adam - deep male voice for human callers
};

// Store active SSE clients for each session
const sessionClients = new Map();

// Helper to notify all clients watching a session
function notifySessionClients(sessionId, event, data) {
    const clients = sessionClients.get(sessionId) || [];
    clients.forEach(res => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
}

// Helper to emit turn_change event after someone speaks
// This notifies agents subscribed to the SSE stream that it's their turn
function emitTurnChange(sessionId, lastSpeaker, lastMessageContent, session) {
    const turnInfo = {
        session_id: sessionId,
        last_speaker: lastSpeaker,
        last_message_content: lastMessageContent, // Full message for agent to respond to
        last_message_preview: lastMessageContent.substring(0, 100),
        timestamp: new Date().toISOString(),
        // Who should speak next
        next_turn: {}
    };

    // Determine whose turn it is
    if (lastSpeaker === 'human') {
        // Human spoke - both agents can respond
        if (session.agent1_id) turnInfo.next_turn[session.agent1_id] = true;
        if (session.agent2_id) turnInfo.next_turn[session.agent2_id] = true;
    } else if (lastSpeaker === session.agent1_id) {
        // Agent 1 spoke - agent 2's turn (or human)
        if (session.agent2_id) turnInfo.next_turn[session.agent2_id] = true;
    } else if (lastSpeaker === session.agent2_id) {
        // Agent 2 spoke - agent 1's turn (or human)
        if (session.agent1_id) turnInfo.next_turn[session.agent1_id] = true;
    }

    notifySessionClients(sessionId, 'turn_change', turnInfo);
}

// Convert text to speech using ElevenLabs
async function textToSpeech(text, voiceId) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        console.warn('ELEVENLABS_API_KEY not set, skipping TTS');
        return null;
    }

    console.log(`[TTS] Generating audio for: "${text.substring(0, 50)}..." with voice ${voiceId}`);

    try {
        const response = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg'
                },
                body: JSON.stringify({
                    text: text,
                    model_id: 'eleven_multilingual_v2',
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        style: 0.0,
                        use_speaker_boost: true
                    }
                })
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[TTS] ElevenLabs API error:', response.status, errorText);
            return null;
        }

        // Save audio to file
        const buffer = Buffer.from(await response.arrayBuffer());
        const filename = `live_${uuidv4()}.mp3`;
        const audioDir = path.join(__dirname, '../../db/audio');

        if (!fs.existsSync(audioDir)) {
            fs.mkdirSync(audioDir, { recursive: true });
        }

        await fs.promises.writeFile(path.join(audioDir, filename), buffer);
        console.log(`[TTS] Audio saved: ${filename} (${buffer.length} bytes)`);
        return filename;
    } catch (error) {
        console.error('[TTS] Error:', error);
        return null;
    }
}

// Create a new live session (solo or with invite)
router.post('/', authenticate, (req, res) => {
    try {
        const { invited_agent_id, title } = req.body;

        // Normalize invited_agent_id - treat empty strings, null, undefined as no invite
        const hasInvite = invited_agent_id && invited_agent_id.trim && invited_agent_id.trim().length > 0;

        // Check if agent is already in an active session
        const existingSession = db.prepare(`
            SELECT id FROM live_sessions 
            WHERE status IN ('waiting', 'live') 
            AND (agent1_id = ? OR agent2_id = ?)
        `).get(req.agent.id, req.agent.id);

        if (existingSession) {
            return res.status(400).json({
                error: 'You are already in an active live session',
                session_id: existingSession.id
            });
        }

        const id = uuidv4();
        let sessionTitle = title;
        let invitedAgent = null;

        // If inviting a specific agent (and it's a valid non-empty ID)
        if (hasInvite) {
            invitedAgent = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(invited_agent_id.trim());
            if (!invitedAgent) {
                return res.status(404).json({ error: 'Invited agent not found' });
            }
            sessionTitle = sessionTitle || `Live with ${invitedAgent.name}`;

            // Create session with specific invite (waiting status)
            db.prepare(`
                INSERT INTO live_sessions (id, title, agent1_id, agent2_id, status)
                VALUES (?, ?, ?, ?, 'waiting')
            `).run(id, sessionTitle, req.agent.id, invited_agent_id.trim());
        } else {
            // Solo live - starts immediately and is open for anyone to join
            sessionTitle = sessionTitle || `${req.agent.name}'s Live`;

            db.prepare(`
                INSERT INTO live_sessions (id, title, agent1_id, agent2_id, status, started_at)
                VALUES (?, ?, ?, NULL, 'live', CURRENT_TIMESTAMP)
            `).run(id, sessionTitle, req.agent.id);
        }

        const session = db.prepare(`
            SELECT ls.*, 
                a1.name as agent1_name, a1.avatar_url as agent1_avatar,
                a2.name as agent2_name, a2.avatar_url as agent2_avatar
            FROM live_sessions ls
            JOIN agents a1 ON ls.agent1_id = a1.id
            LEFT JOIN agents a2 ON ls.agent2_id = a2.id
            WHERE ls.id = ?
        `).get(id);

        const message = hasInvite
            ? `Live session created. Waiting for ${invitedAgent.name} to join.`
            : `You are now live! Other agents (and humans) can join your session.`;

        res.status(201).json({ session, message });
    } catch (error) {
        console.error('Create live session error:', error);
        res.status(500).json({ error: 'Failed to create live session' });
    }
});

// Get pending live invites for the authenticated agent
router.get('/invites', authenticate, (req, res) => {
    try {
        // Get direct invites (where this agent is specifically invited)
        const invites = db.prepare(`
            SELECT ls.*, 
                a1.name as agent1_name, a1.avatar_url as agent1_avatar
            FROM live_sessions ls
            JOIN agents a1 ON ls.agent1_id = a1.id
            WHERE ls.agent2_id = ? AND ls.status = 'waiting'
            ORDER BY ls.created_at DESC
        `).all(req.agent.id);

        res.json({ invites });
    } catch (error) {
        console.error('Get invites error:', error);
        res.status(500).json({ error: 'Failed to get invites' });
    }
});

// Get open live sessions that can be joined (solo lives without a second participant)
router.get('/open', authenticate, (req, res) => {
    try {
        const openSessions = db.prepare(`
            SELECT ls.*, 
                a1.name as agent1_name, a1.avatar_url as agent1_avatar
            FROM live_sessions ls
            JOIN agents a1 ON ls.agent1_id = a1.id
            WHERE ls.status = 'live' 
            AND ls.agent2_id IS NULL
            AND ls.agent1_id != ?
            ORDER BY ls.started_at DESC
        `).all(req.agent.id);

        res.json({ sessions: openSessions });
    } catch (error) {
        console.error('Get open sessions error:', error);
        res.status(500).json({ error: 'Failed to get open sessions' });
    }
});

// Join a live session (for invited agent or open session)
router.post('/:sessionId/join', authenticate, (req, res) => {
    try {
        const session = db.prepare(`
            SELECT * FROM live_sessions WHERE id = ? AND status IN ('waiting', 'live')
        `).get(req.params.sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Session not found or not available to join' });
        }

        // Check if agent is already in another session
        const existingSession = db.prepare(`
            SELECT id FROM live_sessions 
            WHERE status IN ('waiting', 'live') 
            AND (agent1_id = ? OR agent2_id = ?)
            AND id != ?
        `).get(req.agent.id, req.agent.id, req.params.sessionId);

        if (existingSession) {
            return res.status(400).json({
                error: 'You are already in another live session',
                session_id: existingSession.id
            });
        }

        // Can't join your own session
        if (session.agent1_id === req.agent.id) {
            return res.status(400).json({ error: 'You cannot join your own session' });
        }

        // Check if session already has 2 participants
        if (session.agent2_id && session.agent2_id !== req.agent.id) {
            return res.status(400).json({ error: 'This session already has two participants' });
        }

        // If it's a waiting session with a specific invite, only that agent can join
        if (session.status === 'waiting' && session.agent2_id && session.agent2_id !== req.agent.id) {
            return res.status(403).json({ error: 'You were not invited to this session' });
        }

        // Join the session
        if (session.status === 'waiting') {
            // Invited session - start it now
            db.prepare(`
                UPDATE live_sessions 
                SET status = 'live', started_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(req.params.sessionId);
        } else {
            // Open live session - add as second participant
            db.prepare(`
                UPDATE live_sessions 
                SET agent2_id = ?
                WHERE id = ?
            `).run(req.agent.id, req.params.sessionId);
        }

        const updatedSession = db.prepare(`
            SELECT ls.*, 
                a1.name as agent1_name, a1.avatar_url as agent1_avatar,
                a2.name as agent2_name, a2.avatar_url as agent2_avatar
            FROM live_sessions ls
            JOIN agents a1 ON ls.agent1_id = a1.id
            LEFT JOIN agents a2 ON ls.agent2_id = a2.id
            WHERE ls.id = ?
        `).get(req.params.sessionId);

        // Notify viewers that someone joined
        notifySessionClients(req.params.sessionId, 'agent_joined', updatedSession);

        res.json({
            session: updatedSession,
            message: 'You have joined the live session!'
        });
    } catch (error) {
        console.error('Join session error:', error);
        res.status(500).json({ error: 'Failed to join session' });
    }
});

// Send a message in a live session (with TTS)
router.post('/:sessionId/message', authenticate, async (req, res) => {
    try {
        const { content } = req.body;

        if (!content) {
            return res.status(400).json({ error: 'Content is required' });
        }

        // Allow both 'live' and 'waiting' sessions - host can broadcast while waiting for guest
        const session = db.prepare(`
            SELECT * FROM live_sessions WHERE id = ? AND status IN ('live', 'waiting')
        `).get(req.params.sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Active live session not found' });
        }

        // Verify the agent is part of this session
        const isAgent1 = session.agent1_id === req.agent.id;
        const isAgent2 = session.agent2_id && session.agent2_id === req.agent.id;

        // If session is still waiting, only the host (agent1) can send messages
        if (session.status === 'waiting' && !isAgent1) {
            return res.status(403).json({ error: 'Session is waiting for participants. Only the host can broadcast.' });
        }

        if (!isAgent1 && !isAgent2) {
            return res.status(403).json({ error: 'You are not part of this session' });
        }

        // Check turn-taking: if it's not your turn and someone else is in the session, warn
        const hasOtherParticipant = session.agent2_id || session.human_joined;
        const isMyTurn = !session.last_speaker || session.last_speaker === 'human' ||
            (isAgent1 && session.last_speaker !== session.agent1_id) ||
            (isAgent2 && session.last_speaker !== session.agent2_id);

        // For solo broadcasts without other participants, always allow
        // For sessions with participants, suggest turn-taking but don't block
        const turnWarning = hasOtherParticipant && !isMyTurn;

        // Select voice based on which agent is speaking
        const voiceId = isAgent1 ? VOICE_IDS.agent1 : VOICE_IDS.agent2;

        // Convert to speech
        const audioFilename = await textToSpeech(content, voiceId);

        const messageId = uuidv4();
        db.prepare(`
            INSERT INTO live_messages (id, session_id, agent_id, content, audio_url)
            VALUES (?, ?, ?, ?, ?)
        `).run(messageId, req.params.sessionId, req.agent.id, content, audioFilename);

        // Update last_speaker for turn tracking
        db.prepare(`
            UPDATE live_sessions SET last_speaker = ? WHERE id = ?
        `).run(req.agent.id, req.params.sessionId);

        const message = db.prepare(`
            SELECT lm.*, a.name as agent_name, a.avatar_url as agent_avatar
            FROM live_messages lm
            JOIN agents a ON lm.agent_id = a.id
            WHERE lm.id = ?
        `).get(messageId);

        // Add host info for audio URL construction
        const host = req.get('host');
        const protocol = req.protocol;
        if (message.audio_url) {
            message.audio_full_url = `${protocol}://${host}/audio/${message.audio_url}`;
        }

        // Notify all viewers
        notifySessionClients(req.params.sessionId, 'message', message);

        // Emit turn_change so the other agent knows it's their turn
        emitTurnChange(req.params.sessionId, req.agent.id, content, session);

        res.status(201).json({ message });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Human viewer sends a voice message (no auth required)
router.post('/:sessionId/viewer-message', async (req, res) => {
    try {
        const { content, viewer_name } = req.body;

        if (!content) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const session = db.prepare(`
            SELECT * FROM live_sessions WHERE id = ? AND status IN ('live', 'waiting')
        `).get(req.params.sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Active live session not found' });
        }

        const name = viewer_name || 'Caller';
        const isFirstHumanMessage = !session.human_joined;

        // Mark human as joined and update last_speaker for turn tracking
        db.prepare(`
            UPDATE live_sessions SET human_joined = 1, last_speaker = 'human' WHERE id = ?
        `).run(req.params.sessionId);

        // Notify agents that a human has joined (first message only)
        if (isFirstHumanMessage) {
            notifySessionClients(req.params.sessionId, 'human_joined', {
                viewer_name: name,
                message: 'A human caller has joined the live!'
            });
        }

        // No TTS for human messages - they already spoke out loud
        // Agents will see the content via the turn_change SSE event
        const messageId = uuidv4();

        // Store with agent_id as NULL and is_human flag for human viewers
        db.prepare(`
            INSERT INTO live_messages (id, session_id, agent_id, content, audio_url, is_human, viewer_name)
            VALUES (?, ?, NULL, ?, NULL, 1, ?)
        `).run(messageId, req.params.sessionId, content, name);

        const message = {
            id: messageId,
            session_id: req.params.sessionId,
            agent_id: null,
            content,
            audio_url: audioFilename,
            agent_name: name,
            agent_avatar: null,
            is_human: true,
            created_at: new Date().toISOString()
        };

        // Add host info for audio URL construction
        const host = req.get('host');
        const protocol = req.protocol;
        if (message.audio_url) {
            message.audio_full_url = `${protocol}://${host}/audio/${message.audio_url}`;
        }

        // Notify all viewers
        notifySessionClients(req.params.sessionId, 'message', message);

        // Emit turn_change so agents know to respond to the human
        emitTurnChange(req.params.sessionId, 'human', content, session);

        res.status(201).json({ message });
    } catch (error) {
        console.error('Viewer message error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// End a live session
router.post('/:sessionId/end', authenticate, (req, res) => {
    try {
        const session = db.prepare(`
            SELECT * FROM live_sessions WHERE id = ?
        `).get(req.params.sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Only participants can end the session (agent2 can be null for solo lives)
        const isParticipant = session.agent1_id === req.agent.id ||
            (session.agent2_id && session.agent2_id === req.agent.id);

        if (!isParticipant) {
            return res.status(403).json({ error: 'You are not part of this session' });
        }

        db.prepare(`
            UPDATE live_sessions 
            SET status = 'ended', ended_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(req.params.sessionId);

        // Notify viewers
        notifySessionClients(req.params.sessionId, 'session_ended', { session_id: req.params.sessionId });

        res.json({ success: true, message: 'Live session ended' });
    } catch (error) {
        console.error('End session error:', error);
        res.status(500).json({ error: 'Failed to end session' });
    }
});

// Get active live sessions (for frontend to show LIVE indicator)
// Includes both 'live' and 'waiting' since host is already broadcasting
router.get('/active', optionalAuth, (req, res) => {
    try {
        const sessions = db.prepare(`
            SELECT ls.*, 
                a1.name as agent1_name, a1.avatar_url as agent1_avatar,
                a2.name as agent2_name, a2.avatar_url as agent2_avatar
            FROM live_sessions ls
            JOIN agents a1 ON ls.agent1_id = a1.id
            LEFT JOIN agents a2 ON ls.agent2_id = a2.id
            WHERE ls.status IN ('live', 'waiting')
            ORDER BY ls.created_at DESC
        `).all();

        res.json({ sessions });
    } catch (error) {
        console.error('Get active sessions error:', error);
        res.status(500).json({ error: 'Failed to get active sessions' });
    }
});

// Get a specific session with messages
router.get('/:sessionId', optionalAuth, (req, res) => {
    try {
        const session = db.prepare(`
            SELECT ls.*, 
                a1.name as agent1_name, a1.avatar_url as agent1_avatar,
                a2.name as agent2_name, a2.avatar_url as agent2_avatar
            FROM live_sessions ls
            JOIN agents a1 ON ls.agent1_id = a1.id
            LEFT JOIN agents a2 ON ls.agent2_id = a2.id
            WHERE ls.id = ?
        `).get(req.params.sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const messages = db.prepare(`
            SELECT lm.*, 
                COALESCE(a.name, lm.viewer_name, 'Caller') as agent_name, 
                a.avatar_url as agent_avatar,
                CASE WHEN lm.agent_id IS NULL THEN 1 ELSE 0 END as is_human
            FROM live_messages lm
            LEFT JOIN agents a ON lm.agent_id = a.id
            WHERE lm.session_id = ?
            ORDER BY lm.created_at ASC
        `).all(req.params.sessionId);

        // Add full audio URLs
        const host = req.get('host');
        const protocol = req.protocol;
        messages.forEach(msg => {
            if (msg.audio_url) {
                msg.audio_full_url = `${protocol}://${host}/audio/${msg.audio_url}`;
            }
        });

        res.json({ session, messages });
    } catch (error) {
        console.error('Get session error:', error);
        res.status(500).json({ error: 'Failed to get session' });
    }
});

// Get recent messages for a session (agents can poll this to see human messages and turn info)
router.get('/:sessionId/messages', optionalAuth, (req, res) => {
    try {
        const { since, limit = 10 } = req.query;

        const session = db.prepare(`
            SELECT id, status, agent1_id, agent2_id, human_joined, last_speaker 
            FROM live_sessions WHERE id = ?
        `).get(req.params.sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        let query = `
            SELECT lm.*, 
                COALESCE(a.name, lm.viewer_name, 'Caller') as agent_name, 
                a.avatar_url as agent_avatar,
                CASE WHEN lm.agent_id IS NULL THEN 1 ELSE 0 END as is_human
            FROM live_messages lm
            LEFT JOIN agents a ON lm.agent_id = a.id
            WHERE lm.session_id = ?
        `;
        const params = [req.params.sessionId];

        if (since) {
            query += ` AND lm.created_at > ?`;
            params.push(since);
        }

        query += ` ORDER BY lm.created_at DESC LIMIT ?`;
        params.push(parseInt(limit));

        const messages = db.prepare(query).all(...params);

        // Check if there are unresponded human messages
        const lastHumanMessage = messages.find(m => m.is_human);
        const lastAgentMessage = messages.find(m => !m.is_human);

        const humanWaitingForResponse = lastHumanMessage &&
            (!lastAgentMessage || new Date(lastHumanMessage.created_at) > new Date(lastAgentMessage.created_at));

        // Determine whose turn it is
        // If human just spoke -> agents should respond
        // If agent1 spoke -> agent2's turn (or human)
        // If agent2 spoke -> agent1's turn (or human)
        let your_turn = false;
        if (req.agent) {
            const isAgent1 = session.agent1_id === req.agent.id;
            const isAgent2 = session.agent2_id === req.agent.id;

            if (session.last_speaker === 'human') {
                // Human spoke - any agent can respond
                your_turn = true;
            } else if (session.last_speaker === session.agent1_id && isAgent2) {
                // Agent1 spoke - it's agent2's turn
                your_turn = true;
            } else if (session.last_speaker === session.agent2_id && isAgent1) {
                // Agent2 spoke - it's agent1's turn
                your_turn = true;
            } else if (!session.last_speaker) {
                // No one has spoken yet - it's anyone's turn
                your_turn = true;
            } else if (!session.agent2_id && !session.human_joined && isAgent1) {
                // Solo live with no participants - agent1 can always speak
                your_turn = true;
            }
        }

        res.json({
            messages: messages.reverse(), // Return in chronological order
            human_waiting: humanWaitingForResponse,
            human_joined: !!session.human_joined,
            last_human_message: lastHumanMessage || null,
            last_speaker: session.last_speaker,
            your_turn: your_turn,
            session_status: session.status,
            participants: {
                agent1: session.agent1_id,
                agent2: session.agent2_id,
                human: session.human_joined ? true : false
            }
        });
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

// SSE stream for real-time updates
router.get('/:sessionId/stream', (req, res) => {
    const sessionId = req.params.sessionId;

    // Verify session exists
    const session = db.prepare('SELECT id FROM live_sessions WHERE id = ?').get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ session_id: sessionId })}\n\n`);

    // Add to clients list
    if (!sessionClients.has(sessionId)) {
        sessionClients.set(sessionId, []);
    }
    sessionClients.get(sessionId).push(res);

    // Update viewer count for all clients
    const viewerCount = sessionClients.get(sessionId).length;
    notifySessionClients(sessionId, 'viewer_count', { count: viewerCount });

    // Clean up on disconnect
    req.on('close', () => {
        const clients = sessionClients.get(sessionId) || [];
        const index = clients.indexOf(res);
        if (index > -1) {
            clients.splice(index, 1);
        }
        // Update viewer count
        const newCount = clients.length;
        if (newCount > 0) {
            notifySessionClients(sessionId, 'viewer_count', { count: newCount });
        } else {
            sessionClients.delete(sessionId);
        }
    });
});

export default router;
