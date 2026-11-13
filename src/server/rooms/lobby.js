'use strict';

const { ROOM_ERROR_CODES, RoomError } = require('./errors');
const { serializeRoom } = require('./room-manager');
const { GameSession } = require('../game/game-session');

function roomSummary(room) {
    return {
        id: room.id,
        code: room.code,
        name: room.name
    };
}

function noop() {}

/**
 * Transport-facing room/lobby behavior.
 *
 * RoomManager owns the data; RoomLobby owns the protocol, room-scoped
 * broadcasts, membership restoration and disconnect grace timers. Keeping it
 * separate from server.js makes the join/leave flow unit-testable without
 * starting the game server.
 */
class RoomLobby {
    constructor(options = {}) {
        if (!options.roomManager) {
            throw new TypeError('roomManager is required');
        }
        if (!options.transport) {
            throw new TypeError('transport is required');
        }
        if (typeof options.identityForSocket !== 'function') {
            throw new TypeError('identityForSocket is required');
        }

        this.roomManager = options.roomManager;
        this.transport = options.transport;
        this.identityForSocket = options.identityForSocket;
        this.disconnectGraceMs = options.disconnectGraceMs === undefined
            ? 2 * 60 * 1000
            : options.disconnectGraceMs;
        this.setTimeoutFn = options.setTimeoutFn || setTimeout;
        this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
        this.setIntervalFn = options.setIntervalFn || setInterval;
        this.clearIntervalFn = options.clearIntervalFn || clearInterval;
        this.now = typeof options.now === 'function' ? options.now : Date.now;
        this.logger = options.logger || console;
        this.onMatchFinished = options.onMatchFinished || noop;
        // Called when a socket switches from the default game into a room.
        // The server uses it to drop the socket's default-game player/spectator
        // entry so its heartbeat timer cannot kick a room player later.
        this.onSocketEnterRoom = options.onSocketEnterRoom || noop;

        this.gameConfig = options.gameConfig || {};
        this.gameFactory = options.gameFactory ||
            ((sessionOptions) => new GameSession(sessionOptions));
        this.gameCountdownMs = options.gameCountdownMs === undefined
            ? ((this.gameConfig.game && this.gameConfig.game.countdownMs) || 3000)
            : options.gameCountdownMs;
        this.minPlayers = options.minPlayers === undefined
            ? ((this.gameConfig.game && this.gameConfig.game.minPlayers) || 2)
            : options.minPlayers;

        if (!Number.isFinite(this.disconnectGraceMs) || this.disconnectGraceMs < 0) {
            throw new TypeError('disconnectGraceMs must be a non-negative number');
        }
        if (!Number.isFinite(this.gameCountdownMs) || this.gameCountdownMs < 0) {
            throw new TypeError('gameCountdownMs must be a non-negative number');
        }
        if (!Number.isInteger(this.minPlayers) || this.minPlayers < 1) {
            throw new TypeError('minPlayers must be a positive integer');
        }

        this.memberDetails = new Map();
        this.disconnectTimers = new Map();
        this.sessions = new Map();
        this.cleanupTimer = null;
    }

    _identity(socket) {
        return this.identityForSocket(socket);
    }

    _sendError(socket, err) {
        if (err instanceof RoomError) {
            socket.emit('roomError', err.toPayload());
            return;
        }

        this.logger.error('[ROOMS] Unexpected room error:', err);
        socket.emit('roomError', {
            code: ROOM_ERROR_CODES.INTERNAL_ERROR,
            message: 'Room operation failed.'
        });
    }

    _broadcastToRoom(room, event, payload, exceptSocket) {
        for (const socket of this.transport.sockets.values()) {
            if (socket === exceptSocket) {
                continue;
            }

            const identity = this._identity(socket);
            if (
                room.members.indexOf(identity.id) !== -1 ||
                room.spectators.indexOf(identity.id) !== -1
            ) {
                socket.emit(event, payload);
            }
        }
    }

    _broadcastRoomUpdate(room, exceptSocket) {
        for (const socket of this.transport.sockets.values()) {
            if (socket === exceptSocket) {
                continue;
            }

            const identity = this._identity(socket);
            if (
                room.members.indexOf(identity.id) !== -1 ||
                room.spectators.indexOf(identity.id) !== -1
            ) {
                socket.emit('roomUpdated', {
                    room: serializeRoom(room, identity.id)
                });
            }
        }
    }

    _emitRoomList(socket) {
        const identity = this._identity(socket);
        const rooms = this.roomManager.listRooms({ viewerId: identity.id })
            .map((room) => serializeRoom(room, identity.id));

        socket.emit('roomList', { rooms });
    }

    _memberInfo(memberId) {
        const info = this.memberDetails.get(memberId) || {};
        return {
            name: info.name || 'Guest',
            accountId: info.accountId === undefined ? null : info.accountId,
            screenWidth: info.screenWidth,
            screenHeight: info.screenHeight
        };
    }

    _emitToMember(memberId, event, ...args) {
        for (const socket of this.transport.sockets.values()) {
            if (this._identity(socket).id === memberId) {
                socket.emit(event, ...args);
            }
        }
    }

    _emitRoomEvent(room, event, payload) {
        this._broadcastToRoom(room, event, payload, null);
    }

    getSession(roomId) {
        return this.sessions.get(roomId) || null;
    }

    getSessionForMember(memberId) {
        const room = this.roomManager.getRoomForMember(memberId);
        return room ? this.getSession(room.id) : null;
    }

    getSessionForSocket(socket) {
        return this.getSessionForMember(this._identity(socket).id);
    }

    updateMemberName(socket, name) {
        socket.displayName = name;
        const identity = this._identity(socket);
        const detail = this.memberDetails.get(identity.id);
        if (detail) {
            detail.name = name;
        }
    }

    _syncSessionSettings(room, session) {
        if (session && session.state === 'lobby') {
            session.settings = Object.assign({}, session.settings, room.settings);
        }
    }

    _getOrCreateSession(room) {
        let session = this.sessions.get(room.id);
        if (session) {
            this._syncSessionSettings(room, session);
            return session;
        }

        session = this.gameFactory({
            roomId: room.id,
            settings: room.settings,
            config: this.gameConfig,
            scoreWeights: this.gameConfig.game && this.gameConfig.game.scoreWeights,
            competitive: true,
            now: this.now,
            setTimeoutFn: this.setTimeoutFn,
            clearTimeoutFn: this.clearTimeoutFn,
            setIntervalFn: this.setIntervalFn,
            clearIntervalFn: this.clearIntervalFn,
            countdownMs: this.gameCountdownMs,
            logger: this.logger,
            emitToMember: (memberId, event, ...args) => this._emitToMember(memberId, event, ...args),
            emitToRoom: (event, payload) => this._emitRoomEvent(room, event, payload),
            onFinished: (result) => this._handleGameFinished(room, result),
            onHeartbeatTimeout: (memberId, reason) => this._handleHeartbeatTimeout(memberId, reason)
        });

        this.sessions.set(room.id, session);

        for (const memberId of room.members) {
            session.addPlayer(memberId, this._memberInfo(memberId));
        }
        for (const memberId of room.spectators) {
            session.addSpectator(memberId);
        }

        return session;
    }

    _handleGameFinished(room, result) {
        this.roomManager.clearReady(room);
        this._broadcastRoomUpdate(room);
        this.broadcastRoomLists();

        try {
            const pending = this.onMatchFinished(result, roomSummary(room));
            if (pending && typeof pending.catch === 'function') {
                pending.catch((err) => this.logger.error(
                    '[ROOMS] Failed to persist match result:',
                    err
                ));
            }
        } catch (err) {
            this.logger.error('[ROOMS] Failed to persist match result:', err);
        }

        return result;
    }

    _closeSession(roomId) {
        const session = this.sessions.get(roomId);
        if (!session) {
            return;
        }

        session.close();
        this.sessions.delete(roomId);
    }

    _memberIdentity(memberId) {
        const detail = this.memberDetails.get(memberId) || {};
        let accountId = detail.accountId;
        if (accountId === undefined) {
            accountId = memberId.startsWith('account:')
                ? parseInt(memberId.slice('account:'.length), 10)
                : null;
        }

        return {
            id: memberId,
            accountId: Number.isInteger(accountId) ? accountId : null,
            name: detail.name || 'Guest'
        };
    }

    _broadcastPlayerDisconnect(membership, identity, reason, graceMs) {
        this._broadcastToRoom(membership.room, 'playerDisconnect', {
            roomId: membership.room.id,
            memberId: identity.id,
            accountId: identity.accountId,
            name: identity.name,
            role: membership.role,
            reason,
            graceMs
        }, null);
    }

    _clearReadyOnDisconnect(room, memberId) {
        if (!room.ready || !room.ready.delete(memberId)) {
            return;
        }

        this._broadcastToRoom(room, 'playerReady', {
            roomId: room.id,
            memberId,
            ready: false
        }, null);
        this._broadcastRoomUpdate(room);
        this.broadcastRoomLists();
    }

    /**
     * Shared handling for a socket disconnect and a heartbeat timeout. Account
     * members keep their membership and game cell during the grace period;
     * guests are removed at once because their identity cannot be restored.
     */
    _handleLostMember(identity, reason, socket, options = {}) {
        const membership = this.roomManager.getMembership(identity.id);
        if (!membership) {
            if (socket) {
                socket.roomMembership = null;
            }
            return false;
        }

        const detail = this.memberDetails.get(identity.id) || {};
        identity = Object.assign({}, identity, {
            name: detail.name || identity.name || 'Guest',
            accountId: identity.accountId === undefined ? detail.accountId : identity.accountId
        });

        const session = this.sessions.get(membership.room.id);
        const wasDisconnected = session ? session.isDisconnected(identity.id) : false;
        if (session) {
            session.markDisconnected(identity.id);
        }

        if (!wasDisconnected || options.announce) {
            this._clearReadyOnDisconnect(membership.room, identity.id);
            this._broadcastPlayerDisconnect(
                membership,
                identity,
                reason,
                identity.accountId === null ? 0 : this.disconnectGraceMs
            );
        }

        if (identity.accountId === null) {
            this._removeMembership(identity, reason, socket);
        } else if (options.force || !this._hasActiveSocket(identity.id)) {
            this._scheduleDisconnectCleanup(identity, {
                force: Boolean(options.force),
                reason: options.reason || 'disconnect timeout'
            });
        }

        return true;
    }

    _handleHeartbeatTimeout(memberId, reason) {
        const identity = this._memberIdentity(memberId);
        const membership = this.roomManager.getMembership(memberId);
        if (!membership) {
            return;
        }

        // Mark and announce the disconnect before closing the sockets. The
        // sockets are flagged so their own disconnect handler does not repeat
        // the work or restart the grace timer.
        this._handleLostMember(identity, 'heartbeat timeout', null, {
            force: true,
            announce: true,
            reason: 'heartbeat timeout'
        });

        for (const socket of this.transport.sockets.values()) {
            if (this._identity(socket).id !== memberId) {
                continue;
            }

            socket.suppressRoomDisconnect = true;
            socket.emit('kick', reason);
            socket.disconnect(reason);
        }
    }

    _ownedRoom(identity, payload) {
        if (payload && payload.id) {
            const room = this.roomManager.getRoom(payload.id);
            if (!room) {
                throw new RoomError(ROOM_ERROR_CODES.ROOM_NOT_FOUND, 'Room not found.');
            }
            if (room.ownerId !== identity.id) {
                throw new RoomError(
                    ROOM_ERROR_CODES.NOT_OWNER,
                    'Only the room owner can control the game.'
                );
            }
            return room;
        }

        const membership = this.roomManager.getMembership(identity.id);
        if (!membership) {
            throw new RoomError(ROOM_ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.');
        }
        if (membership.room.ownerId !== identity.id) {
            throw new RoomError(
                ROOM_ERROR_CODES.NOT_OWNER,
                'Only the room owner can control the game.'
            );
        }
        return membership.room;
    }

    _snapshotPayload(room, identity, role, restored) {
        const session = this._getOrCreateSession(room);
        return {
            room: serializeRoom(room, identity.id, { includeMembers: true }),
            role,
            restored,
            game: session.snapshot()
        };
    }

    broadcastRoomLists() {
        for (const socket of this.transport.sockets.values()) {
            this._emitRoomList(socket);
        }
    }

    _clearDisconnectTimer(memberId) {
        const timer = this.disconnectTimers.get(memberId);
        if (timer !== undefined) {
            this.clearTimeoutFn(timer);
            this.disconnectTimers.delete(memberId);
        }
    }

    _hasActiveSocket(memberId) {
        for (const socket of this.transport.sockets.values()) {
            if (socket.connected === false) {
                continue;
            }
            if (this._identity(socket).id === memberId) {
                return true;
            }
        }
        return false;
    }

    _scheduleDisconnectCleanup(identity, options = {}) {
        this._clearDisconnectTimer(identity.id);

        const timer = this.setTimeoutFn(() => {
            this.disconnectTimers.delete(identity.id);

            if (!options.force && this._hasActiveSocket(identity.id)) {
                return;
            }
            if (!this.roomManager.getMembership(identity.id)) {
                return;
            }

            this._removeMembership(identity, options.reason || 'disconnect timeout', null);
        }, this.disconnectGraceMs);

        if (timer && typeof timer.unref === 'function') {
            timer.unref();
        }
        this.disconnectTimers.set(identity.id, timer);
    }

    _removeMembership(identity, reason, socket) {
        const membership = this.roomManager.getMembership(identity.id);
        if (!membership) {
            if (socket) {
                socket.roomMembership = null;
            }
            this.memberDetails.delete(identity.id);
            this._clearDisconnectTimer(identity.id);
            return null;
        }

        const room = membership.room;
        const role = membership.role;
        const wasOwner = room.ownerId === identity.id;
        const detail = this.memberDetails.get(identity.id) || {
            name: identity.name || 'Guest',
            accountId: identity.accountId
        };

        this._clearDisconnectTimer(identity.id);

        const session = this.sessions.get(room.id);
        if (session) {
            session.removeMember(identity.id);
        }

        this.roomManager.removeMember(room.id, identity.id);
        this.memberDetails.delete(identity.id);

        if (socket) {
            socket.roomMembership = null;
            if (socket.gameSession === session) {
                socket.gameSession = null;
                socket.gameMemberId = null;
            }
        }

        let closed = false;
        if (room.members.length === 0 && room.spectators.length === 0) {
            // The last occupant left (normally the owner): close immediately
            // instead of waiting for the empty-room grace period.
            this._closeSession(room.id);
            this.roomManager.removeRoom(room.id, null, { force: true });
            closed = true;

            if (room.visibility === 'public') {
                this.transport.emit('roomRemoved', roomSummary(room));
            }
        } else {
            this._broadcastToRoom(room, 'playerLeft', {
                roomId: room.id,
                memberId: identity.id,
                accountId: detail.accountId,
                name: detail.name,
                role,
                reason
            }, null);

            if (wasOwner) {
                // Serialize per recipient so the new owner sees isOwner: true.
                this._broadcastRoomUpdate(room, null);
            }
        }

        this.broadcastRoomLists();
        return { room, role, closed };
    }

    /**
     * Restore room membership after authentication (reconnect, token resume
     * or a fresh login on an account that is still in a room).
     */
    restoreMembership(socket) {
        const identity = this._identity(socket);
        const membership = this.roomManager.getMembership(identity.id);
        if (!membership) {
            return false;
        }

        this._clearDisconnectTimer(identity.id);
        socket.roomMembership = {
            roomId: membership.room.id,
            role: membership.role
        };
        this.memberDetails.set(identity.id, {
            name: identity.name || 'Guest',
            accountId: identity.accountId
        });

        const session = this._getOrCreateSession(membership.room);
        if (membership.role === 'player') {
            // A player who died before disconnecting stays dead until the next
            // game; do not respawn them just because a socket reconnected.
            session.addPlayer(identity.id, this._memberInfo(identity.id), {
                spawn: session.state !== 'running'
            });
        } else {
            session.addSpectator(identity.id);
        }
        this.onSocketEnterRoom(socket, session);
        socket.gameSession = session;
        socket.gameMemberId = identity.id;

        if (session) {
            session.markReconnected(identity.id);
            this._broadcastToRoom(membership.room, 'playerReconnect', {
                roomId: membership.room.id,
                memberId: identity.id,
                accountId: identity.accountId,
                name: identity.name || 'Guest',
                role: membership.role
            }, socket);
        }

        socket.emit('roomSnapshot', {
            room: serializeRoom(membership.room, identity.id, { includeMembers: true }),
            role: membership.role,
            restored: true,
            game: session.snapshot()
        });

        return true;
    }

    /**
     * Called after socket.auth changes. If the identity changed while the
     * socket was in a room, leave the old membership first, then restore any
     * room that belongs to the new identity.
     */
    handleAuthChange(socket, previousIdentity) {
        const nextIdentity = this._identity(socket);

        if (
            previousIdentity &&
            previousIdentity.id !== nextIdentity.id &&
            socket.roomMembership
        ) {
            this._removeMembership(previousIdentity, 'identity changed', socket);
        }

        this.restoreMembership(socket);
    }

    leaveRoom(socket, reason = 'leave') {
        const identity = this._identity(socket);
        const result = this._removeMembership(identity, reason, socket);

        if (!result) {
            this._sendError(
                socket,
                new RoomError(ROOM_ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.')
            );
            return false;
        }

        socket.emit('roomLeft', {
            id: result.room.id,
            code: result.room.code,
            name: result.room.name,
            reason
        });
        return true;
    }

    /**
     * Remove a member on behalf of an admin. Unlike a disconnect this ignores
     * the account reconnect grace period: the player leaves the room and the
     * game session immediately.
     */
    kickMember(memberId, reason = '') {
        const membership = this.roomManager.getMembership(memberId);
        if (!membership) {
            return false;
        }

        const detail = this.memberDetails.get(memberId) || {};
        let accountId = detail.accountId;
        if (accountId === undefined) {
            accountId = memberId.startsWith('account:')
                ? parseInt(memberId.slice('account:'.length), 10)
                : null;
        }

        const sockets = [];
        for (const socket of this.transport.sockets.values()) {
            if (this._identity(socket).id === memberId) {
                sockets.push(socket);
            }
        }

        // Notify every transport for this identity, then remove membership
        // and session state. Disconnecting first also prevents the client
        // from receiving further room events while cleanup runs.
        for (const socket of sockets) {
            socket.emit('kick', reason);
            socket.disconnect(reason);
        }

        this._removeMembership({
            id: memberId,
            accountId: Number.isInteger(accountId) ? accountId : null,
            name: detail.name || 'Guest'
        }, 'kick', sockets[0] || null);

        return true;
    }

    handleDisconnect(socket) {
        if (socket.suppressRoomDisconnect) {
            socket.suppressRoomDisconnect = false;
            socket.roomMembership = null;
            return false;
        }

        const identity = this._identity(socket);
        const membership = this.roomManager.getMembership(identity.id);
        if (!membership) {
            socket.roomMembership = null;
            return false;
        }

        // A newer connection may already represent this account (duplicate
        // login or reconnect). The stale socket must not mark the active member
        // as disconnected.
        if (this._hasActiveSocket(identity.id)) {
            socket.roomMembership = null;
            return false;
        }

        return this._handleLostMember(identity, 'disconnect', socket);
    }

    attachSocket(socket) {
        socket.on('listRooms', () => {
            this._emitRoomList(socket);
        });

        socket.on('createRoom', (payload) => {
            const identity = this._identity(socket);

            try {
                const room = this.roomManager.createRoom({
                    name: payload && payload.name,
                    visibility: payload && payload.visibility,
                    settings: payload && payload.settings,
                    ownerId: identity.id,
                    ownerAccountId: identity.accountId
                });

                socket.emit('roomCreated', {
                    room: serializeRoom(room, identity.id)
                });

                if (room.visibility === 'public') {
                    socket.broadcast.emit('roomCreated', {
                        room: serializeRoom(room)
                    });
                }

                this.broadcastRoomLists();
            } catch (err) {
                this._sendError(socket, err);
            }
        });

        socket.on('updateRoom', (payload) => {
            const identity = this._identity(socket);

            try {
                const existing = this.roomManager.getRoom(payload && payload.id);
                if (!existing) {
                    throw new RoomError(ROOM_ERROR_CODES.ROOM_NOT_FOUND, 'Room not found.');
                }

                const wasPublic = existing.visibility === 'public';
                const room = this.roomManager.updateRoom(
                    existing.id,
                    identity.id,
                    {
                        name: payload && payload.name,
                        visibility: payload && payload.visibility,
                        settings: payload && payload.settings
                    }
                );

                this._syncSessionSettings(room, this.sessions.get(room.id));

                socket.emit('roomUpdated', {
                    room: serializeRoom(room, identity.id)
                });

                if (room.visibility === 'public') {
                    socket.broadcast.emit('roomUpdated', {
                        room: serializeRoom(room)
                    });
                } else if (wasPublic) {
                    socket.broadcast.emit('roomRemoved', roomSummary(room));
                }

                this.broadcastRoomLists();
            } catch (err) {
                this._sendError(socket, err);
            }
        });

        socket.on('deleteRoom', (payload) => {
            const identity = this._identity(socket);
            const ownerSocket = socket;

            try {
                const existing = this.roomManager.getRoom(payload && payload.id);
                if (!existing) {
                    throw new RoomError(ROOM_ERROR_CODES.ROOM_NOT_FOUND, 'Room not found.');
                }

                const summary = roomSummary(existing);
                const occupants = existing.members.concat(existing.spectators).slice();

                this._closeSession(existing.id);
                this.roomManager.removeRoom(existing.id, identity.id);

                for (const occupantId of occupants) {
                    this.memberDetails.delete(occupantId);
                    this._clearDisconnectTimer(occupantId);
                }

                for (const memberSocket of this.transport.sockets.values()) {
                    const occupantIdentity = this._identity(memberSocket);
                    if (occupants.indexOf(occupantIdentity.id) === -1) {
                        continue;
                    }

                    memberSocket.roomMembership = null;

                    if (existing.visibility === 'private' && memberSocket !== ownerSocket) {
                        // handled below for the owner; other occupants still
                        // need a direct notification
                        memberSocket.emit('roomRemoved', summary);
                    }
                }

                socket.emit('roomRemoved', summary);
                if (existing.visibility === 'public') {
                    socket.broadcast.emit('roomRemoved', summary);
                }

                this.broadcastRoomLists();
            } catch (err) {
                this._sendError(socket, err);
            }
        });

        socket.on('joinRoom', (payload) => {
            const identity = this._identity(socket);
            const idOrCode = payload && (payload.code || payload.id);
            const byCode = Boolean(payload && payload.code);
            const asSpectator = Boolean(
                payload && (payload.asSpectator || payload.role === 'spectator')
            );

            try {
                const existing = this.roomManager.getRoom(idOrCode);
                const existingSession = existing ? this.sessions.get(existing.id) : null;

                if (
                    !asSpectator &&
                    existingSession &&
                    (existingSession.state === 'countdown' || existingSession.state === 'running')
                ) {
                    throw new RoomError(
                        ROOM_ERROR_CODES.ROOM_IN_GAME,
                        'This room is already in a game. Join as a spectator or wait for it to end.'
                    );
                }

                const room = asSpectator
                    ? this.roomManager.addSpectator(idOrCode, identity.id, { byCode })
                    : this.roomManager.addMember(idOrCode, identity.id, { byCode });

                socket.roomMembership = {
                    roomId: room.id,
                    role: asSpectator ? 'spectator' : 'player'
                };
                this.memberDetails.set(identity.id, {
                    name: identity.name || 'Guest',
                    accountId: identity.accountId
                });
                this._clearDisconnectTimer(identity.id);

                const session = this._getOrCreateSession(room);
                if (asSpectator) {
                    session.addSpectator(identity.id);
                } else {
                    session.addPlayer(identity.id, this._memberInfo(identity.id));
                }
                this.onSocketEnterRoom(socket, session);
                socket.gameSession = session;
                socket.gameMemberId = identity.id;

                socket.emit('roomSnapshot', {
                    room: serializeRoom(room, identity.id, { includeMembers: true }),
                    role: asSpectator ? 'spectator' : 'player',
                    restored: false,
                    game: session.snapshot()
                });

                this._broadcastToRoom(room, 'playerJoined', {
                    roomId: room.id,
                    memberId: identity.id,
                    accountId: identity.accountId,
                    name: identity.name || 'Guest',
                    role: asSpectator ? 'spectator' : 'player'
                }, socket);

                this.broadcastRoomLists();
            } catch (err) {
                this._sendError(socket, err);
            }
        });

        socket.on('setReady', (payload) => {
            const identity = this._identity(socket);
            const membership = this.roomManager.getMembership(identity.id);

            if (!membership) {
                this._sendError(
                    socket,
                    new RoomError(ROOM_ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.')
                );
                return;
            }
            if (membership.role !== 'player') {
                this._sendError(
                    socket,
                    new RoomError(
                        ROOM_ERROR_CODES.NOT_A_PLAYER,
                        'Spectators cannot ready up.'
                    )
                );
                return;
            }

            try {
                const ready = !payload || payload.ready !== false;
                const room = this.roomManager.setReady(
                    membership.room.id,
                    identity.id,
                    ready
                );
                const session = this._getOrCreateSession(room);

                this._broadcastToRoom(room, 'playerReady', {
                    roomId: room.id,
                    memberId: identity.id,
                    ready
                }, null);
                this._broadcastRoomUpdate(room);
                this.broadcastRoomLists();

                if (session.state === 'lobby') {
                    this._emitRoomEvent(room, 'gameState', session.snapshot());
                }
            } catch (err) {
                this._sendError(socket, err);
            }
        });

        socket.on('startGame', (payload) => {
            const identity = this._identity(socket);

            try {
                const room = this._ownedRoom(identity, payload);

                if (room.members.length < this.minPlayers) {
                    throw new RoomError(
                        ROOM_ERROR_CODES.NOT_ENOUGH_PLAYERS,
                        'At least ' + this.minPlayers + ' players are required to start.',
                        { minPlayers: this.minPlayers }
                    );
                }
                if (!this.roomManager.allPlayersReady(room)) {
                    throw new RoomError(
                        ROOM_ERROR_CODES.PLAYERS_NOT_READY,
                        'All players must be ready before the game can start.'
                    );
                }

                const session = this._getOrCreateSession(room);
                if (session.state === 'countdown' || session.state === 'running') {
                    throw new RoomError(
                        ROOM_ERROR_CODES.GAME_IN_PROGRESS,
                        'The game is already running.'
                    );
                }

                session.settings = Object.assign({}, session.settings, room.settings);
                this.roomManager.clearReady(room);
                session.start();

                this._broadcastRoomUpdate(room);
                this.broadcastRoomLists();
            } catch (err) {
                this._sendError(socket, err);
            }
        });

        socket.on('stopGame', (payload) => {
            const identity = this._identity(socket);

            try {
                const room = this._ownedRoom(identity, payload);
                const session = this.sessions.get(room.id);

                if (
                    !session ||
                    (session.state !== 'running' && session.state !== 'countdown')
                ) {
                    throw new RoomError(
                        ROOM_ERROR_CODES.GAME_NOT_RUNNING,
                        'There is no running game to stop.'
                    );
                }

                session.finish('owner_stop');
            } catch (err) {
                this._sendError(socket, err);
            }
        });

        socket.on('returnToLobby', (payload) => {
            const identity = this._identity(socket);

            try {
                const room = this._ownedRoom(identity, payload);
                const session = this.sessions.get(room.id);

                if (!session || session.state !== 'finished') {
                    throw new RoomError(
                        ROOM_ERROR_CODES.GAME_NOT_RUNNING,
                        'The game has not finished.'
                    );
                }

                session.reset();
                this.roomManager.clearReady(room);
                this._broadcastRoomUpdate(room);
                this.broadcastRoomLists();
            } catch (err) {
                this._sendError(socket, err);
            }
        });

        socket.on('getGameState', () => {
            const identity = this._identity(socket);
            const membership = this.roomManager.getMembership(identity.id);

            if (!membership) {
                this._sendError(
                    socket,
                    new RoomError(ROOM_ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.')
                );
                return;
            }

            const session = this._getOrCreateSession(membership.room);
            socket.emit('gameState', session.snapshot());
        });

        socket.on('leaveRoom', () => {
            this.leaveRoom(socket, 'leave');
        });
    }

    startCleanup(intervalMs) {
        if (!(intervalMs > 0)) {
            return this;
        }

        this.stopCleanup();
        this.cleanupTimer = this.setIntervalFn(() => {
            const removed = this.roomManager.cleanupEmptyRooms();

            for (const room of removed) {
                this._closeSession(room.id);

                if (room.visibility === 'public') {
                    this.transport.emit('roomRemoved', roomSummary(room));
                }
            }

            if (removed.length > 0) {
                this.broadcastRoomLists();
            }
        }, intervalMs);

        if (typeof this.cleanupTimer.unref === 'function') {
            this.cleanupTimer.unref();
        }

        return this;
    }

    stopCleanup() {
        if (this.cleanupTimer) {
            this.clearIntervalFn(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        return this;
    }

    stop() {
        this.stopCleanup();
        for (const timer of this.disconnectTimers.values()) {
            this.clearTimeoutFn(timer);
        }
        this.disconnectTimers.clear();

        for (const session of this.sessions.values()) {
            session.close();
        }
        this.sessions.clear();
        this.memberDetails.clear();

        return this;
    }
}

module.exports = {
    RoomLobby,
    roomSummary
};
