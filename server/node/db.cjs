const path = require('path');
const { existsSync, mkdirSync } = require('fs');

const DB_PATH = path.join(process.cwd(), 'save', 'risuai.db');

let _db = null;

function getDb() {
    if (_db) return _db;
    const Database = require('better-sqlite3');
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
    return _db;
}

function initSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data TEXT NOT NULL,
            updated_at INTEGER DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS characters (
            cha_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'character',
            image TEXT,
            last_interaction INTEGER,
            data TEXT NOT NULL,
            updated_at INTEGER DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            cha_id TEXT NOT NULL REFERENCES characters(cha_id) ON DELETE CASCADE,
            name TEXT,
            chat_page INTEGER DEFAULT 0,
            message_count INTEGER DEFAULT 0,
            data TEXT NOT NULL,
            updated_at INTEGER DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            data TEXT NOT NULL,
            time INTEGER,
            metadata TEXT,
            UNIQUE(chat_id, seq)
        );

        CREATE TABLE IF NOT EXISTS bot_presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            data TEXT NOT NULL,
            updated_at INTEGER DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS modules (
            id TEXT PRIMARY KEY,
            name TEXT,
            data TEXT NOT NULL,
            updated_at INTEGER DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS assets (
            key TEXT PRIMARY KEY,
            data BLOB NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_chats_cha_id ON chats(cha_id);
        CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_id, seq);
        CREATE INDEX IF NOT EXISTS idx_characters_interaction ON characters(last_interaction);
    `);
}

// --- Config ---

function getConfig() {
    const db = getDb();
    const row = db.prepare('SELECT data FROM config WHERE id = 1').get();
    return row ? JSON.parse(row.data) : null;
}

function setConfig(data) {
    const db = getDb();
    db.prepare(`
        INSERT INTO config (id, data, updated_at) VALUES (1, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = unixepoch()
    `).run(JSON.stringify(data));
}

function patchConfig(patch) {
    const db = getDb();
    const current = getConfig() || {};
    Object.assign(current, patch);
    setConfig(current);
    return current;
}

// --- Characters ---

function getCharacterList() {
    const db = getDb();
    return db.prepare('SELECT cha_id, name, type, image, last_interaction FROM characters ORDER BY last_interaction DESC').all();
}

function getCharacter(chaId) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM characters WHERE cha_id = ?').get(chaId);
    if (!row) return null;
    return { ...row, data: JSON.parse(row.data) };
}

function upsertCharacter(chaId, char) {
    const db = getDb();
    db.prepare(`
        INSERT INTO characters (cha_id, name, type, image, last_interaction, data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(cha_id) DO UPDATE SET
            name = excluded.name, type = excluded.type, image = excluded.image,
            last_interaction = excluded.last_interaction, data = excluded.data, updated_at = unixepoch()
    `).run(chaId, char.name || '', char.type || 'character', char.image || null, char.lastInteraction || null, JSON.stringify(char));
}

function deleteCharacter(chaId) {
    const db = getDb();
    db.prepare('DELETE FROM characters WHERE cha_id = ?').run(chaId);
}

// --- Chats ---

function getChatList(chaId) {
    const db = getDb();
    return db.prepare('SELECT id, cha_id, name, chat_page, message_count FROM chats WHERE cha_id = ? ORDER BY rowid').all(chaId);
}

function getChat(chatId) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!row) return null;
    return { ...row, data: JSON.parse(row.data) };
}

function upsertChat(chatId, chaId, chat) {
    const db = getDb();
    const messageCount = chat.message?.length || 0;
    const chatData = { ...chat };
    delete chatData.message; // messages stored separately
    db.prepare(`
        INSERT INTO chats (id, cha_id, name, chat_page, message_count, data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, chat_page = excluded.chat_page,
            message_count = excluded.message_count, data = excluded.data, updated_at = unixepoch()
    `).run(chatId, chaId, chat.name || null, chat.chatPage || 0, messageCount, JSON.stringify(chatData));
}

function deleteChat(chatId) {
    const db = getDb();
    db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
}

// --- Messages ---

function getMessages(chatId, limit = 30, offset = 0) {
    const db = getDb();
    return db.prepare(
        'SELECT seq, role, data, time, metadata FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?'
    ).all(chatId, limit, offset).reverse();
}

function getMessageCount(chatId) {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?').get(chatId);
    return row.count;
}

function insertMessages(chatId, messages) {
    const db = getDb();
    const insert = db.prepare(
        'INSERT OR REPLACE INTO messages (chat_id, seq, role, data, time, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const tx = db.transaction((msgs) => {
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            insert.run(chatId, i, m.role || 'char', typeof m.data === 'string' ? m.data : JSON.stringify(m.data), m.time || null, m.generationInfo ? JSON.stringify({ generationInfo: m.generationInfo, promptInfo: m.promptInfo }) : null);
        }
    });
    tx(messages);
}

function appendMessage(chatId, seq, message) {
    const db = getDb();
    db.prepare(
        'INSERT INTO messages (chat_id, seq, role, data, time, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(chatId, seq, message.role || 'char', message.data || '', message.time || null, message.generationInfo ? JSON.stringify({ generationInfo: message.generationInfo, promptInfo: message.promptInfo }) : null);
}

function updateMessage(chatId, seq, message) {
    const db = getDb();
    db.prepare(
        'UPDATE messages SET role = ?, data = ?, time = ?, metadata = ? WHERE chat_id = ? AND seq = ?'
    ).run(message.role || 'char', message.data || '', message.time || null, message.generationInfo ? JSON.stringify({ generationInfo: message.generationInfo, promptInfo: message.promptInfo }) : null, chatId, seq);
}

function deleteMessagesFrom(chatId, fromSeq) {
    const db = getDb();
    db.prepare('DELETE FROM messages WHERE chat_id = ? AND seq >= ?').run(chatId, fromSeq);
}

// --- Presets ---

function getPresets() {
    const db = getDb();
    return db.prepare('SELECT id, name, data FROM bot_presets ORDER BY id').all().map(r => ({ ...r, data: JSON.parse(r.data) }));
}

function upsertPreset(id, preset) {
    const db = getDb();
    if (id) {
        db.prepare('UPDATE bot_presets SET name = ?, data = ?, updated_at = unixepoch() WHERE id = ?')
            .run(preset.name || null, JSON.stringify(preset), id);
    } else {
        const result = db.prepare('INSERT INTO bot_presets (name, data, updated_at) VALUES (?, ?, unixepoch())')
            .run(preset.name || null, JSON.stringify(preset));
        return result.lastInsertRowid;
    }
}

// --- Modules ---

function getModules() {
    const db = getDb();
    return db.prepare('SELECT id, name, data FROM modules ORDER BY id').all().map(r => ({ ...r, data: JSON.parse(r.data) }));
}

function upsertModule(id, mod) {
    const db = getDb();
    db.prepare(`
        INSERT INTO modules (id, name, data, updated_at) VALUES (?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = unixepoch()
    `).run(id, mod.name || null, JSON.stringify(mod));
}

// --- Assets ---

function getAsset(key) {
    const db = getDb();
    const row = db.prepare('SELECT data FROM assets WHERE key = ?').get(key);
    return row ? row.data : null;
}

function setAsset(key, data) {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO assets (key, data) VALUES (?, ?)').run(key, data);
}

function deleteAsset(key) {
    const db = getDb();
    db.prepare('DELETE FROM assets WHERE key = ?').run(key);
}

function listAssets() {
    const db = getDb();
    return db.prepare('SELECT key FROM assets').all().map(r => r.key);
}

// --- Utility ---

function isDbReady() {
    return existsSync(DB_PATH);
}

function closeDb() {
    if (_db) {
        _db.close();
        _db = null;
    }
}

module.exports = {
    getDb, isDbReady, closeDb,
    getConfig, setConfig, patchConfig,
    getCharacterList, getCharacter, upsertCharacter, deleteCharacter,
    getChatList, getChat, upsertChat, deleteChat,
    getMessages, getMessageCount, insertMessages, appendMessage, updateMessage, deleteMessagesFrom,
    getPresets, upsertPreset,
    getModules, upsertModule,
    getAsset, setAsset, deleteAsset, listAssets,
    DB_PATH,
};
