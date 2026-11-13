'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { packager } = require('@electron/packager');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function copy(source, destination) {
    if (!fs.existsSync(source)) {
        throw new Error('Missing ' + source + '. Run `npm run build` first.');
    }
    fs.cpSync(source, destination, { recursive: true });
}

function createStage(stage) {
    copy(path.join(ROOT, 'config.js'), path.join(stage, 'config.js'));
    copy(path.join(ROOT, 'src', 'electron'), path.join(stage, 'src', 'electron'));
    copy(
        path.join(ROOT, 'src', 'shared', 'tcp-socket'),
        path.join(stage, 'src', 'shared', 'tcp-socket')
    );
    copy(path.join(ROOT, 'bin', 'client'), path.join(stage, 'bin', 'client'));

    const project = readJson(path.join(ROOT, 'package.json'));
    const manifest = {
        name: 'open-agar',
        productName: 'Open Agar',
        version: project.version,
        description: project.description,
        main: 'src/electron/main.js',
        author: project.author,
        license: project.license
    };

    fs.writeFileSync(
        path.join(stage, 'package.json'),
        JSON.stringify(manifest, null, 2) + '\n'
    );
}

async function main() {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agar-package-'));
    const project = readJson(path.join(ROOT, 'package.json'));
    const electronVersion = readJson(
        path.join(ROOT, 'node_modules', 'electron', 'package.json')
    ).version;

    createStage(stage);

    console.log('[package] Electron ' + electronVersion);
    console.log('[package] staging ' + stage);

    try {
        const appPaths = await packager({
            dir: stage,
            out: OUT_DIR,
            name: 'OpenAgar',
            appVersion: project.version,
            platform: process.env.AGAR_PACKAGE_PLATFORM || process.platform,
            arch: process.env.AGAR_PACKAGE_ARCH || process.arch,
            electronVersion,
            overwrite: true,
            asar: true,
            prune: false
        });

        for (const appPath of appPaths) {
            console.log('[package] created ' + appPath);
        }
    } finally {
        fs.rmSync(stage, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error('[package] ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
