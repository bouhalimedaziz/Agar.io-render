'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const config = require('../../config');
const { TcpClient } = require('../shared/tcp-socket');
const { createTcpBridge } = require('./tcp-bridge');

function serverHost() {
    return process.env.AGAR_SERVER_HOST || '127.0.0.1';
}

function serverPort() {
    const raw = process.env.AGAR_SERVER_PORT || config.tcp.port;
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('Invalid AGAR_SERVER_PORT: ' + raw);
    }
    return port;
}

let mainWindow = null;
let bridge = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        backgroundColor: '#222222',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file://')) {
            event.preventDefault();
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../../bin/client/index.html'));

    mainWindow.on('closed', () => {
        if (bridge) {
            // Release the server-side player as soon as the window closes.
            bridge.disconnect('window closed');
        }
        mainWindow = null;
    });

    if (!bridge) {
        bridge = createTcpBridge({
            ipcMain,
            getWindow: () => mainWindow,
            createClient: (options) => new TcpClient(options),
            clientOptions: {
                host: serverHost(),
                port: serverPort(),
                reconnect: true,
                reconnectDelay: 1000,
                reconnectMaxDelay: 5000
            }
        });
        bridge.start();
    }
}

app.whenReady().then(createWindow);

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (bridge) {
        bridge.stop();
    }
});
