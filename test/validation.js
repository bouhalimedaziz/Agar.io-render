'use strict';

const expect = require('chai').expect;

const {
    DEFAULT_VIEW_WIDTH,
    DEFAULT_VIEW_HEIGHT,
    MIN_VIEW_DIMENSION,
    normalizeScreenSize,
    normalizeTarget,
    normalizeCommandArgs,
    normalizeChatMessage
} = require('../src/server/game').validation;

describe('game input validation', () => {
    describe('normalizeScreenSize', () => {
        it('keeps sane dimensions and falls back for missing values', () => {
            expect(normalizeScreenSize(1280, 720)).to.deep.equal({
                width: 1280,
                height: 720
            });

            expect(normalizeScreenSize(undefined, null)).to.deep.equal({
                width: DEFAULT_VIEW_WIDTH,
                height: DEFAULT_VIEW_HEIGHT
            });
        });

        it('rejects non-finite values and clamps to bounds', () => {
            expect(normalizeScreenSize(NaN, Infinity)).to.deep.equal({
                width: DEFAULT_VIEW_WIDTH,
                height: DEFAULT_VIEW_HEIGHT
            });

            const tiny = normalizeScreenSize(1, 1);
            expect(tiny.width).to.equal(MIN_VIEW_DIMENSION);
            expect(tiny.height).to.equal(MIN_VIEW_DIMENSION);

            const huge = normalizeScreenSize(50000, 50000, {
                maxWidth: 5000,
                maxHeight: 4000
            });
            expect(huge).to.deep.equal({ width: 5000, height: 4000 });
        });
    });

    describe('normalizeTarget', () => {
        it('accepts finite coordinates', () => {
            expect(normalizeTarget({ x: 12, y: -8 })).to.deep.equal({
                x: 12,
                y: -8
            });
        });

        it('rejects malformed payloads', () => {
            expect(normalizeTarget(null)).to.equal(null);
            expect(normalizeTarget('nope')).to.equal(null);
            expect(normalizeTarget([])).to.equal(null);
            expect(normalizeTarget({ x: 1 })).to.equal(null);
            expect(normalizeTarget({ x: NaN, y: 1 })).to.equal(null);
            expect(normalizeTarget({ x: '1', y: 2 })).to.equal(null);
        });

        it('clamps impossible offsets', () => {
            expect(normalizeTarget({ x: 1e9, y: -1e9 }, { maxOffset: 100 }))
                .to.deep.equal({ x: 100, y: -100 });
        });
    });

    describe('normalizeCommandArgs', () => {
        it('accepts arrays and normalises values to strings', () => {
            expect(normalizeCommandArgs(['secret', 2, null])).to.deep.equal([
                'secret',
                '2',
                ''
            ]);
        });

        it('rejects non-array payloads and caps the argument count', () => {
            expect(normalizeCommandArgs('secret')).to.deep.equal([]);
            expect(normalizeCommandArgs({ 0: 'secret' })).to.deep.equal([]);
            expect(normalizeCommandArgs(['a', 'b', 'c'], 2)).to.deep.equal(['a', 'b']);
        });
    });

    describe('normalizeChatMessage', () => {
        it('accepts and sanitises string messages', () => {
            expect(normalizeChatMessage({ message: '  hello <b>there</b>  ' }))
                .to.equal('hello there');
            expect(normalizeChatMessage({ message: 'x'.repeat(500) }, 35))
                .to.have.length(35);
        });

        it('rejects invalid or empty messages', () => {
            expect(normalizeChatMessage(null)).to.equal(null);
            expect(normalizeChatMessage('hello')).to.equal(null);
            expect(normalizeChatMessage({ message: 5 })).to.equal(null);
            expect(normalizeChatMessage({ message: '   ' })).to.equal(null);
            expect(normalizeChatMessage({ message: '<b></b>' })).to.equal(null);
        });
    });
});
