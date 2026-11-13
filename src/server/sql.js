'use strict';

const path = require('path');
const config = require('../../config');
const { createDatabase, initializeSchema } = require('./database');

const sqlInfo = config.sqlinfo;
const dbPath = process.env.AGAR_DB_FILE
    ? path.resolve(process.env.AGAR_DB_FILE)
    : path.join(__dirname, 'db', sqlInfo.fileName);

const db = createDatabase(dbPath);

initializeSchema(db)
    .then(() => console.log('Connected to the SQLite database.'))
    .catch((err) => console.error('Error initializing the SQLite database.', err));

process.on('beforeExit', () => {
    db.close((err) => {
        if (err) {
            console.error('Error closing the database connection. ', err);
        } else {
            console.log('Closed the database connection.');
        }
    });
});

module.exports = db;
