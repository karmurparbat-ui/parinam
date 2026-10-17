const { DatabaseSync } = require('node:sqlite');
const { scrypt, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const derive = promisify(scrypt);

async function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const hash = await derive(password, salt, 64);
    return salt + ':' + hash.toString('hex');
}

async function verifyPassword(password, encoded) {
    const [salt, hex] = encoded.split(':');
    const expected = Buffer.from(hex, 'hex');
    const actual = await derive(password, salt, 64);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}

function openStore(filename = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'parinam.sqlite')) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(filename);
    db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS schools (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','blocked')),
            valid_until INTEGER,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            school_id TEXT REFERENCES schools(id),
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin','principal','teacher')),
            active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            CHECK ((role = 'admin' AND school_id IS NULL) OR (role != 'admin' AND school_id IS NOT NULL))
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            csrf TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS documents (
            school_id TEXT NOT NULL REFERENCES schools(id),
            kind TEXT NOT NULL,
            record_key TEXT NOT NULL,
            value TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (school_id, kind, record_key)
        );
        CREATE TABLE IF NOT EXISTS rate_limits (
            bucket TEXT PRIMARY KEY,
            attempts INTEGER NOT NULL,
            reset_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY,
            actor_id TEXT NOT NULL,
            action TEXT NOT NULL,
            target_id TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
    `);
    if (filename !== ':memory:' && process.platform !== 'win32') fs.chmodSync(filename, 0o600);
    return db;
}

function transaction(db, work) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = work();
        db.exec('COMMIT');
        return result;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

module.exports = { openStore, hashPassword, verifyPassword, digest, transaction };
