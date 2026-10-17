const pino = require('pino');
const fs = require('fs');
const path = require('path');

const sessions = {};
const qrCodes = {};
const pendingSessions = {};
const connectedState = {};
const reconnectTimers = {};
const contexts = {};
const generations = {};
const resets = {};
const sessionErrors = {};
const activeSends = {};
const logger = pino({ level: 'warn' });
const QUERY_TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 30000;
const SEND_TIMEOUT_MS = 120000;

let baileys = null;
async function loadBaileys() {
    if (!baileys) {
        const module = await import('@whiskeysockets/baileys');
        baileys = { ...module, ...module.default };
    }
    return baileys;
}

function stoppedError() {
    const error = new Error('WhatsApp સેશન બંધ અથવા Reset થયું છે. ફરી કનેક્ટ કરો.');
    error.code = 'SESSION_STOPPED';
    return error;
}

function assertActive(context) {
    if (!context.active || context.generation !== (generations[context.businessId] || 0)) {
        throw stoppedError();
    }
}

async function authOperation(context, operation) {
    assertActive(context);
    const task = (async () => {
        await fs.promises.mkdir(context.directory, { recursive: true });
        try {
            return await operation();
        } catch (error) {
            if (error.code !== 'ENOENT' || !context.active) throw error;
            console.warn(`WhatsApp session folder disappeared for ${context.businessId}; recreating it.`);
            await fs.promises.mkdir(context.directory, { recursive: true });
            return operation();
        }
    })();
    context.authTasks.add(task);
    try {
        return await task;
    } catch (error) {
        console.error(`WhatsApp session storage failed for ${context.businessId}:`, error.message);
        if (context.active && contexts[context.businessId] === context) {
            const storageError = new Error('WhatsApp session સાચવી શકાઈ નથી. Folderની permission / OneDrive તપાસો અને ફરી કનેક્ટ કરો.');
            storageError.code = 'AUTH_STORAGE_FAILED';
            sessionErrors[context.businessId] = storageError;
            connectedState[context.businessId] = false;
            if (context.sock) {
                Promise.resolve(context.sock.end(storageError)).catch(closeError => {
                    console.error('WhatsApp socket close failed:', closeError.message);
                });
            }
        }
        throw error;
    } finally {
        context.authTasks.delete(task);
    }
}

async function stopContext(context) {
    if (!context) return;
    context.active = false;
    if (!context.stopping) {
        context.stopping = (async () => {
            if (context.sock) {
                context.sock.ev.off('creds.update', context.onCreds);
                await context.sock.end(stoppedError());
            }
            // No new auth operations can start after deactivation. Drain existing writes before deleting files.
            await Promise.allSettled(Array.from(context.authTasks));
        })();
    }
    return context.stopping;
}

async function getWhatsAppSession(businessId) {
    if (resets[businessId]) await resets[businessId];
    if (sessionErrors[businessId]) throw sessionErrors[businessId];
    if (sessions[businessId]) return sessions[businessId];
    if (pendingSessions[businessId]) return pendingSessions[businessId];
    clearTimeout(reconnectTimers[businessId]);
    delete reconnectTimers[businessId];

    const creation = createSession(businessId);
    pendingSessions[businessId] = creation;
    try {
        return await creation;
    } finally {
        if (pendingSessions[businessId] === creation) delete pendingSessions[businessId];
    }
}

async function createSession(businessId) {
    const previous = contexts[businessId];
    const context = {
        businessId,
        generation: generations[businessId] || 0,
        directory: path.join(__dirname, 'whatsapp_sessions', `business_${businessId}`),
        active: true,
        authTasks: new Set(),
        messages: new Map()
    };
    contexts[businessId] = context;
    try {
        await stopContext(previous);
        assertActive(context);
        const {
            makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion,
            makeCacheableSignalKeyStore, DisconnectReason
        } = await loadBaileys();
        assertActive(context);
        await fs.promises.mkdir(context.directory, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(context.directory);
        const { version } = await fetchLatestBaileysVersion();
        assertActive(context);
        const keys = {
            get: (...args) => authOperation(context, () => state.keys.get(...args)),
            set: (...args) => authOperation(context, () => state.keys.set(...args))
        };
        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(keys, logger)
            },
            logger,
            browser: ['School Result', 'Chrome', '1.0'],
            markOnlineOnConnect: false,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            defaultQueryTimeoutMs: QUERY_TIMEOUT_MS,
            keepAliveIntervalMs: 15000,
            connectTimeoutMs: 60000,
            getMessage: async key => context.messages.get(key.id)
        });
        context.sock = sock;
        sessions[businessId] = sock;
        connectedState[businessId] = false;
        context.onCreds = () => {
            if (!context.active) return;
            // Event emitters do not await async listeners; handle persistence failures at their source.
            return authOperation(context, saveCreds).catch(() => {
                // authOperation reports the error and stops the affected session.
            });
        };
        sock.ev.on('creds.update', context.onCreds);
        sock.ev.on('messages.upsert', ({ messages }) => {
            if (!context.active) return;
            for (const message of messages) {
                if (message.key?.id && message.message) {
                    context.messages.set(message.key.id, message.message);
                }
            }
            while (context.messages.size > 1000) {
                context.messages.delete(context.messages.keys().next().value);
            }
        });
        sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
            if (!context.active || sessions[businessId] !== sock) return;
            if (qr) qrCodes[businessId] = qr;
            if (connection === 'open') {
                connectedState[businessId] = true;
                delete qrCodes[businessId];
                console.log(`✅ Business ${businessId} WhatsApp Connected!`);
            }
            if (connection === 'close') {
                context.active = false;
                sock.ev.off('creds.update', context.onCreds);
                delete sessions[businessId];
                delete qrCodes[businessId];
                connectedState[businessId] = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                const terminalCodes = [
                    DisconnectReason.loggedOut, DisconnectReason.badSession,
                    DisconnectReason.connectionReplaced, DisconnectReason.multideviceMismatch,
                    DisconnectReason.forbidden
                ];
                if (code !== undefined && terminalCodes.includes(code)) {
                    const error = new Error(code === DisconnectReason.connectionReplaced
                        ? 'આ WhatsApp સેશન બીજી જગ્યાએ ચાલુ છે. બીજો server બંધ કરો, પછી Setupમાં Reset કરીને QR ફરી સ્કેન કરો.'
                        : 'WhatsApp લોગિન અમાન્ય અથવા બંધ થયું છે. Setupમાં Reset કરીને QR ફરી સ્કેન કરો.');
                    error.code = 'LOGIN_REQUIRED';
                    sessionErrors[businessId] = error;
                }
                const reconnect = !sessionErrors[businessId];
                console.log(`Connection closed for business ${businessId}, reconnecting: ${reconnect} (Code: ${code})`);
                if (reconnect) {
                    reconnectTimers[businessId] = setTimeout(() => {
                        delete reconnectTimers[businessId];
                        getWhatsAppSession(businessId).catch(error => {
                            console.error('WhatsApp reconnect failed:', error.message);
                        });
                    }, 3000);
                }
            }
        });
        return sock;
    } catch (error) {
        await stopContext(context);
        throw error;
    }
}

async function waitForConnection(businessId, generation, timeoutMs = 60000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (generation !== (generations[businessId] || 0)) throw stoppedError();
        const sock = await getWhatsAppSession(businessId);
        if (generation !== (generations[businessId] || 0)) throw stoppedError();
        if (connectedState[businessId] && sessions[businessId] === sock) return sock;
        if (qrCodes[businessId]) {
            throw new Error('WhatsApp લોગિન નથી. પહેલા Setupમાં QR સ્કેન કરો.');
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('WhatsApp connection તૈયાર થયું નથી. Setup અને ઇન્ટરનેટ તપાસો.');
}

async function sendWhatsAppMessage(businessId, phone, message, media) {
    if (resets[businessId]) {
        return { success: false, error: 'WhatsApp Reset થઈ રહ્યું છે. પ્રક્રિયા પૂરી થયા પછી ફરી કનેક્ટ કરો.' };
    }
    if (activeSends[businessId]) {
        return { success: false, error: 'અગાઉનો WhatsApp મેસેજ હજી પ્રક્રિયામાં છે. થોડી વાર પછી ફરી પ્રયત્ન કરો.' };
    }
    const job = { pending: false, finished: false };
    const generation = generations[businessId] || 0;
    activeSends[businessId] = job;
    const release = () => {
        if (job.finished && !job.pending && activeSends[businessId] === job) delete activeSends[businessId];
    };
    let stage = 'connection';
    let timeout;
    let sock;
    let onClose;
    try {
        let formattedPhone = String(phone).replace(/\D/g, '');
        if (formattedPhone.length === 10) formattedPhone = '91' + formattedPhone;
        if (!/^[1-9]\d{10,14}$/.test(formattedPhone)) throw new Error('માન્ય મોબાઇલ નંબર દાખલ કરો.');
        sock = await waitForConnection(businessId, generation);
        const content = media
            ? { image: media.buffer, mimetype: media.mimetype, caption: message }
            : { text: message };
        stage = media ? 'image preparation' : 'message send';
        const options = {
            mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS,
            ...(media ? {
                upload: async (...args) => {
                    stage = 'image upload';
                    console.log(`WhatsApp image upload started for business ${businessId}`);
                    const uploaded = await sock.waUploadToServer(...args);
                    stage = 'message send';
                    console.log(`WhatsApp image upload completed for business ${businessId}`);
                    return uploaded;
                }
            } : {})
        };
        const disconnected = new Promise((_, reject) => {
            onClose = ({ connection }) => {
                if (connection === 'close') reject(new Error('મોકલતી વખતે WhatsApp connection બંધ થયું. Setup તપાસો.'));
            };
            sock.ev.on('connection.update', onClose);
        });
        job.pending = true;
        const operation = Promise.resolve().then(() => {
            if (generation !== (generations[businessId] || 0) || sessions[businessId] !== sock || !connectedState[businessId]) {
                throw stoppedError();
            }
            return sock.sendMessage(formattedPhone + '@s.whatsapp.net', content, options);
        });
        operation.then(() => { job.pending = false; release(); }, () => { job.pending = false; release(); });
        // An outer timeout cannot cancel an upload. Never retry or allow overlapping sends while it is unsettled.
        await Promise.race([
            operation,
            disconnected,
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    const error = new Error('WhatsApp મોકલવાનો સમય પૂરો થયો. મેસેજ પહોંચ્યો હોઈ શકે; વાલીના WhatsAppમાં તપાસ્યા પછી જ ફરી મોકલો.');
                    error.code = 'SEND_TIMEOUT';
                    reject(error);
                }, SEND_TIMEOUT_MS);
            })
        ]);
        console.log(`✅ WhatsApp message submitted for business ${businessId}`);
        return { success: true, message: 'મેસેજ સફળતાપૂર્વક મોકલાઈ ગયો!' };
    } catch (error) {
        console.error(`WhatsApp send failed for business ${businessId} (${stage}):`, error.message);
        return { success: false, error: `${error.message} (તબક્કો: ${stage})` };
    } finally {
        clearTimeout(timeout);
        if (sock && onClose) sock.ev.off('connection.update', onClose);
        job.finished = true;
        release();
    }
}

function isWhatsAppConnected(businessId) {
    return Boolean(!resets[businessId] && !sessionErrors[businessId] && sessions[businessId] && connectedState[businessId]);
}

function getWhatsAppStatus(businessId) {
    return {
        connected: isWhatsAppConnected(businessId),
        error: sessionErrors[businessId]?.message || null
    };
}

async function resetWhatsAppSession(businessId) {
    if (resets[businessId]) return resets[businessId];
    generations[businessId] = (generations[businessId] || 0) + 1;
    const context = contexts[businessId];
    if (context) context.active = false;
    delete sessions[businessId];
    delete qrCodes[businessId];
    connectedState[businessId] = false;
    clearTimeout(reconnectTimers[businessId]);
    delete reconnectTimers[businessId];
    const creation = pendingSessions[businessId];
    const reset = (async () => {
        if (creation) {
            try {
                await creation;
            } catch (error) {
                if (error.code !== 'SESSION_STOPPED') {
                    console.error('WhatsApp creation failed during reset:', error.message);
                }
            }
        }
        await stopContext(context);
        const directory = path.join(__dirname, 'whatsapp_sessions', `business_${businessId}`);
        await fs.promises.rm(directory, { recursive: true, force: true });
        if (contexts[businessId] === context) delete contexts[businessId];
        delete sessionErrors[businessId];
    })();
    resets[businessId] = reset;
    try {
        await reset;
    } finally {
        if (resets[businessId] === reset) delete resets[businessId];
    }
}

module.exports = {
    getWhatsAppSession, sendWhatsAppMessage, resetWhatsAppSession,
    isWhatsAppConnected, getWhatsAppStatus, qrCodes, sessions
};
