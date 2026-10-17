const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '..', 'whatsapp.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}

function createHarness() {
    const sockets = [];
    const trace = [];
    const timers = new Set();
    const controls = {
        saveCreds: async () => { trace.push('save'); },
        fetchVersion: async () => ({ version: [2, 3000, 1] }),
        remove: async () => { trace.push('remove'); },
        send: async () => ({ key: { id: 'sent' } }),
        upload: async () => ({ mediaUrl: 'https://example.invalid/image', directPath: '/image' })
    };
    const fileSystem = {
        promises: {
            mkdir: async () => { trace.push('mkdir'); },
            rm: async () => controls.remove()
        }
    };
    const library = {
        useMultiFileAuthState: async () => ({
            state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } },
            saveCreds: () => controls.saveCreds()
        }),
        fetchLatestBaileysVersion: () => controls.fetchVersion(),
        makeCacheableSignalKeyStore: keys => keys,
        DisconnectReason: {
            loggedOut: 401, connectionReplaced: 440, badSession: 500,
            multideviceMismatch: 411, forbidden: 403
        },
        makeWASocket: options => {
            let closed = false;
            const socket = {
                options,
                ev: new EventEmitter(),
                sendCalls: [],
                sendMessage: async (...args) => {
                    socket.sendCalls.push(args);
                    return controls.send(...args);
                },
                waUploadToServer: (...args) => controls.upload(...args),
                disconnect: code => {
                    closed = true;
                    socket.ev.emit('connection.update', {
                        connection: 'close',
                        lastDisconnect: { error: { output: { statusCode: code } } }
                    });
                },
                end: async () => {
                    trace.push('end');
                    if (!closed) socket.disconnect(428);
                }
            };
            sockets.push(socket);
            return socket;
        }
    };
    const context = vm.createContext({
        require: name => name === 'fs' ? fileSystem : require(name),
        module: { exports: {} },
        __dirname: path.join(__dirname, '..'),
        console: {
            log: (...args) => trace.push(['log', ...args]),
            warn: (...args) => trace.push(['warn', ...args]),
            error: (...args) => trace.push(['error', ...args])
        },
        setTimeout: (callback, delay) => {
            const timer = { callback, delay };
            timers.add(timer);
            return timer;
        },
        clearTimeout: timer => { timers.delete(timer); },
        Buffer
    });
    vm.runInContext(source, context);
    context.testLibrary = library;
    vm.runInContext('baileys = testLibrary;', context);
    return { api: context.module.exports, controls, sockets, trace, timers, context };
}

async function connectedHarness() {
    const harness = createHarness();
    const socket = await harness.api.getWhatsAppSession('school1');
    socket.ev.emit('connection.update', { connection: 'open' });
    return { ...harness, socket };
}

test('concurrent callers create only one socket', async () => {
    const h = createHarness();
    const sockets = await Promise.all(Array.from({ length: 10 }, () => h.api.getWhatsAppSession('school1')));
    assert.equal(h.sockets.length, 1);
    assert.ok(sockets.every(socket => socket === h.sockets[0]));
});

test('reset drains credential writes, then deletes files, then allows reconnection', async () => {
    const h = await connectedHarness();
    const started = deferred();
    const saving = deferred();
    h.controls.saveCreds = async () => {
        started.resolve();
        await saving.promise;
        h.trace.push('save-finished');
    };
    h.socket.ev.emit('creds.update', {});
    await started.promise;
    const reset = h.api.resetWhatsAppSession('school1');
    const reconnect = h.api.getWhatsAppSession('school1');
    await flush();
    assert.equal(h.trace.includes('remove'), false);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.api.isWhatsAppConnected('school1'), false);
    saving.resolve();
    await reset;
    const newSocket = await reconnect;
    assert.ok(h.trace.indexOf('save-finished') < h.trace.indexOf('remove'));
    assert.notEqual(newSocket, h.socket);
    assert.equal(h.sockets.length, 2);
    assert.equal(h.socket.ev.listenerCount('creds.update'), 0);
    const before = h.trace.length;
    h.socket.ev.emit('creds.update', {});
    await flush();
    assert.equal(h.trace.length, before);
    assert.equal(h.timers.size, 0);
});

test('reset during session creation does not create an orphan socket', async () => {
    const h = createHarness();
    const started = deferred();
    const version = deferred();
    h.controls.fetchVersion = () => { started.resolve(); return version.promise; };
    const creation = h.api.getWhatsAppSession('school1');
    const rejection = assert.rejects(creation, error => error.code === 'SESSION_STOPPED');
    await started.promise;
    const reset = h.api.resetWhatsAppSession('school1');
    version.resolve({ version: [2, 3000, 1] });
    await rejection;
    await reset;
    assert.equal(h.sockets.length, 0);
    assert.equal(h.trace.filter(value => value === 'remove').length, 1);
});

test('missing auth directory is recreated and the failed write is retried once', async () => {
    const h = await connectedHarness();
    let writes = 0;
    h.controls.saveCreds = async () => {
        writes++;
        if (writes === 1) throw Object.assign(new Error('Directory missing'), { code: 'ENOENT' });
    };
    h.socket.ev.emit('creds.update', {});
    await flush();
    assert.equal(writes, 2);
    assert.equal(h.api.isWhatsAppConnected('school1'), true);
    assert.equal(h.api.getWhatsAppStatus('school1').error, null);
});

test('credential write errors are handled, displayed and stop reconnecting', async () => {
    const h = await connectedHarness();
    h.controls.saveCreds = async () => {
        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    };
    h.socket.ev.emit('creds.update', {});
    await flush();
    assert.equal(h.api.isWhatsAppConnected('school1'), false);
    assert.match(h.api.getWhatsAppStatus('school1').error, /OneDrive/);
    await assert.rejects(h.api.getWhatsAppSession('school1'), error => error.code === 'AUTH_STORAGE_FAILED');
    assert.equal(h.timers.size, 0);
});

test('restart 515 drains old writes and ignores old socket events', async () => {
    const h = await connectedHarness();
    const started = deferred();
    const saving = deferred();
    h.controls.saveCreds = async () => { started.resolve(); await saving.promise; };
    h.socket.ev.emit('creds.update', {});
    await started.promise;
    h.socket.disconnect(515);
    const reconnect = h.api.getWhatsAppSession('school1');
    await flush();
    assert.equal(h.sockets.length, 1);
    saving.resolve();
    const newSocket = await reconnect;
    newSocket.ev.emit('connection.update', { connection: 'open' });
    h.socket.ev.emit('connection.update', { connection: 'open', qr: 'stale QR' });
    assert.equal(h.api.sessions.school1, newSocket);
    assert.equal(h.api.qrCodes.school1, undefined);
    assert.equal(h.api.isWhatsAppConnected('school1'), true);
    assert.equal(h.timers.size, 0);
});

test('440 is terminal until an explicit successful reset', async () => {
    const h = await connectedHarness();
    h.socket.disconnect(440);
    await assert.rejects(h.api.getWhatsAppSession('school1'), error => error.code === 'LOGIN_REQUIRED');
    assert.equal(h.timers.size, 0);
    assert.equal(h.sockets.length, 1);
    await h.api.resetWhatsAppSession('school1');
    await h.api.getWhatsAppSession('school1');
    assert.equal(h.sockets.length, 2);
});

test('reset deletion failures propagate instead of reporting success', async () => {
    const h = await connectedHarness();
    h.controls.remove = async () => { throw Object.assign(new Error('Delete denied'), { code: 'EACCES' }); };
    await assert.rejects(h.api.resetWhatsAppSession('school1'), error => error.code === 'EACCES');
    assert.equal(h.api.isWhatsAppConnected('school1'), false);
});

test('image sends pass a real upload timeout and identify upload failures without resending', async () => {
    const h = await connectedHarness();
    const uploadCalls = [];
    h.controls.upload = async (...args) => {
        uploadCalls.push(args);
        throw new Error('Upload timeout');
    };
    h.controls.send = async (jid, content, options) => {
        assert.equal(options.mediaUploadTimeoutMs, 30000);
        return options.upload('encrypted-file', { mediaType: 'image', timeoutMs: options.mediaUploadTimeoutMs });
    };
    const result = await h.api.sendWhatsAppMessage('school1', '9876500001', 'Caption', {
        buffer: Buffer.from('test image'), mimetype: 'image/jpeg'
    });
    assert.equal(result.success, false);
    assert.match(result.error, /Upload timeout.*image upload/);
    assert.equal(uploadCalls[0][1].timeoutMs, 30000);
    assert.equal(h.socket.sendCalls.length, 1);
    assert.equal(h.socket.ev.listenerCount('connection.update'), 1);
});

test('a send timeout never retries or overlaps the still-running send', async () => {
    const h = await connectedHarness();
    const pending = deferred();
    h.controls.send = () => pending.promise;
    const sending = h.api.sendWhatsAppMessage('school1', '9876500001', 'Caption');
    await flush();
    assert.equal(h.socket.sendCalls.length, 1);
    assert.equal((await h.api.sendWhatsAppMessage('school1', '9876500001', 'Duplicate')).success, false);
    const deadline = Array.from(h.timers).find(timer => timer.delay === 120000);
    assert.ok(deadline);
    deadline.callback();
    const result = await sending;
    assert.equal(result.success, false);
    assert.match(result.error, /message send/);
    assert.equal((await h.api.sendWhatsAppMessage('school1', '9876500001', 'Another duplicate')).success, false);
    assert.equal(h.socket.sendCalls.length, 1);
    pending.resolve({ key: { id: 'late-message' } });
    await flush();
    assert.equal((await h.api.sendWhatsAppMessage('school1', '9876500001', 'New send')).success, true);
    assert.equal(h.socket.sendCalls.length, 2);
    assert.equal(h.timers.size, 0);
    assert.equal(h.socket.ev.listenerCount('connection.update'), 1);
});

test('reset cancels a send waiting for its socket rather than sending on the replacement login', async () => {
    const h = await connectedHarness();
    const sending = h.api.sendWhatsAppMessage('school1', '9876500001', 'Before reset');
    const reset = h.api.resetWhatsAppSession('school1');
    await reset;
    const result = await sending;
    assert.equal(result.success, false);
    assert.equal(h.socket.sendCalls.length, 0);
    assert.equal(h.api.isWhatsAppConnected('school1'), false);
});

test('unknown message retries do not send a fabricated Hello message', async () => {
    const h = await connectedHarness();
    assert.equal(await h.socket.options.getMessage({ id: 'missing' }), undefined);
    const message = { conversation: 'Actual message' };
    h.socket.ev.emit('messages.upsert', { messages: [{ key: { id: 'known' }, message }], type: 'append' });
    assert.equal(await h.socket.options.getMessage({ id: 'known' }), message);
});
