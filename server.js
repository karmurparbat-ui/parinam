const express = require('express');
const path = require('path');
const fs = require('node:fs');
const qrcode = require('qrcode');
const waModule = require('./whatsapp.js');
const { openStore } = require('./saas-store');
const { installSaas } = require('./saas-api');

function createApp({ store = openStore() } = {}) {
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.locals.store = store;
app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
});
app.use(['/api/auth', '/api/admin', '/api/school/teachers'], express.json({ limit: '8kb' }));
app.use(express.json({ limit: '50mb' }));
installSaas(app, store);

app.get('/vendor/html2canvas.min.js', (req, res) => {
    res.sendFile(require.resolve('html2canvas/dist/html2canvas.min.js'));
});

// ============================================================
// WhatsApp API Routes
// ============================================================
// 1. QR Code મેળવવા
app.get('/api/whatsapp/qr', async (req, res) => {
    const BUSINESS_ID = req.account.school_id;
    try {
        await waModule.getWhatsAppSession(BUSINESS_ID);
        const startedAt = Date.now();
        while (!res.destroyed) {
            const status = waModule.getWhatsAppStatus(BUSINESS_ID);
            if (status.error) {
                return res.status(409).json({ success: false, error: status.error });
            }
            if (status.connected) {
                return res.json({ success: true, connected: true });
            }
            if (waModule.qrCodes[BUSINESS_ID]) {
                const qr = await qrcode.toDataURL(waModule.qrCodes[BUSINESS_ID]);
                return res.json({ success: true, qr });
            }
            if (Date.now() - startedAt >= 15000) {
                return res.json({ success: false, message: 'QR તૈયાર થવામાં વધુ સમય લાગી રહ્યો છે. ફરી બટન દબાવો.' });
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    } catch (error) {
        console.error("QR Error:", error);
        if (!res.destroyed) res.status(500).json({ error: error.message });
    }
});

// 2. Status ચેક કરવા (Connected છે કે નહીં)
app.get('/api/whatsapp/status', (req, res) => {
    res.json(waModule.getWhatsAppStatus(req.account.school_id));
});

// 3. Reset કરવા (Disconnect)
app.post('/api/whatsapp/reset', async (req, res) => {
    try {
        await waModule.resetWhatsAppSession(req.account.school_id);
        res.json({ message: 'WhatsApp session reset થઈ ગયું.' });
    } catch (error) {
        console.error('WhatsApp reset failed:', error);
        res.status(500).json({ error: 'Reset થઈ શક્યું નથી: ' + error.message });
    }
});

// 4. મેસેજ મોકલવા
app.post('/api/whatsapp/send', async (req, res) => {
    const { phone, message = '', image } = req.body || {};
    if (!phone || typeof message !== 'string' || (!message.trim() && !image)) {
        return res.status(400).json({ error: 'મોબાઇલ નંબર સાથે સંદેશ અથવા પરિણામની image જરૂરી છે.' });
    }
    let normalizedPhone = String(phone).replace(/\D/g, '');
    if (normalizedPhone.length === 10) normalizedPhone = '91' + normalizedPhone;
    if (!/^[1-9]\d{10,14}$/.test(normalizedPhone)) {
        return res.status(400).json({ error: 'માન્ય મોબાઇલ નંબર દાખલ કરો.' });
    }
    let media;
    if (image !== undefined) {
        const match = typeof image === 'string' && image.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/);
        if (!match || match[2].length % 4 !== 0) {
            return res.status(400).json({ error: 'પરિણામ માટે માન્ય JPEG અથવા PNG image જરૂરી છે.' });
        }
        const buffer = Buffer.from(match[2], 'base64');
        const validSignature = match[1] === 'jpeg'
            ? buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
            : buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        if (!validSignature || buffer.length > 10 * 1024 * 1024) {
            return res.status(400).json({ error: 'માન્ય image મોકલો (વધુમાં વધુ 10 MB).' });
        }
        if (message.length > 1024) {
            return res.status(400).json({ error: 'Image સાથેનો સંદેશ વધુમાં વધુ 1024 અક્ષરનો હોવો જોઈએ.' });
        }
        media = { buffer, mimetype: `image/${match[1]}` };
    }
    try {
        const result = await waModule.sendWhatsAppMessage(req.account.school_id, normalizedPhone, message, media);
        if (!result.success) {
            return res.status(502).json({ error: result.error });
        }
        res.json(result);
    } catch (error) {
        console.error('WhatsApp send error:', error);
        res.status(500).json({ error: 'મેસેજ મોકલી શકાયો નથી.' });
    }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API મળી નથી.' }));

const pages = new Set([
    'index.html', 'home.html', 'home_std1.html', 'home_std2.html', 'hpc_std1.html',
    'covers.html', 'marksheet.html', 'marks_entry.html', 'marks_entry_std2.html',
    'patrak_b.html', 'patrak_c_front.html', 'patrak_f.html', 'patrak_std2.html',
    'result.html', 'school_info.html', 'whatsapp_setup.html',
    'login.html', 'admin.html', 'school_admin.html', 'account.html'
]);
const assets = new Set([
    'db.js', 'std2_db.js', 'std2_config.js', 'names_dictionary.js', 'whatsapp_result.js',
    'auth-client.js', 'saas-ui.js', 'saas.css', 'responsive.css', 'frame.png', 'saraswati.png', 'saraswati2.png'
]);
app.get('/', (req, res) => res.redirect('/index.html'));
app.get('/{*file}', (req, res, next) => {
    const file = req.path.slice(1);
    if (pages.has(file)) {
        if (req.query.std !== undefined && !/^[1-8]$/.test(req.query.std)) return res.status(400).send('માન્ય ધોરણ પસંદ કરો.');
        if (req.query.exam !== undefined && !['Sem1', 'Sem2', 'Annual'].includes(req.query.exam)) return res.status(400).send('માન્ય પરીક્ષા પસંદ કરો.');
        if (file !== 'login.html') {
            if (!req.account) return res.redirect('/login.html');
            const account = req.account;
            if (file === 'admin.html' && account.role !== 'admin') return res.redirect('/index.html');
            if (account.role === 'admin' && !['admin.html', 'account.html'].includes(file)) return res.redirect('/admin.html');
            if (account.role !== 'admin' && file !== 'account.html') {
                if (account.school_status !== 'active' || !account.valid_until || account.valid_until < Date.now()) return res.redirect('/account.html');
                if (['school_admin.html', 'school_info.html'].includes(file) && account.role !== 'principal') {
                    return res.status(403).send('આ પેજ ફક્ત Principal માટે છે. ધોરણના ડેશબોર્ડ પર પાછા જાઓ.');
                }
            }
        }
        res.set('Cache-Control', 'no-store');
        return fs.readFile(path.join(__dirname, file), 'utf8', (error, html) => {
            if (error) return next(error);
            res.type('html').send(html.replace(/<head>/i, '<head><script src="/auth-client.js"></script><link rel="stylesheet" href="/responsive.css">'));
        });
    }
    if (assets.has(file) || /^cover-design\/(?:templates\.json|(?:previews|backgrounds|overlays)\/[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg))$/.test(file)) {
        return res.sendFile(path.join(__dirname, file));
    }
    next();
});
app.use((req, res) => res.status(404).send('Not found'));
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    if (status >= 500) console.error('Request failed:', error);
    res.status(status).json({ error: status >= 500 ? 'સર્વરમાં ભૂલ થઈ છે. ફરી પ્રયત્ન કરો અથવા Adminનો સંપર્ક કરો.' : error.message });
});
return app;
}

const PORT = process.env.PORT || 3001; // પોર્ટ 3001 (જો 3000 પર બીજું ચાલતું હોય તો)
if (require.main === module) {
    if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));
    const app = createApp();
    const port = process.env.PORT || PORT;
    app.listen(port, () => {
        console.log(`🚀 Server running on http://localhost:${port}`);
        console.log(`School login: http://localhost:${port}/login.html`);
    });
}

module.exports = { createApp };