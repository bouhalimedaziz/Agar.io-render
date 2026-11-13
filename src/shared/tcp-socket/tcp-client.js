'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const { TcpSocket, RESERVED_EVENTS, DEFAULTS } = require('./tcp-socket');
const { DEFAULT_MAX_PAYLOAD_SIZE } = require('./protocol');

const localEmit = EventEmitter.prototype.emit;

const DEFAULT_OPTIONS = Object.freeze({
    host: '127.0.0.1',
    port: null,
    path: null,
    reconnect: true,
    reconnectDelay: 1000,
    reconnectMaxDelay: 30000,
    reconnectJitter: 0.2,
    maxReconnectAttempts: Infinity,
    maxPendingMessages: 1000,
    maxPayloadSize: DEFAULT_MAX_PAYLOAD_SIZE,
    heartbeatInterval: DEFAULTS.heartbeatInterval,
    heartbeatTimeout: DEFAULTS.heartbeatTimeout,
    maxBufferedBytes: DEFAULTS.maxBufferedBytes,
    keepAlive: DEFAULTS.keepAlive,
    keepAliveInitialDelay: DEFAULTS.keepAliveInitialDelay,
    connectTimeout: 10000,
    handshake: true,
    query: null,
    auth: null,
    client: { name: 'agar.io-clone-tcp-socket' }
});

const CLIENT_INTERNAL_EVENTS = new Set([
    ...RESERVED_EVENTS,
    'connecting',
    'connect_error',
    'reconnect',
    'reconnecting',
    'reconnect_failed'
]);

/**
 * TCP client.
 *
 * Usage mirrors socket.io-client:
 *
 *   const client = new TcpClient({ host: '127.0.0.1', port: 3000, query: { type: 'player' } });
 *   client.on('welcome', (player, sizes) => { ... });
 *   client.emit('gotit', player);
 *   client.connect();
 *
 * Events are buffered while the client is connecting or reconnecting.
 */
class TcpClient extends EventEmitter {
    constructor(options = {}) {
        super();

        if (!options || (options.port === undefined && options.path === undefined)) {
            throw new TypeError('TcpClient requires a port or path option');
        }

        this.options = Object.assign({}, DEFAULT_OPTIONS, options);
        this.connected = false;
        this.id = null;
        this.socket = null;
        this.lastError = null;

        this._raw = null;
        this._state = 'idle';
        this._manualClose = false;
        this._reconnectAttempts = 0;
        this._reconnectTimer = null;
        this._pending = [];
        this._anyHandlers = new Set();

        this._onSocketEvent = this._onSocketEvent.bind(this);
    }

    connect() {
        this._manualClose = false;

        if (this._state === 'connecting' || this._state === 'connected') {
            return this;
        }

        this._clearReconnectTimer();
        this._state = 'connecting';
        this._emitLocal('connecting');

        const raw = this._createRawSocket();
        this._raw = raw;

        let settled = false;

        const cleanup = () => {
            raw.removeListener('connect', onConnect);
            raw.removeListener('error', onError);
            raw.removeListener('close', onClose);
            raw.removeListener('timeout', onTimeout);
        };

        const onConnect = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();

            if (this._manualClose || this._raw !== raw) {
                raw.destroy();
                return;
            }

            raw.setTimeout(0);
            this._attach(raw);
        };

        const onError = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            this._failConnection(raw, err);
        };

        const onClose = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            this._failConnection(raw, new Error('connection closed before it was established'));
        };

        const onTimeout = () => {
            raw.destroy(new Error('connection timed out'));
        };

        raw.once('connect', onConnect);
        raw.once('error', onError);
        raw.once('close', onClose);

        if (this.options.connectTimeout > 0) {
            raw.setTimeout(this.options.connectTimeout);
            raw.once('timeout', onTimeout);
        }

        return this;
    }

    _createRawSocket() {
        if (this.options.path) {
            return net.connect(this.options.path);
        }

        return net.connect({
            host: this.options.host,
            port: this.options.port,
            localAddress: this.options.localAddress,
            localPort: this.options.localPort,
            family: this.options.family
        });
    }

    _attach(raw) {
        const socket = new TcpSocket(raw, {
            maxPayloadSize: this.options.maxPayloadSize,
            heartbeatInterval: this.options.heartbeatInterval,
            heartbeatTimeout: this.options.heartbeatTimeout,
            maxBufferedBytes: this.options.maxBufferedBytes,
            keepAlive: this.options.keepAlive,
            keepAliveInitialDelay: this.options.keepAliveInitialDelay,
            sendHandshake: this.options.handshake !== false,
            handshake: {
                query: this.options.query || {},
                auth: this.options.auth || {},
                client: this.options.client
            }
        });

        this.socket = socket;
        this.id = socket.id;
        this.connected = true;
        this._state = 'connected';
        this._raw = raw;
        this._reconnectAttempts = 0;

        socket.onAny(this._onSocketEvent);
        socket.on('error', (err) => this._emitError(err));
        socket.once('disconnect', (reason) => this._handleSocketDisconnect(socket, reason));

        this._flushPending();
        this._emitLocal('connect');

        return socket;
    }

    _failConnection(raw, err) {
        if (this._raw !== raw) {
            return;
        }

        this._raw = null;
        this._state = 'disconnected';
        this.connected = false;

        if (!raw.destroyed) {
            raw.destroy();
        }

        this._emitError(err, 'connect_error');

        if (!this._manualClose) {
            this._scheduleReconnect();
        }
    }

    _handleSocketDisconnect(socket, reason) {
        if (this.socket !== socket) {
            return;
        }

        this.socket = null;
        this.id = null;
        this.connected = false;
        this._raw = null;
        this._state = 'disconnected';

        this._emitLocal('disconnect', reason);

        if (!this._manualClose) {
            this._scheduleReconnect();
        }
    }

    _onSocketEvent(event, ...args) {
        if (CLIENT_INTERNAL_EVENTS.has(event)) {
            return;
        }
        this._emitLocal(event, ...args);

        for (const handler of Array.from(this._anyHandlers)) {
            handler(event, ...args);
        }
    }

    /**
     * Listen to every application event received from the server. Named
     * listeners still receive their event; internal client events
     * (connect/disconnect/reconnect) are not delivered here.
     */
    onAny(handler) {
        if (typeof handler !== 'function') {
            throw new TypeError('handler must be a function');
        }

        this._anyHandlers.add(handler);
        return this;
    }

    offAny(handler) {
        this._anyHandlers.delete(handler);
        return this;
    }

    /**
     * Send an application event to the server. Messages are queued while the
     * client is connecting or waiting to reconnect.
     */
    emit(event, ...args) {
        if (typeof event !== 'string' || event.length === 0) {
            throw new TypeError('event must be a non-empty string');
        }
        if (CLIENT_INTERNAL_EVENTS.has(event)) {
            throw new TypeError('cannot emit reserved event "' + event + '"');
        }

        if (this.socket && this.socket.connected) {
            this.socket.emit(event, ...args);
            return this;
        }

        if (this._manualClose) {
            return this;
        }

        if (this._pending.length >= this.options.maxPendingMessages) {
            this._pending.shift();
        }

        this._pending.push([event, args]);
        return this;
    }

    _flushPending() {
        const pending = this._pending;
        this._pending = [];

        for (const [event, args] of pending) {
            try {
                this.socket.emit(event, ...args);
            } catch (err) {
                this._emitError(err);
            }
        }
    }

    _scheduleReconnect() {
        if (this._manualClose || !this.options.reconnect || this._reconnectTimer) {
            return;
        }

        if (this._reconnectAttempts >= this.options.maxReconnectAttempts) {
            this._emitLocal('reconnect_failed');
            return;
        }

        const attempt = this._reconnectAttempts;
        this._reconnectAttempts += 1;

        const exponential = Math.min(
            this.options.reconnectDelay * Math.pow(2, attempt),
            this.options.reconnectMaxDelay
        );
        const jitter = exponential * this.options.reconnectJitter * (Math.random() * 2 - 1);
        const delay = Math.max(0, Math.round(exponential + jitter));

        this._emitLocal('reconnecting', attempt + 1, delay);

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect();
        }, delay);
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    /**
     * Close the client and stop reconnecting.
     */
    disconnect(reason = 'client disconnect') {
        this._manualClose = true;
        this._clearReconnectTimer();
        this._pending = [];

        const wasActive = this._state === 'connecting' ||
            this._state === 'connected' ||
            this._state === 'disconnecting';

        if (this.socket) {
            this.connected = false;
            this._state = 'disconnecting';
            this.socket.disconnect(reason);
            return this;
        }

        if (this._raw) {
            const raw = this._raw;
            this._raw = null;
            this.connected = false;
            this._state = 'disconnected';

            if (!raw.destroyed) {
                raw.destroy();
            }

            if (wasActive) {
                this._emitLocal('disconnect', reason);
            }
            return this;
        }

        this.connected = false;
        this._state = 'disconnected';

        if (wasActive) {
            this._emitLocal('disconnect', reason);
        }
        return this;
    }

    /** Alias kept for Socket.IO client compatibility. */
    close(reason = 'client disconnect') {
        return this.disconnect(reason);
    }

    _emitLocal(event, ...args) {
        return localEmit.call(this, event, ...args);
    }

    _emitError(err, preferredEvent) {
        this.lastError = err;

        const event = preferredEvent && this.listenerCount(preferredEvent) > 0
            ? preferredEvent
            : 'error';

        if (this.listenerCount(event) > 0) {
            this._emitLocal(event, err);
        }
    }
}

function createClient(options) {
    return new TcpClient(options);
}

module.exports = {
    TcpClient,
    createClient,
    DEFAULT_OPTIONS,
    CLIENT_INTERNAL_EVENTS
};
