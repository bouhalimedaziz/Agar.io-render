'use strict';

const expect = require('chai').expect;
const {
    DesktopTransport,
    createDesktopTransport
} = require('../src/client/js/transport/desktop-transport');

function createBridge() {
    const handlers = new Map();
    return {
        connected: false,
        connects: 0,
        disconnects: 0,
        emitted: [],
        emit(event, ...args) {
            this.emitted.push([event].concat(args));
        },
        on(event, handler) {
            if (!handlers.has(event)) {
                handlers.set(event, []);
            }
            handlers.get(event).push(handler);
        },
        off(event, handler) {
            const list = handlers.get(event) || [];
            handlers.set(event, list.filter((entry) => entry !== handler));
        },
        connect() {
            this.connects += 1;
            this.connectOptions = arguments.length > 0 ? arguments[0] : null;
        },
        disconnect() {
            this.disconnects += 1;
        },
        isConnected() {
            return this.connected;
        },
        trigger(event, ...args) {
            for (const handler of (handlers.get(event) || []).slice()) {
                handler(...args);
            }
        },
        count(event) {
            return (handlers.get(event) || []).length;
        }
    };
}

describe('desktop transport adapter', () => {
    it('connects through the bridge and reports connection state', () => {
        const bridge = createBridge();
        const transport = createDesktopTransport(bridge);

        expect(bridge.connects).to.equal(1);
        expect(bridge.connectOptions).to.deep.equal({ query: {} });
        expect(transport.connected).to.equal(false);

        bridge.connected = true;
        expect(transport.connected).to.equal(true);
    });

    it('forwards the handshake type to the bridge', () => {
        const bridge = createBridge();
        createDesktopTransport(bridge, { query: 'type=spectator' });

        expect(bridge.connectOptions).to.deep.equal({
            query: { type: 'spectator' }
        });

        const objectBridge = createBridge();
        createDesktopTransport(objectBridge, { query: { type: 'player' } });
        expect(objectBridge.connectOptions).to.deep.equal({
            query: { type: 'player' }
        });
    });

    it('proxies events and supports listeners', () => {
        const bridge = createBridge();
        const transport = new DesktopTransport(bridge);
        const events = [];

        transport.emit('gotit', { name: 'Alice' });
        expect(bridge.emitted).to.deep.equal([['gotit', { name: 'Alice' }]]);

        transport.on('welcome', (...args) => events.push(args));
        bridge.trigger('welcome', 'hi', { width: 100 });
        expect(events).to.deep.equal([['hi', { width: 100 }]]);

        const handler = () => events.push('once');
        transport.once('roomSnapshot', handler);
        bridge.trigger('roomSnapshot', {});
        bridge.trigger('roomSnapshot', {});
        expect(events).to.deep.equal([
            ['hi', { width: 100 }],
            'once'
        ]);
        expect(bridge.count('roomSnapshot')).to.equal(0);
    });

    it('closes the bridge connection', () => {
        const bridge = createBridge();
        const transport = new DesktopTransport(bridge);

        transport.close();
        transport.disconnect();

        expect(bridge.disconnects).to.equal(2);
    });

    it('rejects invalid event names', () => {
        const bridge = createBridge();
        const transport = new DesktopTransport(bridge);

        expect(() => transport.emit('')).to.throw(TypeError);
        expect(() => transport.emit(null)).to.throw(TypeError);
    });

    it('requires a bridge', () => {
        expect(() => new DesktopTransport(null)).to.throw(TypeError);
        expect(() => new DesktopTransport({})).to.throw(TypeError);
    });
});
