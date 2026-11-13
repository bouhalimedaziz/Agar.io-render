'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS failed_login_attempts (
    username TEXT,
    ip_address TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
    username TEXT,
    message TEXT,
    ip_address TEXT,
    room_id TEXT,
    timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    normalized_username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT,
    room_name TEXT,
    room_code TEXT,
    reason TEXT NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    winner_id TEXT,
    winner_name TEXT,
    player_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS match_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    account_id INTEGER,
    name TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    rank INTEGER,
    winner INTEGER NOT NULL DEFAULT 0,
    mass_total INTEGER NOT NULL DEFAULT 0,
    peak_mass INTEGER NOT NULL DEFAULT 0,
    kills INTEGER NOT NULL DEFAULT 0,
    food_eaten INTEGER NOT NULL DEFAULT 0,
    survived_ms INTEGER NOT NULL DEFAULT 0,
    alive INTEGER NOT NULL DEFAULT 0,
    dnf INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (match_id) REFERENCES matches (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions (account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_matches_room_id ON matches (room_id);
CREATE INDEX IF NOT EXISTS idx_matches_finished_at ON matches (finished_at);
CREATE INDEX IF NOT EXISTS idx_match_players_match_id ON match_players (match_id);
CREATE INDEX IF NOT EXISTS idx_match_players_account_id ON match_players (account_id);
`;

/**
 * Open a SQLite database. The special path ':memory:' is passed through
 * without trying to create folders, which keeps tests side-effect free.
 */
function createDatabase(filePath) {
    if (filePath !== ':memory:') {
        const folder = path.dirname(filePath);
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true });
            console.log(`Created the database folder: ${folder}`);
        }
    }

    return new sqlite3.Database(filePath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
}

/**
 * Older databases created before room-scoped chat need the room_id column.
 * `CREATE TABLE IF NOT EXISTS` does not alter an existing table, so migrate it
 * before creating the index.
 */
function ensureChatRoomId(db) {
    return new Promise((resolve, reject) => {
        db.all('PRAGMA table_info(chat_messages)', (err, rows) => {
            if (err) {
                reject(err);
                return;
            }

            const hasRoomId = (rows || []).some((row) => row.name === 'room_id');
            if (hasRoomId) {
                resolve();
                return;
            }

            db.run('ALTER TABLE chat_messages ADD COLUMN room_id TEXT', (alterErr) => {
                if (alterErr) {
                    reject(alterErr);
                } else {
                    resolve();
                }
            });
        });
    });
}

function createChatIndexes(db) {
    return new Promise((resolve, reject) => {
        db.exec(
            'CREATE INDEX IF NOT EXISTS idx_chat_messages_room_id ON chat_messages (room_id);',
            (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            }
        );
    });
}

/**
 * Create every table and index used by the server. Resolves once the whole
 * script has run, so callers can safely query afterwards.
 */
function initializeSchema(db) {
    return new Promise((resolve, reject) => {
        db.exec(SCHEMA, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    })
        .then(() => ensureChatRoomId(db))
        .then(() => createChatIndexes(db));
}

module.exports = {
    SCHEMA,
    createDatabase,
    initializeSchema
};
