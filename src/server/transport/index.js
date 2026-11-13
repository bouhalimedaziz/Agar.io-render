'use strict';

const { TcpServer } = require('../../shared/tcp-socket');

/**
 * Normalize the handshake shape so TCP and other sockets look the same to the
 * game code.
 */
function normalizeHandshake(rawSocket) {
    const handshake = rawSocket.handshake || {};
    const connection = rawSocket.conn || null;

    return Object.assign({}, handshake, {
        address: handshake.address ||
            rawSocket.remoteAddress ||
            (connection && connection.remoteAddress) ||
            null,
        port: handshake.port ||
            rawSocket.remotePort ||
            (connection && connection.remotePort) ||
            null,
        query: handshake.query || {},
        auth: handshake.auth || {}
    });
}

/**
 * Common socket interface used by the game logic.
 *
 * It exposes the surface the game logic expects:
 *   socket.id
 *   socket.handshake
 *   socket.on/once/off
 *   socket.emit(event, ...args)
 *   socket.broadcast.emit(event, ...args)
 *   socket.disconnect()
 *
 * broadcast.emit() goes through the hub, so it reaches clients on every
 * attached transport, not just the transport that owns this socket.
 */
class TransportSocket {
    constructor(rawSocket, hub, transportName) {
        if (!rawSocket || rawSocket.id === undefined) {
            throw new TypeError('rawSocket with an id is required');
        }

        this.raw = rawSocket;
        this.hub = hub;
        this.transport = transportName;
        this.id = rawSocket.id;
        this.handshake = normalizeHandshake(rawSocket);

        this.broadcast = {
            emit: (event, ...args) => {
                this.hub.broadcastExcept(this, event, ...args);
                return this.broadcast;
            }
        };
    }

    get connected() {
        return this.raw.connected !== false;
    }

    get remoteAddress() {
        return this.handshake.address;
    }

    on(event, handler) {
        this.raw.on(event, handler);
        return this;
    }

    once(event, handler) {
        this.raw.once(event, handler);
        return this;
    }

    off(event, handler) {
        if (typeof this.raw.off === 'function') {
            this.raw.off(event, handler);
        } else {
            this.raw.removeListener(event, handler);
        }
        return this;
    }

    removeListener(event, handler) {
        this.raw.removeListener(event, handler);
        return this;
    }

    emit(event, ...args) {
        this.raw.emit(event, ...args);
        return this;
    }

    disconnect(reason) {
        this.raw.disconnect(reason);
        return this;
    }

    close(reason) {
        return this.disconnect(reason);
    }
}

/**
 * Hub that fans connections in from several transports and fans broadcasts
 * back out to all of them.
 *
 * Every transport exposes the two things needed here:
 *   transport.on('connection', rawSocket => ...)
 *   transport.close(callback)
 */
class TransportHub {
    constructor() {
        this.sockets = new Map();
        this.transports = [];
        this._connectionHandlers = [];
    }

    addTransport(name, transport) {
        if (!transport || typeof transport.on !== 'function') {
            throw new TypeError('transport must expose on(event, handler)');
        }

        this.transports.push({ name, transport });
        transport.on('connection', (rawSocket) => this._accept(name, rawSocket));
        return this;
    }

    /**
     * Register a connection handler. Only the "connection" event is supported;
     * application events are registered on the wrapped socket itself.
     */
    on(event, handler) {
        if (event !== 'connection') {
            throw new Error('TransportHub only supports the "connection" event');
        }
        if (typeof handler !== 'function') {
            throw new TypeError('handler must be a function');
        }

        this._connectionHandlers.push(handler);
        return this;
    }

    _accept(name, rawSocket) {
        const socket = new TransportSocket(rawSocket, this, name);
        this.sockets.set(socket.id, socket);

        rawSocket.once('disconnect', () => {
            if (this.sockets.get(socket.id) === socket) {
                this.sockets.delete(socket.id);
            }
        });

        for (const handler of this._connectionHandlers) {
            handler(socket);
        }
    }

    getSocket(id) {
        return this.sockets.get(id) || null;
    }

    emit(event, ...args) {
        const sockets = Array.from(this.sockets.values());
        for (const socket of sockets) {
            socket.emit(event, ...args);
        }
        return this;
    }

    broadcastExcept(sender, event, ...args) {
        const senderId = typeof sender === 'string' ? sender : sender && sender.id;
        const sockets = Array.from(this.sockets.values());

        for (const socket of sockets) {
            if (socket.id === senderId) {
                continue;
            }
            socket.emit(event, ...args);
        }

        return this;
    }

    close(callback) {
        const sockets = Array.from(this.sockets.values());
        for (const socket of sockets) {
            socket.disconnect('server closed');
        }

        const transports = this.transports.slice();
        if (transports.length === 0) {
            if (typeof callback === 'function') {
                process.nextTick(callback);
            }
            return this;
        }

        let remaining = transports.length;
        let finished = false;

        const done = () => {
            remaining -= 1;
            if (remaining === 0 && !finished) {
                finished = true;
                if (typeof callback === 'function') {
                    callback();
                }
            }
        };

        for (const { transport } of transports) {
            if (typeof transport.close === 'function') {
                try {
                    transport.close(done);
                } catch (err) {
                    done();
                }
            } else {
                done();
            }
        }

        return this;
    }
}

function createTransportHub() {
    return new TransportHub();
}

function createTcpServer(options) {
    return new TcpServer(options);
}

module.exports = {
    TransportHub,
    TransportSocket,
    createTransportHub,
    createTcpServer,
    normalizeHandshake
};
