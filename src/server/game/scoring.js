'use strict';

/**
 * Match scoring and ranking.
 *
 * A player's score is a weighted combination of their final mass, the number
 * of players they ate, the amount of food they collected and how long they
 * survived. The weights are deliberately simple so results are easy to
 * explain in the final scoreboard; a room can override them through the
 * session options if a different balance is wanted.
 */
const DEFAULT_SCORE_WEIGHTS = Object.freeze({
    mass: 1,
    kill: 50,
    food: 2,
    survivalPerSecond: 1
});

function finiteOrZero(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeWeights(weights) {
    return Object.assign({}, DEFAULT_SCORE_WEIGHTS, weights || {});
}

function scorePlayer(stats, weights) {
    const resolved = normalizeWeights(weights);
    const mass = finiteOrZero(stats && stats.massTotal);
    const kills = finiteOrZero(stats && stats.kills);
    const food = finiteOrZero(stats && stats.foodEaten);
    const survivedMs = finiteOrZero(stats && stats.survivedMs);

    return Math.round(
        (mass * resolved.mass) +
        (kills * resolved.kill) +
        (food * resolved.food) +
        (Math.floor(survivedMs / 1000) * resolved.survivalPerSecond)
    );
}

/**
 * Deterministic ordering for equal scores. Rank is still based on score alone
 * so genuinely tied players share a rank and both count as winners.
 */
function compareEntries(a, b) {
    if (b.score !== a.score) {
        return b.score - a.score;
    }
    if (finiteOrZero(b.kills) !== finiteOrZero(a.kills)) {
        return finiteOrZero(b.kills) - finiteOrZero(a.kills);
    }
    if (finiteOrZero(b.massTotal) !== finiteOrZero(a.massTotal)) {
        return finiteOrZero(b.massTotal) - finiteOrZero(a.massTotal);
    }
    if (a.name < b.name) {
        return -1;
    }
    if (a.name > b.name) {
        return 1;
    }
    if (a.id < b.id) {
        return -1;
    }
    return a.id > b.id ? 1 : 0;
}

/**
 * Turn per-player match stats into a ranked result list.
 *
 * Players marked as DNF (they left or disconnected while still alive) are
 * listed after everyone who finished and can never win the match.
 */
function rankPlayers(statsList, weights) {
    const resolved = normalizeWeights(weights);
    const entries = (statsList || []).map((stats) => Object.assign({}, stats, {
        score: scorePlayer(stats, resolved),
        rank: null,
        winner: false,
        dnf: Boolean(stats && stats.dnf)
    }));

    const participants = entries.filter((entry) => !entry.dnf);
    const dnf = entries.filter((entry) => entry.dnf);

    participants.sort(compareEntries);
    dnf.sort(compareEntries);

    let previousScore = null;
    let previousRank = 0;

    participants.forEach((entry, index) => {
        if (index > 0 && entry.score === previousScore) {
            entry.rank = previousRank;
        } else {
            entry.rank = index + 1;
            previousRank = entry.rank;
        }
        previousScore = entry.score;
        entry.winner = entry.rank === 1;
    });

    dnf.forEach((entry, index) => {
        entry.rank = participants.length + index + 1;
        entry.winner = false;
    });

    return participants.concat(dnf);
}

module.exports = {
    DEFAULT_SCORE_WEIGHTS,
    normalizeWeights,
    scorePlayer,
    rankPlayers
};
