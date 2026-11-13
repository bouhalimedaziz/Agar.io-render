'use strict';

const { EventEmitter } = require('events');
const expect = require('chai').expect;

const {
    createTransportHub,
    createTcpServer
} = require('../src/server/transport');
const { createClient } = require('../src/shared/tcp-socket');

class FakeTransport extends EventEmitter {
    constructor() {
        super();
        this.closed = false;
    }

    close(callback) {
        this.closed = true;
        if (callback) callback();
    }
}

class FakeRawSocket extends EventEmitter {
    constructor(id, handshake) {
        super();
        this.id = id;
        this.handshake = handshake || {};
        this.connected = true;
        this.sent = [];
    }

    // The hub sends application events through this method, so record them
    // instead of triggering local listeners.
    emit(event, ...args) {
        this.sent.push({ event, args });
        return this;
    }

    localEmit(event, ...args) {
        return EventEmitter.prototype.emit.call(this, event, ...args);
    }

    disconnect(reason) {
        if (!this.connected) return;
        this.connected = false;
        this.localEmit('disconnect', reason || 'disconnect');
    }
}

function waitForEvent(emitter, event, timeout = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('timed out waiting for ' + event));
        }, timeout);

        const onEvent = (...args) => {
            cleanup();
            resolve(args);
        };

        const onError = (err) => {
            cleanup();
            reject(err);
        };

        function cleanup() {
            clearTimeout(timer);
            emitter.removeListener(event, onEvent);
            emitter.removeListener('error', onError);
        }

        emitter.once(event, onEvent);
        emitter.once('error', onError);
    });
}

function waitUntil(predicate, timeout = 2000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - started > timeout) {
                clearInterval(timer);
                reject(new Error('timed out waiting for condition'));
            }
        }, 10);
    });
}

function closeServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

describe('TransportHub', () => {
    it('wraps connections from multiple transports and normalizes handshakes', () => {
        const hub = createTransportHub();
        const first = new FakeTransport();
        const second = new FakeTransport();
        const connections = [];

        hub.addTransport('first', first);
        hub.addTransport('second', second);
        hub.on('connection', (socket) => connections.push(socket));

        const rawFirst = new FakeRawSocket('first-1', {
            query: { type: 'player' },
            address: '10.0.0.1'
        });
        const rawSecond = new FakeRawSocket('second-1', {
            query: { type: 'spectator' },
            address: '10.0.0.2'
        });

        first.emit('connection', rawFirst);
        second.emit('connection', rawSecond);

        expect(connections).to.have.length(2);
        expect(connections[0].id).to.equal('first-1');
        expect(connections[0].transport).to.equal('first');
        expect(connections[0].handshake.query.type).to.equal('player');
        expect(connections[0].remoteAddress).to.equal('10.0.0.1');
        expect(connections[1].transport).to.equal('second');
        expect(connections[1].handshake.query.type).to.equal('spectator');
        expect(connections[1].remoteAddress).to.equal('10.0.0.2');
    });

    it('broadcasts across transports and excludes only the sender', () => {
        const hub = createTransportHub();
        const first = new FakeTransport();
        const second = new FakeTransport();
        const connections = [];

        hub.addTransport('first', first);
        hub.addTransport('second', second);
        hub.on('connection', (socket) => connections.push(socket));

        const rawFirst = new FakeRawSocket('first-1', { query: {} });
        const rawSecond = new FakeRawSocket('second-1', { query: {} });

        first.emit('connection', rawFirst);
        second.emit('connection', rawSecond);

        hub.emit('global', 1);
        expect(rawFirst.sent).to.deep.equal([{ event: 'global', args: [1] }]);
        expect(rawSecond.sent).to.deep.equal([{ event: 'global', args: [1] }]);

        rawFirst.sent.length = 0;
        rawSecond.sent.length = 0;

        connections[0].broadcast.emit('room', 2);
        expect(rawFirst.sent).to.deep.equal([]);
        expect(rawSecond.sent).to.deep.equal([{ event: 'room', args: [2] }]);

        rawFirst.sent.length = 0;
        rawSecond.sent.length = 0;

        hub.broadcastExcept('second-1', 'except', 3);
        expect(rawFirst.sent).to.deep.equal([{ event: 'except', args: [3] }]);
        expect(rawSecond.sent).to.deep.equal([]);
    });

    it('removes disconnected sockets from the hub', () => {
        const hub = createTransportHub();
        const transport = new FakeTransport();
        const raw = new FakeRawSocket('one', { query: {} });

        hub.addTransport('test', transport);
        transport.emit('connection', raw);

        expect(hub.sockets.has('one')).to.equal(true);
        raw.disconnect('gone');
        expect(hub.sockets.has('one')).to.equal(false);
    });

    it('closes every attached transport', (done) => {
        const hub = createTransportHub();
        const first = new FakeTransport();
        const second = new FakeTransport();

        hub.addTransport('first', first);
        hub.addTransport('second', second);

        hub.close(() => {
            expect(first.closed).to.equal(true);
            expect(second.closed).to.equal(true);
            done();
        });
    });

    it('works with real TCP transports and clients', async () => {
        const hub = createTransportHub();
        const firstServer = createTcpServer({ requireHandshake: true, heartbeatInterval: 0 });
        const secondServer = createTcpServer({ requireHandshake: true, heartbeatInterval: 0 });
        const connections = [];
        const clients = [];

        try {
            hub.addTransport('tcp-first', firstServer);
            hub.addTransport('tcp-second', secondServer);
            hub.on('connection', (socket) => connections.push(socket));

            const firstListening = waitForEvent(firstServer, 'listening');
            const secondListening = waitForEvent(secondServer, 'listening');
            firstServer.listen(0, '127.0.0.1');
            secondServer.listen(0, '127.0.0.1');
            await Promise.all([firstListening, secondListening]);

            const firstClient = createClient({
                host: '127.0.0.1',
                port: firstServer.address().port,
                reconnect: false,
                heartbeatInterval: 0,
                query: { type: 'player' }
            });
            const secondClient = createClient({
                host: '127.0.0.1',
                port: secondServer.address().port,
                reconnect: false,
                heartbeatInterval: 0,
                query: { type: 'spectator' }
            });
            clients.push(firstClient, secondClient);

            const firstConnected = waitForEvent(firstClient, 'connect');
            const secondConnected = waitForEvent(secondClient, 'connect');
            firstClient.connect();
            secondClient.connect();
            await Promise.all([firstConnected, secondConnected]);
            await waitUntil(() => connections.length === 2);

            const firstSocket = connections.find((socket) => socket.transport === 'tcp-first');
            const secondSocket = connections.find((socket) => socket.transport === 'tcp-second');
            expect(firstSocket).to.not.equal(undefined);
            expect(secondSocket).to.not.equal(undefined);
            expect(firstSocket.transport).to.equal('tcp-first');
            expect(secondSocket.transport).to.equal('tcp-second');
            expect(firstSocket.handshake.query.type).to.equal('player');
            expect(secondSocket.handshake.query.type).to.equal('spectator');

            const globalEvent = waitForEvent(secondClient, 'global');
            hub.emit('global', 'all');
            expect(await globalEvent).to.deep.equal(['all']);

            const firstWouldHear = [];
            firstClient.on('roomOnly', (...args) => firstWouldHear.push(args));
            const roomEvent = waitForEvent(secondClient, 'roomOnly');
            firstSocket.broadcast.emit('roomOnly', 'others');
            expect(await roomEvent).to.deep.equal(['others']);

            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(firstWouldHear).to.deep.equal([]);
        } finally {
            for (const client of clients) {
                client.disconnect();
            }
            await Promise.all([closeServer(firstServer), closeServer(secondServer)]);
        }
    });
});
