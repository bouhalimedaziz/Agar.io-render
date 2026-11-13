'use strict';

const crypto = require('crypto');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

/**
 * Derive a key with scrypt. The encoded format is:
 *
 *   scrypt$N$r$p$<salt hex>$<key hex>
 *
 * so a stored hash is self-describing and can survive a future cost change.
 */
function scrypt(password, salt, options) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, KEY_LENGTH, options, (err, derivedKey) => {
            if (err) {
                reject(err);
            } else {
                resolve(derivedKey);
            }
        });
    });
}

async function hashPassword(password) {
    if (typeof password !== 'string') {
        throw new TypeError('password must be a string');
    }

    const salt = crypto.randomBytes(SALT_LENGTH);
    const derivedKey = await scrypt(password, salt, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: MAX_MEMORY
    });

    return [
        'scrypt',
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        salt.toString('hex'),
        derivedKey.toString('hex')
    ].join('$');
}

function parseHash(encoded) {
    if (typeof encoded !== 'string') {
        return null;
    }

    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
        return null;
    }

    const N = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], 'hex');
    const key = Buffer.from(parts[5], 'hex');

    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
        return null;
    }

    // Bound the cost parameters so a corrupted row cannot exhaust memory.
    if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) {
        return null;
    }

    if (salt.length !== SALT_LENGTH || key.length !== KEY_LENGTH) {
        return null;
    }

    return { N, r, p, salt, key };
}

async function verifyPassword(password, encoded) {
    if (typeof password !== 'string') {
        return false;
    }

    const parsed = parseHash(encoded);
    if (!parsed) {
        return false;
    }

    try {
        const derivedKey = await scrypt(password, parsed.salt, {
            N: parsed.N,
            r: parsed.r,
            p: parsed.p,
            maxmem: MAX_MEMORY
        });

        if (derivedKey.length !== parsed.key.length) {
            return false;
        }

        return crypto.timingSafeEqual(derivedKey, parsed.key);
    } catch (err) {
        return false;
    }
}

module.exports = {
    hashPassword,
    verifyPassword
};
