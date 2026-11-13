'use strict';

const net = require('net');
const expect = require('chai').expect;

const {
    OPCODES,
    ProtocolError,
    FrameDecoder,
    encodeFrame,
    encodeEvent,
    decodeEventPayload,
    createServer,
    createClient
} = require('../src/shared/tcp-socket');

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

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

describe('tcp-socket protocol', () => {
    it('decodes a frame that is split across several TCP chunks', () => {
        const frame = encodeFrame(OPCODES.EVENT, Buffer.from('hello'));
        const decoder = new FrameDecoder();

        expect(decoder.push(frame.subarray(0, 3))).to.have.length(0);
        expect(decoder.push(frame.subarray(3, 4))).to.have.length(0);
        expect(decoder.push(frame.subarray(4, 7))).to.have.length(0);

        const frames = decoder.push(frame.subarray(7));
        expect(frames).to.have.length(1);
        expect(frames[0].opcode).to.equal(OPCODES.EVENT);
        expect(frames[0].payload.toString('utf8')).to.equal('hello');
    });

    it('decodes several frames from one TCP chunk', () => {
        const first = encodeEvent('a', [1]);
        const second = encodeEvent('b', [2]);
        const decoder = new FrameDecoder();

        const frames = decoder.push(Buffer.concat([first, second]));
        expect(frames).to.have.length(2);
        expect(decodeEventPayload(frames[0].payload)).to.deep.equal({ event: 'a', args: [1] });
        expect(decodeEventPayload(frames[1].payload)).to.deep.equal({ event: 'b', args: [2] });
    });

    it('rejects a frame larger than the configured limit', () => {
        const header = Buffer.alloc(5);
        header.writeUInt32BE(11, 0);
        header.writeUInt8(OPCODES.EVENT, 4);

        const decoder = new FrameDecoder({ maxPayloadSize: 10 });
        expect(() => decoder.push(header)).to.throw(ProtocolError);
    });

    it('preserves unknown opcodes for the higher layer to reject', () => {
        const frame = encodeFrame(0xff, Buffer.from('x'));
        const decoder = new FrameDecoder();
        const frames = decoder.push(frame);
        expect(frames[0].opcode).to.equal(0xff);
    });

    it('uses the same framing header on both ends', () => {
        const frame = encodeFrame(OPCODES.PING, Buffer.from('abc'));
        expect(frame.readUInt32BE(0)).to.equal(3);
        expect(frame.readUInt8(4)).to.equal(OPCODES.PING);
        expect(frame.subarray(5).toString('utf8')).to.equal('abc');
    });
});

describe('tcp-socket client/server', function () {
    this.timeout(5000);

    it('delivers events in both directions with multiple arguments', async () => {
        const server = createServer({ heartbeatInterval: 0 });
        let client = null;

        try {
            server.on('connection', (socket) => {
                socket.on('hello', (number, object) => {
                    socket.emit('welcome', 'hi', { number, object });
                });
            });

            const listening = waitForEvent(server, 'listening');
            server.listen(0, '127.0.0.1');
            await listening;

            client = createClient({
                host: '127.0.0.1',
                port: server.address().port,
                reconnect: false,
                heartbeatInterval: 0
            });

            const connected = waitForEvent(client, 'connect');
            client.connect();
            await connected;

            const welcome = waitForEvent(client, 'welcome');
            client.emit('hello', 42, { x: 1 });
            const [message, payload] = await welcome;

            expect(message).to.equal('hi');
            expect(payload).to.deep.equal({ number: 42, object: { x: 1 } });
        } finally {
            if (client) {
                client.disconnect();
            }
            await closeServer(server);
        }
    });

    it('broadcasts to every socket except the sender', async () => {
        const server = createServer({ heartbeatInterval: 0 });
        const clients = [];

        try {
            server.on('connection', (socket) => {
                socket.on('announce', (text) => {
                    socket.broadcast.emit('announcement', text);
                });
            });

            const listening = waitForEvent(server, 'listening');
            server.listen(0, '127.0.0.1');
            await listening;

            const port = server.address().port;
            const first = createClient({ host: '127.0.0.1', port, reconnect: false, heartbeatInterval: 0 });
            const second = createClient({ host: '127.0.0.1', port, reconnect: false, heartbeatInterval: 0 });
            clients.push(first, second);

            let firstReceived = false;
            first.on('announcement', () => {
                firstReceived = true;
            });

            const firstConnected = waitForEvent(first, 'connect');
            const secondConnected = waitForEvent(second, 'connect');
            first.connect();
            second.connect();
            await Promise.all([firstConnected, secondConnected]);

            const announcement = waitForEvent(second, 'announcement');
            first.emit('announce', 'hello everyone');

            const [text] = await announcement;
            expect(text).to.equal('hello everyone');

            await delay(50);
            expect(firstReceived).to.equal(false);
        } finally {
            for (const client of clients) {
                client.disconnect();
            }
            await closeServer(server);
        }
    });

    it('waits for the handshake when requireHandshake is enabled', async () => {
        const server = createServer({
            heartbeatInterval: 0,
            requireHandshake: true,
            handshakeTimeout: 1000
        });
        let client = null;

        try {
            const connection = waitForEvent(server, 'connection');
            const listening = waitForEvent(server, 'listening');
            server.listen(0, '127.0.0.1');
            await listening;

            client = createClient({
                host: '127.0.0.1',
                port: server.address().port,
                reconnect: false,
                heartbeatInterval: 0,
                query: { type: 'player' },
                auth: { token: 'secret' }
            });

            const connected = waitForEvent(client, 'connect');
            client.connect();
            await connected;

            const [socket] = await connection;
            expect(socket.handshake.query.type).to.equal('player');
            expect(socket.handshake.auth.token).to.equal('secret');
            expect(socket.handshake.address).to.be.a('string');
            expect(socket.handshake.address.length).to.be.greaterThan(0);
        } finally {
            if (client) {
                client.disconnect();
            }
            await closeServer(server);
        }
    });

    it('disconnects peers that stop answering heartbeats', async () => {
        const server = createServer({
            heartbeatInterval: 40,
            heartbeatTimeout: 40
        });
        let rawSocket = null;

        try {
            const connection = waitForEvent(server, 'connection');
            const listening = waitForEvent(server, 'listening');
            server.listen(0, '127.0.0.1');
            await listening;

            rawSocket = net.connect({
                host: '127.0.0.1',
                port: server.address().port
            });

            const [serverSocket] = await connection;
            const disconnected = waitForEvent(serverSocket, 'disconnect', 2000);

            const [reason] = await disconnected;
            expect(reason).to.equal('heartbeat timeout');
        } finally {
            if (rawSocket) {
                rawSocket.destroy();
            }
            await closeServer(server);
        }
    });

    it('delivers application events through onAny and honours offAny', async () => {
        const server = createServer({ heartbeatInterval: 0 });
        let client = null;
        let serverSocket = null;

        try {
            server.on('connection', (socket) => {
                serverSocket = socket;
                socket.emit('notice', 'hello', 7);
            });

            const listening = waitForEvent(server, 'listening');
            server.listen(0, '127.0.0.1');
            await listening;

            client = createClient({
                host: '127.0.0.1',
                port: server.address().port,
                reconnect: false,
                heartbeatInterval: 0
            });

            const anyEvents = [];
            const anyHandler = (event, ...args) => anyEvents.push([event].concat(args));
            client.onAny(anyHandler);

            const notice = waitForEvent(client, 'notice');
            const connected = waitForEvent(client, 'connect');
            client.connect();
            await Promise.all([connected, notice]);

            expect(anyEvents).to.deep.equal([['notice', 'hello', 7]]);

            client.offAny(anyHandler);
            const second = waitForEvent(client, 'notice2');
            serverSocket.emit('notice2', 'ignored');
            await second;

            expect(anyEvents).to.deep.equal([['notice', 'hello', 7]]);
        } finally {
            if (client) {
                client.disconnect();
            }
            await closeServer(server);
        }
    });

    it('refuses to emit reserved event names', async () => {
        const server = createServer();
        let client = null;

        try {
            const listening = waitForEvent(server, 'listening');
            server.listen(0, '127.0.0.1');
            await listening;

            client = createClient({
                host: '127.0.0.1',
                port: server.address().port,
                reconnect: false,
                heartbeatInterval: 0
            });

            expect(() => client.emit('disconnect')).to.throw(TypeError);
            expect(() => client.emit('error')).to.throw(TypeError);
        } finally {
            if (client) {
                client.disconnect();
            }
            await closeServer(server);
        }
    });
});
