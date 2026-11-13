'use strict';

const expect = require('chai').expect;
const {
    formatDuration,
    formatCountdown,
    countdownRemaining,
    formatTimeLimit,
    formatScoreLimit,
    formatVisibility,
    formatRoomMeta,
    formatEndReason,
    formatResultTitle,
    formatResultSubtitle,
    resultEntries,
    formatRank,
    formatScore,
    formatMemberStatus,
    formatRoomError,
    formatAuthError
} = require('../src/client/js/ui-format');

describe('UI formatting', () => {
    it('formats durations and countdowns', () => {
        expect(formatDuration(0)).to.equal('0:00');
        expect(formatDuration(1000)).to.equal('0:01');
        expect(formatDuration(61000)).to.equal('1:01');
        expect(formatDuration(3661000)).to.equal('1:01:01');
        expect(formatDuration(-5)).to.equal('0:00');
        expect(formatCountdown(3000)).to.equal('3');
        expect(formatCountdown(1)).to.equal('1');
        expect(formatCountdown(0)).to.equal('0');
        expect(countdownRemaining(5000, 2000)).to.equal(3000);
        expect(countdownRemaining(1000, 2000)).to.equal(0);
    });

    it('formats optional limits', () => {
        expect(formatTimeLimit(0)).to.equal('No limit');
        expect(formatTimeLimit(90000)).to.equal('1:30');
        expect(formatScoreLimit(0)).to.equal('No limit');
        expect(formatScoreLimit(500)).to.equal('500');
    });

    it('formats room metadata', () => {
        expect(formatVisibility('private')).to.equal('Private');
        expect(formatVisibility('public')).to.equal('Public');
        expect(formatRoomMeta({
            visibility: 'public',
            memberCount: 2,
            capacity: 8
        })).to.equal('Public · 2/8 players');
        expect(formatRoomMeta(null)).to.equal('');
    });

    it('formats match end reasons', () => {
        expect(formatEndReason('owner_stop')).to.contain('owner');
        expect(formatEndReason('time_limit')).to.contain('time limit');
        expect(formatEndReason('custom_reason')).to.equal('Custom reason.');
        expect(formatEndReason(null)).to.equal('The match finished.');
    });

    it('builds result titles and subtitles', () => {
        const result = {
            reason: 'score_limit',
            durationMs: 125000,
            scores: [
                { id: 'b', name: 'Bob', score: 20, rank: 1, winner: true },
                { id: 'a', name: 'Ada', score: 10, rank: 2, winner: false }
            ]
        };

        expect(formatResultTitle(result)).to.equal('Bob wins!');
        expect(formatResultSubtitle(result)).to.equal(
            'A player reached the score limit. · Duration 2:05'
        );
        expect(formatResultTitle({ scores: [] })).to.equal('Match over');
        expect(formatResultSubtitle(null)).to.equal('');
    });

    it('handles draws and result ordering', () => {
        const result = {
            scores: [
                { name: 'B', score: 5, rank: 1, winner: true },
                { name: 'A', score: 5, rank: 1, winner: true },
                { name: 'C', score: 1, rank: 3, winner: false }
            ]
        };

        expect(formatResultTitle(result)).to.equal('Draw: A & B');
        expect(resultEntries(result).map((entry) => entry.name)).to.deep.equal(['A', 'B', 'C']);
    });

    it('formats scores, ranks and member states', () => {
        expect(formatRank(1)).to.equal('#1');
        expect(formatRank(0)).to.equal('—');
        expect(formatScore(12.6)).to.equal('13');
        expect(formatMemberStatus({ ready: true, role: 'player' })).to.equal('Ready');
        expect(formatMemberStatus({ ready: false, role: 'player' })).to.equal('Not ready');
        expect(formatMemberStatus({ role: 'spectator' })).to.equal('Spectating');
        expect(formatMemberStatus({ ready: true, alive: false })).to.equal('Eliminated');
    });

    it('falls back to friendly error messages', () => {
        expect(formatRoomError({ code: 'room_full' })).to.contain('full');
        expect(formatRoomError({ code: 'room_full', message: 'No space' })).to.equal('No space');
        expect(formatRoomError({ code: 'mystery_error' })).to.equal('mystery error');
        expect(formatRoomError(null, 'Fallback')).to.equal('Fallback');
        expect(formatAuthError({ message: 'Bad login' })).to.equal('Bad login');
        expect(formatAuthError(null, 'Try again')).to.equal('Try again');
    });
});
