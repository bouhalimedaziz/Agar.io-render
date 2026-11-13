'use strict';

const expect = require('chai').expect;
const ConnectionStatus = require('../src/client/js/connection-status');

function createElement() {
    return {
        textContent: '',
        className: '',
        attributes: {},
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        }
    };
}

describe('connection status UI', () => {
    it('starts hidden', () => {
        const element = createElement();
        const status = new ConnectionStatus(element);

        expect(status.state).to.equal('idle');
        expect(status.hidden).to.equal(true);
        expect(element.className).to.contain('connection-status--hidden');
        expect(element.attributes['aria-hidden']).to.equal('true');
    });

    it('shows connecting, reconnecting and offline states', () => {
        const element = createElement();
        const status = new ConnectionStatus(element);

        status.connecting();
        expect(status.state).to.equal('connecting');
        expect(element.textContent).to.contain('Connecting');
        expect(element.attributes['aria-hidden']).to.equal('false');

        status.reconnecting(3, 4000);
        expect(status.state).to.equal('reconnecting');
        expect(element.textContent).to.contain('attempt 3');
        expect(element.textContent).to.contain('4s');

        status.offline();
        expect(status.state).to.equal('offline');
        expect(element.textContent).to.contain('Unable to reach the server');
    });

    it('hides again once connected', () => {
        const element = createElement();
        const status = new ConnectionStatus(element);

        status.connecting();
        status.connected();

        expect(status.state).to.equal('connected');
        expect(status.hidden).to.equal(true);
        expect(element.textContent).to.equal('');
        expect(element.className).to.contain('connection-status--hidden');
        expect(element.attributes['aria-hidden']).to.equal('true');
    });

    it('renders shutdown and kick messages', () => {
        const element = createElement();
        const status = new ConnectionStatus(element);

        status.shutdown();
        expect(status.state).to.equal('shutdown');
        expect(element.textContent).to.contain('Server is shutting down');

        status.kicked('spamming');
        expect(status.state).to.equal('kicked');
        expect(element.textContent).to.contain('spamming');
    });
});
