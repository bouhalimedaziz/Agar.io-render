'use strict';

const expect = require('chai').expect;
const {
    SessionStore,
    createMemoryStorage,
    STORAGE_KEY
} = require('../src/client/js/session-store');

function createStore() {
    return new SessionStore({ storage: createMemoryStorage() });
}

describe('session store', () => {
    it('starts empty', () => {
        const store = createStore();

        expect(store.token).to.equal(null);
        expect(store.account).to.equal(null);
        expect(store.guestName).to.equal('');
        expect(store.isAuthenticated).to.equal(false);
        expect(store.displayName).to.equal('Guest');
    });

    it('persists a session and guest name across instances', () => {
        const storage = createMemoryStorage();
        const first = new SessionStore({ storage });

        first.setGuestName('Ada_1');
        first.setSession({
            token: 'token-123',
            account: {
                id: 7,
                username: 'Ada',
                createdAt: 100,
                lastLoginAt: 200
            }
        });

        expect(first.isAuthenticated).to.equal(true);
        expect(first.displayName).to.equal('Ada');
        expect(storage.getItem(STORAGE_KEY)).to.contain('token-123');

        const second = new SessionStore({ storage });
        expect(second.token).to.equal('token-123');
        expect(second.account).to.deep.include({ id: 7, username: 'Ada' });
        expect(second.guestName).to.equal('Ada_1');
    });

    it('clears the account but keeps the guest name', () => {
        const store = createStore();
        store.setGuestName('Guesty');
        store.setSession({
            token: 'token',
            account: { id: 1, username: 'Player' }
        });

        store.clearSession();

        expect(store.token).to.equal(null);
        expect(store.account).to.equal(null);
        expect(store.guestName).to.equal('Guesty');
        expect(store.displayName).to.equal('Guesty');
    });

    it('ignores malformed persisted data', () => {
        const storage = createMemoryStorage();
        storage.setItem(STORAGE_KEY, '{not json');
        const store = new SessionStore({ storage });

        expect(store.token).to.equal(null);
        expect(store.account).to.equal(null);
        expect(store.guestName).to.equal('');
    });

    it('rejects an invalid session payload', () => {
        const store = createStore();

        expect(() => store.setSession({ token: '', account: { id: 1, username: 'x' } }))
            .to.throw(TypeError);
        expect(() => store.setSession({ token: 'abc', account: { id: 0, username: 'x' } }))
            .to.throw(TypeError);
        expect(() => store.setSession(null)).to.throw(TypeError);
    });

    it('normalizes and truncates guest names', () => {
        const store = createStore();
        store.setGuestName('   ' + 'a'.repeat(40) + '   ');

        expect(store.guestName.length).to.equal(25);
        expect(store.guestName).to.equal('a'.repeat(25));
    });
});
