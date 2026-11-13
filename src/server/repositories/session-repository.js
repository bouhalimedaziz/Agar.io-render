'use strict';

const { run, get, all } = require('./db-helpers');

const SESSION_COLUMNS = `
    token,
    account_id AS accountId,
    created_at AS createdAt,
    expires_at AS expiresAt,
    last_seen_at AS lastSeenAt,
    state
`;

function createSessionRepository(db) {
    return {
        async create({ token, accountId, createdAt, expiresAt, lastSeenAt }) {
            await run(
                db,
                `INSERT INTO sessions (token, account_id, created_at, expires_at, last_seen_at, state)
                 VALUES (?, ?, ?, ?, ?, 'active')`,
                [token, accountId, createdAt, expiresAt, lastSeenAt]
            );

            return {
                token,
                accountId,
                createdAt,
                expiresAt,
                lastSeenAt,
                state: 'active'
            };
        },

        findByToken(token) {
            return get(db, `SELECT ${SESSION_COLUMNS} FROM sessions WHERE token = ?`, [token]);
        },

        findActiveByAccountId(accountId, now) {
            return all(
                db,
                `SELECT ${SESSION_COLUMNS} FROM sessions
                 WHERE account_id = ? AND expires_at > ?
                 ORDER BY created_at DESC`,
                [accountId, now]
            );
        },

        async markActive(token, timestamp) {
            const result = await run(
                db,
                `UPDATE sessions SET state = 'active', last_seen_at = ? WHERE token = ?`,
                [timestamp, token]
            );
            return result.changes > 0;
        },

        async markDisconnected(token, timestamp) {
            const result = await run(
                db,
                `UPDATE sessions SET state = 'disconnected', last_seen_at = ? WHERE token = ?`,
                [timestamp, token]
            );
            return result.changes > 0;
        },

        async deleteByToken(token) {
            const result = await run(db, 'DELETE FROM sessions WHERE token = ?', [token]);
            return result.changes > 0;
        },

        async deleteByAccountId(accountId, exceptToken) {
            const rows = await all(
                db,
                'SELECT token FROM sessions WHERE account_id = ? AND token != ?',
                [accountId, exceptToken || '']
            );

            if (rows.length === 0) {
                return [];
            }

            await run(db, 'DELETE FROM sessions WHERE account_id = ? AND token != ?', [
                accountId,
                exceptToken || ''
            ]);

            return rows.map((row) => row.token);
        },

        async deleteExpired(now) {
            const result = await run(db, 'DELETE FROM sessions WHERE expires_at <= ?', [now]);
            return result.changes;
        }
    };
}

module.exports = {
    createSessionRepository
};
