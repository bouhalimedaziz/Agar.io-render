'use strict';

const { EventEmitter } = require('events');
const { randomBytes, randomUUID } = require('crypto');

const {
    OPCODES,
    DEFAULT_MAX_PAYLOAD_SIZE,
    ProtocolError,
    encodeFrame,
    encodeEvent,
    decodeJsonPayload,
    decodeEventPayload,
    FrameDecoder
} = require('./protocol');

const localEmit = EventEmitter.prototype.emit;

/**
 * Events that belong to the module itself. A remote peer may not send these as
 * application events, otherwise it could pretend a socket connected or
 * disconnected.
 */
const RESERVED_EVENTS = new Set([
    'connect',
    'connection',
    'disconnect',
    'disconnecting',
    'error',
    'close',
    'drain',
    'handshake',
    'ping',
    'pong',
    'protocolError',
    'newListener',
    'removeListener'
]);

const DEFAULTS = Object.freeze({
    heartbeatInterval: 1000,
    heartbeatTimeout: 3000,
    maxBufferedBytes: 4 * 1024 * 1024,
    keepAlive: true,
    keepAliveInitialDelay: 10000
});

function generateId() {
    if (typeof randomUUID === 'function') {
        return randomUUID();
    }
    return randomBytes(16).toString('hex');
}

/**
 * A single connection.
 *
 * The public surface intentionally mirrors the parts of Socket.IO used by the
 * game:
 *
 *   socket.id
 *   socket.on(event, handler)
 *   socket.emit(event, ...args)
 *   socket.broadcast.emit(event, ...args)
 *   socket.disconnect()
 *   socket.connected
 *
 * emit() writes an application event to the peer. Local events (connect,
 * disconnect, error, handshake, ...) are delivered through the regular
 * EventEmitter on() API.
 */
class TcpSocket extends EventEmitter {
    constructor(rawSocket, options = {}) {
        super();

        if (!rawSocket) {
            throw new TypeError('rawSocket is required');
        }

        this.raw = rawSocket;
        this.server = options.server || null;
        this.id = options.id || generateId();
        this.remoteAddress = rawSocket.remoteAddress || null;
        this.remotePort = rawSocket.remotePort || null;
        this.connected = true;

        const providedHandshake = options.handshake || {};
        this.handshake = Object.assign({}, providedHandshake, {
            address: this.remoteAddress,
            port: this.remotePort,
            secure: Boolean(rawSocket.encrypted),
            query: providedHandshake.query || {},
            auth: providedHandshake.auth || {}
        });

        this._maxPayloadSize = options.maxPayloadSize === undefined
            ? DEFAULT_MAX_PAYLOAD_SIZE
            : options.maxPayloadSize;
        this._maxBufferedBytes = options.maxBufferedBytes === undefined
            ? DEFAULTS.maxBufferedBytes
            : options.maxBufferedBytes;
        this._heartbeatInterval = options.heartbeatInterval === undefined
            ? DEFAULTS.heartbeatInterval
            : options.heartbeatInterval;
        this._heartbeatTimeout = options.heartbeatTimeout === undefined
            ? DEFAULTS.heartbeatTimeout
            : options.heartbeatTimeout;
        this._keepAlive = options.keepAlive === undefined ? DEFAULTS.keepAlive : options.keepAlive;
        this._keepAliveInitialDelay = options.keepAliveInitialDelay === undefined
            ? DEFAULTS.keepAliveInitialDelay
            : options.keepAliveInitialDelay;

        this._decoder = new FrameDecoder({ maxPayloadSize: this._maxPayloadSize });
        this._outbox = [];
        this._outboxBytes = 0;
        this._needsDrain = false;

        this._anyListeners = new Set();
        this._heartbeatTimer = null;
        this._pongTimer = null;
        this._awaitingPong = false;
        this._closeTimer = null;

        this._handshakeToSend = options.sendHandshake ? providedHandshake : null;
        this._closing = false;
        this._destroyed = false;
        this._disconnectReason = null;
        this.lastError = null;

        // Socket.IO exposes this on every socket. The returned object lets code
        // write socket.broadcast.emit(...) without knowing about the server.
        this.broadcast = {
            emit: (event, ...args) => {
                if (this.server && !this._destroyed) {
                    this.server._broadcast(event, args, this.id);
                }
                return this.broadcast;
            }
        };

        this._bindTransport();

        if (this._handshakeToSend) {
            this._sendHandshake();
        }

        this._startHeartbeat();
    }

    _bindTransport() {
        const raw = this.raw;

        raw.on('data', (chunk) => this._onData(chunk));
        raw.on('drain', () => this._onDrain());
        raw.on('error', (err) => this._onTransportError(err));
        raw.on('end', () => this._destroy(this._disconnectReason || 'transport end'));
        raw.on('close', () => this._destroy(this._disconnectReason || 'transport close'));

        if (typeof raw.setNoDelay === 'function') {
            raw.setNoDelay(true);
        }
        if (this._keepAlive && typeof raw.setKeepAlive === 'function') {
            raw.setKeepAlive(true, this._keepAliveInitialDelay);
        }
    }

    /**
     * Register a listener that receives every inbound application event as
     * (eventName, ...args). Used by TcpClient to proxy events without knowing
     * their names in advance.
     */
    onAny(listener) {
        if (typeof listener !== 'function') {
            throw new TypeError('listener must be a function');
        }
        this._anyListeners.add(listener);
        return this;
    }

    offAny(listener) {
        this._anyListeners.delete(listener);
        return this;
    }

    /**
     * Send an application event to the peer.
     *
     * Returns this socket, matching Socket.IO's chainable emit().
     */
    emit(event, ...args) {
        if (typeof event !== 'string' || event.length === 0) {
            throw new TypeError('event must be a non-empty string');
        }
        if (RESERVED_EVENTS.has(event)) {
            throw new TypeError('cannot emit reserved event "' + event + '"');
        }

        if (this.connected && !this._destroyed) {
            this._enqueueFrame(encodeEvent(event, args));
        }

        return this;
    }

    /** Send a raw frame. Exposed for protocol extensions. */
    sendFrame(opcode, payload) {
        if (!this.connected || this._destroyed) {
            return false;
        }
        return this._sendFrame(opcode, payload);
    }

    /**
     * Close the connection. The disconnect event is emitted once the
     * underlying socket has closed (or after a short fallback timeout).
     */
    disconnect(reason = 'server disconnect') {
        if (this._destroyed || this._closing) {
            return this;
        }

        this._closing = true;
        this._disconnectReason = reason;
        this.connected = false;
        this._stopHeartbeat();

        if (this.server) {
            this.server._removeSocket(this);
        }

        try {
            this.raw.end();
        } catch (err) {
            // The transport is already gone; _destroy will run from the close
            // handler (or the fallback timer below).
        }

        this._closeTimer = setTimeout(() => this._destroy(reason), 1000);
        if (typeof this._closeTimer.unref === 'function') {
            this._closeTimer.unref();
        }

        return this;
    }

    /** Alias kept for Socket.IO client compatibility. */
    close(reason = 'client disconnect') {
        return this.disconnect(reason);
    }

    _emitLocal(event, ...args) {
        for (const listener of this._anyListeners) {
            listener(event, ...args);
        }
        return localEmit.call(this, event, ...args);
    }

    _emitError(err) {
        this.lastError = err;
        if (this.listenerCount('error') > 0) {
            this._emitLocal('error', err);
        }
    }

    _onTransportError(err) {
        this._emitError(err);
        this._destroy('transport error');
    }

    _onData(chunk) {
        if (this._destroyed) {
            return;
        }

        let frames;
        try {
            frames = this._decoder.push(chunk);
        } catch (err) {
            this._failProtocol(err);
            return;
        }

        for (const frame of frames) {
            if (this._destroyed) {
                break;
            }

            try {
                this._handleFrame(frame);
            } catch (err) {
                this._failProtocol(err);
                break;
            }
        }
    }

    _handleFrame(frame) {
        // Any valid traffic proves the peer is alive, even if a PING reply was
        // lost. This avoids dropping healthy connections on a busy network.
        this._markAlive();

        switch (frame.opcode) {
            case OPCODES.EVENT: {
                const message = decodeEventPayload(frame.payload);
                if (RESERVED_EVENTS.has(message.event)) {
                    throw new ProtocolError('event name "' + message.event + '" is reserved');
                }
                this._emitLocal(message.event, ...message.args);
                break;
            }

            case OPCODES.PING:
                this._sendFrame(OPCODES.PONG, frame.payload);
                this._emitLocal('ping');
                break;

            case OPCODES.PONG:
                this._emitLocal('pong');
                break;

            case OPCODES.HANDSHAKE: {
                const data = decodeJsonPayload(frame.payload);
                if (!data || typeof data !== 'object' || Array.isArray(data)) {
                    throw new ProtocolError('handshake payload must be a JSON object');
                }

                const previous = this.handshake;
                this.handshake = Object.assign({}, previous, data, {
                    // Connection metadata always comes from the transport, not
                    // from data supplied by the peer.
                    address: previous.address,
                    port: previous.port,
                    secure: previous.secure,
                    query: data.query || previous.query || {},
                    auth: data.auth || previous.auth || {}
                });

                this._emitLocal('handshake', this.handshake);
                break;
            }

            default:
                throw new ProtocolError('unknown opcode ' + frame.opcode);
        }
    }

    _failProtocol(err) {
        this._emitLocal('protocolError', err);
        this._emitError(err);
        this._destroy('protocol error');
    }

    _sendHandshake() {
        const handshake = this._handshakeToSend || {};
        const payload = Object.assign({}, handshake, {
            query: handshake.query || {},
            auth: handshake.auth || {}
        });

        delete payload.address;
        delete payload.port;
        delete payload.secure;

        let body;
        try {
            body = Buffer.from(JSON.stringify(payload), 'utf8');
        } catch (err) {
            this._emitError(err);
            return false;
        }

        return this._sendFrame(OPCODES.HANDSHAKE, body);
    }

    _sendFrame(opcode, payload) {
        return this._enqueueFrame(encodeFrame(opcode, payload));
    }

    _enqueueFrame(frame) {
        if (!this.connected || this._destroyed) {
            return false;
        }

        if (this._needsDrain || this._outbox.length > 0) {
            return this._queueFrame(frame);
        }

        let writable;
        try {
            writable = this.raw.write(frame);
        } catch (err) {
            this._emitError(err);
            this._destroy('write error');
            return false;
        }

        if (!writable) {
            this._needsDrain = true;
        }

        return writable;
    }

    _queueFrame(frame) {
        if (this._outboxBytes + frame.length > this._maxBufferedBytes) {
            const err = new Error('outgoing buffer limit exceeded');
            this._emitError(err);
            this._destroy('write buffer overflow');
            return false;
        }

        this._outbox.push(frame);
        this._outboxBytes += frame.length;
        return false;
    }

    _onDrain() {
        this._needsDrain = false;

        while (this._outbox.length > 0 && !this._needsDrain && this.connected && !this._destroyed) {
            const frame = this._outbox.shift();
            this._outboxBytes -= frame.length;

            let writable;
            try {
                writable = this.raw.write(frame);
            } catch (err) {
                this._emitError(err);
                this._destroy('write error');
                return;
            }

            if (!writable) {
                this._needsDrain = true;
            }
        }

        if (!this._needsDrain && this._outbox.length === 0) {
            this._emitLocal('drain');
        }
    }

    _startHeartbeat() {
        if (!(this._heartbeatInterval > 0)) {
            return;
        }

        this._heartbeatTimer = setInterval(() => this._sendHeartbeat(), this._heartbeatInterval);
        if (typeof this._heartbeatTimer.unref === 'function') {
            this._heartbeatTimer.unref();
        }
    }

    _stopHeartbeat() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }

        this._awaitingPong = false;

        if (this._pongTimer) {
            clearTimeout(this._pongTimer);
            this._pongTimer = null;
        }
    }

    _sendHeartbeat() {
        if (!this.connected || this._destroyed) {
            return;
        }

        if (this._awaitingPong) {
            // Still waiting for the previous PONG: the pong timer decides when to give up.
            return;
        }

        this._awaitingPong = true;
        this._sendFrame(OPCODES.PING, Buffer.alloc(0));

        if (this._destroyed) {
            return;
        }

        if (this._heartbeatTimeout > 0) {
            this._pongTimer = setTimeout(() => {
                this._destroy('heartbeat timeout');
            }, this._heartbeatTimeout);

            if (typeof this._pongTimer.unref === 'function') {
                this._pongTimer.unref();
            }
        }
    }

    _markAlive() {
        if (!this._awaitingPong && !this._pongTimer) {
            return;
        }

        this._awaitingPong = false;

        if (this._pongTimer) {
            clearTimeout(this._pongTimer);
            this._pongTimer = null;
        }
    }

    _destroy(reason) {
        if (this._destroyed) {
            return;
        }

        this._destroyed = true;
        this._closing = false;
        this.connected = false;
        this._stopHeartbeat();

        if (this._closeTimer) {
            clearTimeout(this._closeTimer);
            this._closeTimer = null;
        }

        if (this.server) {
            this.server._removeSocket(this);
        }

        this._outbox = [];
        this._outboxBytes = 0;
        this._anyListeners.clear();

        try {
            this.raw.destroy();
        } catch (err) {
            // Nothing else we can do with an already dead transport.
        }

        this._emitLocal('disconnect', reason || this._disconnectReason || 'disconnected');
    }
}

module.exports = {
    TcpSocket,
    RESERVED_EVENTS,
    DEFAULTS,
    generateId
};
