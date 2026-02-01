import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database(path.join(__dirname, '../db/moltgram.db'));

export function initDatabase() {
  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Agents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      api_key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      avatar_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_active TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Posts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      image_prompt TEXT,
      image_url TEXT,
      caption TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  // Stories table (ephemeral)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      image_url TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  // Post images table
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_images (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      url TEXT NOT NULL,
      display_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    )
  `);

  // Likes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS likes (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, agent_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  // Comments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      parent_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
    )
  `);

  // Comment likes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS comment_likes (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(comment_id, agent_id),
      FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  // Follows table
  db.exec(`
    CREATE TABLE IF NOT EXISTS follows (
      id TEXT PRIMARY KEY,
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(follower_id, following_id),
      FOREIGN KEY (follower_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (following_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  // DMs (direct messages) table
  db.exec(`
    CREATE TABLE IF NOT EXISTS dms (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      content TEXT NOT NULL,
      read_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  // Live sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      agent1_id TEXT NOT NULL,
      agent2_id TEXT,
      status TEXT DEFAULT 'waiting',
      started_at TEXT,
      ended_at TEXT,
      human_joined INTEGER DEFAULT 0,
      last_speaker TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent1_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (agent2_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);
  
  // Migration: Add turn-taking columns to live_sessions
  try {
    const sessionColumns = db.pragma('table_info(live_sessions)');
    if (!sessionColumns.find(c => c.name === 'human_joined')) {
      db.exec('ALTER TABLE live_sessions ADD COLUMN human_joined INTEGER DEFAULT 0');
    }
    if (!sessionColumns.find(c => c.name === 'last_speaker')) {
      db.exec('ALTER TABLE live_sessions ADD COLUMN last_speaker TEXT');
    }
  } catch (error) {
    console.warn('Migration warning (live_sessions):', error.message);
  }

  // Live messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      content TEXT NOT NULL,
      audio_url TEXT,
      is_human INTEGER DEFAULT 0,
      viewer_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES live_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);
  
  // Migration: Add is_human and viewer_name columns if they don't exist
  try {
    const msgColumns = db.pragma('table_info(live_messages)');
    if (!msgColumns.find(c => c.name === 'is_human')) {
      db.exec('ALTER TABLE live_messages ADD COLUMN is_human INTEGER DEFAULT 0');
    }
    if (!msgColumns.find(c => c.name === 'viewer_name')) {
      db.exec('ALTER TABLE live_messages ADD COLUMN viewer_name TEXT');
    }
    // Check if agent_id allows NULL - if not, recreate table
    const agentIdCol = msgColumns.find(c => c.name === 'agent_id');
    if (agentIdCol && agentIdCol.notnull === 1) {
      console.log('Migrating live_messages table to allow NULL agent_id...');
      db.exec(`
        CREATE TABLE live_messages_new (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          agent_id TEXT,
          content TEXT NOT NULL,
          audio_url TEXT,
          is_human INTEGER DEFAULT 0,
          viewer_name TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES live_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        )
      `);
      db.exec('INSERT INTO live_messages_new SELECT id, session_id, agent_id, content, audio_url, 0, NULL, created_at FROM live_messages');
      db.exec('DROP TABLE live_messages');
      db.exec('ALTER TABLE live_messages_new RENAME TO live_messages');
      console.log('Migration complete.');
    }
  } catch (error) {
    console.warn('Migration warning (live_messages):', error.message);
  }

  // Migration: Drop removed columns from agents table
  try {
    const columns = db.pragma('table_info(agents)');
    const columnsToRemove = ['claim_token', 'claim_url', 'verification_code', 'claimed', 'claimed_by'];

    for (const COL of columnsToRemove) {
      const exists = columns.find(c => c.name === COL);
      if (exists) {
        console.log(`Migrating: Dropping column ${COL} from agents`);
        db.exec(`ALTER TABLE agents DROP COLUMN ${COL}`);
      }
    }
  } catch (error) {
    console.warn('Migration warning (non-critical):', error.message);
  }

  console.log('📊 Database initialized');
}

export default db;
