'use strict';

const DEFAULT_VIEW_WIDTH = 800;
const DEFAULT_VIEW_HEIGHT = 600;
const MIN_VIEW_DIMENSION = 100;
const DEFAULT_MAX_VIEW_DIMENSION = 10000;

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * Clamp a client-provided viewport dimension to a sane range.
 *
 * Screen size controls how much of the map a player can see, so it has to be
 * bounded by the server instead of trusted from the client.
 */
function normalizeScreenDimension(value, fallback, maxDimension) {
    const numeric = finiteNumber(value);
    if (numeric === null) {
        return fallback;
    }

    return clamp(numeric, MIN_VIEW_DIMENSION, maxDimension);
}

function normalizeScreenSize(width, height, options = {}) {
    const fallbackWidth = options.fallbackWidth || DEFAULT_VIEW_WIDTH;
    const fallbackHeight = options.fallbackHeight || DEFAULT_VIEW_HEIGHT;
    const maxWidth = options.maxWidth || DEFAULT_MAX_VIEW_DIMENSION;
    const maxHeight = options.maxHeight || DEFAULT_MAX_VIEW_DIMENSION;

    return {
        width: normalizeScreenDimension(width, fallbackWidth, maxWidth),
        height: normalizeScreenDimension(height, fallbackHeight, maxHeight)
    };
}

/**
 * Validate a movement target. Returns null for anything that is not a pair of
 * finite numbers, and otherwise clamps the offsets to a bounded range.
 */
function normalizeTarget(target, options = {}) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
        return null;
    }

    const x = finiteNumber(target.x);
    const y = finiteNumber(target.y);
    if (x === null || y === null) {
        return null;
    }

    const maxOffset = options.maxOffset || DEFAULT_MAX_VIEW_DIMENSION;

    return {
        x: clamp(x, -maxOffset, maxOffset),
        y: clamp(y, -maxOffset, maxOffset)
    };
}

/**
 * Event payloads such as `pass` and `kick` are arrays of command arguments.
 * Reject every other shape and normalise the elements to strings.
 */
function normalizeCommandArgs(data, maxArgs = 16) {
    if (!Array.isArray(data)) {
        return [];
    }

    return data.slice(0, maxArgs).map((value) => {
        if (typeof value === 'string') {
            return value;
        }
        if (value === undefined || value === null) {
            return '';
        }
        return String(value);
    });
}

/**
 * Validate and sanitise a chat payload. Returns null when there is nothing to
 * deliver; otherwise returns the trimmed, HTML-stripped message.
 */
function normalizeChatMessage(data, maxLength = 200) {
    if (!data || typeof data !== 'object' || typeof data.message !== 'string') {
        return null;
    }

    const message = data.message.replace(/(<([^>]+)>)/ig, '').trim();
    if (message.length === 0) {
        return null;
    }

    return message.substring(0, maxLength);
}

module.exports = {
    DEFAULT_VIEW_WIDTH,
    DEFAULT_VIEW_HEIGHT,
    MIN_VIEW_DIMENSION,
    DEFAULT_MAX_VIEW_DIMENSION,
    normalizeScreenSize,
    normalizeTarget,
    normalizeCommandArgs,
    normalizeChatMessage
};
