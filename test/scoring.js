'use strict';

const expect = require('chai').expect;

const {
    DEFAULT_SCORE_WEIGHTS,
    normalizeWeights,
    scorePlayer,
    rankPlayers
} = require('../src/server/game').scoring;

function stats(overrides = {}) {
    return Object.assign({
        id: 'a',
        name: 'Alice',
        massTotal: 0,
        kills: 0,
        foodEaten: 0,
        survivedMs: 0,
        dnf: false
    }, overrides);
}

describe('match scoring', () => {
    describe('scorePlayer', () => {
        it('weights mass, kills, food and survival time', () => {
            expect(scorePlayer(stats({
                massTotal: 100,
                kills: 2,
                foodEaten: 5,
                survivedMs: 9500
            }))).to.equal(
                (100 * DEFAULT_SCORE_WEIGHTS.mass) +
                (2 * DEFAULT_SCORE_WEIGHTS.kill) +
                (5 * DEFAULT_SCORE_WEIGHTS.food) +
                (9 * DEFAULT_SCORE_WEIGHTS.survivalPerSecond)
            );
        });

        it('ignores invalid values and accepts custom weights', () => {
            expect(scorePlayer(stats({
                massTotal: NaN,
                kills: -1,
                foodEaten: 1,
                survivedMs: 1000
            }), { mass: 1, kill: 10, food: 3, survivalPerSecond: 2 })).to.equal(
                (-1 * 10) + 3 + 2
            );

            expect(normalizeWeights({ kill: 1 })).to.deep.equal(
                Object.assign({}, DEFAULT_SCORE_WEIGHTS, { kill: 1 })
            );
        });
    });

    describe('rankPlayers', () => {
        it('orders by score and assigns ranks', () => {
            const ranked = rankPlayers([
                stats({ id: 'a', name: 'Alice', massTotal: 50 }),
                stats({ id: 'b', name: 'Bob', massTotal: 200 }),
                stats({ id: 'c', name: 'Carol', massTotal: 100 })
            ]);

            expect(ranked.map((entry) => entry.id)).to.deep.equal(['b', 'c', 'a']);
            expect(ranked.map((entry) => entry.rank)).to.deep.equal([1, 2, 3]);
            expect(ranked[0].winner).to.equal(true);
            expect(ranked[1].winner).to.equal(false);
        });

        it('shares rank and marks every tied leader as a winner', () => {
            const ranked = rankPlayers([
                stats({ id: 'a', name: 'Alice', massTotal: 100 }),
                stats({ id: 'b', name: 'Bob', massTotal: 100 }),
                stats({ id: 'c', name: 'Carol', massTotal: 10 })
            ]);

            expect(ranked.map((entry) => entry.rank)).to.deep.equal([1, 1, 3]);
            expect(ranked.filter((entry) => entry.winner).map((entry) => entry.id))
                .to.deep.equal(['a', 'b']);
        });

        it('lists DNF players last and excludes them from winning', () => {
            const ranked = rankPlayers([
                stats({ id: 'a', name: 'Alice', massTotal: 1000, dnf: true }),
                stats({ id: 'b', name: 'Bob', massTotal: 10 })
            ]);

            expect(ranked.map((entry) => entry.id)).to.deep.equal(['b', 'a']);
            expect(ranked[0].winner).to.equal(true);
            expect(ranked[1].rank).to.equal(2);
            expect(ranked[1].winner).to.equal(false);
            expect(ranked[1].dnf).to.equal(true);
        });

        it('has no winner when every player is DNF', () => {
            const ranked = rankPlayers([
                stats({ id: 'a', name: 'Alice', dnf: true }),
                stats({ id: 'b', name: 'Bob', dnf: true })
            ]);

            expect(ranked.filter((entry) => entry.winner)).to.have.length(0);
        });
    });
});
