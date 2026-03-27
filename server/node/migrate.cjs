/**
 * database.bin → SQLite migration script
 * Decodes RISUSAVE format (msgpack + gzip blocks) and inserts into SQLite.
 * Run automatically on server startup when save/risuai.db does not exist.
 */

const path = require('path');
const { existsSync, readFileSync, renameSync } = require('fs');
const fs = require('fs/promises');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

const db = require('./db.cjs');

const SAVE_DIR = path.join(process.cwd(), 'save');
// NodeStorage uses hex-encoded filenames in a flat directory
const DB_BIN_FILENAME = Buffer.from('database/database.bin').toString('hex');
const DB_BIN_PATH = path.join(SAVE_DIR, DB_BIN_FILENAME);
const COLD_STORAGE_DIR = path.join(SAVE_DIR, 'coldstorage');

// RISUSAVE headers
const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const MAGIC_COMPRESSED = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);
const MAGIC_STREAM = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9]);
const MAGIC_RISUSAVE = Buffer.from('RISUSAVE\0');

// Block types (matching RisuSaveType enum)
const BLOCK_CONFIG = 0;
const BLOCK_ROOT = 1;
const BLOCK_CHARACTER_WITH_CHAT = 2;
const BLOCK_CHAT = 3;
const BLOCK_BOTPRESET = 4;
const BLOCK_MODULES = 5;
const BLOCK_REMOTE = 6;
const BLOCK_CHARACTER_WITHOUT_CHAT = 7;
const BLOCK_ROOT_COMPONENT = 8;

function checkHeader(data) {
    if (data.length < MAGIC_RAW.length) return 'unknown';
    if (data.subarray(0, MAGIC_RAW.length).equals(MAGIC_RAW)) return 'raw';
    if (data.subarray(0, MAGIC_COMPRESSED.length).equals(MAGIC_COMPRESSED)) return 'compressed';
    if (data.subarray(0, MAGIC_STREAM.length).equals(MAGIC_STREAM)) return 'stream';
    if (data.subarray(0, MAGIC_RISUSAVE.length).equals(MAGIC_RISUSAVE)) return 'risusave';
    return 'unknown';
}

async function decodeLegacy(data) {
    const { Unpackr } = require('msgpackr');
    const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false });
    const fflate = require('fflate');

    const header = checkHeader(data);
    switch (header) {
        case 'raw':
            return unpackr.decode(data.subarray(MAGIC_RAW.length));
        case 'compressed':
            return unpackr.decode(fflate.decompressSync(data.subarray(MAGIC_COMPRESSED.length)));
        case 'stream': {
            const decompressed = await gunzip(data.subarray(MAGIC_STREAM.length));
            return unpackr.decode(decompressed);
        }
        default:
            throw new Error(`Unknown legacy format: ${header}`);
    }
}

async function decodeRisuSaveBlocks(data) {
    let offset = MAGIC_RISUSAVE.length;
    const blocks = [];

    while (offset < data.length) {
        try {
            const type = data[offset];
            const compression = data[offset + 1] === 1;
            offset += 2;

            const nameLength = data[offset];
            offset += 1;
            const name = data.subarray(offset, offset + nameLength).toString('utf-8');
            offset += nameLength;

            const length = data.readUInt32LE(offset);
            offset += 4;

            let blockData = data.subarray(offset, offset + length);
            offset += length;

            if (compression) {
                blockData = await gunzip(blockData);
            }

            blocks.push({
                type,
                name,
                content: blockData.toString('utf-8'),
            });
        } catch (e) {
            console.error('[Migrate] Error reading block at offset', offset, e.message);
            break;
        }
    }
    return blocks;
}

async function decodeDatabase(filePath) {
    const raw = readFileSync(filePath);
    const header = checkHeader(raw);

    if (header === 'risusave') {
        // New RISUSAVE block format
        const blocks = await decodeRisuSaveBlocks(raw);
        const result = { characters: [], botPresets: [], modules: [] };

        for (const block of blocks) {
            switch (block.type) {
                case BLOCK_ROOT: {
                    const rootData = JSON.parse(block.content);
                    for (const key in rootData) {
                        if (!key.startsWith('__')) {
                            result[key] = rootData[key];
                        }
                    }
                    break;
                }
                case BLOCK_CHARACTER_WITH_CHAT:
                case BLOCK_CHARACTER_WITHOUT_CHAT:
                    result.characters.push(JSON.parse(block.content));
                    break;
                case BLOCK_BOTPRESET:
                    result.botPresets = JSON.parse(block.content);
                    break;
                case BLOCK_MODULES:
                    result.modules = JSON.parse(block.content);
                    break;
                case BLOCK_ROOT_COMPONENT: {
                    const comp = JSON.parse(block.content);
                    result[comp.key] = comp.data;
                    break;
                }
                case BLOCK_REMOTE:
                    // Remote blocks reference external files — skip for now
                    console.log(`[Migrate] Skipping remote block: ${block.name}`);
                    break;
                case BLOCK_CONFIG:
                    break;
                default:
                    console.log(`[Migrate] Unknown block type ${block.type}: ${block.name}`);
            }
        }
        return result;
    } else {
        // Legacy format (msgpack + gzip/raw)
        return await decodeLegacy(raw);
    }
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

async function migrate() {
    if (db.isDbReady()) {
        // Check if DB has data
        const config = db.getConfig();
        if (config) {
            console.log('[Migrate] SQLite database already exists and has data. Skipping migration.');
            return true;
        }
    }

    if (!existsSync(DB_BIN_PATH)) {
        console.log('[Migrate] No database.bin found. Starting fresh.');
        return false;
    }

    console.log('[Migrate] Starting database.bin → SQLite migration...');
    const startTime = Date.now();

    let data;
    try {
        data = await decodeDatabase(DB_BIN_PATH);
    } catch (e) {
        console.error('[Migrate] Failed to decode database.bin:', e.message);
        return false;
    }

    const sqlite = db.getDb();

    try {
        sqlite.exec('BEGIN TRANSACTION');

        // 1. Config — everything except characters, botPresets, modules
        const configData = { ...data };
        delete configData.characters;
        delete configData.botPresets;
        delete configData.modules;
        db.setConfig(configData);
        console.log(`[Migrate] Config: saved (${Object.keys(configData).length} fields)`);

        // 2. Characters + Chats + Messages
        const characters = data.characters || [];
        let totalChats = 0;
        let totalMessages = 0;

        for (let i = 0; i < characters.length; i++) {
            const char = characters[i];
            const chaId = char.chaId || generateId();
            char.chaId = chaId;

            // Extract chats
            const chats = char.chats || [];
            const charData = { ...char };
            delete charData.chats;

            db.upsertCharacter(chaId, {
                ...charData,
                name: char.name || `Character ${i}`,
                type: char.type || 'character',
                image: char.image || null,
                lastInteraction: char.lastInteraction || null,
            });

            for (let j = 0; j < chats.length; j++) {
                const chat = chats[j];
                const chatId = `${chaId}_chat_${j}`;
                const messages = chat.message || [];

                const chatMeta = { ...chat };
                delete chatMeta.message;

                db.upsertChat(chatId, chaId, {
                    ...chatMeta,
                    name: chat.name || null,
                    chatPage: j,
                });

                if (messages.length > 0) {
                    db.insertMessages(chatId, messages);
                    totalMessages += messages.length;
                }
                totalChats++;
            }
        }
        console.log(`[Migrate] Characters: ${characters.length}, Chats: ${totalChats}, Messages: ${totalMessages}`);

        // 3. Presets
        const presets = data.botPresets || [];
        for (const preset of presets) {
            db.upsertPreset(null, preset);
        }
        console.log(`[Migrate] Presets: ${presets.length}`);

        // 4. Modules
        const modules = data.modules || [];
        for (const mod of modules) {
            if (mod.name) {
                db.upsertModule(mod.name, mod);
            }
        }
        console.log(`[Migrate] Modules: ${modules.length}`);

        sqlite.exec('COMMIT');

        const elapsed = Date.now() - startTime;
        console.log(`[Migrate] Migration completed in ${elapsed}ms`);

        // Keep original file (don't move — client still uses it during dual-write period)
        console.log(`[Migrate] Original database.bin preserved for dual-write compatibility.`);

        return true;
    } catch (e) {
        console.error('[Migrate] Migration failed, rolling back:', e.message);
        sqlite.exec('ROLLBACK');
        return false;
    }
}

module.exports = { migrate, decodeDatabase };
