'use strict';

const END_REASONS = Object.freeze({
    owner_stop: 'The room owner stopped the match.',
    time_limit: 'The time limit was reached.',
    score_limit: 'A player reached the score limit.',
    last_player_standing: 'Only one player remained.',
    not_enough_players: 'Not enough players were left to continue.',
    empty_room: 'Everyone left the room.',
    finished: 'The match finished.'
});

const ROOM_ERROR_MESSAGES = Object.freeze({
    room_not_found: 'That room no longer exists.',
    room_name_taken: 'A room with that name already exists.',
    invalid_room_name: 'Room names must be 3-30 letters, numbers, spaces, _ or -.',
    invalid_visibility: 'Choose a public or private room.',
    invalid_settings: 'One of the room settings is out of range.',
    invalid_update: 'That room update is not supported.',
    not_owner: 'Only the room owner can do that.',
    room_full: 'That room is full.',
    room_closed: 'That room is closed.',
    room_private: 'That room is private.',
    already_in_room: 'You are already in a room.',
    not_in_room: 'You are not in a room.',
    room_limit_reached: 'The server has reached its room limit.',
    room_in_game: 'That room is already playing. Join as a spectator or wait.',
    game_in_progress: 'The game is already running.',
    game_not_running: 'There is no running game.',
    not_enough_players: 'At least 2 players are required to start.',
    players_not_ready: 'All players must be ready before the match can start.',
    not_a_player: 'Spectators cannot ready up.',
    internal_error: 'Something went wrong. Please try again.'
});

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function pad2(value) {
    return value < 10 ? '0' + value : String(value);
}

/**
 * Format a duration in milliseconds as `m:ss` (or `h:mm:ss`).
 */
function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(toNumber(ms) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return hours + ':' + pad2(minutes) + ':' + pad2(seconds);
    }
    return minutes + ':' + pad2(seconds);
}

/**
 * Remaining whole seconds for a countdown. Rounds up so `1` is shown for the
 * final second rather than `0` before the match starts.
 */
function formatCountdown(ms) {
    return String(Math.max(0, Math.ceil(toNumber(ms) / 1000)));
}

function countdownRemaining(startsAt, now) {
    return Math.max(0, toNumber(startsAt) - toNumber(now));
}

function formatTimeLimit(ms) {
    return toNumber(ms) > 0 ? formatDuration(ms) : 'No limit';
}

function formatScoreLimit(value) {
    return toNumber(value) > 0 ? String(Math.round(toNumber(value))) : 'No limit';
}

function formatVisibility(visibility) {
    return visibility === 'private' ? 'Private' : 'Public';
}

function formatRoomStatus(status) {
    if (status === 'closed') {
        return 'Closed';
    }
    return 'Open';
}

function formatRoomMeta(room) {
    if (!room) {
        return '';
    }
    const players = toNumber(room.memberCount) + '/' + toNumber(room.capacity);
    return formatVisibility(room.visibility) + ' · ' + players + ' players';
}

function formatEndReason(reason) {
    if (!reason) {
        return 'The match finished.';
    }
    if (END_REASONS[reason]) {
        return END_REASONS[reason];
    }

    const words = String(reason).replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1) + '.';
}

function resultEntries(result) {
    if (!result || !Array.isArray(result.scores)) {
        return [];
    }
    return result.scores.slice().sort((a, b) => {
        const rankA = toNumber(a && a.rank) || Number.MAX_SAFE_INTEGER;
        const rankB = toNumber(b && b.rank) || Number.MAX_SAFE_INTEGER;
        if (rankA !== rankB) {
            return rankA - rankB;
        }
        return String(a && a.name).localeCompare(String(b && b.name));
    });
}

function formatResultTitle(result) {
    const entries = resultEntries(result);
    if (entries.length === 0) {
        return 'Match over';
    }

    const winners = entries.filter((entry) => entry.winner);
    if (winners.length > 1) {
        return 'Draw: ' + winners.map((entry) => entry.name).join(' & ');
    }
    if (winners.length === 1) {
        return winners[0].name + ' wins!';
    }

    return result && result.tie ? 'Draw' : 'Match over';
}

function formatResultSubtitle(result) {
    if (!result) {
        return '';
    }

    const parts = [formatEndReason(result.reason)];
    if (toNumber(result.durationMs) > 0) {
        parts.push('Duration ' + formatDuration(result.durationMs));
    }
    return parts.join(' · ');
}

function formatRank(rank) {
    const value = toNumber(rank);
    return value > 0 ? '#' + value : '—';
}

function formatScore(score) {
    return String(Math.round(toNumber(score)));
}

function formatMemberStatus(member) {
    if (!member) {
        return '';
    }
    if (member.role === 'spectator') {
        return 'Spectating';
    }
    if (member.alive === false) {
        return 'Eliminated';
    }
    return member.ready ? 'Ready' : 'Not ready';
}

function formatRoomError(payload, fallback) {
    if (payload && typeof payload.message === 'string' && payload.message.length > 0) {
        return payload.message;
    }
    if (payload && payload.code && ROOM_ERROR_MESSAGES[payload.code]) {
        return ROOM_ERROR_MESSAGES[payload.code];
    }
    if (payload && payload.code) {
        return String(payload.code).replace(/_/g, ' ');
    }
    return fallback || 'Something went wrong. Please try again.';
}

function formatAuthError(payload, fallback) {
    if (payload && typeof payload.message === 'string' && payload.message.length > 0) {
        return payload.message;
    }
    return fallback || 'Sign in failed. Please try again.';
}

function formatIdentity(account) {
    if (!account || !account.username) {
        return 'Guest';
    }
    return account.username;
}

module.exports = {
    END_REASONS,
    ROOM_ERROR_MESSAGES,
    formatDuration,
    formatCountdown,
    countdownRemaining,
    formatTimeLimit,
    formatScoreLimit,
    formatVisibility,
    formatRoomStatus,
    formatRoomMeta,
    formatEndReason,
    formatResultTitle,
    formatResultSubtitle,
    resultEntries,
    formatRank,
    formatScore,
    formatMemberStatus,
    formatRoomError,
    formatAuthError,
    formatIdentity
};
