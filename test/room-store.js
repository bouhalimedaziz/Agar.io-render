'use strict';

const expect = require('chai').expect;
const { RoomStore } = require('../src/client/js/room-store');

function game(overrides) {
    return Object.assign({
        roomId: 'room_1',
        state: 'lobby',
        countdownMs: 3000,
        countdownEndsAt: null,
        map: { width: 5000, height: 5000 },
        playerCount: 2,
        spectatorCount: 0,
        players: [
            { id: 'account:1', name: 'Owner', alive: true, score: 10, admin: false },
            { id: 'guest:s1', name: 'Guest', alive: true, score: 4, admin: false }
        ],
        spectators: []
    }, overrides);
}

function snapshot(overrides) {
    const options = overrides || {};
    return {
        room: Object.assign({
            id: 'room_1',
            code: 'ABC123',
            name: 'Test Room',
            visibility: 'public',
            ownerAccountId: 1,
            capacity: 8,
            status: 'open',
            settings: {
                maxPlayers: 8,
                mapWidth: 5000,
                mapHeight: 5000,
                timeLimitMs: 0,
                scoreLimit: 0
            },
            memberCount: 2,
            spectatorCount: 0,
            readyCount: 1,
            isReady: false,
            createdAt: 10,
            updatedAt: 10,
            isOwner: true,
            members: ['account:1', 'guest:s1'],
            spectators: [],
            readyMembers: ['account:1']
        }, options.room),
        role: options.role || 'player',
        restored: Boolean(options.restored),
        game: options.game === null ? null : game(options.game)
    };
}

describe('room store', () => {
    it('builds a roster from a room snapshot', () => {
        const store = new RoomStore();

        store.enterRoom(snapshot());

        expect(store.room.id).to.equal('room_1');
        expect(store.role).to.equal('player');
        expect(store.members).to.have.length(2);
        expect(store.members[0]).to.include({
            id: 'account:1',
            name: 'Owner',
            ready: true,
            score: 10
        });
        expect(store.members[1]).to.include({
            id: 'guest:s1',
            name: 'Guest',
            ready: false,
            score: 4
        });
        expect(store.spectators).to.have.length(0);
        expect(store.gameState).to.equal('lobby');
        expect(store.canStart()).to.equal(false);
    });

    it('updates a room without losing the roster', () => {
        const store = new RoomStore();
        store.enterRoom(snapshot());

        store.applyRoomUpdated({
            id: 'room_1',
            name: 'Renamed',
            isOwner: true,
            isReady: true,
            readyCount: 1,
            memberCount: 2,
            settings: { maxPlayers: 12 }
        });

        expect(store.room.name).to.equal('Renamed');
        expect(store.members).to.have.length(2);
        expect(store.members.map((member) => member.name)).to.deep.equal(['Owner', 'Guest']);
        expect(store.isReady).to.equal(true);
    });

    it('clears stale ready badges when the server resets readiness', () => {
        const store = new RoomStore();
        store.enterRoom(snapshot());
        store.applyPlayerReady({ memberId: 'guest:s1', ready: true });
        expect(store.members.every((member) => member.ready)).to.equal(true);

        store.applyGameEnd({ reason: 'owner_stop', scores: [] });
        store.applyRoomUpdated({
            id: 'room_1',
            isReady: false,
            readyCount: 0,
            memberCount: 2
        });

        expect(store.members.some((member) => member.ready)).to.equal(false);
        expect(store.room.readyMembers).to.deep.equal([]);
        expect(store.canStart()).to.equal(false);
    });

    it('tracks joins, leaves and ready changes', () => {        const store = new RoomStore();
        store.enterRoom(snapshot());

        store.applyPlayerJoined({
            memberId: 'guest:s2',
            name: 'Late',
            role: 'player'
        });
        expect(store.members).to.have.length(3);
        expect(store.room.memberCount).to.equal(3);
        expect(store.members[2].name).to.equal('Late');

        store.applyPlayerJoined({
            memberId: 'guest:spec',
            name: 'Watcher',
            role: 'spectator'
        });
        expect(store.spectators).to.have.length(1);
        expect(store.room.spectatorCount).to.equal(1);

        store.applyPlayerReady({ memberId: 'guest:s1', ready: true });
        store.applyPlayerReady({ memberId: 'guest:s2', ready: true });
        expect(store.members.every((member) => member.ready)).to.equal(true);
        expect(store.canStart()).to.equal(true);

        store.applyPlayerLeft({ memberId: 'guest:s2' });
        expect(store.members).to.have.length(2);
        expect(store.room.memberCount).to.equal(2);

        store.applyPlayerLeft({ memberId: 'guest:spec' });
        expect(store.spectators).to.have.length(0);
        expect(store.room.spectatorCount).to.equal(0);
    });

    it('only lets a ready owner start with enough players', () => {
        const store = new RoomStore();
        const onePlayer = snapshot({
            room: {
                members: ['account:1'],
                readyMembers: ['account:1'],
                memberCount: 1,
                isOwner: true
            },
            game: {
                playerCount: 1,
                players: [
                    { id: 'account:1', name: 'Owner', alive: true, score: 0 }
                ]
            }
        });

        store.enterRoom(onePlayer);
        expect(store.canStart()).to.equal(false);

        const other = snapshot({ room: { isOwner: false } });
        store.enterRoom(other);
        expect(store.canStart()).to.equal(false);
    });

    it('tracks countdown, start, end and lobby transitions', () => {
        const store = new RoomStore();
        store.enterRoom(snapshot());

        store.applyCountdown({ countdownMs: 3000, startsAt: Date.now() + 3000 });
        expect(store.gameState).to.equal('countdown');
        expect(store.countdown.countdownMs).to.equal(3000);

        store.applyGameStart(game({ state: 'running' }));
        expect(store.gameState).to.equal('running');
        expect(store.countdown).to.equal(null);
        expect(store.inGame).to.equal(true);

        store.applyGameEnd({
            reason: 'score_limit',
            durationMs: 1000,
            scores: [{ id: 'account:1', name: 'Owner', winner: true, rank: 1 }]
        });
        expect(store.finished).to.equal(true);
        expect(store.result.reason).to.equal('score_limit');

        store.applyGameState(game({ state: 'lobby' }));
        expect(store.result).to.equal(null);
        expect(store.countdown).to.equal(null);
        expect(store.gameState).to.equal('lobby');
    });

    it('resets the room when it is removed or left', () => {
        const store = new RoomStore();
        store.enterRoom(snapshot());

        const wasCurrent = store.applyRoomRemoved({ id: 'room_1', code: 'ABC123' });

        expect(wasCurrent).to.equal(true);
        expect(store.room).to.equal(null);
        expect(store.members).to.have.length(0);

        store.enterRoom(snapshot());
        store.leaveRoom();
        expect(store.room).to.equal(null);
        expect(store.gameState).to.equal(null);
    });

    it('keeps a sorted public room list', () => {
        const store = new RoomStore();
        store.setRoomList([
            { id: 'b', name: 'Older', createdAt: 10 },
            { id: 'a', name: 'Newest', createdAt: 20 }
        ]);

        expect(store.rooms.map((room) => room.id)).to.deep.equal(['a', 'b']);

        store.upsertRoom({ id: 'a', name: 'Updated', createdAt: 20 });
        expect(store.rooms[0].name).to.equal('Updated');

        expect(store.removeRoom('b')).to.equal(true);
        expect(store.rooms).to.have.length(1);
    });

    it('exposes spectator roles and the viewer name', () => {
        const store = new RoomStore();
        store.setAccount({ id: 1, username: 'Owner' });
        store.enterRoom(snapshot({
            role: 'spectator',
            room: {
                members: ['guest:s1'],
                spectators: ['account:1'],
                readyMembers: []
            },
            game: {
                playerCount: 1,
                spectatorCount: 1,
                players: [
                    { id: 'guest:s1', name: 'Guest', alive: true, score: 0 }
                ],
                spectators: ['account:1']
            }
        }));

        expect(store.isSpectator).to.equal(true);
        expect(store.isPlayer).to.equal(false);
        expect(store.members).to.have.length(1);
        expect(store.spectators).to.have.length(1);
        expect(store.spectators[0].isSelf).to.equal(true);
        expect(store.viewerName).to.equal('Spectator');
    });
});
