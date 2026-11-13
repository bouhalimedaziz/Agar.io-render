'use strict';

/**
 * Wire protocol used by the TCP socket module.
 *
 * Every frame is length prefixed so it can be safely sent over a TCP stream,
 * which does not preserve message boundaries:
 *
 *   +-----------------------+----------+-------------------+
 *   | payload length (u32)  | opcode   | payload (N bytes) |
 *   +-----------------------+----------+-------------------+
 *
 * The payload length only covers the payload, not the 5 byte header.
 * Multi-byte integers are big endian.
 */

const OPCODES = Object.freeze({
    EVENT: 0x01,
    PING: 0x02,
    PONG: 0x03,
    HANDSHAKE: 0x04
});

const HEADER_SIZE = 5;
const DEFAULT_MAX_PAYLOAD_SIZE = 1024 * 1024; // 1 MiB, same default as Socket.IO.
const MAX_UINT32 = 0xffffffff;

class ProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProtocolError';
    }
}

function encodeFrame(opcode, payload) {
    if (!Number.isInteger(opcode) || opcode < 0 || opcode > 255) {
        throw new TypeError('opcode must be an integer between 0 and 255');
    }

    let body;
    if (Buffer.isBuffer(payload)) {
        body = payload;
    } else if (payload === undefined || payload === null) {
        body = Buffer.alloc(0);
    } else {
        body = Buffer.from(String(payload), 'utf8');
    }

    if (body.length > MAX_UINT32) {
        throw new RangeError('payload is too large to be framed');
    }

    const frame = Buffer.allocUnsafe(HEADER_SIZE + body.length);
    frame.writeUInt32BE(body.length, 0);
    frame.writeUInt8(opcode, HEADER_SIZE - 1);
    body.copy(frame, HEADER_SIZE);
    return frame;
}

function encodeJsonFrame(opcode, value) {
    return encodeFrame(opcode, Buffer.from(JSON.stringify(value), 'utf8'));
}

function encodeEvent(event, args) {
    if (typeof event !== 'string' || event.length === 0) {
        throw new TypeError('event must be a non-empty string');
    }

    const eventArgs = args === undefined ? [] : args;
    if (!Array.isArray(eventArgs)) {
        throw new TypeError('event arguments must be an array');
    }

    return encodeJsonFrame(OPCODES.EVENT, {
        event,
        args: eventArgs
    });
}

function decodeJsonPayload(payload) {
    let value;
    try {
        value = JSON.parse(payload.toString('utf8'));
    } catch (err) {
        throw new ProtocolError('invalid JSON payload: ' + err.message);
    }
    return value;
}

function decodeEventPayload(payload) {
    const value = decodeJsonPayload(payload);

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ProtocolError('event payload must be a JSON object');
    }
    if (typeof value.event !== 'string' || value.event.length === 0) {
        throw new ProtocolError('event payload is missing a valid event name');
    }
    if (value.args !== undefined && !Array.isArray(value.args)) {
        throw new ProtocolError('event payload args must be an array');
    }

    return {
        event: value.event,
        args: value.args === undefined ? [] : value.args
    };
}

/**
 * Incremental frame decoder.
 *
 * TCP can split a frame over multiple chunks, or put many frames in one chunk.
 * Call push() with every chunk read from the socket; it returns all complete
 * frames currently available.
 */
class FrameDecoder {
    constructor(options = {}) {
        this.maxPayloadSize = options.maxPayloadSize === undefined
            ? DEFAULT_MAX_PAYLOAD_SIZE
            : options.maxPayloadSize;

        if (!Number.isInteger(this.maxPayloadSize) || this.maxPayloadSize < 0) {
            throw new TypeError('maxPayloadSize must be a non-negative integer');
        }

        this.buffer = Buffer.alloc(0);
    }

    get bufferedBytes() {
        return this.buffer.length;
    }

    push(chunk) {
        if (!Buffer.isBuffer(chunk)) {
            throw new TypeError('chunk must be a Buffer');
        }

        if (chunk.length === 0) {
            return [];
        }

        this.buffer = this.buffer.length === 0
            ? chunk
            : Buffer.concat([this.buffer, chunk]);

        const frames = [];

        while (this.buffer.length >= HEADER_SIZE) {
            const payloadLength = this.buffer.readUInt32BE(0);

            if (payloadLength > this.maxPayloadSize) {
                throw new ProtocolError(
                    'frame payload of ' + payloadLength + ' bytes exceeds the ' +
                    this.maxPayloadSize + ' byte limit'
                );
            }

            const frameLength = HEADER_SIZE + payloadLength;
            if (this.buffer.length < frameLength) {
                break;
            }

            frames.push({
                opcode: this.buffer.readUInt8(HEADER_SIZE - 1),
                payload: this.buffer.subarray(HEADER_SIZE, frameLength)
            });

            this.buffer = this.buffer.subarray(frameLength);
        }

        return frames;
    }

    reset() {
        this.buffer = Buffer.alloc(0);
    }
}

module.exports = {
    OPCODES,
    HEADER_SIZE,
    DEFAULT_MAX_PAYLOAD_SIZE,
    ProtocolError,
    encodeFrame,
    encodeJsonFrame,
    encodeEvent,
    decodeJsonPayload,
    decodeEventPayload,
    FrameDecoder
};
