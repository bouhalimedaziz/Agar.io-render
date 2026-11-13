'use strict';

const expect = require('chai').expect;

const {
    createRoomManager,
    RoomLobby,
    ROOM_ERROR_CODES
} = require('../src/server/rooms');

const DEFAULT_SETTINGS = {
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
};

function account(id, username) {
    return { id, username: username || 'user' + id };
}

function identityForSocket(socket) {
    const authAccount = socket.auth && socket.auth.account;

    if (authAccount) {
        return {
            id: 'account:' + authAccount.id,
            accountId: authAccount.id,
            account: authAccount,
            name: authAccount.username
        };
    }

    return {
        id: 'guest:' + socket.id,
        accountId: null,
        account: null,
        name: socket.displayName || 'Guest'
    };
}

function createSocket(id, authAccount) {
    const handlers = new Map();
    const emitted = [];

    const socket = {
        id,
        connected: true,
        auth: authAccount ? { account: authAccount, token: 'token-' + authAccount.id } : null,
        displayName: null,
        roomMembership: null,
        emitted,
        emit(event, payload) {
            emitted.push({ event, payload });
            return true;
        },
        on(event, handler) {
            if (!handlers.has(event)) {
                handlers.set(event, []);
            }
            handlers.get(event).push(handler);
            return socket;
        },
        trigger(event, payload) {
            for (const handler of (handlers.get(event) || []).slice()) {
                handler(payload);
            }
        },
        last(event) {
            for (let index = emitted.length - 1; index >= 0; index -= 1) {
                if (emitted[index].event === event) {
                    return emitted[index].payload;
                }
            }
            return undefined;
        },
        count(event) {
            return emitted.filter((entry) => entry.event === event).length;
        },
        disconnect(reason) {
            socket.connected = false;
            socket.disconnectReason = reason;
            return socket;
        }
    };

    socket.broadcast = {
        emit() {
            throw new Error('broadcast is wired up by the harness');
        }
    };

    return socket;
}

function createHarness(options = {}) {
    let clock = 1000;
    let timers = [];
    let timerId = 0;
    const intervals = [];
    const sockets = new Map();
    const transportEvents = [];

    const roomManager = createRoomManager({
        now: () => clock,
        emptyRoomGraceMs: 1000,
        defaults: DEFAULT_SETTINGS
    });

    const transport = {
        sockets,
        emit(event, payload) {
            transportEvents.push({ event, payload });
        }
    };

    const gameConfig = Object.assign({
        networkUpdateFactor: 40,
        slowBase: 4.5,
        limitSplit: 16,
        fireFood: 20,
        massLossRate: 1,
        minMassLoss: 50,
        maxHeartbeatInterval: 5000,
        newPlayerInitialPosition: 'farthest',
        foodUniformDisposition: true,
        virus: {
            fill: '#33ff33',
            stroke: '#19D119',
            strokeWidth: 20,
            defaultMass: { from: 100, to: 150 },
            splitMass: 180,
            uniformDisposition: false
        },
        game: {
            countdownMs: 1000,
            minPlayers: 2
        }
    }, options.gameConfig || {});

    const lobby = new RoomLobby({
        roomManager,
        transport,
        identityForSocket,
        disconnectGraceMs: 100,
        setTimeoutFn(fn, ms) {
            const timer = {
                id: (timerId += 1),
                fn,
                ms,
                cleared: false,
                unref() {}
            };
            timers.push(timer);
            return timer;
        },
        clearTimeoutFn(timer) {
            timer.cleared = true;
            timers = timers.filter((candidate) => candidate !== timer);
        },
        setIntervalFn(fn, ms) {
            const timer = { fn, ms, cleared: false, unref() {} };
            intervals.push(timer);
            return timer;
        },
        clearIntervalFn(timer) {
            timer.cleared = true;
        },
        gameConfig,
        minPlayers: options.minPlayers,
        gameCountdownMs: options.gameCountdownMs,
        onMatchFinished: options.onMatchFinished,
        onSocketEnterRoom: options.onSocketEnterRoom,
        logger: { error() {} }
    });

    function addSocket(id, authAccount) {
        const socket = createSocket(id, authAccount);
        socket.broadcast = {
            emit(event, payload) {
                for (const other of sockets.values()) {
                    if (other !== socket) {
                        other.emit(event, payload);
                    }
                }
            }
        };

        sockets.set(id, socket);
        lobby.attachSocket(socket);
        return socket;
    }

    function removeSocket(socket) {
        socket.connected = false;
        sockets.delete(socket.id);
    }

    function runTimers() {
        const pending = timers.filter((timer) => !timer.cleared);
        timers = [];
        for (const timer of pending) {
            timer.fn();
        }
    }

    function advance(ms) {
        clock += ms;
    }

    function activeIntervals() {
        return intervals.filter((timer) => !timer.cleared);
    }

    return {
        roomManager,
        lobby,
        sockets,
        transportEvents,
        addSocket,
        removeSocket,
        runTimers,
        advance,
        timerCount: () => timers.length,
        activeIntervals,
        now: () => clock
    };
}

function createRoom(harness, name, options = {}) {
    harness.advance(10);
    return harness.roomManager.createRoom(Object.assign({
        name,
        ownerId: 'account:1',
        ownerAccountId: 1
    }, options));
}

function roomRemovedEvents(harness) {
    return harness.transportEvents.filter((entry) => entry.event === 'roomRemoved');
}

describe('room lobby', () => {
    let harness;

    beforeEach(() => {
        harness = createHarness();
    });

    describe('joining', () => {
        it('joins a player and sends a room snapshot', () => {
            const room = createRoom(harness, 'Alpha Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));

            owner.trigger('joinRoom', { id: room.id });

            const snapshot = owner.last('roomSnapshot');
            expect(snapshot).to.exist;
            expect(snapshot.restored).to.equal(false);
            expect(snapshot.role).to.equal('player');
            expect(snapshot.room.id).to.equal(room.id);
            expect(snapshot.room.members).to.deep.equal(['account:1']);
            expect(snapshot.room.isOwner).to.equal(true);
            expect(owner.roomMembership).to.deep.equal({
                roomId: room.id,
                role: 'player'
            });
            expect(harness.roomManager.getMembership('account:1').room).to.equal(room);
            expect(room.emptySince).to.equal(null);
        });

        it('sends playerJoined only to room occupants', () => {
            const room = createRoom(harness, 'Scoped Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));
            const outsider = harness.addSocket('socket-3', account(3, 'outsider'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });

            const joined = owner.last('playerJoined');
            expect(joined.roomId).to.equal(room.id);
            expect(joined.memberId).to.equal('account:2');
            expect(joined.name).to.equal('member');
            expect(joined.role).to.equal('player');
            expect(member.count('playerJoined')).to.equal(0);
            expect(outsider.count('playerJoined')).to.equal(0);
            expect(outsider.count('roomSnapshot')).to.equal(0);
        });

        it('rejects a duplicate join', () => {
            const room = createRoom(harness, 'Duplicate Room');
            const member = harness.addSocket('socket-1', account(1));

            member.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });

            expect(member.last('roomError').code).to.equal(ROOM_ERROR_CODES.ALREADY_IN_ROOM);
        });

        it('enforces capacity for players but lets spectators in', () => {
            const room = createRoom(harness, 'Full Room', {
                settings: { maxPlayers: 1 }
            });
            const first = harness.addSocket('socket-1', account(1));
            const second = harness.addSocket('socket-2', account(2));

            first.trigger('joinRoom', { id: room.id });
            second.trigger('joinRoom', { id: room.id });

            expect(second.last('roomError').code).to.equal(ROOM_ERROR_CODES.ROOM_FULL);

            second.trigger('joinRoom', { id: room.id, asSpectator: true });

            const snapshot = second.last('roomSnapshot');
            expect(snapshot.role).to.equal('spectator');
            expect(room.members).to.deep.equal(['account:1']);
            expect(room.spectators).to.deep.equal(['account:2']);
            expect(harness.roomManager.getMembership('account:2').role).to.equal('spectator');
        });

        it('requires a join code for private rooms', () => {
            const room = createRoom(harness, 'Private Room', {
                visibility: 'private'
            });
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const other = harness.addSocket('socket-2', account(2, 'other'));

            other.trigger('joinRoom', { id: room.id });
            expect(other.last('roomError').code).to.equal(ROOM_ERROR_CODES.ROOM_PRIVATE);

            other.trigger('joinRoom', { code: room.code });
            expect(other.last('roomSnapshot').room.id).to.equal(room.id);

            owner.trigger('joinRoom', { id: room.id });
            expect(owner.last('roomSnapshot').room.id).to.equal(room.id);
        });

        it('allows only one active room per player', () => {
            const first = createRoom(harness, 'First Room');
            const second = createRoom(harness, 'Second Room');
            const member = harness.addSocket('socket-1', account(1));

            member.trigger('joinRoom', { id: first.id });
            member.trigger('joinRoom', { id: second.id });

            const error = member.last('roomError');
            expect(error.code).to.equal(ROOM_ERROR_CODES.ALREADY_IN_ROOM);
            expect(error.details).to.deep.equal({ roomId: first.id });

            expect(harness.roomManager.getMembership('account:1').room).to.equal(first);
            expect(member.roomMembership.roomId).to.equal(first.id);
        });

        it('reports missing rooms', () => {
            const member = harness.addSocket('socket-1', account(1));

            member.trigger('joinRoom', { id: 'room_missing' });

            expect(member.last('roomError').code).to.equal(ROOM_ERROR_CODES.ROOM_NOT_FOUND);
        });
    });

    describe('leaving', () => {
        it('leaves a room and notifies the remaining occupants', () => {
            const room = createRoom(harness, 'Leaving Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });
            member.trigger('leaveRoom');

            const left = member.last('roomLeft');
            expect(left.id).to.equal(room.id);
            expect(left.code).to.equal(room.code);
            expect(left.name).to.equal('Leaving Room');
            expect(left.reason).to.equal('leave');

            const playerLeft = owner.last('playerLeft');
            expect(playerLeft.roomId).to.equal(room.id);
            expect(playerLeft.memberId).to.equal('account:2');
            expect(playerLeft.name).to.equal('member');
            expect(playerLeft.role).to.equal('player');
            expect(playerLeft.reason).to.equal('leave');

            expect(room.members).to.deep.equal(['account:1']);
            expect(member.roomMembership).to.equal(null);
            expect(harness.roomManager.getMembership('account:2')).to.equal(null);
        });

        it('rejects leaving when not in a room', () => {
            const member = harness.addSocket('socket-1', account(1));

            member.trigger('leaveRoom');

            expect(member.last('roomError').code).to.equal(ROOM_ERROR_CODES.NOT_IN_ROOM);
        });

        it('transfers ownership when the owner leaves', () => {
            const room = createRoom(harness, 'Transfer Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });
            owner.trigger('leaveRoom');

            expect(room.ownerId).to.equal('account:2');
            expect(room.ownerAccountId).to.equal(2);

            const update = member.last('roomUpdated');
            expect(update.room.ownerAccountId).to.equal(2);
            expect(update.room.isOwner).to.equal(true);
            expect(member.last('playerLeft').memberId).to.equal('account:1');
        });

        it('closes the room when the last occupant leaves', () => {
            const room = createRoom(harness, 'Closing Room');
            const owner = harness.addSocket('socket-1', account(1));

            owner.trigger('joinRoom', { id: room.id });
            owner.trigger('leaveRoom');

            expect(harness.roomManager.getRoom(room.id)).to.equal(null);
            expect(harness.roomManager.getMembership('account:1')).to.equal(null);
            expect(roomRemovedEvents(harness).map((entry) => entry.payload.id))
                .to.deep.equal([room.id]);
        });

        it('does not broadcast roomRemoved for a closed private room', () => {
            const room = createRoom(harness, 'Private Closing', {
                visibility: 'private'
            });
            const owner = harness.addSocket('socket-1', account(1));

            owner.trigger('joinRoom', { id: room.id });
            owner.trigger('leaveRoom');

            expect(harness.roomManager.getRoom(room.id)).to.equal(null);
            expect(roomRemovedEvents(harness)).to.deep.equal([]);
        });

        it('broadcasts spectator join and leave roles', () => {
            const room = createRoom(harness, 'Spectator Room');
            const player = harness.addSocket('socket-1', account(1, 'player'));
            const watcher = harness.addSocket('socket-2', account(2, 'watcher'));

            player.trigger('joinRoom', { id: room.id });
            watcher.trigger('joinRoom', { id: room.id, role: 'spectator' });

            expect(watcher.last('roomSnapshot').role).to.equal('spectator');
            expect(player.last('playerJoined').role).to.equal('spectator');

            watcher.trigger('leaveRoom');
            expect(player.last('playerLeft').role).to.equal('spectator');
            expect(player.last('playerLeft').memberId).to.equal('account:2');
            expect(room.spectators).to.deep.equal([]);
        });

        it('notifies occupants when the owner deletes a private room', () => {
            const room = createRoom(harness, 'Private Delete', {
                visibility: 'private'
            });
            const owner = harness.addSocket('socket-1', account(1));
            const member = harness.addSocket('socket-2', account(2));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { code: room.code });
            owner.trigger('deleteRoom', { id: room.id });

            expect(owner.last('roomRemoved').id).to.equal(room.id);
            expect(member.last('roomRemoved').id).to.equal(room.id);
            expect(owner.roomMembership).to.equal(null);
            expect(member.roomMembership).to.equal(null);
            expect(harness.roomManager.getMembership('account:1')).to.equal(null);
            expect(harness.roomManager.getMembership('account:2')).to.equal(null);
        });
    });

    describe('reconnect and disconnect', () => {
        it('notifies the server when a socket enters a room', () => {
            const entered = [];
            const localHarness = createHarness({
                onSocketEnterRoom: (socket, session) => entered.push({ socket, session })
            });
            const room = createRoom(localHarness, 'Enter Room');
            const owner = localHarness.addSocket('socket-1', account(1, 'owner'));

            owner.trigger('joinRoom', { id: room.id });

            expect(entered).to.have.length(1);
            expect(entered[0].socket).to.equal(owner);
            expect(entered[0].session).to.equal(localHarness.lobby.getSession(room.id));

            localHarness.removeSocket(owner);
            localHarness.lobby.handleDisconnect(owner);

            const second = localHarness.addSocket('socket-2', account(1, 'owner'));
            localHarness.lobby.restoreMembership(second);

            expect(entered).to.have.length(2);
            expect(entered[1].socket).to.equal(second);
        });

        it('restores account membership after reconnecting', () => {
            const room = createRoom(harness, 'Reconnect Room');
            const first = harness.addSocket('socket-1', account(1, 'owner'));

            first.trigger('joinRoom', { id: room.id });

            harness.removeSocket(first);
            harness.lobby.handleDisconnect(first);

            expect(harness.roomManager.getMembership('account:1').room).to.equal(room);
            expect(harness.timerCount()).to.equal(1);

            const second = harness.addSocket('socket-2', account(1, 'owner'));
            harness.lobby.restoreMembership(second);

            const snapshot = second.last('roomSnapshot');
            expect(snapshot.restored).to.equal(true);
            expect(snapshot.role).to.equal('player');
            expect(snapshot.room.id).to.equal(room.id);
            expect(second.roomMembership).to.deep.equal({
                roomId: room.id,
                role: 'player'
            });
            expect(harness.timerCount()).to.equal(0);
        });

        it('removes account membership when the grace period expires', () => {
            const room = createRoom(harness, 'Grace Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });

            harness.removeSocket(owner);
            harness.lobby.handleDisconnect(owner);
            harness.runTimers();

            expect(room.members).to.deep.equal(['account:2']);
            expect(room.ownerId).to.equal('account:2');
            expect(harness.roomManager.getMembership('account:1')).to.equal(null);

            const playerLeft = member.last('playerLeft');
            expect(playerLeft.memberId).to.equal('account:1');
            expect(playerLeft.reason).to.equal('disconnect timeout');

            const update = member.last('roomUpdated');
            expect(update.room.isOwner).to.equal(true);
        });

        it('removes guest membership immediately on disconnect', () => {
            const room = createRoom(harness, 'Guest Disconnect');
            const player = harness.addSocket('socket-1', account(1, 'player'));
            const guest = harness.addSocket('guest-socket', null);
            guest.displayName = 'Guesty';

            player.trigger('joinRoom', { id: room.id });
            guest.trigger('joinRoom', { id: room.id });

            harness.removeSocket(guest);
            harness.lobby.handleDisconnect(guest);

            expect(room.members).to.deep.equal(['account:1']);
            expect(harness.roomManager.getMembership('guest:guest-socket')).to.equal(null);
            expect(harness.timerCount()).to.equal(0);

            const playerLeft = player.last('playerLeft');
            expect(playerLeft.memberId).to.equal('guest:guest-socket');
            expect(playerLeft.name).to.equal('Guesty');
            expect(playerLeft.reason).to.equal('disconnect');
        });

        it('leaves a guest room when the socket signs in', () => {
            const guestRoom = createRoom(harness, 'Guest Room', {
                ownerId: 'account:9',
                ownerAccountId: 9
            });
            const owner = harness.addSocket('socket-owner', account(9, 'host'));
            const guest = harness.addSocket('socket-guest', null);

            owner.trigger('joinRoom', { id: guestRoom.id });
            guest.trigger('joinRoom', { id: guestRoom.id });

            const snapshotsBefore = guest.count('roomSnapshot');
            const previousIdentity = identityForSocket(guest);
            guest.auth = { account: account(2, 'newuser'), token: 'token-2' };

            harness.lobby.handleAuthChange(guest, previousIdentity);

            expect(guestRoom.members).to.deep.equal(['account:9']);
            expect(harness.roomManager.getMembership('guest:socket-guest')).to.equal(null);
            expect(owner.last('playerLeft').memberId).to.equal('guest:socket-guest');
            expect(guest.roomMembership).to.equal(null);
            expect(guest.count('roomSnapshot')).to.equal(snapshotsBefore);
        });

        it('restores an account room after signing in', () => {
            const accountRoom = createRoom(harness, 'Account Room');
            harness.roomManager.addMember(accountRoom.id, 'account:2');

            const guest = harness.addSocket('socket-guest', null);
            const previousIdentity = identityForSocket(guest);
            guest.auth = { account: account(2, 'newuser'), token: 'token-2' };

            harness.lobby.handleAuthChange(guest, previousIdentity);

            const snapshot = guest.last('roomSnapshot');
            expect(snapshot.restored).to.equal(true);
            expect(snapshot.room.id).to.equal(accountRoom.id);
            expect(guest.roomMembership).to.deep.equal({
                roomId: accountRoom.id,
                role: 'player'
            });
        });

        it('broadcasts playerDisconnect only to the affected room', () => {
            const room = createRoom(harness, 'Scoped Disconnect');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));
            const outsider = harness.addSocket('socket-3', account(3, 'outsider'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });
            const session = harness.lobby.getSession(room.id);

            harness.removeSocket(member);
            harness.lobby.handleDisconnect(member);

            const disconnect = owner.last('playerDisconnect');
            expect(disconnect.memberId).to.equal('account:2');
            expect(disconnect.name).to.equal('member');
            expect(disconnect.role).to.equal('player');
            expect(disconnect.graceMs).to.equal(100);
            expect(outsider.count('playerDisconnect')).to.equal(0);
            expect(session.isDisconnected('account:2')).to.equal(true);
            expect(session.snapshot().players.find(
                (player) => player.id === 'account:2'
            ).disconnected).to.equal(true);
            expect(harness.timerCount()).to.equal(1);
        });

        it('clears readiness for a player who disconnects during the lobby', () => {
            const room = createRoom(harness, 'Ready Disconnect');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });
            member.trigger('setReady', { ready: true });
            expect(room.ready.has('account:2')).to.equal(true);

            harness.removeSocket(member);
            harness.lobby.handleDisconnect(member);

            expect(room.ready.has('account:2')).to.equal(false);
            expect(owner.last('playerReady')).to.deep.include({
                memberId: 'account:2',
                ready: false
            });
        });

        it('ignores a stale socket when a newer connection owns the account', () => {
            const room = createRoom(harness, 'Replaced Socket');
            const first = harness.addSocket('socket-1', account(1, 'owner'));
            const second = harness.addSocket('socket-2', account(1, 'owner'));

            first.trigger('joinRoom', { id: room.id });
            harness.lobby.restoreMembership(second);
            const session = harness.lobby.getSession(room.id);

            // The replacement socket is still connected when the stale one
            // closes, so the member must stay connected.
            harness.removeSocket(first);
            const handled = harness.lobby.handleDisconnect(first);

            expect(handled).to.equal(false);
            expect(session.isDisconnected('account:1')).to.equal(false);
            expect(second.count('playerDisconnect')).to.equal(0);
            expect(harness.timerCount()).to.equal(0);
        });

        it('keeps ownership during grace and transfers it on expiry', () => {
            const room = createRoom(harness, 'Owner Disconnect');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });

            harness.removeSocket(owner);
            harness.lobby.handleDisconnect(owner);

            expect(room.ownerId).to.equal('account:1');
            expect(harness.roomManager.getMembership('account:1').room).to.equal(room);
            expect(member.last('playerDisconnect')).to.deep.include({
                memberId: 'account:1',
                reason: 'disconnect'
            });

            harness.runTimers();

            expect(harness.roomManager.getMembership('account:1')).to.equal(null);
            expect(room.ownerId).to.equal('account:2');
            expect(room.ownerAccountId).to.equal(2);
            expect(member.last('playerLeft').reason).to.equal('disconnect timeout');
            expect(member.last('roomUpdated').room.isOwner).to.equal(true);
        });

        it('restores a disconnected player and broadcasts playerReconnect', () => {
            const room = createRoom(harness, 'Reconnect Event');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });
            const session = harness.lobby.getSession(room.id);

            harness.removeSocket(member);
            harness.lobby.handleDisconnect(member);
            expect(session.isDisconnected('account:2')).to.equal(true);

            const second = harness.addSocket('socket-3', account(2, 'member'));
            expect(harness.lobby.restoreMembership(second)).to.equal(true);

            expect(owner.last('playerReconnect')).to.deep.include({
                memberId: 'account:2',
                role: 'player'
            });
            expect(session.isDisconnected('account:2')).to.equal(false);
            expect(harness.timerCount()).to.equal(0);
            expect(second.last('roomSnapshot').restored).to.equal(true);
        });

        it('handles a heartbeat timeout through the reconnect grace policy', () => {
            const room = createRoom(harness, 'Heartbeat Match');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });
            owner.trigger('setReady', { ready: true });
            member.trigger('setReady', { ready: true });
            owner.trigger('startGame');
            harness.advance(1000);
            harness.runTimers();

            const session = harness.lobby.getSession(room.id);
            const player = session.getPlayer('account:2');
            player.lastHeartbeat = harness.now() - 6000;

            session.tickGame();
            session.tickGame();

            expect(owner.count('playerDisconnect')).to.equal(1);
            expect(owner.last('playerDisconnect').reason).to.equal('heartbeat timeout');
            expect(member.connected).to.equal(false);
            expect(member.disconnectReason).to.equal(
                'Last heartbeat received over 5000 ago.'
            );
            expect(session.isDisconnected('account:2')).to.equal(true);
            expect(harness.timerCount()).to.equal(1);

            harness.runTimers();

            expect(harness.roomManager.getMembership('account:2')).to.equal(null);
            expect(owner.last('playerLeft').reason).to.equal('heartbeat timeout');
            expect(owner.last('gameEnd').reason).to.equal('not_enough_players');
        });

        it('stops sessions, intervals and timers during shutdown', () => {
            const room = createRoom(harness, 'Shutdown Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });
            owner.trigger('setReady', { ready: true });
            member.trigger('setReady', { ready: true });
            owner.trigger('startGame');
            harness.advance(1000);
            harness.runTimers();
            expect(harness.activeIntervals()).to.have.length(3);

            harness.removeSocket(member);
            harness.lobby.handleDisconnect(member);
            harness.lobby.startCleanup(1000);

            expect(harness.timerCount()).to.equal(1);
            harness.lobby.stop();

            expect(harness.lobby.sessions.size).to.equal(0);
            expect(harness.lobby.disconnectTimers.size).to.equal(0);
            expect(harness.timerCount()).to.equal(0);
            expect(harness.activeIntervals()).to.have.length(0);
        });
    });

    describe('game lifecycle', () => {
        function joinAndReady(room, first, second) {
            first.trigger('joinRoom', { id: room.id });
            second.trigger('joinRoom', { id: room.id });
            first.trigger('setReady', { ready: true });
            second.trigger('setReady', { ready: true });
        }

        it('starts a game after the owner starts a ready room', () => {
            const room = createRoom(harness, 'Start Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });

            expect(owner.last('roomSnapshot').game.state).to.equal('lobby');
            expect(owner.last('roomSnapshot').room.isReady).to.equal(false);

            owner.trigger('setReady', { ready: true });
            member.trigger('setReady', { ready: true });

            expect(owner.last('playerReady').memberId).to.equal('account:2');
            expect(owner.last('roomUpdated').room.isReady).to.equal(true);
            expect(owner.last('roomUpdated').room.readyCount).to.equal(2);

            owner.trigger('startGame');

            const countdown = owner.last('gameCountdown');
            expect(countdown.state).to.equal('countdown');
            expect(countdown.countdownMs).to.equal(1000);
            expect(owner.last('gameState').state).to.equal('countdown');
            expect(room.ready.size).to.equal(0);

            const session = harness.lobby.getSession(room.id);
            expect(session.state).to.equal('countdown');

            harness.advance(1000);
            harness.runTimers();

            expect(session.state).to.equal('running');
            expect(session.map.players.data).to.have.length(2);
            expect(owner.last('gameStart').state).to.equal('running');
            expect(harness.activeIntervals()).to.have.length(3);
        });

        it('stops a running game and returns to the lobby', () => {
            const room = createRoom(harness, 'Stop Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            joinAndReady(room, owner, member);
            owner.trigger('startGame');
            harness.advance(1000);
            harness.runTimers();

            owner.trigger('stopGame');

            expect(owner.last('gameEnd').reason).to.equal('owner_stop');
            expect(owner.last('gameState').state).to.equal('finished');
            expect(harness.activeIntervals()).to.have.length(0);

            owner.trigger('returnToLobby');

            expect(owner.last('gameState').state).to.equal('lobby');
            expect(room.ready.size).to.equal(0);
        });

        it('rejects starting without enough players', () => {
            const room = createRoom(harness, 'Solo Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));

            owner.trigger('joinRoom', { id: room.id });
            owner.trigger('setReady', { ready: true });
            owner.trigger('startGame');

            expect(owner.last('roomError').code).to.equal(ROOM_ERROR_CODES.NOT_ENOUGH_PLAYERS);
        });

        it('rejects starting until every player is ready', () => {
            const room = createRoom(harness, 'Unready Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });
            owner.trigger('setReady', { ready: true });

            owner.trigger('startGame');

            expect(owner.last('roomError').code).to.equal(ROOM_ERROR_CODES.PLAYERS_NOT_READY);
        });

        it('rejects starting a room owned by someone else', () => {
            const room = createRoom(harness, 'Owner Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            joinAndReady(room, owner, member);
            member.trigger('startGame');

            expect(member.last('roomError').code).to.equal(ROOM_ERROR_CODES.NOT_OWNER);
        });

        it('rejects new players during a game but allows spectators', () => {
            const room = createRoom(harness, 'Running Room');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));
            const late = harness.addSocket('socket-3', account(3, 'late'));

            joinAndReady(room, owner, member);
            owner.trigger('startGame');
            harness.advance(1000);
            harness.runTimers();

            late.trigger('joinRoom', { id: room.id });
            expect(late.last('roomError').code).to.equal(ROOM_ERROR_CODES.ROOM_IN_GAME);

            late.trigger('joinRoom', { id: room.id, asSpectator: true });
            expect(late.last('roomSnapshot').role).to.equal('spectator');
            expect(late.last('roomSnapshot').game.state).to.equal('running');
            expect(harness.lobby.getSession(room.id).spectatorCount).to.equal(1);
        });

        it('ends a game when a player leaves a two-player match', () => {
            const room = createRoom(harness, 'Leave Game');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            joinAndReady(room, owner, member);
            owner.trigger('startGame');
            harness.advance(1000);
            harness.runTimers();

            member.trigger('leaveRoom');

            expect(owner.last('gameEnd').reason).to.equal('not_enough_players');
            expect(harness.lobby.getSession(room.id).state).to.equal('finished');
        });

        it('closes the session when the room is deleted', () => {
            const room = createRoom(harness, 'Delete Game');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            joinAndReady(room, owner, member);
            owner.trigger('startGame');
            harness.advance(1000);
            harness.runTimers();

            const session = harness.lobby.getSession(room.id);
            owner.trigger('deleteRoom', { id: room.id });

            expect(harness.lobby.getSession(room.id)).to.equal(null);
            expect(session.state).to.equal('closed');
            expect(harness.activeIntervals()).to.have.length(0);
        });

        it('kicks a lobby player and removes membership immediately', () => {
            const room = createRoom(harness, 'Kick Lobby');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            owner.trigger('joinRoom', { id: room.id });
            member.trigger('joinRoom', { id: room.id });
            member.trigger('setReady', { ready: true });
            const session = harness.lobby.getSession(room.id);

            expect(harness.lobby.kickMember('account:2', 'cheating')).to.equal(true);

            expect(member.last('kick')).to.equal('cheating');
            expect(member.connected).to.equal(false);
            expect(member.disconnectReason).to.equal('cheating');
            expect(harness.roomManager.getMembership('account:2')).to.equal(null);
            expect(room.members).to.deep.equal(['account:1']);
            expect(room.ready.has('account:2')).to.equal(false);
            expect(session.hasPlayer('account:2')).to.equal(false);
            expect(owner.last('playerLeft').reason).to.equal('kick');
            expect(harness.lobby.restoreMembership(member)).to.equal(false);
        });

        it('ends the match when an admin kicks a player', () => {
            const room = createRoom(harness, 'Kick Game');
            const owner = harness.addSocket('socket-1', account(1, 'owner'));
            const member = harness.addSocket('socket-2', account(2, 'member'));

            joinAndReady(room, owner, member);
            owner.trigger('startGame');
            harness.advance(1000);
            harness.runTimers();

            expect(harness.lobby.kickMember('account:2', 'cheating')).to.equal(true);

            expect(owner.last('gameEnd').reason).to.equal('not_enough_players');
            expect(harness.roomManager.getMembership('account:2')).to.equal(null);
        });

        it('reports a finished match with its room metadata', () => {
            const finished = [];
            const finishedHarness = createHarness({
                onMatchFinished: (result, room) => finished.push({ result, room })
            });
            const room = createRoom(finishedHarness, 'Finished Game');
            const owner = finishedHarness.addSocket('socket-1', account(1, 'owner'));
            const member = finishedHarness.addSocket('socket-2', account(2, 'member'));

            joinAndReady(room, owner, member);
            owner.trigger('startGame');
            finishedHarness.advance(1000);
            finishedHarness.runTimers();

            owner.trigger('stopGame');

            expect(finished).to.have.length(1);
            expect(finished[0].result.reason).to.equal('owner_stop');
            expect(finished[0].room).to.deep.equal({
                id: room.id,
                code: room.code,
                name: 'Finished Game'
            });
            expect(finished[0].result.scores).to.have.length(2);
        });
    });
});
