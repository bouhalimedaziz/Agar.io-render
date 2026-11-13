'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const { TcpSocket, RESERVED_EVENTS, DEFAULTS } = require('./tcp-socket');
const { DEFAULT_MAX_PAYLOAD_SIZE } = require('./protocol');

const localEmit = EventEmitter.prototype.emit;

const DEFAULT_OPTIONS = Object.freeze({
    maxPayloadSize: DEFAULT_MAX_PAYLOAD_SIZE,
    heartbeatInterval: DEFAULTS.heartbeatInterval,
    heartbeatTimeout: DEFAULTS.heartbeatTimeout,
    maxBufferedBytes: DEFAULTS.maxBufferedBytes,
    keepAlive: DEFAULTS.keepAlive,
    keepAliveInitialDelay: DEFAULTS.keepAliveInitialDelay,
    requireHandshake: false,
    handshakeTimeout: 5000
});

/**
 * TCP server.
 *
 * Usage mirrors Socket.IO:
 *
 *   const server = new TcpServer({ requireHandshake: true });
 *   server.on('connection', socket => {
 *       console.log(socket.handshake.query.type);
 *       socket.on('hello', () => socket.emit('world'));
 *   });
 *   server.listen(3000, '0.0.0.0');
 *
 * server.emit(event, ...args) broadcasts to every connected socket.
 */
class TcpServer extends EventEmitter {
    constructor(options = {}) {
        super();

        this.options = Object.assign({}, DEFAULT_OPTIONS, options);
        if (!this.options.requireHandshake) {
            this.options.handshakeTimeout = 0;
        }

        this.lastError = null;
        this.sockets = new Map();
        this.listening = false;
        this._netServer = null;

        this.broadcast = {
            emit: (event, ...args) => {
                this._broadcast(event, args);
                return this.broadcast;
            }
        };
    }

    /**
     * Start listening. Arguments are passed straight to net.Server.listen(),
     * so all of these work:
     *
     *   server.listen(3000, '127.0.0.1', callback)
     *   server.listen(3000, callback)
     *   server.listen('/tmp/agar.sock', callback)
     */
    listen(...args) {
        if (this._netServer) {
            throw new Error('server is already listening');
        }

        const netServer = net.createServer((rawSocket) => this._handleConnection(rawSocket));
        this._netServer = netServer;

        netServer.on('error', (err) => this._emitError(err));
        netServer.on('listening', () => {
            this.listening = true;
            this._emitLocal('listening');
        });
        netServer.on('close', () => {
            this.listening = false;
            if (this._netServer === netServer) {
                this._netServer = null;
            }
            this._emitLocal('close');
        });

        netServer.listen(...args);
        return this;
    }

    address() {
        return this._netServer ? this._netServer.address() : null;
    }

    /**
     * Accept an already connected socket. Useful if the caller wants to own
     * the listener (for example, an Electron main process sharing a server).
     */
    accept(rawSocket) {
        return this._handleConnection(rawSocket);
    }

    _handleConnection(rawSocket) {
        const socket = new TcpSocket(rawSocket, {
            server: this,
            maxPayloadSize: this.options.maxPayloadSize,
            heartbeatInterval: this.options.heartbeatInterval,
            heartbeatTimeout: this.options.heartbeatTimeout,
            maxBufferedBytes: this.options.maxBufferedBytes,
            keepAlive: this.options.keepAlive,
            keepAliveInitialDelay: this.options.keepAliveInitialDelay
        });

        this.sockets.set(socket.id, socket);

        if (!this.options.requireHandshake) {
            this._emitLocal('connection', socket);
            return socket;
        }

        const handshakeTimer = this.options.handshakeTimeout > 0
            ? setTimeout(() => {
                socket._destroy('handshake timeout');
            }, this.options.handshakeTimeout)
            : null;

        if (handshakeTimer && typeof handshakeTimer.unref === 'function') {
            handshakeTimer.unref();
        }

        socket.once('handshake', () => {
            if (handshakeTimer) {
                clearTimeout(handshakeTimer);
            }
            this._emitLocal('connection', socket);
        });

        socket.once('disconnect', () => {
            if (handshakeTimer) {
                clearTimeout(handshakeTimer);
            }
        });

        return socket;
    }

    _removeSocket(socket) {
        if (this.sockets.get(socket.id) === socket) {
            this.sockets.delete(socket.id);
        }
    }

    getSocket(id) {
        return this.sockets.get(id) || null;
    }

    /**
     * Broadcast an application event to every connected socket.
     * Returns this server.
     */
    emit(event, ...args) {
        this._broadcast(event, args);
        return this;
    }

    _broadcast(event, args, exceptId) {
        if (typeof event !== 'string' || event.length === 0) {
            throw new TypeError('event must be a non-empty string');
        }
        if (RESERVED_EVENTS.has(event)) {
            throw new TypeError('cannot emit reserved event "' + event + '"');
        }

        // Snapshot first: event handlers are allowed to disconnect sockets,
        // which mutates the map while we are iterating it.
        const sockets = Array.from(this.sockets.values());

        for (const socket of sockets) {
            if (exceptId !== undefined && socket.id === exceptId) {
                continue;
            }
            socket.emit(event, ...args);
        }
    }

    close(callback) {
        const netServer = this._netServer;
        this._netServer = null;

        const sockets = Array.from(this.sockets.values());
        for (const socket of sockets) {
            socket.disconnect('server closed');
        }

        if (!netServer) {
            if (typeof callback === 'function') {
                process.nextTick(callback);
            }
            return this;
        }

        netServer.close(callback);
        return this;
    }

    _emitLocal(event, ...args) {
        return localEmit.call(this, event, ...args);
    }

    _emitError(err) {
        this.lastError = err;
        if (this.listenerCount('error') > 0) {
            this._emitLocal('error', err);
        }
    }
}

function createServer(options) {
    return new TcpServer(options);
}

module.exports = {
    TcpServer,
    createServer,
    DEFAULT_OPTIONS
};
