'use strict';

const { TcpServer, createServer } = require('./tcp-server');
const { TcpClient, createClient } = require('./tcp-client');
const { TcpSocket, RESERVED_EVENTS, generateId } = require('./tcp-socket');
const {
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
} = require('./protocol');

module.exports = {
    // High level API, close to Socket.IO.
    TcpServer,
    TcpClient,
    TcpSocket,
    createServer,
    createClient,

    // Lower level building blocks.
    OPCODES,
    HEADER_SIZE,
    DEFAULT_MAX_PAYLOAD_SIZE,
    ProtocolError,
    FrameDecoder,
    encodeFrame,
    encodeJsonFrame,
    encodeEvent,
    decodeJsonPayload,
    decodeEventPayload,

    // Utilities.
    RESERVED_EVENTS,
    generateId
};
