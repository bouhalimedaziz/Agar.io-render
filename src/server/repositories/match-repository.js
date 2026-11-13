'use strict';

const { run, get, all } = require('./db-helpers');

const MATCH_COLUMNS = `
    id,
    room_id AS roomId,
    room_name AS roomName,
    room_code AS roomCode,
    reason,
    started_at AS startedAt,
    finished_at AS finishedAt,
    duration_ms AS durationMs,
    winner_id AS winnerId,
    winner_name AS winnerName,
    player_count AS playerCount,
    created_at AS createdAt
`;

const PLAYER_COLUMNS = `
    id,
    match_id AS matchId,
    member_id AS memberId,
    account_id AS accountId,
    name,
    score,
    rank,
    winner,
    mass_total AS massTotal,
    peak_mass AS peakMass,
    kills,
    food_eaten AS foodEaten,
    survived_ms AS survivedMs,
    alive,
    dnf
`;

/**
 * Persist finished matches and expose a small read API for player history.
 * The repository takes an explicit database handle so tests and callers can
 * use an in-memory instance.
 */
function createMatchRepository(db) {
    return {
        /**
         * Insert a `GameSession` result and all of its player rows as one
         * transaction. Returns the new match id.
         */
        async saveMatch(result, meta = {}) {
            const scores = Array.isArray(result && result.scores) ? result.scores : [];
            const winner = Array.isArray(result && result.winners) && result.winners.length === 1
                ? scores.find((entry) => entry.winner) || null
                : null;
            const createdAt = Date.now();

            await run(db, 'BEGIN IMMEDIATE');

            try {
                const inserted = await run(
                    db,
                    `INSERT INTO matches (
                        room_id, room_name, room_code, reason, started_at, finished_at,
                        duration_ms, winner_id, winner_name, player_count, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        result.roomId === undefined ? null : result.roomId,
                        meta.name === undefined ? null : meta.name,
                        meta.code === undefined ? null : meta.code,
                        result.reason || 'finished',
                        result.startedAt === undefined ? null : result.startedAt,
                        result.finishedAt === undefined ? null : result.finishedAt,
                        result.durationMs || 0,
                        result.winner === undefined ? null : result.winner,
                        winner ? winner.name : null,
                        scores.length,
                        createdAt
                    ]
                );

                const matchId = inserted.lastID;

                for (const entry of scores) {
                    await run(
                        db,
                        `INSERT INTO match_players (
                            match_id, member_id, account_id, name, score, rank, winner,
                            mass_total, peak_mass, kills, food_eaten, survived_ms, alive, dnf
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            matchId,
                            entry.id,
                            entry.accountId === undefined ? null : entry.accountId,
                            entry.name || 'Guest',
                            entry.score || 0,
                            entry.rank === undefined ? null : entry.rank,
                            entry.winner ? 1 : 0,
                            entry.massTotal || 0,
                            entry.peakMass || 0,
                            entry.kills || 0,
                            entry.foodEaten || 0,
                            entry.survivedMs || 0,
                            entry.alive ? 1 : 0,
                            entry.dnf ? 1 : 0
                        ]
                    );
                }

                await run(db, 'COMMIT');
                return matchId;
            } catch (err) {
                try {
                    await run(db, 'ROLLBACK');
                } catch (rollbackErr) {
                    // Preserve the original failure.
                }
                throw err;
            }
        },

        async getMatch(matchId) {
            const match = await get(
                db,
                `SELECT ${MATCH_COLUMNS} FROM matches WHERE id = ?`,
                [matchId]
            );
            if (!match) {
                return null;
            }

            const players = await all(
                db,
                `SELECT ${PLAYER_COLUMNS} FROM match_players
                 WHERE match_id = ? ORDER BY rank ASC, id ASC`,
                [matchId]
            );

            return Object.assign({}, match, { players });
        },

        listMatchesForAccount(accountId, limit = 20) {
            const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
            return all(
                db,
                `SELECT ${MATCH_COLUMNS} FROM matches
                 WHERE id IN (
                     SELECT match_id FROM match_players WHERE account_id = ?
                 )
                 ORDER BY finished_at DESC, id DESC
                 LIMIT ?`,
                [accountId, safeLimit]
            );
        }
    };
}

module.exports = {
    createMatchRepository
};
