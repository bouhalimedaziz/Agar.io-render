'use strict';

const { RESERVED_EVENTS } = require('../shared/tcp-socket');

const IPC_CHANNELS = Object.freeze({
    CONNECT: 'agar:transport:connect',
    DISCONNECT: 'agar:transport:disconnect',
    EMIT: 'agar:transport:emit',
    STATE: 'agar:transport:state',
    EVENT: 'agar:transport:event'
});

// These names are owned by the transport/client and must never be sent to the
// game server by the renderer.
const INTERNAL_EVENTS = new Set([
    ...RESERVED_EVENTS,
    'connecting',
    'connect_error',
    'reconnect',
    'reconnecting',
    'reconnect_failed'
]);

function serializeError(err) {
    if (!err || typeof err !== 'object') {
        return err;
    }

    const payload = {
        name: err.name,
        message: err.message
    };
    if (err.code !== undefined) {
        payload.code = err.code;
    }
    return payload;
}

function serializeArg(value) {
    return value instanceof Error ? serializeError(value) : value;
}

/**
 * Only the handshake type is exposed to the renderer. Everything else about
 * the connection stays under main-process control.
 */
function normalizeConnectQuery(options) {
    const requested = options && (
        options.type ||
        (options.query && options.query.type)
    );
    return requested === 'spectator'
        ? { type: 'spectator' }
        : { type: 'player' };
}

/**
 * Owns the TCP client in the Electron main process and bridges it to one
 * renderer over IPC. The renderer never sees `net` or the raw socket.
 */
class TcpBridge {
    constructor(options = {}) {
        if (typeof options.createClient !== 'function') {
            throw new TypeError('createClient is required');
        }

        this.createClient = options.createClient;
        this.ipcMain = options.ipcMain || null;
        this.getWindow = options.getWindow || (() => null);
        this.clientOptions = options.clientOptions || {};
        this.logger = options.logger || console;

        this.client = null;
        this.state = 'idle';
        this._ipcHandlers = [];
    }

    start() {
        this._registerIpc();
        return this;
    }

    connect(options = {}) {
        if (this.client) {
            // A new renderer (reload) or a transport switch (player ->
            // spectator) needs a fresh server session, so the handshake
            // query is always applied to a new client.
            this._destroyClient();
        }

        this._createClient(normalizeConnectQuery(options));
        return this;
    }

    disconnect(reason = 'renderer disconnect') {
        if (this.client) {
            this.client.disconnect(reason);
        }
        return this;
    }

    emit(event, ...args) {
        if (typeof event !== 'string' || event.length === 0) {
            throw new TypeError('event must be a non-empty string');
        }
        if (INTERNAL_EVENTS.has(event)) {
            throw new TypeError('cannot emit internal event "' + event + '"');
        }
        if (!this.client) {
            return false;
        }

        this.client.emit(event, ...args);
        return true;
    }

    getState() {
        return {
            connected: Boolean(this.client && this.client.connected),
            state: this.state
        };
    }

    stop() {
        for (const [channel, handler] of this._ipcHandlers) {
            if (this.ipcMain && typeof this.ipcMain.removeListener === 'function') {
                this.ipcMain.removeListener(channel, handler);
            }
        }
        this._ipcHandlers = [];
        this._destroyClient();
        this.state = 'stopped';
        return this;
    }

    _createClient(query) {
        const baseOptions = Object.assign({
            reconnect: true,
            client: { name: 'agar-desktop' }
        }, this.clientOptions);

        baseOptions.query = Object.assign(
            { type: 'player' },
            this.clientOptions.query || {},
            query || {}
        );

        const client = this.createClient(baseOptions);

        this.client = client;
        this.state = 'connecting';

        client.on('connect', () => {
            this.state = 'connected';
            this._forward('connect');
        });
        client.on('connecting', () => {
            this.state = 'connecting';
            this._forward('connecting');
        });
        client.on('disconnect', (reason) => {
            this.state = 'disconnected';
            this._forward('disconnect', reason);
        });
        client.on('reconnecting', (attempt, delay) => {
            this.state = 'reconnecting';
            this._forward('reconnecting', attempt, delay);
        });
        client.on('reconnect_failed', () => {
            this.state = 'offline';
            this._forward('reconnect_failed');
        });
        client.on('connect_error', (err) => {
            this._forward('connect_error', serializeError(err));
        });
        client.on('error', (err) => {
            this._forward('error', serializeError(err));
        });
        client.onAny((event, ...args) => this._forward(event, ...args));

        client.connect();
    }

    _destroyClient() {
        const client = this.client;
        this.client = null;
        if (!client) {
            return;
        }

        if (typeof client.removeAllListeners === 'function') {
            client.removeAllListeners();
        }
        try {
            client.disconnect('bridge teardown');
        } catch (err) {
            this.logger.warn('[TRANSPORT] Failed to close the TCP client:', err);
        }
        this.state = 'disconnected';
    }

    _registerIpc() {
        if (!this.ipcMain || this._ipcHandlers.length > 0) {
            return;
        }

        this._handle(IPC_CHANNELS.CONNECT, (event, options) => {
            if (!this._fromRenderer(event)) {
                return;
            }
            this.connect(options);
        });

        this._handle(IPC_CHANNELS.DISCONNECT, (event) => {
            if (!this._fromRenderer(event)) {
                return;
            }
            this.disconnect();
        });

        this._handle(IPC_CHANNELS.EMIT, (event, payload) => {
            if (!this._fromRenderer(event) || !payload || typeof payload.event !== 'string') {
                return;
            }
            if (INTERNAL_EVENTS.has(payload.event)) {
                return;
            }

            const args = Array.isArray(payload.args) ? payload.args : [];
            this.emit(payload.event, ...args);
        });

        this._handle(IPC_CHANNELS.STATE, (event) => {
            event.returnValue = this._fromRenderer(event)
                ? this.getState()
                : { connected: false, state: 'denied' };
        });
    }

    _handle(channel, handler) {
        this.ipcMain.on(channel, handler);
        this._ipcHandlers.push([channel, handler]);
    }

    _fromRenderer(event) {
        const win = this.getWindow();
        return Boolean(
            win &&
            win.webContents &&
            event &&
            event.sender === win.webContents
        );
    }

    _forward(event, ...args) {
        const win = this.getWindow();
        if (!win || !win.webContents) {
            return;
        }
        if (typeof win.isDestroyed === 'function' && win.isDestroyed()) {
            return;
        }
        if (
            typeof win.webContents.isDestroyed === 'function' &&
            win.webContents.isDestroyed()
        ) {
            return;
        }

        try {
            win.webContents.send(IPC_CHANNELS.EVENT, {
                event,
                args: args.map(serializeArg)
            });
        } catch (err) {
            this.logger.warn('[TRANSPORT] Failed to forward event:', err);
        }
    }
}

function createTcpBridge(options) {
    return new TcpBridge(options);
}

module.exports = {
    IPC_CHANNELS,
    INTERNAL_EVENTS,
    TcpBridge,
    createTcpBridge,
    serializeError
};
