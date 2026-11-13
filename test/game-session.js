'use strict';

const expect = require('chai').expect;

const { GameSession } = require('../src/server/game');

const SETTINGS = {
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

function createHarness(options = {}) {
    let now = 1000;
    const timeouts = [];
    const intervals = [];
    const roomEvents = [];
    const memberEvents = [];
    const finished = [];
    const heartbeatTimeouts = [];

    function setTimeoutFn(fn, ms) {
        const timer = { fn, ms, cleared: false, unref() {} };
        timeouts.push(timer);
        return timer;
    }

    function clearTimeoutFn(timer) {
        timer.cleared = true;
    }

    function setIntervalFn(fn, ms) {
        const timer = { fn, ms, cleared: false, unref() {} };
        intervals.push(timer);
        return timer;
    }

    function clearIntervalFn(timer) {
        timer.cleared = true;
    }

    const session = new GameSession(Object.assign({
        roomId: 'room_test',
        settings: SETTINGS,
        config: {
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
            }
        },
        countdownMs: 3000,
        competitive: true,
        now: () => now,
        setTimeoutFn,
        clearTimeoutFn,
        setIntervalFn,
        clearIntervalFn,
        emitToRoom: (event, payload) => roomEvents.push({ event, payload }),
        emitToMember: (memberId, event, payload) =>
            memberEvents.push({ memberId, event, payload }),
        onFinished: (result) => finished.push(result),
        onHeartbeatTimeout: (memberId, reason) =>
            heartbeatTimeouts.push({ memberId, reason })
    }, options));

    function advance(ms) {
        now += ms;
    }

    function runTimeouts() {
        const pending = timeouts.filter((timer) => !timer.cleared);
        timeouts.length = 0;
        for (const timer of pending) {
            timer.fn();
        }
    }

    function activeIntervals() {
        return intervals.filter((timer) => !timer.cleared);
    }

    return {
        session,
        roomEvents,
        memberEvents,
        finished,
        heartbeatTimeouts,
        advance,
        runTimeouts,
        activeIntervals,
        now: () => now,
        event: (name) => {
            for (let index = roomEvents.length - 1; index >= 0; index -= 1) {
                if (roomEvents[index].event === name) {
                    return roomEvents[index].payload;
                }
            }
            return undefined;
        },
        memberEventsFor: (memberId) => memberEvents.filter((entry) => entry.memberId === memberId)
    };
}

describe('game session', () => {
    describe('lifecycle', () => {
        it('starts with a lobby and moves through countdown to running', () => {
            const harness = createHarness();
            const session = harness.session;

            expect(session.state).to.equal('lobby');
            session.addPlayer('a', { name: 'Alice' });
            session.addPlayer('b', { name: 'Bob' });

            expect(session.start()).to.equal(true);
            expect(session.state).to.equal('countdown');
            expect(session.snapshot().countdownEndsAt).to.equal(4000);
            expect(harness.event('gameCountdown').countdownMs).to.equal(3000);
            expect(harness.event('gameState').state).to.equal('countdown');
            expect(session.map.players.data).to.have.length(0);

            harness.advance(3000);
            harness.runTimeouts();

            expect(session.state).to.equal('running');
            expect(session.map.players.data).to.have.length(2);
            expect(harness.event('gameStart').state).to.equal('running');
            expect(harness.activeIntervals()).to.have.length(3);
        });

        it('emits gameEnd, stops timers and can reset to the lobby', () => {
            const harness = createHarness();
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.startRunning();

            expect(harness.activeIntervals()).to.have.length(3);
            expect(session.finish('owner_stop')).to.equal(true);
            expect(session.state).to.equal('finished');
            expect(session.endReason).to.equal('owner_stop');
            expect(harness.event('gameEnd').reason).to.equal('owner_stop');
            expect(harness.finished).to.have.length(1);
            expect(harness.activeIntervals()).to.have.length(0);

            session.reset();
            expect(session.state).to.equal('lobby');
            expect(session.map.players.data).to.have.length(0);
            expect(harness.event('gameState').state).to.equal('lobby');
        });

        it('clears everything when closed', () => {
            const harness = createHarness();
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.addSpectator('watcher');
            session.startRunning();

            session.close();

            expect(session.state).to.equal('closed');
            expect(session.players.size).to.equal(0);
            expect(session.spectators.size).to.equal(0);
            expect(harness.activeIntervals()).to.have.length(0);
        });
    });

    describe('players and input', () => {
        it('tracks input, firing food and splitting only while running', () => {
            const harness = createHarness();
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.startRunning();
            const player = session.getPlayer('a');
            player.cells[0].setMass(100);

            expect(session.setTarget('a', { x: 10, y: 20 })).to.equal(true);
            expect(player.target).to.deep.equal({ x: 10, y: 20 });
            expect(player.lastHeartbeat).to.equal(harness.now());

            expect(session.fireFood('a')).to.equal(true);
            expect(player.cells[0].mass).to.equal(80);
            expect(session.map.massFood.data.length).to.equal(1);

            expect(session.split('a')).to.equal(true);
            expect(player.cells.length).to.be.greaterThan(1);

            session.finish('owner_stop');
            expect(session.setTarget('a', { x: 1, y: 1 })).to.equal(false);
            expect(session.fireFood('a')).to.equal(false);
            expect(session.split('a')).to.equal(false);
        });

        it('sends updates only to the session players and spectators', () => {
            const harness = createHarness();
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.addSpectator('watcher');
            session.startRunning();
            session.sendUpdates();

            expect(harness.memberEventsFor('a').some(
                (entry) => entry.event === 'serverTellPlayerMove'
            )).to.equal(true);
            expect(harness.memberEventsFor('watcher').some(
                (entry) => entry.event === 'serverTellPlayerMove'
            )).to.equal(true);
            expect(harness.memberEventsFor('watcher')[0].payload.id).to.equal('watcher');
        });

        it('rejects malformed targets and clamps impossible offsets', () => {
            const harness = createHarness();
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.startRunning();
            const player = session.getPlayer('a');

            expect(session.setTarget('a', null)).to.equal(false);
            expect(session.setTarget('a', 'nope')).to.equal(false);
            expect(session.setTarget('a', [1, 2])).to.equal(false);
            expect(session.setTarget('a', { x: NaN, y: 0 })).to.equal(false);
            expect(session.setTarget('a', { x: '10', y: 20 })).to.equal(false);
            expect(player.target).to.deep.equal({ x: 0, y: 0 });

            expect(session.setTarget('a', { x: 1e9, y: -1e9 })).to.equal(true);
            expect(player.target).to.deep.equal({ x: 10000, y: -10000 });
        });

        it('bounds screen sizes from gotit and window resizes', () => {
            const harness = createHarness();
            const session = harness.session;

            session.addPlayer('a', {
                name: 'Alice',
                screenWidth: 99999,
                screenHeight: 1
            });
            session.startRunning();
            const player = session.getPlayer('a');

            expect(player.screenWidth).to.equal(5000);
            expect(player.screenHeight).to.equal(100);

            expect(session.setScreenSize('a', 1920, 1080)).to.equal(true);
            expect(player.screenWidth).to.equal(1920);
            expect(player.screenHeight).to.equal(1080);

            expect(session.setScreenSize('a', 1e9, 1e9)).to.equal(true);
            expect(player.screenWidth).to.equal(5000);
            expect(player.screenHeight).to.equal(5000);

            expect(session.setScreenSize('missing', 800, 600)).to.equal(false);
        });

        it('enforces fire-food and split cooldowns', () => {
            const harness = createHarness();
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.startRunning();
            const player = session.getPlayer('a');
            player.cells[0].setMass(100);

            expect(session.fireFood('a')).to.equal(true);
            expect(session.fireFood('a')).to.equal(false);

            harness.advance(99);
            expect(session.fireFood('a')).to.equal(false);
            harness.advance(1);
            expect(session.fireFood('a')).to.equal(true);

            expect(session.split('a')).to.equal(true);
            harness.advance(249);
            expect(session.split('a')).to.equal(false);
            harness.advance(1);
            expect(session.split('a')).to.equal(true);
        });

        it('splits a player when it eats a virus', () => {
            const harness = createHarness();
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.startRunning();
            const player = session.getPlayer('a');
            player.cells[0].setMass(100);

            session.map.viruses.pushNew({
                x: player.cells[0].x,
                y: player.cells[0].y,
                mass: 10,
                radius: 10
            });

            session.tickGame();

            expect(session.map.viruses.data).to.have.length(0);
            expect(player.cells.length).to.be.greaterThan(1);
        });

        it('tracks admin status on the session member', () => {
            const harness = createHarness();
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            expect(session.setAdmin('a', true)).to.equal(true);
            expect(session.snapshot().players[0].admin).to.equal(true);
            expect(session.setAdmin('missing', true)).to.equal(false);

            session.startRunning();
            session.setAdmin('a', false);
            expect(session.getPlayer('a').admin).to.equal(false);
        });
    });

    describe('end conditions', () => {
        it('ends when only one player remains after a death', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.addPlayer('b', { name: 'Bob' });
            session.start();
            expect(session.state).to.equal('running');

            const eater = session.getPlayer('a');
            const eaten = session.getPlayer('b');
            eater.cells[0].setMass(200);
            eater.cells[0].x = 1000;
            eater.cells[0].y = 1000;
            eater.x = 1000;
            eater.y = 1000;
            eaten.cells[0].x = 1000;
            eaten.cells[0].y = 1000;
            eaten.x = 1000;
            eaten.y = 1000;
            eaten.target = { x: 0, y: 0 };

            session.tickGame();

            expect(session.map.players.data.length).to.equal(1);
            expect(session.state).to.equal('finished');
            expect(session.endReason).to.equal('last_player_standing');
            expect(harness.memberEventsFor('b').some((entry) => entry.event === 'RIP')).to.equal(true);
            expect(harness.event('playerDied').name).to.equal('Bob');
        });

        it('ends when the time limit is reached', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;
            session.settings.timeLimitMs = 1000;

            session.addPlayer('a', { name: 'Alice' });
            session.start();

            harness.advance(999);
            session.gameloop();
            expect(session.state).to.equal('running');

            harness.advance(1);
            session.gameloop();
            expect(session.state).to.equal('finished');
            expect(session.endReason).to.equal('time_limit');
        });

        it('ends when a player reaches the score limit', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;
            session.settings.scoreLimit = 100;

            session.addPlayer('a', { name: 'Alice' });
            session.start();
            session.getPlayer('a').massTotal = 100;

            session.gameloop();

            expect(session.state).to.equal('finished');
            expect(session.endReason).to.equal('score_limit');
        });

        it('ends when a competitive game loses enough players', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.addPlayer('b', { name: 'Bob' });
            session.start();

            session.removeMember('b');

            expect(session.state).to.equal('finished');
            expect(session.endReason).to.equal('not_enough_players');
        });

        it('finishes an empty running room', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.start();
            session.removeMember('a');

            expect(session.state).to.equal('finished');
            expect(session.endReason).to.equal('empty_room');
        });
    });

    describe('disconnect handling', () => {
        it('fires a heartbeat timeout once and freezes the resting cell', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.start();
            const player = session.getPlayer('a');
            player.lastHeartbeat = harness.now() - 6000;

            session.tickGame();

            expect(harness.heartbeatTimeouts).to.have.length(1);
            expect(harness.heartbeatTimeouts[0].memberId).to.equal('a');
            expect(player.disconnected).to.equal(true);

            const x = player.cells[0].x;
            const y = player.cells[0].y;
            session.tickGame();
            expect(harness.heartbeatTimeouts).to.have.length(1);
            expect(player.cells[0].x).to.equal(x);
            expect(player.cells[0].y).to.equal(y);
        });

        it('marks a member disconnected without marking them DNF', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.start();

            expect(session.markDisconnected('a')).to.equal(true);
            expect(session.isDisconnected('a')).to.equal(true);
            expect(session.snapshot().players[0].disconnected).to.equal(true);

            const result = session.result();
            expect(result.scores[0].disconnected).to.equal(true);
            expect(result.scores[0].dnf).to.equal(false);
            expect(result.scores[0].winner).to.equal(true);
        });

        it('restores input after a reconnect within the grace period', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.start();
            const player = session.getPlayer('a');

            session.markDisconnected('a');
            expect(session.setTarget('a', { x: 10, y: 10 })).to.equal(true);

            expect(player.disconnected).to.equal(false);
            expect(session.isDisconnected('a')).to.equal(false);
            expect(player.lastHeartbeat).to.equal(harness.now());

            expect(session.markReconnected('a')).to.equal(true);
            expect(session.markReconnected('missing')).to.equal(false);
            expect(session.markDisconnected('missing')).to.equal(false);
        });
    });

    describe('scoring and final results', () => {
        function placePlayer(player, x, y, mass) {
            player.x = x;
            player.y = y;
            player.cells[0].x = x;
            player.cells[0].y = y;
            player.cells[0].setMass(mass);
            player.massTotal = mass;
            player.target = { x, y };
        }

        it('tracks food eaten per player', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.start();

            const player = session.getPlayer('a');
            player.cells[0].setMass(50);
            player.massTotal = 50;
            session.map.food.data.push({
                x: player.cells[0].x,
                y: player.cells[0].y,
                radius: 1,
                mass: 1
            });

            session.tickGame();

            const stats = session.matchStats.get('a');
            expect(stats.foodEaten).to.equal(1);
            expect(stats.massTotal).to.be.greaterThan(50);
            expect(stats.peakMass).to.be.at.least(stats.massTotal);
        });

        it('credits kills and records the eliminated player', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.addPlayer('b', { name: 'Bob' });
            session.start();

            placePlayer(session.getPlayer('a'), 2500, 2500, 100);
            placePlayer(session.getPlayer('b'), 2500, 2500, 10);

            session.tickGame();

            const killer = session.matchStats.get('a');
            const victim = session.matchStats.get('b');
            expect(killer.kills).to.equal(1);
            expect(victim.alive).to.equal(false);
            expect(victim.deaths).to.equal(1);
            expect(victim.massTotal).to.equal(10);
            expect(session.state).to.equal('finished');
            expect(session.endReason).to.equal('last_player_standing');
        });

        it('produces ranked results with a winner', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.addPlayer('b', { name: 'Bob' });
            session.start();
            harness.advance(5000);

            const alice = session.getPlayer('a');
            const bob = session.getPlayer('b');
            alice.cells[0].setMass(100);
            alice.massTotal = 100;
            bob.cells[0].setMass(20);
            bob.massTotal = 20;

            session.finish('time_limit');
            const result = harness.finished[0];

            expect(result.winner).to.equal('a');
            expect(result.winners).to.deep.equal(['a']);
            expect(result.tie).to.equal(false);
            expect(result.durationMs).to.equal(5000);
            expect(result.scores.map((entry) => entry.id)).to.deep.equal(['a', 'b']);
            expect(result.scores.map((entry) => entry.rank)).to.deep.equal([1, 2]);
            expect(result.scores[0]).to.include({
                name: 'Alice',
                massTotal: 100,
                winner: true,
                alive: true,
                dnf: false
            });
            expect(result.scores[0].score).to.be.greaterThan(result.scores[1].score);
        });

        it('marks tied leaders as joint winners', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.addPlayer('b', { name: 'Bob' });
            session.start();

            const alice = session.getPlayer('a');
            const bob = session.getPlayer('b');
            alice.cells[0].setMass(100);
            alice.massTotal = 100;
            bob.cells[0].setMass(100);
            bob.massTotal = 100;

            session.finish('time_limit');
            const result = session.result();

            expect(result.tie).to.equal(true);
            expect(result.winner).to.equal(null);
            expect(result.winners.sort()).to.deep.equal(['a', 'b']);
            expect(result.scores.map((entry) => entry.rank)).to.deep.equal([1, 1]);
        });

        it('marks players who leave mid-match as DNF and never as winners', () => {
            const harness = createHarness({ countdownMs: 0 });
            const session = harness.session;

            session.addPlayer('a', { name: 'Alice' });
            session.addPlayer('b', { name: 'Bob' });
            session.start();
            harness.advance(1500);

            const alice = session.getPlayer('a');
            const bob = session.getPlayer('b');
            alice.cells[0].setMass(100);
            alice.massTotal = 100;
            bob.cells[0].setMass(50);
            bob.massTotal = 50;

            session.removeMember('b');
            const result = session.result();

            const bobResult = result.scores.find((entry) => entry.id === 'b');
            expect(result.reason).to.equal('not_enough_players');
            expect(result.winner).to.equal('a');
            expect(bobResult.dnf).to.equal(true);
            expect(bobResult.disconnected).to.equal(true);
            expect(bobResult.winner).to.equal(false);
            expect(bobResult.survivedMs).to.equal(1500);
            expect(result.scores.map((entry) => entry.id)).to.deep.equal(['a', 'b']);
        });
    });

    describe('isolation', () => {
        it('keeps two sessions completely separate', () => {
            const first = createHarness({ roomId: 'room_a', countdownMs: 0 });
            const second = createHarness({ roomId: 'room_b', countdownMs: 0 });

            first.session.addPlayer('a', { name: 'Alice' });
            second.session.addPlayer('b', { name: 'Bob' });
            first.session.start();
            second.session.start();

            first.session.sendUpdates();
            second.session.sendUpdates();

            expect(first.memberEventsFor('a').length).to.be.greaterThan(0);
            expect(first.memberEventsFor('b')).to.have.length(0);
            expect(second.memberEventsFor('b').length).to.be.greaterThan(0);
            expect(second.memberEventsFor('a')).to.have.length(0);
            expect(first.session.map).to.not.equal(second.session.map);
            expect(first.session.map.players.data[0].name).to.equal('Alice');
            expect(second.session.map.players.data[0].name).to.equal('Bob');

            first.session.finish('owner_stop');
            expect(first.session.state).to.equal('finished');
            expect(second.session.state).to.equal('running');
        });
    });
});
