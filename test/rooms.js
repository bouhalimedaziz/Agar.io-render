'use strict';

const expect = require('chai').expect;

const {
    createRoomManager,
    RoomError,
    ROOM_ERROR_CODES,
    serializeRoom
} = require('../src/server/rooms');

function expectRoomError(fn, code) {
    try {
        fn();
    } catch (err) {
        expect(err).to.be.instanceOf(RoomError);
        expect(err.code).to.equal(code);
        return err;
    }

    throw new Error('Expected room error ' + code);
}

describe('rooms', () => {
    let clock;
    let rooms;

    beforeEach(() => {
        clock = 1000;
        rooms = createRoomManager({
            now: () => clock,
            emptyRoomGraceMs: 1000,
            maxRooms: 5,
            defaults: {
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
            }
        });
    });

    function create(name, options = {}) {
        clock += 10;
        return rooms.createRoom(Object.assign({
            name,
            ownerId: 'account:1',
            ownerAccountId: 1
        }, options));
    }

    describe('create', () => {
        it('creates a room with defaults, id, code and owner', () => {
            const room = create('First Room');

            expect(room.id).to.match(/^room_[0-9a-f]{16}$/);
            expect(room.code).to.match(/^[A-HJ-NP-Z2-9]{6}$/);
            expect(room.name).to.equal('First Room');
            expect(room.normalizedName).to.equal('first room');
            expect(room.visibility).to.equal('public');
            expect(room.status).to.equal('open');
            expect(room.ownerId).to.equal('account:1');
            expect(room.ownerAccountId).to.equal(1);
            expect(room.members).to.deep.equal([]);
            expect(room.spectators).to.deep.equal([]);
            expect(room.settings.maxPlayers).to.equal(8);
            expect(room.capacity).to.equal(room.settings.maxPlayers);
            expect(room.createdAt).to.equal(clock);
            expect(room.updatedAt).to.equal(clock);
            expect(rooms.size).to.equal(1);
        });

        it('accepts custom settings and merges them with defaults', () => {
            const room = create('Custom Room', {
                visibility: 'private',
                settings: {
                    mapWidth: 7000,
                    maxPlayers: 4,
                    timeLimitMs: 600000,
                    scoreLimit: 500
                }
            });

            expect(room.visibility).to.equal('private');
            expect(room.settings.mapWidth).to.equal(7000);
            expect(room.settings.mapHeight).to.equal(5000);
            expect(room.settings.maxPlayers).to.equal(4);
            expect(room.capacity).to.equal(4);
            expect(room.settings.timeLimitMs).to.equal(600000);
            expect(room.settings.scoreLimit).to.equal(500);
        });

        it('looks rooms up by id or join code', () => {
            const room = create('Lookup Room');

            expect(rooms.getRoom(room.id)).to.equal(room);
            expect(rooms.getRoom(room.code)).to.equal(room);
            expect(rooms.getRoom(room.code.toLowerCase())).to.equal(room);
            expect(rooms.getRoom('room_missing')).to.equal(null);
            expect(rooms.getRoom(undefined)).to.equal(null);
        });

        it('generates unique ids and codes', () => {
            const codes = new Set();
            for (let i = 0; i < 5; i += 1) {
                const room = create('Room ' + i);
                codes.add(room.code);
            }

            expect(codes.size).to.equal(5);
        });

        it('enforces case-insensitive room-name uniqueness', () => {
            create('Alpha Room');

            expectRoomError(() => create(' alpha room '), ROOM_ERROR_CODES.ROOM_NAME_TAKEN);
        });

        it('enforces the per-server room limit', () => {
            for (let i = 0; i < 5; i += 1) {
                create('Limit Room ' + i);
            }

            expectRoomError(
                () => create('Limit Room 6'),
                ROOM_ERROR_CODES.ROOM_LIMIT_REACHED
            );
        });
    });

    describe('validation', () => {
        it('rejects invalid room names', () => {
            expectRoomError(() => create('ab'), ROOM_ERROR_CODES.INVALID_ROOM_NAME);
            expectRoomError(
                () => create('bad <script>'),
                ROOM_ERROR_CODES.INVALID_ROOM_NAME
            );
            expectRoomError(
                () => rooms.createRoom({ name: 42, ownerId: 'account:1' }),
                ROOM_ERROR_CODES.INVALID_ROOM_NAME
            );
        });

        it('rejects invalid visibility', () => {
            expectRoomError(
                () => create('Visibility Room', { visibility: 'secret' }),
                ROOM_ERROR_CODES.INVALID_VISIBILITY
            );
        });

        it('rejects unknown, out-of-range and non-integer settings', () => {
            expectRoomError(
                () => create('Unknown Setting', { settings: { nope: 1 } }),
                ROOM_ERROR_CODES.INVALID_SETTINGS
            );
            expectRoomError(
                () => create('Big Room', { settings: { maxPlayers: 100 } }),
                ROOM_ERROR_CODES.INVALID_SETTINGS
            );
            expectRoomError(
                () => create('Small Room', { settings: { mapWidth: 10 } }),
                ROOM_ERROR_CODES.INVALID_SETTINGS
            );
            expectRoomError(
                () => create('Fraction Room', { settings: { maxFood: 1.5 } }),
                ROOM_ERROR_CODES.INVALID_SETTINGS
            );
            expectRoomError(
                () => create('String Room', { settings: { maxFood: '100' } }),
                ROOM_ERROR_CODES.INVALID_SETTINGS
            );
            expectRoomError(
                () => create('Array Room', { settings: [] }),
                ROOM_ERROR_CODES.INVALID_SETTINGS
            );
        });

        it('requires an owner to create a room', () => {
            expect(() => rooms.createRoom({ name: 'No Owner' })).to.throw(TypeError);
        });
    });

    describe('list', () => {
        it('lists public rooms newest first', () => {
            create('Older Room');
            create('Newer Room');

            const names = rooms.listRooms().map((room) => room.name);
            expect(names).to.deep.equal(['Newer Room', 'Older Room']);
        });

        it('hides private rooms from other viewers but shows them to the owner', () => {
            create('Public Room', { visibility: 'public' });
            create('Secret Room', {
                visibility: 'private',
                ownerId: 'account:2',
                ownerAccountId: 2
            });

            const publicView = rooms.listRooms().map((room) => room.name);
            expect(publicView).to.deep.equal(['Public Room']);

            const ownerView = rooms.listRooms({ viewerId: 'account:2' }).map((room) => room.name);
            expect(ownerView).to.deep.equal(['Secret Room', 'Public Room']);

            const otherView = rooms.listRooms({ viewerId: 'account:1' }).map((room) => room.name);
            expect(otherView).to.deep.equal(['Public Room']);

            expect(rooms.listRooms({ includePrivate: true })).to.have.length(2);
        });

        it('filters by visibility and serializes safely', () => {
            const publicRoom = create('Serialized Room');
            const serialized = serializeRoom(publicRoom, 'account:1');

            expect(serialized.id).to.equal(publicRoom.id);
            expect(serialized.code).to.equal(publicRoom.code);
            expect(serialized.capacity).to.equal(publicRoom.settings.maxPlayers);
            expect(serialized.memberCount).to.equal(0);
            expect(serialized.isOwner).to.equal(true);
            expect(serialized.ownerId).to.equal(undefined);

            serialized.settings.maxPlayers = 99;
            expect(publicRoom.settings.maxPlayers).to.equal(8);

            expect(rooms.listRooms({ visibility: 'public' })).to.have.length(1);
            expect(rooms.listRooms({ visibility: 'private' })).to.have.length(0);
        });
    });

    describe('update and delete', () => {
        it('allows only the owner to update a room', () => {
            const room = create('Owned Room');

            expectRoomError(
                () => rooms.updateRoom(room.id, 'account:2', { name: 'Stolen' }),
                ROOM_ERROR_CODES.NOT_OWNER
            );

            clock += 10;
            const updated = rooms.updateRoom(room.id, 'account:1', {
                name: 'Renamed Room',
                visibility: 'private',
                settings: { maxPlayers: 4, mapHeight: 6000 }
            });

            expect(updated.name).to.equal('Renamed Room');
            expect(updated.normalizedName).to.equal('renamed room');
            expect(updated.visibility).to.equal('private');
            expect(updated.settings.maxPlayers).to.equal(4);
            expect(updated.capacity).to.equal(4);
            expect(updated.settings.mapHeight).to.equal(6000);
            expect(updated.updatedAt).to.equal(clock);
            expect(rooms.listRooms()).to.have.length(0);
        });

        it('rejects unknown update fields and duplicate names', () => {
            const room = create('First Name');
            create('Second Name');

            expectRoomError(
                () => rooms.updateRoom(room.id, 'account:1', { status: 'closed' }),
                ROOM_ERROR_CODES.INVALID_UPDATE
            );
            expectRoomError(
                () => rooms.updateRoom(room.id, 'account:1', { name: 'second name' }),
                ROOM_ERROR_CODES.ROOM_NAME_TAKEN
            );
            expectRoomError(
                () => rooms.updateRoom(room.id, 'account:1', {
                    settings: { maxPlayers: 100 }
                }),
                ROOM_ERROR_CODES.INVALID_SETTINGS
            );
        });

        it('rejects a capacity below the current player count', () => {
            const room = create('Busy Room');
            rooms.addMember(room.id, 'account:1');
            rooms.addMember(room.id, 'account:2');

            expectRoomError(
                () => rooms.updateRoom(room.id, 'account:1', {
                    settings: { maxPlayers: 1 }
                }),
                ROOM_ERROR_CODES.INVALID_SETTINGS
            );
        });

        it('allows only the owner to delete a room and reuses the name', () => {
            const room = create('Delete Me');

            expectRoomError(
                () => rooms.removeRoom(room.id, 'account:2'),
                ROOM_ERROR_CODES.NOT_OWNER
            );

            const removed = rooms.removeRoom(room.id, 'account:1');
            expect(removed.id).to.equal(room.id);
            expect(rooms.getRoom(room.id)).to.equal(null);
            expect(rooms.size).to.equal(0);

            const recreated = create('Delete Me');
            expect(recreated.name).to.equal('Delete Me');
        });

        it('reports missing rooms', () => {
            expectRoomError(
                () => rooms.updateRoom('room_missing', 'account:1', {}),
                ROOM_ERROR_CODES.ROOM_NOT_FOUND
            );
            expectRoomError(
                () => rooms.removeRoom('room_missing', 'account:1'),
                ROOM_ERROR_CODES.ROOM_NOT_FOUND
            );
        });
    });

    describe('membership', () => {
        it('enforces capacity for players but allows spectators', () => {
            const room = create('Full Room', { settings: { maxPlayers: 2 } });

            rooms.addMember(room.id, 'account:1');
            rooms.addMember(room.id, 'account:2');
            rooms.addSpectator(room.id, 'account:3');

            expectRoomError(
                () => rooms.addMember(room.id, 'account:4'),
                ROOM_ERROR_CODES.ROOM_FULL
            );
            expectRoomError(
                () => rooms.addMember(room.id, 'account:1'),
                ROOM_ERROR_CODES.ALREADY_IN_ROOM
            );

            expect(room.members).to.have.length(2);
            expect(room.spectators).to.deep.equal(['account:3']);
            expect(room.emptySince).to.equal(null);

            rooms.removeMember(room.id, 'account:2');
            rooms.addMember(room.id, 'account:4');
            expect(room.members).to.deep.equal(['account:1', 'account:4']);
        });

        it('rejects membership operations for closed or missing rooms', () => {
            const room = create('Closed Room');
            room.status = 'closed';

            expectRoomError(
                () => rooms.addMember(room.id, 'account:1'),
                ROOM_ERROR_CODES.ROOM_CLOSED
            );
            expectRoomError(
                () => rooms.removeMember(room.id, 'account:1'),
                ROOM_ERROR_CODES.NOT_IN_ROOM
            );
            expectRoomError(
                () => rooms.addMember('room_missing', 'account:1'),
                ROOM_ERROR_CODES.ROOM_NOT_FOUND
            );
        });

        it('transfers ownership when the owner leaves', () => {
            const room = create('Owner Leaves');
            rooms.addMember(room.id, 'account:1');
            rooms.addMember(room.id, 'account:5');

            rooms.removeMember(room.id, 'account:1');

            expect(room.ownerId).to.equal('account:5');
            expect(room.ownerAccountId).to.equal(5);
        });

        it('transfers ownership to a spectator when no players remain', () => {
            const room = create('Spectator Owner');
            rooms.addMember(room.id, 'account:1');
            rooms.addSpectator(room.id, 'account:9');

            rooms.removeMember(room.id, 'account:1');

            expect(room.members).to.deep.equal([]);
            expect(room.spectators).to.deep.equal(['account:9']);
            expect(room.ownerId).to.equal('account:9');
            expect(room.ownerAccountId).to.equal(9);
        });

        it('tracks one room per member through the membership index', () => {
            const first = create('First Membership');
            const second = create('Second Membership');

            rooms.addMember(first.id, 'account:7');

            const membership = rooms.getMembership('account:7');
            expect(membership.room).to.equal(first);
            expect(membership.role).to.equal('player');
            expect(rooms.getRoomForMember('account:7')).to.equal(first);

            const err = expectRoomError(
                () => rooms.addMember(second.id, 'account:7'),
                ROOM_ERROR_CODES.ALREADY_IN_ROOM
            );
            expect(err.details).to.deep.equal({ roomId: first.id });

            rooms.removeMember(first.id, 'account:7');
            expect(rooms.getMembership('account:7')).to.equal(null);
            expect(rooms.getRoomForMember('account:7')).to.equal(null);

            rooms.addMember(second.id, 'account:7');
            expect(rooms.getMembership('account:7').room).to.equal(second);
        });

        it('reports spectator roles through the membership index', () => {
            const room = create('Spectator Membership');
            rooms.addSpectator(room.id, 'guest:socket-1');

            const membership = rooms.getMembership('guest:socket-1');
            expect(membership.room).to.equal(room);
            expect(membership.role).to.equal('spectator');
        });

        it('requires a join code for private rooms unless the member owns them', () => {
            const room = create('Private Membership', {
                visibility: 'private',
                ownerId: 'account:1',
                ownerAccountId: 1
            });

            expectRoomError(
                () => rooms.addMember(room.id, 'account:2'),
                ROOM_ERROR_CODES.ROOM_PRIVATE
            );
            expectRoomError(
                () => rooms.addSpectator(room.id, 'account:2'),
                ROOM_ERROR_CODES.ROOM_PRIVATE
            );

            rooms.addMember(room.code, 'account:2', { byCode: true });
            expect(room.members).to.deep.equal(['account:2']);

            rooms.removeMember(room.id, 'account:2');
            rooms.addMember(room.id, 'account:1');
            expect(room.members).to.deep.equal(['account:1']);
        });

        it('clears membership indexes when a room is removed', () => {
            const room = create('Removed Membership');
            rooms.addMember(room.id, 'account:3');
            rooms.addSpectator(room.id, 'guest:socket-2');

            rooms.removeRoom(room.id, 'account:1');

            expect(rooms.getMembership('account:3')).to.equal(null);
            expect(rooms.getMembership('guest:socket-2')).to.equal(null);
            expect(rooms.memberRooms.size).to.equal(0);
        });

        it('tracks ready players and clears readiness on join or leave', () => {
            const room = create('Ready Room');
            rooms.addMember(room.id, 'account:1');
            rooms.addMember(room.id, 'account:2');

            expect(rooms.allPlayersReady(room)).to.equal(false);
            expect(serializeRoom(room, 'account:1').isReady).to.equal(false);

            rooms.setReady(room.id, 'account:1', true);
            expect(rooms.allPlayersReady(room)).to.equal(false);

            rooms.setReady(room.id, 'account:2', true);
            expect(rooms.allPlayersReady(room)).to.equal(true);

            const serialized = serializeRoom(room, 'account:2', { includeMembers: true });
            expect(serialized.readyCount).to.equal(2);
            expect(serialized.isReady).to.equal(true);
            expect(serialized.readyMembers).to.deep.equal(['account:1', 'account:2']);

            rooms.setReady(room.id, 'account:1', false);
            expect(rooms.allPlayersReady(room)).to.equal(false);

            rooms.clearReady(room);
            expect(room.ready.size).to.equal(0);

            expectRoomError(
                () => rooms.setReady(room.id, 'account:9', true),
                ROOM_ERROR_CODES.NOT_IN_ROOM
            );

            rooms.addSpectator(room.id, 'guest:watcher');
            expectRoomError(
                () => rooms.setReady(room.id, 'guest:watcher', true),
                ROOM_ERROR_CODES.NOT_IN_ROOM
            );

            rooms.setReady(room.id, 'account:1', true);
            rooms.removeMember(room.id, 'account:1');
            expect(room.ready.has('account:1')).to.equal(false);

            rooms.addMember(room.id, 'account:3');
            expect(room.ready.has('account:3')).to.equal(false);
        });
    });

    describe('cleanup', () => {
        it('removes empty rooms only after the grace period', () => {
            const room = create('Empty Room');

            clock += 500;
            expect(rooms.cleanupEmptyRooms()).to.deep.equal([]);
            expect(rooms.getRoom(room.id)).to.equal(room);

            clock += 501;
            const removed = rooms.cleanupEmptyRooms();
            expect(removed).to.have.length(1);
            expect(removed[0].id).to.equal(room.id);
            expect(rooms.getRoom(room.id)).to.equal(null);
            expect(rooms.size).to.equal(0);
        });

        it('does not remove occupied rooms', () => {
            const room = create('Occupied Room');
            rooms.addMember(room.id, 'account:1');

            clock += 5000;
            expect(rooms.cleanupEmptyRooms()).to.deep.equal([]);
            expect(rooms.getRoom(room.id)).to.equal(room);

            rooms.removeMember(room.id, 'account:1');
            clock += 500;
            expect(rooms.cleanupEmptyRooms()).to.deep.equal([]);
            clock += 501;
            expect(rooms.cleanupEmptyRooms()).to.have.length(1);
        });

        it('cleans up private rooms too', () => {
            const room = create('Private Empty', { visibility: 'private' });

            clock += 1001;
            expect(rooms.cleanupEmptyRooms()).to.have.length(1);
            expect(rooms.getRoom(room.id)).to.equal(null);
        });
    });
});
