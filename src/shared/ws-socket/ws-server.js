'use strict';

/**
 * WebSocket transport for the game server, written by hand on top of Node's
 * HTTP server (RFC 6455): no WebSocket library.
 *
 * Why it exists: public hosts such as Render only accept HTTP(S) on one port.
 * A WebSocket starts as an HTTP request ("Upgrade: websocket") on that port and
 * then becomes a framed, two-way TCP connection, so the same game can be played
 * from any network, in a browser or in the Electron client.
 *
 * Messages use the same JSON event format as the raw TCP transport
 * ({ event, args }), one WebSocket text frame per event, so the game code does
 * not know which transport a player uses.
 *
 * Socket surface (what TransportHub / server.js need, same as TcpSocket):
 *   socket.id, socket.handshake, socket.connected
 *   socket.on/once/off/removeListener(event, handler)  inbound events + 'disconnect'
 *   socket.emit(event, ...args)                         send to this client
 *   socket.disconnect(reason)
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { RESERVED_EVENTS, decodeEventPayload, generateId } = require('../tcp-socket');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = Object.freeze({ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });

// Application heartbeat events. Kept out of the game's event space; handled here.
// (WebSocket ping frames can be absorbed by proxies, and browsers cannot send
// them, so an application-level heartbeat works everywhere.)
const HEARTBEAT_EVENT = '__hb';
const HEARTBEAT_ACK_EVENT = '__hb_ack';

const DEFAULTS = Object.freeze({
    path: '/game',
    heartbeatInterval: 1000,
    heartbeatTimeout: 5000,
    maxPayloadSize: 1024 * 1024,
    maxBufferedBytes: 4 * 1024 * 1024
});

function encodeFrame(opcode, payload) {
    const body = payload || Buffer.alloc(0);
    let header;
    if (body.length < 126) {
        header = Buffer.from([0x80 | opcode, body.length]);
    } else if (body.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(body.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    return Buffer.concat([header, body]);
}

function parseQuery(url) {
    const query = {};
    const index = url.indexOf('?');
    if (index !== -1) {
        new URLSearchParams(url.slice(index + 1)).forEach((value, key) => {
            query[key] = value;
        });
    }
    return query;
}

class WsSocket {
    constructor(raw, req, server) {
        this.raw = raw;
        this.server = server;
        this.id = generateId();
        this.connected = true;
        this._events = new EventEmitter();
        this._buffer = Buffer.alloc(0);
        this._fragments = null;
        this._fragmentOpcode = 0;
        this._closed = false;
        this._lastReceived = Date.now();
        this.stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 };

        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const query = parseQuery(req.url || '');
        this.handshake = {
            query,
            auth: query.token ? { token: query.token } : {},
            // Behind a hosting proxy the TCP peer is the proxy; the real client is in X-Forwarded-For.
            address: forwarded || raw.remoteAddress,
            port: raw.remotePort,
            transport: 'websocket'
        };

        raw.setNoDelay(true);
        raw.on('data', (chunk) => this._onData(chunk));
        raw.on('error', () => this._finish('transport error'));
        raw.on('close', () => this._finish('transport close'));

        const opts = server.options;
        this._heartbeat = setInterval(() => {
            if (Date.now() - this._lastReceived > opts.heartbeatTimeout) {
                this._abort('heartbeat timeout');
                return;
            }
            this.emit(HEARTBEAT_EVENT, Date.now());
        }, opts.heartbeatInterval);
        if (typeof this._heartbeat.unref === 'function') {
            this._heartbeat.unref();
        }
    }

    // ---- events in (listeners) -------------------------------------------

    on(event, handler) { this._events.on(event, handler); return this; }
    once(event, handler) { this._events.once(event, handler); return this; }
    off(event, handler) { this._events.removeListener(event, handler); return this; }
    removeListener(event, handler) { return this.off(event, handler); }

    // ---- events out ------------------------------------------------------

    emit(event, ...args) {
        if (!this.connected || this._closed) {
            return this;
        }
        this._send(OP.TEXT, Buffer.from(JSON.stringify({ event, args }), 'utf8'));
        return this;
    }

    _send(opcode, payload) {
        const frame = encodeFrame(opcode, payload);
        this.stats.framesOut += 1;
        this.stats.bytesOut += frame.length;
        this.raw.write(frame);
        if (this.raw.writableLength > this.server.options.maxBufferedBytes) {
            this._abort('backpressure');
        }
    }

    // ---- frames in -------------------------------------------------------

    _onData(chunk) {
        if (this._closed) {
            return;
        }
        this._lastReceived = Date.now();
        this.stats.bytesIn += chunk.length;
        this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;

        for (;;) {
            const buf = this._buffer;
            if (buf.length < 2) {
                return;
            }
            const fin = (buf[0] & 0x80) !== 0;
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let length = buf[1] & 0x7f;
            let offset = 2;

            if (length === 126) {
                if (buf.length < 4) { return; }
                length = buf.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buf.length < 10) { return; }
                const big = buf.readBigUInt64BE(2);
                if (big > BigInt(this.server.options.maxPayloadSize)) {
                    this._close(1009, 'message too big');
                    return;
                }
                length = Number(big);
                offset = 10;
            }
            if (length > this.server.options.maxPayloadSize) {
                this._close(1009, 'message too big');
                return;
            }
            // RFC 6455 5.1: every frame from a client MUST be masked.
            if (!masked) {
                this._close(1002, 'unmasked client frame');
                return;
            }
            if (buf.length < offset + 4 + length) {
                return; // wait for the rest of the frame (TCP may split it anywhere)
            }

            const mask = buf.subarray(offset, offset + 4);
            const payload = Buffer.allocUnsafe(length);
            for (let i = 0; i < length; i += 1) {
                payload[i] = buf[offset + 4 + i] ^ mask[i & 3];
            }
            this._buffer = buf.subarray(offset + 4 + length);
            this.stats.framesIn += 1;
            this._onFrame(fin, opcode, payload);
            if (this._closed) {
                return;
            }
        }
    }

    _onFrame(fin, opcode, payload) {
        if (opcode === OP.PING) {
            this._send(OP.PONG, payload);
            return;
        }
        if (opcode === OP.PONG) {
            return;
        }
        if (opcode === OP.CLOSE) {
            const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
            // 1000 = the player closed the page / logged out: a deliberate quit
            this._close(1000, '', code === 1000 || code === 1001 ? 'client disconnect' : 'transport close');
            return;
        }
        if (opcode === OP.CONT) {
            if (!this._fragments) {
                this._close(1002, 'unexpected continuation');
                return;
            }
            this._fragments.push(payload);
            if (fin) {
                const whole = Buffer.concat(this._fragments);
                this._fragments = null;
                this._onMessage(this._fragmentOpcode, whole);
            }
            return;
        }
        if (!fin) {
            this._fragments = [payload];
            this._fragmentOpcode = opcode;
            return;
        }
        this._onMessage(opcode, payload);
    }

    _onMessage(opcode, payload) {
        if (opcode !== OP.TEXT && opcode !== OP.BINARY) {
            this._close(1003, 'unsupported data');
            return;
        }
        let message;
        try {
            message = decodeEventPayload(payload);
        } catch (err) {
            this._close(1007, 'invalid event payload');
            return;
        }
        if (message.event === HEARTBEAT_ACK_EVENT) {
            return; // liveness already recorded in _onData
        }
        if (RESERVED_EVENTS.has(message.event) || message.event === HEARTBEAT_EVENT) {
            this._close(1008, 'reserved event name');
            return;
        }
        try {
            this._events.emit(message.event, ...message.args);
        } catch (err) {
            console.error('[WS] handler for "' + message.event + '" failed:', err);
        }
    }

    // ---- closing ---------------------------------------------------------

    disconnect(reason = 'server disconnect') {
        this._close(1000, '', reason);
        return this;
    }

    close(reason) {
        return this.disconnect(reason);
    }

    _close(code, text, reason) {
        if (this._closed) {
            return;
        }
        const body = Buffer.alloc(2 + Buffer.byteLength(text || ''));
        body.writeUInt16BE(code, 0);
        if (text) {
            body.write(text, 2);
        }
        try {
            this.raw.write(encodeFrame(OP.CLOSE, body));
            this.raw.end();
        } catch (err) {
            // socket already gone
        }
        this._finish(reason || ('protocol error: ' + text));
    }

    _abort(reason) {
        this.raw.destroy();
        this._finish(reason);
    }

    _finish(reason) {
        if (this._closed) {
            return;
        }
        this._closed = true;
        this.connected = false;
        clearInterval(this._heartbeat);
        this.server._remove(this);
        this._events.emit('disconnect', reason);
    }
}

/**
 * Listens for "Upgrade: websocket" requests on an existing HTTP server.
 * Emits 'connection' with a WsSocket, like TcpServer, so it plugs into TransportHub.
 */
class WsServer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = Object.assign({}, DEFAULTS, options);
        this.sockets = new Set();
        this._httpServer = null;
        this._onUpgrade = this._onUpgrade.bind(this);
    }

    attach(httpServer) {
        this._httpServer = httpServer;
        httpServer.on('upgrade', this._onUpgrade);
        return this;
    }

    _onUpgrade(req, raw, head) {
        const path = (req.url || '').split('?')[0];
        const key = req.headers['sec-websocket-key'];
        const isWs = String(req.headers.upgrade || '').toLowerCase() === 'websocket';
        if (path !== this.options.path || !isWs || !key || req.headers['sec-websocket-version'] !== '13') {
            raw.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            return;
        }

        // Opening handshake (RFC 6455 4.2.2): prove we read the key, switch protocols.
        const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        raw.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
        );

        const socket = new WsSocket(raw, req, this);
        this.sockets.add(socket);
        if (head && head.length) {
            socket._onData(head);
        }
        this.emit('connection', socket);
    }

    _remove(socket) {
        this.sockets.delete(socket);
    }

    close(callback) {
        if (this._httpServer) {
            this._httpServer.removeListener('upgrade', this._onUpgrade);
        }
        for (const socket of Array.from(this.sockets)) {
            socket.disconnect('server closed');
        }
        if (typeof callback === 'function') {
            process.nextTick(callback);
        }
    }
}

module.exports = {
    WsServer,
    WsSocket,
    encodeFrame,
    HEARTBEAT_EVENT,
    HEARTBEAT_ACK_EVENT
};
