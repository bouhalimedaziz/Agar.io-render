'use strict';

const expect = require('chai').expect;
const {
    IPC_CHANNELS,
    createTcpBridge,
    serializeError
} = require('../src/electron/tcp-bridge');

function createFakeClient(options) {
    const handlers = new Map();
    let anyHandler = null;

    const client = {
        options,
        connected: false,
        sent: [],
        connects: 0,
        disconnects: 0,

        connect() {
            this.connects += 1;
        },

        disconnect(reason) {
            this.disconnects += 1;
            this.connected = false;
            client.trigger('disconnect', reason);
        },

        removeAllListeners() {
            handlers.clear();
            anyHandler = null;
        },

        on(event, handler) {
            if (!handlers.has(event)) {
                handlers.set(event, []);
            }
            handlers.get(event).push(handler);
        },

        onAny(handler) {
            anyHandler = handler;
        },

        emit(event, ...args) {
            this.sent.push([event].concat(args));
            return this;
        },

        trigger(event, ...args) {
            for (const handler of (handlers.get(event) || []).slice()) {
                handler(...args);
            }
        },

        serverEvent(event, ...args) {
            if (anyHandler) {
                anyHandler(event, ...args);
            }
        }
    };

    return client;
}

function createFakeIpc() {
    const handlers = new Map();

    return {
        handlers,
        on(channel, handler) {
            handlers.set(channel, handler);
        },
        removeListener(channel, handler) {
            if (handlers.get(channel) === handler) {
                handlers.delete(channel);
            }
        },
        send(channel, event, ...args) {
            const handler = handlers.get(channel);
            if (handler) {
                handler(event, ...args);
            }
            return event;
        }
    };
}

function setup() {
    const ipcMain = createFakeIpc();
    const clients = [];
    const events = [];
    const webContents = {
        send(channel, payload) {
            events.push({ channel, payload });
        },
        isDestroyed() {
            return false;
        }
    };
    const win = {
        webContents,
        isDestroyed() {
            return false;
        }
    };

    const bridge = createTcpBridge({
        ipcMain,
        getWindow: () => win,
        createClient: (options) => {
            const client = createFakeClient(options);
            clients.push(client);
            return client;
        },
        logger: { warn() {} }
    });
    bridge.start();

    return {
        bridge,
        ipcMain,
        clients,
        events,
        win,
        sender: webContents,
        ipcEvent: { sender: webContents }
    };
}

describe('electron tcp bridge', () => {
    it('creates a TCP client and forwards server events to the renderer', () => {
        const { bridge, clients, events } = setup();

        bridge.connect();

        expect(clients).to.have.length(1);
        expect(clients[0].connects).to.equal(1);
        expect(clients[0].options.query).to.deep.equal({ type: 'player' });
        expect(clients[0].options.reconnect).to.equal(true);
        expect(bridge.getState()).to.deep.equal({
            connected: false,
            state: 'connecting'
        });

        clients[0].connected = true;
        clients[0].trigger('connect');
        clients[0].serverEvent('welcome', {}, { width: 100 });

        expect(events).to.deep.equal([
            { channel: IPC_CHANNELS.EVENT, payload: { event: 'connect', args: [] } },
            {
                channel: IPC_CHANNELS.EVENT,
                payload: { event: 'welcome', args: [{}, { width: 100 }] }
            }
        ]);
        expect(bridge.getState()).to.deep.equal({
            connected: true,
            state: 'connected'
        });
    });

    it('forwards renderer actions and rejects internal or foreign traffic', () => {
        const { bridge, ipcMain, clients, sender } = setup();
        bridge.connect();
        clients[0].connected = true;

        ipcMain.send(IPC_CHANNELS.EMIT, { sender }, {
            event: 'gotit',
            args: [{ name: 'Alice' }]
        });
        expect(clients[0].sent).to.deep.equal([['gotit', { name: 'Alice' }]]);

        ipcMain.send(IPC_CHANNELS.EMIT, { sender }, {
            event: 'connect',
            args: []
        });
        ipcMain.send(IPC_CHANNELS.EMIT, { sender }, null);
        ipcMain.send(IPC_CHANNELS.EMIT, { sender: {} }, {
            event: 'gotit',
            args: []
        });

        expect(clients[0].sent).to.have.length(1);
        expect(() => bridge.emit('disconnect')).to.throw(TypeError);
        expect(() => bridge.emit('')).to.throw(TypeError);
    });

    it('forwards reconnect state and serialized errors', () => {
        const { bridge, clients, events } = setup();
        bridge.connect();

        clients[0].trigger('reconnecting', 2, 1500);
        const error = new Error('boom');
        error.code = 'ECONNREFUSED';
        clients[0].trigger('connect_error', error);
        clients[0].trigger('reconnect_failed');

        expect(events.map((entry) => entry.payload)).to.deep.equal([
            { event: 'reconnecting', args: [2, 1500] },
            {
                event: 'connect_error',
                args: [{ name: 'Error', message: 'boom', code: 'ECONNREFUSED' }]
            },
            { event: 'reconnect_failed', args: [] }
        ]);
        expect(bridge.getState().state).to.equal('offline');
    });

    it('starts a fresh client when the renderer reconnects', () => {
        const { bridge, clients } = setup();

        bridge.connect();
        clients[0].connected = true;
        bridge.connect();

        expect(clients).to.have.length(2);
        expect(clients[0].disconnects).to.equal(1);
        expect(clients[1].connects).to.equal(1);
    });

    it('honours the requested handshake type and rejects unknown types', () => {
        const first = setup();
        first.bridge.connect({ query: { type: 'spectator' } });
        expect(first.clients[0].options.query).to.deep.equal({ type: 'spectator' });

        const second = setup();
        second.bridge.connect({ type: 'spectator' });
        expect(second.clients[0].options.query).to.deep.equal({ type: 'spectator' });

        const third = setup();
        third.bridge.connect({ query: { type: 'admin' } });
        expect(third.clients[0].options.query).to.deep.equal({ type: 'player' });
    });

    it('answers state requests only for the app window', () => {
        const { ipcMain, sender } = setup();
        const allowed = { sender };
        const denied = { sender: {} };

        ipcMain.send(IPC_CHANNELS.STATE, allowed);
        ipcMain.send(IPC_CHANNELS.STATE, denied);

        expect(allowed.returnValue).to.deep.equal({
            connected: false,
            state: 'idle'
        });
        expect(denied.returnValue).to.deep.equal({
            connected: false,
            state: 'denied'
        });
    });

    it('stops the client and unregisters IPC handlers', () => {
        const { bridge, ipcMain, clients } = setup();
        bridge.connect();
        clients[0].connected = true;

        bridge.stop();

        expect(clients[0].disconnects).to.equal(1);
        expect(ipcMain.handlers.size).to.equal(0);
        expect(bridge.getState()).to.deep.equal({
            connected: false,
            state: 'stopped'
        });
    });

    it('serializes errors without leaking stack traces', () => {
        const error = new Error('nope');
        error.code = 'E_FAIL';

        expect(serializeError(error)).to.deep.equal({
            name: 'Error',
            message: 'nope',
            code: 'E_FAIL'
        });
        expect(serializeError('plain')).to.equal('plain');
    });
});
