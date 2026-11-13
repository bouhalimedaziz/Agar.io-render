'use strict';

const MIN_PLAYERS = 2;

function copyRoom(room) {
    if (!room || typeof room !== 'object') {
        return null;
    }

    return Object.assign({}, room, {
        settings: room.settings ? Object.assign({}, room.settings) : {}
    });
}

function memberNameFromId(id) {
    if (typeof id !== 'string') {
        return 'Guest';
    }
    if (id.indexOf('account:') === 0) {
        return 'Player ' + id.slice('account:'.length);
    }
    return 'Guest';
}

function isGameActive(game) {
    return Boolean(game && (game.state === 'countdown' || game.state === 'running'));
}

/**
 * Client-side room, roster and match state.
 *
 * The server sends room summaries without member arrays on purpose
 * (`roomUpdated`), so this store merges those updates into the roster built
 * from the last `roomSnapshot` and the incremental player events.
 */
class RoomStore {
    constructor(options = {}) {
        this.minPlayers = Number.isInteger(options.minPlayers)
            ? options.minPlayers
            : MIN_PLAYERS;
        this.rooms = [];
        this.roomsLoading = false;
        this.roomsError = '';
        this.room = null;
        this.role = null;
        this.restored = false;
        this.game = null;
        this.members = [];
        this.spectators = [];
        this.result = null;
        this.countdown = null;
        this.error = '';
        this.accountId = null;
        this.selfId = null;
        this.nameCache = new Map();
    }

    setAccount(account) {
        this.accountId = account && Number.isInteger(Number(account.id))
            ? Number(account.id)
            : null;
        this.selfId = this.accountId === null ? null : 'account:' + this.accountId;
        return this;
    }

    clearAccount() {
        this.accountId = null;
        this.selfId = null;
        return this;
    }

    resetRoom() {
        this.room = null;
        this.role = null;
        this.restored = false;
        this.game = null;
        this.members = [];
        this.spectators = [];
        this.result = null;
        this.countdown = null;
        this.error = '';
        this.nameCache = new Map();
        return this;
    }

    setRoomsLoading(loading) {
        this.roomsLoading = Boolean(loading);
        if (this.roomsLoading) {
            this.roomsError = '';
        }
        return this;
    }

    setRoomsError(message) {
        this.roomsError = message || '';
        this.roomsLoading = false;
        return this;
    }

    setRoomList(rooms) {
        this.rooms = Array.isArray(rooms)
            ? rooms.filter((room) => room && typeof room.id === 'string').map(copyRoom)
            : [];
        this._sortRooms();
        this.roomsLoading = false;
        this.roomsError = '';
        return this;
    }

    _sortRooms() {
        // Newest rooms first, matching the server's list order.
        this.rooms.sort((a, b) => {
            if (a.createdAt !== b.createdAt) {
                return (b.createdAt || 0) - (a.createdAt || 0);
            }
            return String(a.id).localeCompare(String(b.id));
        });
    }

    upsertRoom(room) {
        if (!room || typeof room.id !== 'string') {
            return this;
        }

        const next = copyRoom(room);
        const index = this.rooms.findIndex((entry) => entry.id === next.id);
        if (index === -1) {
            this.rooms.push(next);
        } else {
            this.rooms[index] = Object.assign({}, this.rooms[index], next);
        }

        // Newest rooms first, matching the server's list order.
        this._sortRooms();
        return this;
    }

    removeRoom(idOrCode) {
        if (!idOrCode) {
            return false;
        }

        const index = this.rooms.findIndex(
            (room) => room.id === idOrCode || room.code === idOrCode
        );
        if (index === -1) {
            return false;
        }

        this.rooms.splice(index, 1);
        return true;
    }

    applyRoomRemoved(summary) {
        const idOrCode = summary && (summary.id || summary.code);
        this.removeRoom(idOrCode);

        if (this.room && (this.room.id === idOrCode || this.room.code === idOrCode)) {
            this.resetRoom();
            return true;
        }
        return false;
    }

    enterRoom(snapshot) {
        if (!snapshot || !snapshot.room) {
            throw new TypeError('roomSnapshot.room is required.');
        }

        this.room = copyRoom(snapshot.room);
        this.role = snapshot.role === 'spectator' ? 'spectator' : 'player';
        this.restored = Boolean(snapshot.restored);
        this.error = '';
        this.result = null;
        this.countdown = null;
        this._cacheNames(snapshot.game);
        this.applyGameState(snapshot.game);
        this._rebuildRoster();
        this.upsertRoom(this.room);
        return this;
    }

    leaveRoom() {
        this.resetRoom();
        return this;
    }

    setError(message) {
        this.error = message || '';
        return this;
    }

    applyRoomUpdated(room) {
        if (!room || !this.room || room.id !== this.room.id) {
            this.upsertRoom(room);
            return this;
        }

        this.room = Object.assign({}, this.room, copyRoom(room), {
            // `roomUpdated` deliberately omits member arrays.
            members: this.room.members,
            spectators: this.room.spectators,
            readyMembers: this.room.readyMembers
        });

        // The server serializes `isReady` per recipient. It is the most
        // reliable self-ready signal, especially for guest identities.
        if (this.selfId && this.members) {
            const self = this.members.find((member) => member.id === this.selfId);
            if (self && typeof room.isReady === 'boolean') {
                self.ready = room.isReady;
            }
        }

        // `roomUpdated` omits the member id list but still carries the
        // aggregate ready count. A zero count means the server cleared
        // readiness (for example after returning to the lobby), so clear the
        // roster too instead of keeping pre-match badges.
        if (Number.isInteger(room.readyCount)) {
            this.room.readyCount = room.readyCount;
            if (room.readyCount === 0) {
                for (const member of this.members) {
                    member.ready = false;
                }
                if (Array.isArray(this.room.readyMembers)) {
                    this.room.readyMembers = [];
                }
            }
        }

        this.upsertRoom(this.room);
        return this;
    }

    applyPlayerJoined(payload) {
        if (!payload || !payload.memberId) {
            return this;
        }

        if (payload.name) {
            this.nameCache.set(payload.memberId, payload.name);
        }

        const id = payload.memberId;
        const existing = this._allMembers().some((entry) => entry.id === id);
        if (existing) {
            return this;
        }

        const entry = {
            id,
            name: payload.name || memberNameFromId(id),
            role: payload.role === 'spectator' ? 'spectator' : 'player',
            ready: false,
            alive: true,
            score: 0,
            admin: false,
            isSelf: id === this.selfId
        };

        if (entry.role === 'spectator') {
            this.spectators.push(entry);
        } else {
            this.members.push(entry);
        }

        if (this.room) {
            if (entry.role === 'spectator') {
                if (!Array.isArray(this.room.spectators)) {
                    this.room.spectators = [];
                }
                if (this.room.spectators.indexOf(id) === -1) {
                    this.room.spectators.push(id);
                }
            } else {
                if (!Array.isArray(this.room.members)) {
                    this.room.members = [];
                }
                if (this.room.members.indexOf(id) === -1) {
                    this.room.members.push(id);
                }
            }
            this.room.memberCount = this.members.length;
            this.room.spectatorCount = this.spectators.length;
            this.room.readyCount = this.members.filter((entry) => entry.ready).length;
        }
        return this;
    }

    applyPlayerLeft(payload) {
        if (!payload || !payload.memberId) {
            return this;
        }

        this.members = this.members.filter((entry) => entry.id !== payload.memberId);
        this.spectators = this.spectators.filter((entry) => entry.id !== payload.memberId);
        this.nameCache.delete(payload.memberId);

        if (this.room) {
            if (Array.isArray(this.room.members)) {
                this.room.members = this.room.members.filter((id) => id !== payload.memberId);
            }
            if (Array.isArray(this.room.spectators)) {
                this.room.spectators = this.room.spectators.filter((id) => id !== payload.memberId);
            }
            if (Array.isArray(this.room.readyMembers)) {
                this.room.readyMembers = this.room.readyMembers.filter(
                    (id) => id !== payload.memberId
                );
            }
            this.room.memberCount = this.members.length;
            this.room.spectatorCount = this.spectators.length;
            this.room.readyCount = this.members.filter((entry) => entry.ready).length;
        }
        return this;
    }

    applyPlayerReady(payload) {
        if (!payload || !payload.memberId) {
            return this;
        }

        const ready = payload.ready !== false;
        const member = this.members.find((entry) => entry.id === payload.memberId);
        if (member) {
            member.ready = ready;
        }

        if (this.room) {
            this.room.readyCount = this.members.filter((entry) => entry.ready).length;
            if (Array.isArray(this.room.readyMembers)) {
                this.room.readyMembers = this.room.readyMembers.filter(
                    (id) => id !== payload.memberId
                );
                if (ready) {
                    this.room.readyMembers.push(payload.memberId);
                }
            }
            if (payload.memberId === this.selfId) {
                this.room.isReady = ready;
            }
        }
        return this;
    }

    applyGameState(game) {
        if (!game || typeof game !== 'object') {
            return this;
        }

        this.game = game;

        if (game.state === 'countdown') {
            this.countdown = {
                countdownMs: game.countdownMs,
                startsAt: game.countdownEndsAt
            };
        } else if (game.state === 'lobby') {
            this.countdown = null;
            this.result = null;
        } else if (game.state !== 'running') {
            this.countdown = null;
        }

        this._cacheNames(game);
        this._rebuildRoster();
        return this;
    }

    applyCountdown(payload) {
        if (!payload) {
            return this;
        }

        this.countdown = {
            countdownMs: payload.countdownMs,
            startsAt: payload.startsAt || payload.countdownEndsAt
        };

        if (this.game) {
            this.game.state = 'countdown';
            this.game.countdownMs = payload.countdownMs;
            this.game.countdownEndsAt = payload.startsAt || payload.countdownEndsAt;
        } else {
            this.game = {
                state: 'countdown',
                countdownMs: payload.countdownMs,
                countdownEndsAt: payload.startsAt || payload.countdownEndsAt
            };
        }

        this._rebuildRoster();
        return this;
    }

    applyGameStart(snapshot) {
        this.applyGameState(snapshot);
        this.countdown = null;
        this.result = null;
        return this;
    }

    applyGameEnd(result) {
        if (!result) {
            return this;
        }

        this.result = result;
        this.countdown = null;
        if (this.game) {
            this.game.state = 'finished';
            this.game.endReason = result.reason;
        }
        return this;
    }

    _cacheNames(game) {
        if (!game || !Array.isArray(game.players)) {
            return;
        }

        for (const player of game.players) {
            if (player && player.id && player.name) {
                this.nameCache.set(player.id, player.name);
            }
        }
    }

    _allMembers() {
        return this.members.concat(this.spectators);
    }

    _rebuildRoster() {
        if (!this.room) {
            return;
        }

        const gamePlayers = new Map();
        if (this.game && Array.isArray(this.game.players)) {
            for (const player of this.game.players) {
                gamePlayers.set(player.id, player);
            }
        }

        const readyMembers = new Set(
            Array.isArray(this.room.readyMembers) ? this.room.readyMembers : []
        );

        // Lobby/countdown snapshots report every unspawned player as
        // `alive: false`. That is an implementation detail of the game
        // session, not an elimination, so only trust the flag during play.
        const matchActive = Boolean(
            this.game &&
            (this.game.state === 'running' || this.game.state === 'finished')
        );

        const existingPlayers = new Map(this.members.map((entry) => [entry.id, entry]));
        const existingSpectators = new Map(this.spectators.map((entry) => [entry.id, entry]));

        const memberIds = Array.isArray(this.room.members) && this.room.members.length > 0
            ? this.room.members
            : this.members.map((entry) => entry.id);

        this.members = memberIds.map((id) => {
            const player = gamePlayers.get(id);
            const existing = existingPlayers.get(id) || {};
            return {
                id,
                name: (player && player.name) || this.nameCache.get(id) ||
                    existing.name || memberNameFromId(id),
                role: 'player',
                ready: readyMembers.size > 0
                    ? readyMembers.has(id)
                    : Boolean(existing.ready),
                alive: matchActive && player
                    ? Boolean(player.alive)
                    : existing.alive !== false,
                score: player ? Number(player.score) || 0 : Number(existing.score) || 0,
                admin: player ? Boolean(player.admin) : Boolean(existing.admin),
                isSelf: id === this.selfId
            };
        });

        const spectatorIds = Array.isArray(this.room.spectators) && this.room.spectators.length > 0
            ? this.room.spectators
            : this.spectators.map((entry) => entry.id);

        this.spectators = spectatorIds.map((id) => {
            const existing = existingSpectators.get(id) || {};
            return {
                id,
                name: this.nameCache.get(id) || existing.name || 'Spectator',
                role: 'spectator',
                ready: false,
                alive: true,
                score: 0,
                admin: false,
                isSelf: id === this.selfId
            };
        });

        this.room.memberCount = this.members.length;
        this.room.spectatorCount = this.spectators.length;
        this.room.readyCount = this.members.filter((entry) => entry.ready).length;
    }

    get isOwner() {
        return Boolean(this.room && this.room.isOwner);
    }

    get isPlayer() {
        return this.role === 'player';
    }

    get isSpectator() {
        return this.role === 'spectator';
    }

    get isReady() {
        return Boolean(this.room && this.room.isReady);
    }

    get gameState() {
        return this.game ? this.game.state : null;
    }

    get inGame() {
        return isGameActive(this.game);
    }

    get inMatch() {
        return Boolean(this.game && this.game.state === 'running');
    }

    get finished() {
        return Boolean(this.game && this.game.state === 'finished');
    }

    canStart() {
        if (!this.room || !this.room.isOwner || !this.isPlayer) {
            return false;
        }
        if (this.gameState && this.gameState !== 'lobby') {
            return false;
        }
        if (this.members.length < this.minPlayers) {
            return false;
        }
        return this.members.every((member) => member.ready);
    }

    get viewerName() {
        if (!this.room) {
            return '';
        }
        if (this.selfId) {
            const self = this._allMembers().find((entry) => entry.id === this.selfId);
            if (self) {
                return self.name;
            }
        }
        return '';
    }
}

function createRoomStore(options) {
    return new RoomStore(options);
}

module.exports = {
    MIN_PLAYERS,
    RoomStore,
    createRoomStore,
    copyRoom
};
