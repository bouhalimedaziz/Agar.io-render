'use strict';

const ROOM_ERROR_CODES = Object.freeze({
    ROOM_NOT_FOUND: 'room_not_found',
    ROOM_NAME_TAKEN: 'room_name_taken',
    INVALID_ROOM_NAME: 'invalid_room_name',
    INVALID_VISIBILITY: 'invalid_visibility',
    INVALID_SETTINGS: 'invalid_settings',
    INVALID_UPDATE: 'invalid_update',
    NOT_OWNER: 'not_owner',
    ROOM_FULL: 'room_full',
    ROOM_CLOSED: 'room_closed',
    ROOM_PRIVATE: 'room_private',
    ALREADY_IN_ROOM: 'already_in_room',
    NOT_IN_ROOM: 'not_in_room',
    ROOM_LIMIT_REACHED: 'room_limit_reached',
    ROOM_IN_GAME: 'room_in_game',
    GAME_IN_PROGRESS: 'game_in_progress',
    GAME_NOT_RUNNING: 'game_not_running',
    NOT_ENOUGH_PLAYERS: 'not_enough_players',
    PLAYERS_NOT_READY: 'players_not_ready',
    NOT_A_PLAYER: 'not_a_player',
    INTERNAL_ERROR: 'internal_error'
});

class RoomError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = 'RoomError';
        this.code = code;
        if (details !== undefined) {
            this.details = details;
        }
    }

    toPayload() {
        const payload = { code: this.code, message: this.message };
        if (this.details !== undefined) {
            payload.details = this.details;
        }
        return payload;
    }
}

module.exports = {
    ROOM_ERROR_CODES,
    RoomError
};
