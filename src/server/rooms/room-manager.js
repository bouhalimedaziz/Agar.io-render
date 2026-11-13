'use strict';

const crypto = require('crypto');

const { ROOM_ERROR_CODES, RoomError } = require('./errors');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const DEFAULT_ROOM_SETTINGS = Object.freeze({
    mapWidth: 5000,
    mapHeight: 5000,
    maxFood: 1000,
    maxVirus: 50,
    foodMass: 1,
    defaultPlayerMass: 10,
    gameMass: 20000,
    maxPlayers: 8,
    timeLimitMs: 0,
    scoreLimit: 0
});

const SETTING_RULES = Object.freeze({
    mapWidth: { min: 1000, max: 20000, integer: true, label: 'Map width' },
    mapHeight: { min: 1000, max: 20000, integer: true, label: 'Map height' },
    maxFood: { min: 0, max: 5000, integer: true, label: 'Max food' },
    maxVirus: { min: 0, max: 500, integer: true, label: 'Max viruses' },
    foodMass: { min: 1, max: 100, integer: false, label: 'Food mass' },
    defaultPlayerMass: { min: 5, max: 500, integer: false, label: 'Starting mass' },
    gameMass: { min: 1000, max: 1000000, integer: true, label: 'Game mass' },
    maxPlayers: { min: 1, max: 50, integer: true, label: 'Max players' },
    timeLimitMs: { min: 0, max: 24 * 60 * 60 * 1000, integer: true, label: 'Time limit' },
    scoreLimit: { min: 0, max: 1000000000, integer: true, label: 'Score limit' }
});

const SETTING_KEYS = Object.keys(SETTING_RULES);

function nameKey(name) {
    return name.trim().toLowerCase();
}

function accountIdFromMemberId(memberId) {
    if (typeof memberId !== 'string' || !memberId.startsWith('account:')) {
        return null;
    }

    const id = parseInt(memberId.slice('account:'.length), 10);
    return Number.isInteger(id) ? id : null;
}

/**
 * In-memory lobby of rooms.
 *
 * Rooms are not game sessions yet; they only describe what a client can see
 * and change in the lobby. Phase 3 adds explicit join/leave behavior on top
 * of the membership helpers here.
 */
class RoomManager {
    constructor(options = {}) {
        this.defaults = Object.assign({}, DEFAULT_ROOM_SETTINGS, options.defaults || {});
        this.emptyRoomGraceMs = options.emptyRoomGraceMs === undefined
            ? 5 * 60 * 1000
            : options.emptyRoomGraceMs;
        this.maxRooms = options.maxRooms === undefined ? 200 : options.maxRooms;
        this.now = typeof options.now === 'function' ? options.now : Date.now;

        if (!Number.isFinite(this.emptyRoomGraceMs) || this.emptyRoomGraceMs < 0) {
            throw new TypeError('emptyRoomGraceMs must be a non-negative number');
        }
        if (!Number.isInteger(this.maxRooms) || this.maxRooms <= 0) {
            throw new TypeError('maxRooms must be a positive integer');
        }

        // Validate defaults once so a bad configuration fails at startup.
        this._buildSettings(this.defaults);

        this.rooms = new Map();
        this.codes = new Map();
        this.names = new Map();
        // memberId -> room id. Enforces one room per player/spectator and
        // makes reconnect restoration a simple lookup.
        this.memberRooms = new Map();
    }

    get size() {
        return this.rooms.size;
    }

    _validateName(rawName) {
        if (typeof rawName !== 'string') {
            throw new RoomError(ROOM_ERROR_CODES.INVALID_ROOM_NAME, 'Room name is required.');
        }

        const name = rawName.trim();
        if (name.length < 3 || name.length > 30) {
            throw new RoomError(
                ROOM_ERROR_CODES.INVALID_ROOM_NAME,
                'Room name must be 3-30 characters.'
            );
        }

        if (!/^[A-Za-z0-9 _-]+$/.test(name)) {
            throw new RoomError(
                ROOM_ERROR_CODES.INVALID_ROOM_NAME,
                'Room name may only contain letters, numbers, spaces, underscores and dashes.'
            );
        }

        return name;
    }

    _validateVisibility(visibility) {
        if (visibility !== 'public' && visibility !== 'private') {
            throw new RoomError(
                ROOM_ERROR_CODES.INVALID_VISIBILITY,
                'Room visibility must be "public" or "private".'
            );
        }
        return visibility;
    }

    _validateSetting(key, value) {
        const rule = SETTING_RULES[key];

        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new RoomError(
                ROOM_ERROR_CODES.INVALID_SETTINGS,
                rule.label + ' must be a number.',
                { setting: key }
            );
        }

        if (rule.integer && !Number.isInteger(value)) {
            throw new RoomError(
                ROOM_ERROR_CODES.INVALID_SETTINGS,
                rule.label + ' must be a whole number.',
                { setting: key }
            );
        }

        if (value < rule.min || value > rule.max) {
            throw new RoomError(
                ROOM_ERROR_CODES.INVALID_SETTINGS,
                rule.label + ' must be between ' + rule.min + ' and ' + rule.max + '.',
                { setting: key }
            );
        }

        return value;
    }

    _validateSettingObject(raw) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new RoomError(ROOM_ERROR_CODES.INVALID_SETTINGS, 'Settings must be an object.');
        }

        for (const key of Object.keys(raw)) {
            if (!Object.prototype.hasOwnProperty.call(SETTING_RULES, key)) {
                throw new RoomError(
                    ROOM_ERROR_CODES.INVALID_SETTINGS,
                    'Unknown room setting: ' + key,
                    { setting: key }
                );
            }
        }
    }

    _buildSettings(raw) {
        this._validateSettingObject(raw);

        const merged = Object.assign({}, this.defaults, raw);
        for (const key of Object.keys(merged)) {
            if (!Object.prototype.hasOwnProperty.call(SETTING_RULES, key)) {
                throw new RoomError(
                    ROOM_ERROR_CODES.INVALID_SETTINGS,
                    'Unknown room setting: ' + key,
                    { setting: key }
                );
            }
        }

        const result = {};
        for (const key of SETTING_KEYS) {
            result[key] = this._validateSetting(key, merged[key]);
        }
        return result;
    }

    _mergeSettings(current, partial) {
        if (partial === undefined) {
            return current;
        }

        this._validateSettingObject(partial);

        const merged = Object.assign({}, current, partial);
        const result = {};
        for (const key of SETTING_KEYS) {
            result[key] = this._validateSetting(key, merged[key]);
        }
        return result;
    }

    _isNameTaken(name, exceptId) {
        const key = nameKey(name);
        const roomId = this.names.get(key);
        return roomId !== undefined && roomId !== exceptId;
    }

    _generateId() {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const id = 'room_' + crypto.randomBytes(8).toString('hex');
            if (!this.rooms.has(id)) {
                return id;
            }
        }
        throw new RoomError(
            ROOM_ERROR_CODES.INTERNAL_ERROR,
            'Could not allocate a room id.'
        );
    }

    _generateCode() {
        for (let attempt = 0; attempt < 50; attempt += 1) {
            let code = '';
            for (let i = 0; i < CODE_LENGTH; i += 1) {
                code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
            }
            if (!this.codes.has(code)) {
                return code;
            }
        }
        throw new RoomError(
            ROOM_ERROR_CODES.INTERNAL_ERROR,
            'Could not allocate a room code.'
        );
    }

    createRoom(input = {}) {
        if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
            throw new TypeError('ownerId is required to create a room');
        }

        if (this.rooms.size >= this.maxRooms) {
            throw new RoomError(
                ROOM_ERROR_CODES.ROOM_LIMIT_REACHED,
                'The server has reached its room limit.'
            );
        }

        const name = this._validateName(input.name);
        const visibility = this._validateVisibility(input.visibility || 'public');

        if (this._isNameTaken(name)) {
            throw new RoomError(
                ROOM_ERROR_CODES.ROOM_NAME_TAKEN,
                'A room with that name already exists.'
            );
        }

        const settings = this._buildSettings(input.settings || {});
        const now = this.now();

        const room = {
            id: this._generateId(),
            code: this._generateCode(),
            name,
            normalizedName: nameKey(name),
            ownerId: input.ownerId,
            ownerAccountId: input.ownerAccountId === undefined ? null : input.ownerAccountId,
            visibility,
            capacity: settings.maxPlayers,
            status: 'open',
            settings,
            members: [],
            spectators: [],
            ready: new Set(),
            createdAt: now,
            updatedAt: now,
            emptySince: now
        };

        this.rooms.set(room.id, room);
        this.codes.set(room.code, room.id);
        this.names.set(room.normalizedName, room.id);

        return room;
    }

    getRoom(idOrCode) {
        if (typeof idOrCode !== 'string' || idOrCode.length === 0) {
            return null;
        }

        const byId = this.rooms.get(idOrCode);
        if (byId) {
            return byId;
        }

        const roomId = this.codes.get(idOrCode.toUpperCase());
        return roomId ? this.rooms.get(roomId) : null;
    }

    listRooms(options = {}) {
        const viewerId = options.viewerId || null;
        const includePrivate = options.includePrivate === true;
        const visibility = options.visibility;

        const rooms = [];
        for (const room of this.rooms.values()) {
            if (room.status === 'closed') {
                continue;
            }
            if (visibility && room.visibility !== visibility) {
                continue;
            }
            if (
                room.visibility === 'private' &&
                !includePrivate &&
                room.ownerId !== viewerId
            ) {
                continue;
            }
            rooms.push(room);
        }

        rooms.sort((a, b) => {
            if (a.createdAt !== b.createdAt) {
                return b.createdAt - a.createdAt;
            }
            return a.id.localeCompare(b.id);
        });

        return rooms;
    }

    updateRoom(idOrCode, actorId, changes = {}) {
        const room = this.getRoom(idOrCode);
        if (!room) {
            throw new RoomError(ROOM_ERROR_CODES.ROOM_NOT_FOUND, 'Room not found.');
        }
        if (actorId !== room.ownerId) {
            throw new RoomError(
                ROOM_ERROR_CODES.NOT_OWNER,
                'Only the room owner can change these settings.'
            );
        }

        if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
            throw new RoomError(ROOM_ERROR_CODES.INVALID_UPDATE, 'Update must be an object.');
        }

        for (const key of Object.keys(changes)) {
            if (key !== 'name' && key !== 'visibility' && key !== 'settings') {
                throw new RoomError(
                    ROOM_ERROR_CODES.INVALID_UPDATE,
                    'Unknown room update field: ' + key
                );
            }
        }

        let nextName = room.name;

        if (changes.name !== undefined) {
            nextName = this._validateName(changes.name);
            if (this._isNameTaken(nextName, room.id)) {
                throw new RoomError(
                    ROOM_ERROR_CODES.ROOM_NAME_TAKEN,
                    'A room with that name already exists.'
                );
            }
        }

        let nextVisibility = room.visibility;
        if (changes.visibility !== undefined) {
            nextVisibility = this._validateVisibility(changes.visibility);
        }

        let nextSettings = room.settings;
        if (changes.settings !== undefined) {
            nextSettings = this._mergeSettings(room.settings, changes.settings);

            if (nextSettings.maxPlayers < room.members.length) {
                throw new RoomError(
                    ROOM_ERROR_CODES.INVALID_SETTINGS,
                    'Max players cannot be lower than the current number of players.',
                    { setting: 'maxPlayers' }
                );
            }
        }

        if (nextName !== room.name) {
            this.names.delete(room.normalizedName);
            room.name = nextName;
            room.normalizedName = nameKey(nextName);
            this.names.set(room.normalizedName, room.id);
        }

        room.visibility = nextVisibility;
        room.settings = nextSettings;
        room.capacity = nextSettings.maxPlayers;
        room.updatedAt = this.now();

        return room;
    }

    removeRoom(idOrCode, actorId, options = {}) {
        const room = this.getRoom(idOrCode);
        if (!room) {
            throw new RoomError(ROOM_ERROR_CODES.ROOM_NOT_FOUND, 'Room not found.');
        }
        if (!options.force && actorId !== room.ownerId) {
            throw new RoomError(
                ROOM_ERROR_CODES.NOT_OWNER,
                'Only the room owner can remove this room.'
            );
        }

        this._removeRoom(room);
        return room;
    }

    _removeRoom(room) {
        for (const memberId of room.members.concat(room.spectators)) {
            if (this.memberRooms.get(memberId) === room.id) {
                this.memberRooms.delete(memberId);
            }
        }

        this.rooms.delete(room.id);
        this.codes.delete(room.code);
        this.names.delete(room.normalizedName);
    }

    getMembership(memberId) {
        const roomId = this.memberRooms.get(memberId);
        if (!roomId) {
            return null;
        }

        const room = this.rooms.get(roomId);
        if (!room) {
            this.memberRooms.delete(memberId);
            return null;
        }

        const role = room.members.indexOf(memberId) !== -1 ? 'player' : 'spectator';
        return { room, role };
    }

    getRoomForMember(memberId) {
        const membership = this.getMembership(memberId);
        return membership ? membership.room : null;
    }

    _transferOwnership(room) {
        const nextOwner = room.members[0] || room.spectators[0] || null;
        room.ownerId = nextOwner;
        room.ownerAccountId = nextOwner ? accountIdFromMemberId(nextOwner) : null;
    }

    _addOccupant(idOrCode, memberId, spectator, options = {}) {
        const room = this.getRoom(idOrCode);
        if (!room) {
            throw new RoomError(ROOM_ERROR_CODES.ROOM_NOT_FOUND, 'Room not found.');
        }
        if (room.status !== 'open') {
            throw new RoomError(ROOM_ERROR_CODES.ROOM_CLOSED, 'Room is not accepting players.');
        }
        if (typeof memberId !== 'string' || memberId.length === 0) {
            throw new TypeError('memberId is required');
        }

        const currentRoomId = this.memberRooms.get(memberId);
        if (currentRoomId !== undefined) {
            if (currentRoomId === room.id) {
                throw new RoomError(
                    ROOM_ERROR_CODES.ALREADY_IN_ROOM,
                    'That player is already in this room.'
                );
            }
            throw new RoomError(
                ROOM_ERROR_CODES.ALREADY_IN_ROOM,
                'A player can only be in one room at a time.',
                { roomId: currentRoomId }
            );
        }

        if (
            room.visibility === 'private' &&
            room.ownerId !== memberId &&
            options.byCode !== true
        ) {
            throw new RoomError(
                ROOM_ERROR_CODES.ROOM_PRIVATE,
                'A join code is required for this private room.'
            );
        }

        if (room.members.indexOf(memberId) !== -1 || room.spectators.indexOf(memberId) !== -1) {
            throw new RoomError(
                ROOM_ERROR_CODES.ALREADY_IN_ROOM,
                'That player is already in this room.'
            );
        }
        if (!spectator && room.members.length >= room.settings.maxPlayers) {
            throw new RoomError(ROOM_ERROR_CODES.ROOM_FULL, 'Room is full.');
        }

        if (spectator) {
            room.spectators.push(memberId);
        } else {
            room.members.push(memberId);
            room.ready.delete(memberId);
        }
        this.memberRooms.set(memberId, room.id);

        room.emptySince = null;
        room.updatedAt = this.now();
        return room;
    }

    addMember(idOrCode, memberId, options) {
        return this._addOccupant(idOrCode, memberId, false, options);
    }

    addSpectator(idOrCode, memberId, options) {
        return this._addOccupant(idOrCode, memberId, true, options);
    }

    removeMember(idOrCode, memberId) {
        const room = this.getRoom(idOrCode);
        if (!room) {
            throw new RoomError(ROOM_ERROR_CODES.ROOM_NOT_FOUND, 'Room not found.');
        }

        let index = room.members.indexOf(memberId);
        if (index !== -1) {
            room.members.splice(index, 1);
        } else {
            index = room.spectators.indexOf(memberId);
            if (index === -1) {
                throw new RoomError(
                    ROOM_ERROR_CODES.NOT_IN_ROOM,
                    'That player is not in this room.'
                );
            }
            room.spectators.splice(index, 1);
        }

        room.ready.delete(memberId);

        if (this.memberRooms.get(memberId) === room.id) {
            this.memberRooms.delete(memberId);
        }

        if (room.ownerId === memberId) {
            this._transferOwnership(room);
        }

        if (room.members.length === 0 && room.spectators.length === 0) {
            room.emptySince = this.now();
        }

        room.updatedAt = this.now();
        return room;
    }

    setReady(idOrCode, memberId, ready = true) {
        const room = this.getRoom(idOrCode);
        if (!room) {
            throw new RoomError(ROOM_ERROR_CODES.ROOM_NOT_FOUND, 'Room not found.');
        }
        if (room.members.indexOf(memberId) === -1) {
            throw new RoomError(
                ROOM_ERROR_CODES.NOT_IN_ROOM,
                'Only room players can change their ready state.'
            );
        }

        if (ready) {
            room.ready.add(memberId);
        } else {
            room.ready.delete(memberId);
        }

        room.updatedAt = this.now();
        return room;
    }

    allPlayersReady(room) {
        if (!room || room.members.length === 0) {
            return false;
        }

        return room.members.every((memberId) => room.ready.has(memberId));
    }

    clearReady(room) {
        if (room && room.ready) {
            room.ready.clear();
            room.updatedAt = this.now();
        }
        return room;
    }

    cleanupEmptyRooms(now = this.now()) {
        const removed = [];

        for (const room of Array.from(this.rooms.values())) {
            if (
                room.members.length === 0 &&
                room.spectators.length === 0 &&
                room.emptySince !== null &&
                now - room.emptySince >= this.emptyRoomGraceMs
            ) {
                this._removeRoom(room);
                removed.push(room);
            }
        }

        return removed;
    }
}

function serializeRoom(room, viewerId, options = {}) {
    const data = {
        id: room.id,
        code: room.code,
        name: room.name,
        visibility: room.visibility,
        ownerAccountId: room.ownerAccountId,
        capacity: room.settings.maxPlayers,
        status: room.status,
        settings: Object.assign({}, room.settings),
        memberCount: room.members.length,
        spectatorCount: room.spectators.length,
        readyCount: room.ready ? room.ready.size : 0,
        isReady: Boolean(
            viewerId !== undefined &&
            viewerId !== null &&
            room.ready &&
            room.ready.has(viewerId)
        ),
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
        isOwner: viewerId !== undefined && viewerId !== null && room.ownerId === viewerId
    };

    if (options.includeMembers) {
        data.members = room.members.slice();
        data.spectators = room.spectators.slice();
        data.readyMembers = room.ready ? Array.from(room.ready) : [];
    }

    return data;
}

function createRoomManager(options) {
    return new RoomManager(options);
}

module.exports = {
    DEFAULT_ROOM_SETTINGS,
    SETTING_RULES,
    RoomManager,
    createRoomManager,
    serializeRoom
};
