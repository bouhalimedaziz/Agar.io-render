'use strict';

/**
 * Sliding-window counter keyed by an arbitrary string (IP, username, ...).
 *
 *   const limiter = new AttemptRateLimiter({ maxAttempts: 5, windowMs: 60000 });
 *   if (!limiter.check(key).allowed) { ... }
 *   limiter.record(key);
 */
class AttemptRateLimiter {
    constructor({ maxAttempts, windowMs, now }) {
        if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
            throw new TypeError('maxAttempts must be a positive integer');
        }
        if (!Number.isInteger(windowMs) || windowMs <= 0) {
            throw new TypeError('windowMs must be a positive integer');
        }

        this.maxAttempts = maxAttempts;
        this.windowMs = windowMs;
        this.now = typeof now === 'function' ? now : Date.now;
        this.attempts = new Map();
    }

    _recent(key, now) {
        const list = this.attempts.get(key);
        if (!list) {
            return [];
        }

        const cutoff = now - this.windowMs;
        const recent = list.filter((timestamp) => timestamp > cutoff);

        if (recent.length === 0) {
            this.attempts.delete(key);
        } else if (recent.length !== list.length) {
            this.attempts.set(key, recent);
        }

        return recent;
    }

    check(key) {
        const now = this.now();
        const recent = this._recent(key, now);

        if (recent.length >= this.maxAttempts) {
            const retryAfterMs = Math.max(0, recent[0] + this.windowMs - now);
            return {
                allowed: false,
                remaining: 0,
                retryAfterMs
            };
        }

        return {
            allowed: true,
            remaining: this.maxAttempts - recent.length,
            retryAfterMs: 0
        };
    }

    record(key) {
        const now = this.now();
        const recent = this._recent(key, now);
        recent.push(now);
        this.attempts.set(key, recent);
        return this;
    }

    reset(key) {
        this.attempts.delete(key);
        return this;
    }

    clear() {
        this.attempts.clear();
        return this;
    }
}

module.exports = {
    AttemptRateLimiter
};
