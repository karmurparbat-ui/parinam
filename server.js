const express = require('express');
const cors = require('cors');
const path = require('path');
const qrcode = require('qrcode');
const waModule = require('./whatsapp.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 🔒 સિક્યોરિટી: WhatsApp સેશન ફોલ્ડરને બ્રાઉઝરમાંથી એક્સેસ ન થાય તે માટે બ્લોક કરો
app.use('/whatsapp_sessions', (req, res) => res.status(404).end());

app.get('/vendor/html2canvas.min.js', (req, res) => {
    res.sendFile(require.resolve('html2canvas/dist/html2canvas.min.js'));
});

// 👉 તમારું ફ્રન્ટએન્ડ (HTML, JS, CSS, Images) સર્વ કરવા માટે
// ધારો કે બધી ફાઇલો આ જ ફોલ્ડરમાં છે
app.use(express.static(__dirname));

// ============================================================
// WhatsApp API Routes
// ============================================================
// હાલમાં એક જ શાળા માટે 'school1' વાપરીએ છીએ. SaaS માં આ ડાયનેમિક થશે.
const BUSINESS_ID = 'school1';

// 1. QR Code મેળવવા
app.get('/api/whatsapp/qr', async (req, res) => {
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
    res.json(waModule.getWhatsAppStatus(BUSINESS_ID));
});

// 3. Reset કરવા (Disconnect)
app.post('/api/whatsapp/reset', async (req, res) => {
    try {
        await waModule.resetWhatsAppSession(BUSINESS_ID);
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
        const result = await waModule.sendWhatsAppMessage(BUSINESS_ID, normalizedPhone, message, media);
        if (!result.success) {
            return res.status(502).json({ error: result.error });
        }
        res.json(result);
    } catch (error) {
        console.error('WhatsApp send error:', error);
        res.status(500).json({ error: 'મેસેજ મોકલી શકાયો નથી.' });
    }
});

// ============================================================
// Server ચાલુ કરો
// ============================================================
const PORT = process.env.PORT || 3001; // પોર્ટ 3001 (જો 3000 પર બીજું ચાલતું હોય તો)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📱 WhatsApp setup: http://localhost:${PORT}/whatsapp_setup.html`);
    });
}

module.exports = app;