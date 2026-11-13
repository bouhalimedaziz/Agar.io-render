'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'bin', 'server', 'server.js');
const CLIENT_ENTRY = path.join(ROOT, 'bin', 'client', 'index.html');
const ELECTRON_ENTRY = process.argv[2]
    ? path.resolve(ROOT, process.argv[2])
    : path.join(__dirname, 'electron-main.js');
const TEST_TIMEOUT_MS = 120000;

function electronBinary() {
    try {
        return require('electron');
    } catch (err) {
        throw new Error('Electron is not installed. Run `npm install` first.');
    }
}

function log(message) {
    console.log('[e2e-runner] ' + message);
}

function assertBuildExists() {
    for (const file of [SERVER_ENTRY, CLIENT_ENTRY]) {
        if (!fs.existsSync(file)) {
            throw new Error('Missing ' + file + '. Run `npm run build` first.');
        }
    }
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function waitForLine(child, pattern) {
    return new Promise((resolve) => {
        let buffer = '';
        function onData(chunk) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (pattern.test(line)) {
                    child.stdout.removeListener('data', onData);
                    resolve(line);
                    return;
                }
            }
        }
        child.stdout.on('data', onData);
    });
}

function pipeOutput(child, prefix) {
    child.stdout.on('data', (chunk) => process.stdout.write('[e2e:' + prefix + '] ' + chunk));
    child.stderr.on('data', (chunk) => process.stderr.write('[e2e:' + prefix + '] ' + chunk));
}

function waitForExit(child) {
    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve({ code, signal }));
    });
}

function stopChild(child) {
    if (!child || child.exitCode !== null) {
        return Promise.resolve();
    }
    child.kill('SIGTERM');
    return Promise.race([
        waitForExit(child),
        new Promise((resolve) => setTimeout(resolve, 6000))
    ]).then(() => {
        if (child.exitCode === null) {
            child.kill('SIGKILL');
        }
    });
}

async function main() {
    assertBuildExists();

    const httpPort = await getFreePort();
    const tcpPort = await getFreePort();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agar-e2e-'));
    const dbFile = path.join(tempDir, 'e2e.sqlite3');

    log('starting server (http ' + httpPort + ', tcp ' + tcpPort + ')');

    const server = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
            PORT: String(httpPort),
            TCP_PORT: String(tcpPort),
            TCP_HOST: '127.0.0.1',
            AGAR_DB_FILE: dbFile
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    pipeOutput(server, 'server');

    let electron = null;
    let exitCode = 1;

    try {
        await Promise.all([
            waitForLine(server, /TCP listening on/),
            waitForLine(server, /Listening on/),
            waitForLine(server, /Connected to the SQLite database/)
        ]);

        log('launching Electron');
        const args = [ELECTRON_ENTRY];
        if (process.env.AGAR_E2E_NO_SANDBOX === '1' ||
            (typeof process.getuid === 'function' && process.getuid() === 0)) {
            args.push('--no-sandbox');
        }

        electron = spawn(electronBinary(), args, {
            cwd: ROOT,
            env: Object.assign({}, process.env, {
                AGAR_SERVER_HOST: '127.0.0.1',
                AGAR_SERVER_PORT: String(tcpPort)
            }),
            stdio: ['ignore', 'pipe', 'pipe']
        });
        pipeOutput(electron, 'electron');

        const timeout = setTimeout(() => {
            log('Electron E2E timed out after ' + TEST_TIMEOUT_MS + 'ms');
            stopChild(electron);
        }, TEST_TIMEOUT_MS);

        const result = await waitForExit(electron);
        clearTimeout(timeout);
        exitCode = result.code === 0 ? 0 : 1;
        if (exitCode === 0) {
            log('Electron E2E passed');
        } else {
            log('Electron E2E failed (code ' + result.code + ', signal ' + result.signal + ')');
        }
    } finally {
        await stopChild(electron);
        await stopChild(server);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    return exitCode;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error('[e2e-runner] ' + (err && err.stack ? err.stack : err));
        process.exit(1);
    });
