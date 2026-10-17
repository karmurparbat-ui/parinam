const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const waModule = require('../whatsapp');
const app = require('../server');

const originalSend = waModule.sendWhatsAppMessage;
const calls = [];
const png = fs.readFileSync(path.join(__dirname, '..', 'frame.png'));
const image = 'data:image/png;base64,' + png.toString('base64');
let server;
let baseUrl;

before(async () => {
    waModule.sendWhatsAppMessage = async (...args) => {
        calls.push(args);
        return { success: true };
    };
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    waModule.sendWhatsAppMessage = originalSend;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function post(body) {
    return fetch(`${baseUrl}/api/whatsapp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

test('accepts result image and teacher caption, decoding the exact image bytes', async () => {
    const response = await post({ phone: '9876500001', message: 'Teacher message', image });
    assert.equal(response.status, 200);
    const [business, phone, caption, media] = calls.at(-1);
    assert.equal(business, 'school1');
    assert.equal(phone, '919876500001');
    assert.equal(caption, 'Teacher message');
    assert.equal(media.mimetype, 'image/png');
    assert.deepEqual(media.buffer, png);
});

test('supports image-only sends and preserves legacy text-only sends', async () => {
    assert.equal((await post({ phone: '9876500001', image })).status, 200);
    assert.equal(calls.at(-1)[2], '');
    assert.equal((await post({ phone: '9876500001', message: 'Text only' })).status, 200);
    assert.equal(calls.at(-1)[3], undefined);
});

test('accepts JPEG data from the browser renderer', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
    const response = await post({
        phone: '9876500001',
        message: 'Result caption',
        image: 'data:image/jpeg;base64,' + jpeg.toString('base64')
    });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1)[3].mimetype, 'image/jpeg');
    assert.deepEqual(calls.at(-1)[3].buffer, jpeg);
});

test('rejects invalid media, caption and phone without invoking WhatsApp', async () => {
    const beforeCount = calls.length;
    for (const body of [
        { phone: '9876500001', message: 'No media', image: 'bad' },
        { phone: '9876500001', image: 'data:image/png;base64,SGVsbG8=' },
        { phone: '9876500001', image, message: 'x'.repeat(1025) },
        { phone: '123', image },
        { phone: '9876500001', message: '' }
    ]) {
        assert.equal((await post(body)).status, 400);
    }
    assert.equal(calls.length, beforeCount);
});

test('allows caption at the exact 1024-character limit', async () => {
    assert.equal((await post({ phone: '9876500001', message: 'x'.repeat(1024), image })).status, 200);
});

test('rejects images larger than 10 MB', async () => {
    const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1);
    png.copy(tooLarge, 0, 0, 8);
    const count = calls.length;
    assert.equal((await post({
        phone: '9876500001',
        image: 'data:image/png;base64,' + tooLarge.toString('base64')
    })).status, 400);
    assert.equal(calls.length, count);
});

test('serves the local image renderer', async () => {
    const response = await fetch(`${baseUrl}/vendor/html2canvas.min.js`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /html2canvas/);
});

test('status reports the session error instead of showing a connected session', async () => {
    const original = waModule.getWhatsAppStatus;
    waModule.getWhatsAppStatus = () => ({ connected: false, error: 'Session storage failed' });
    try {
        const response = await fetch(`${baseUrl}/api/whatsapp/status`);
        assert.deepEqual(await response.json(), { connected: false, error: 'Session storage failed' });
    } finally {
        waModule.getWhatsAppStatus = original;
    }
});

test('QR endpoint recognizes an already connected session without waiting for a QR', async () => {
    const originalGet = waModule.getWhatsAppSession;
    const originalStatus = waModule.getWhatsAppStatus;
    waModule.getWhatsAppSession = async () => ({});
    waModule.getWhatsAppStatus = () => ({ connected: true, error: null });
    try {
        const response = await fetch(`${baseUrl}/api/whatsapp/qr`);
        assert.deepEqual(await response.json(), { success: true, connected: true });
    } finally {
        waModule.getWhatsAppSession = originalGet;
        waModule.getWhatsAppStatus = originalStatus;
    }
});

test('QR encoding errors are handled in the request rather than an unawaited timer', async () => {
    const qrcode = require('qrcode');
    const originalEncode = qrcode.toDataURL;
    const originalGet = waModule.getWhatsAppSession;
    const originalStatus = waModule.getWhatsAppStatus;
    waModule.getWhatsAppSession = async () => ({});
    waModule.getWhatsAppStatus = () => ({ connected: false, error: null });
    waModule.qrCodes.school1 = 'test QR';
    qrcode.toDataURL = async () => { throw new Error('QR encoding failed'); };
    try {
        const response = await fetch(`${baseUrl}/api/whatsapp/qr`);
        assert.equal(response.status, 500);
        assert.equal((await response.json()).error, 'QR encoding failed');
    } finally {
        delete waModule.qrCodes.school1;
        qrcode.toDataURL = originalEncode;
        waModule.getWhatsAppSession = originalGet;
        waModule.getWhatsAppStatus = originalStatus;
    }
});

test('installed Baileys media preparation forwards the upload deadline', async () => {
    const { prepareWAMessageMedia } = await import('@whiskeysockets/baileys');
    let uploadCount = 0;
    const prepared = await prepareWAMessageMedia({
        image: png,
        caption: 'Test result',
        mimetype: 'image/png',
        jpegThumbnail: Buffer.alloc(0)
    }, {
        mediaUploadTimeoutMs: 30000,
        upload: async (file, options) => {
            uploadCount++;
            assert.equal(options.timeoutMs, 30000);
            assert.equal(options.mediaType, 'image');
            assert.ok((await fs.promises.stat(file)).size > 0);
            return { mediaUrl: 'https://example.invalid/image', directPath: '/test-image' };
        }
    });
    assert.equal(uploadCount, 1);
    assert.equal(prepared.imageMessage.caption, 'Test result');
    assert.equal(prepared.imageMessage.mimetype, 'image/png');
});

test('send failures remain failures in the API', async () => {
    waModule.sendWhatsAppMessage = async () => ({ success: false, error: 'Disconnected' });
    try {
        const response = await post({ phone: '9876500001', image });
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error, 'Disconnected');
    } finally {
        waModule.sendWhatsAppMessage = async (...args) => {
            calls.push(args);
            return { success: true };
        };
    }
});

test('WhatsApp socket receives media with caption or the original text payload', async () => {
    const sent = [];
    const context = vm.createContext({
        require,
        module: { exports: {} },
        __dirname: path.join(__dirname, '..'),
        console,
        process: { on() {} },
        setTimeout,
        clearTimeout,
        Buffer
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'whatsapp.js'), 'utf8'), context);
    context.testSocket = {
        ev: new EventEmitter(),
        sendMessage: async (jid, content, options) => { sent.push({ jid, content, options }); }
    };
    vm.runInContext("sessions.school1 = testSocket; connectedState.school1 = true;", context);
    const send = context.module.exports.sendWhatsAppMessage;
    assert.equal((await send('school1', '9876500001', 'Caption', { buffer: png, mimetype: 'image/png' })).success, true);
    assert.equal(sent[0].jid, '919876500001@s.whatsapp.net');
    assert.equal(sent[0].content.caption, 'Caption');
    assert.equal(sent[0].content.mimetype, 'image/png');
    assert.deepEqual(sent[0].content.image, png);
    assert.equal(sent[0].options.mediaUploadTimeoutMs, 30000);
    assert.equal(typeof sent[0].options.upload, 'function');
    assert.equal((await send('school1', '9876500001', 'Legacy')).success, true);
    assert.equal(sent[1].content.text, 'Legacy');
    assert.equal(sent[1].content.image, undefined);
});
