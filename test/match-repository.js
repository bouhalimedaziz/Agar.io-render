'use strict';

const expect = require('chai').expect;

const { createDatabase, initializeSchema } = require('../src/server/database');
const { createMatchRepository } = require('../src/server/repositories/match-repository');

function sampleResult() {
    return {
        roomId: 'room-1',
        state: 'finished',
        reason: 'time_limit',
        startedAt: 1000,
        finishedAt: 65000,
        durationMs: 64000,
        winner: 'account:1',
        winners: ['account:1'],
        tie: false,
        scores: [
            {
                id: 'account:1',
                accountId: 1,
                name: 'Alice',
                score: 750,
                rank: 1,
                winner: true,
                massTotal: 300,
                peakMass: 400,
                kills: 2,
                foodEaten: 25,
                survivedMs: 64000,
                alive: true,
                dnf: false
            },
            {
                id: 'account:2',
                accountId: 2,
                name: 'Bob',
                score: 120,
                rank: 2,
                winner: false,
                massTotal: 0,
                peakMass: 100,
                kills: 0,
                foodEaten: 10,
                survivedMs: 30000,
                alive: false,
                dnf: true
            }
        ]
    };
}

describe('match repository', () => {
    let db;
    let repository;

    beforeEach(async () => {
        db = createDatabase(':memory:');
        await initializeSchema(db);
        repository = createMatchRepository(db);
    });

    afterEach((done) => {
        db.close(done);
    });

    it('saves a match and its player stats as one result', async () => {
        const matchId = await repository.saveMatch(sampleResult(), {
            name: 'Test Room',
            code: 'ABC123'
        });

        expect(matchId).to.be.a('number');

        const match = await repository.getMatch(matchId);
        expect(match).to.include({
            roomId: 'room-1',
            roomName: 'Test Room',
            roomCode: 'ABC123',
            reason: 'time_limit',
            durationMs: 64000,
            winnerId: 'account:1',
            winnerName: 'Alice',
            playerCount: 2
        });

        expect(match.players).to.have.length(2);
        expect(match.players[0]).to.include({
            memberId: 'account:1',
            accountId: 1,
            name: 'Alice',
            score: 750,
            rank: 1,
            winner: 1,
            kills: 2,
            foodEaten: 25,
            dnf: 0
        });
        expect(match.players[1]).to.include({
            memberId: 'account:2',
            winner: 0,
            dnf: 1,
            alive: 0
        });
    });

    it('does not store a single winner for a tie', async () => {
        const result = sampleResult();
        result.winner = null;
        result.winners = ['account:1', 'account:2'];
        result.tie = true;
        result.scores[0].rank = 1;
        result.scores[1].rank = 1;
        result.scores[1].winner = true;
        result.scores[1].dnf = false;
        result.scores[1].alive = true;

        const matchId = await repository.saveMatch(result);
        const match = await repository.getMatch(matchId);

        expect(match.winnerId).to.equal(null);
        expect(match.winnerName).to.equal(null);
    });

    it('lists basic match history for an account', async () => {
        await repository.saveMatch(sampleResult(), { name: 'First' });
        await repository.saveMatch(sampleResult(), { name: 'Second' });

        const history = await repository.listMatchesForAccount(1);

        expect(history).to.have.length(2);
        expect(history.map((match) => match.roomName).sort())
            .to.deep.equal(['First', 'Second']);
        expect(await repository.listMatchesForAccount(999)).to.have.length(0);
    });

    it('returns null for an unknown match', async () => {
        expect(await repository.getMatch(12345)).to.equal(null);
    });
});
