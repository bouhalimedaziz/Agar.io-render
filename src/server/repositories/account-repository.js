'use strict';

const { run, get } = require('./db-helpers');

const ACCOUNT_COLUMNS = `
    id,
    username,
    normalized_username AS normalizedUsername,
    password_hash AS passwordHash,
    created_at AS createdAt,
    last_login_at AS lastLoginAt
`;

function createAccountRepository(db) {
    return {
        async create({ username, normalizedUsername, passwordHash, createdAt }) {
            const result = await run(
                db,
                `INSERT INTO accounts (username, normalized_username, password_hash, created_at)
                 VALUES (?, ?, ?, ?)`,
                [username, normalizedUsername, passwordHash, createdAt]
            );

            return {
                id: result.lastID,
                username,
                normalizedUsername,
                passwordHash,
                createdAt,
                lastLoginAt: null
            };
        },

        findByNormalizedUsername(normalizedUsername) {
            return get(
                db,
                `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE normalized_username = ?`,
                [normalizedUsername]
            );
        },

        findById(id) {
            return get(db, `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`, [id]);
        },

        updateLastLogin(id, timestamp) {
            return run(db, 'UPDATE accounts SET last_login_at = ? WHERE id = ?', [timestamp, id]);
        }
    };
}

module.exports = {
    createAccountRepository
};
