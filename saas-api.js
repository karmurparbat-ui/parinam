const { randomBytes, randomUUID } = require('node:crypto');
const { hashPassword, verifyPassword, digest, transaction } = require('./saas-store');

const COOKIE = 'parinam_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const ROLES = ['admin', 'principal', 'teacher'];
const DUMMY_HASH = '0123456789abcdef0123456789abcdef:' + '00'.repeat(64);

function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
}

function text(value, label, max = 120) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
        fail(400, label + ' યોગ્ય રીતે દાખલ કરો.');
    }
    return value.trim();
}

function emailAddress(value) {
    const email = text(value, 'Email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'માન્ય Email દાખલ કરો.');
    return email;
}

function passwordValue(value) {
    if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
        fail(400, 'Password 12 થી 128 અક્ષરનો રાખો.');
    }
    return value;
}

function parseExpiry(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'માન્ય validity તારીખ પસંદ કરો.');
    const utc = new Date(date + 'T00:00:00Z');
    if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== date) fail(400, 'માન્ય validity તારીખ પસંદ કરો.');
    return new Date(date + 'T23:59:59.999+05:30').getTime();
}

function installSaas(app, db) {
    function audit(actor, action, target) {
        db.prepare('INSERT INTO audit_log(actor_id,action,target_id,created_at) VALUES(?,?,?,?)')
            .run(actor, action, target, Date.now());
    }

    function rateLimit(bucket, limit, duration) {
        const now = Date.now();
        db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(now);
        const record = db.prepare(`INSERT INTO rate_limits(bucket,attempts,reset_at) VALUES(?,1,?)
            ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts`).get(bucket, now + duration);
        if (record.attempts > limit) fail(429, 'ઘણા પ્રયત્ન થયા છે. થોડી વાર પછી ફરી પ્રયત્ન કરો.');
    }

    function cookie(req, token, maxAge) {
        return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;
    }

    app.use('/api', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            const origin = req.get('origin');
            if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) {
                return res.status(403).json({ error: 'બીજી site પરથી વિનંતી માન્ય નથી.' });
            }
            if (!req.is('application/json')) return res.status(415).json({ error: 'JSON વિનંતી જરૂરી છે.' });
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                return res.status(400).json({ error: 'માન્ય JSON માહિતી મોકલો.' });
            }
        }
        next();
    });

    app.use((req, res, next) => {
        const token = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='));
        if (token) {
            const hash = digest(token.slice(COOKIE.length + 1));
            const session = db.prepare(`SELECT sessions.csrf, sessions.expires_at, users.id, users.school_id,
                users.name, users.email, users.role, users.active, schools.name AS school_name,
                schools.status AS school_status, schools.valid_until
                FROM sessions JOIN users ON users.id=sessions.user_id
                LEFT JOIN schools ON schools.id=users.school_id
                WHERE sessions.token_hash=? AND sessions.expires_at>? AND users.active=1`).get(hash, Date.now());
            if (session) req.account = session;
            req.sessionHash = hash;
        }
        next();
    });

    function authenticated(req, res, next) {
        if (!req.account) return res.status(401).json({ error: 'ફરી login કરો.', code: 'LOGIN_REQUIRED' });
        if (req.get('x-account-id') && req.get('x-account-id') !== req.account.id) {
            return res.status(401).json({ error: 'બીજા ટેબમાં account બદલાયું છે. ફરી login કરો.', code: 'LOGIN_REQUIRED' });
        }
        if (!['GET', 'HEAD'].includes(req.method) && req.get('x-csrf-token') !== req.account.csrf) {
            return res.status(403).json({ error: 'Session સુરક્ષા ચકાસણી નિષ્ફળ. પેજ refresh કરો.' });
        }
        next();
    }

    function schoolActive(req, res, next) {
        const account = req.account;
        if (account.role === 'admin') return res.status(403).json({ error: 'Admin panel વાપરો.' });
        if (account.school_status !== 'active' || !account.valid_until || account.valid_until < Date.now()) {
            return res.status(403).json({ error: 'શાળા approval/renewal માટે Adminનો સંપર્ક કરો.', code: 'SCHOOL_INACTIVE' });
        }
        next();
    }

    function roles(...allowed) {
        return (req, res, next) => allowed.includes(req.account.role)
            ? next() : res.status(403).json({ error: 'આ કામગીરીની permission નથી.' });
    }

    function publicAccount(account) {
        return {
            id: account.id, name: account.name, email: account.email, role: account.role,
            schoolId: account.school_id, schoolName: account.school_name,
            schoolStatus: account.school_status, validUntil: account.valid_until,
            csrfToken: account.csrf
        };
    }

    app.post('/api/auth/register', async (req, res) => {
        rateLimit('register:' + req.ip, 5, 60 * 60 * 1000);
        const name = text(req.body.name, 'Principalનું નામ');
        const schoolName = text(req.body.schoolName, 'શાળાનું નામ', 200);
        const email = emailAddress(req.body.email);
        const password = await hashPassword(passwordValue(req.body.password));
        if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) fail(409, 'આ Emailથી account છે. Login કરો અથવા Adminનો સંપર્ક કરો.');
        const schoolId = randomUUID();
        const userId = randomUUID();
        transaction(db, () => {
            db.prepare('INSERT INTO schools(id,name,created_at) VALUES(?,?,?)').run(schoolId, schoolName, Date.now());
            db.prepare(`INSERT INTO users(id,school_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,'principal',?)`)
                .run(userId, schoolId, name, email, password, Date.now());
            audit(userId, 'school.register', schoolId);
        });
        res.status(201).json({ message: 'નોંધણી થઈ ગઈ. Admin approval પછી login કરીને કામ કરી શકશો.' });
    });

    app.post('/api/auth/login', async (req, res) => {
        rateLimit('login-ip:' + req.ip, 40, 15 * 60 * 1000);
        const email = emailAddress(req.body.email);
        rateLimit('login-email:' + digest(email), 12, 15 * 60 * 1000);
        const password = req.body.password;
        if (typeof password !== 'string' || password.length > 128) fail(400, 'માન્ય password દાખલ કરો.');
        const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        const verified = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
        // Password verification yields; recheck active state and password after it completes.
        const current = user && db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
        if (!verified || !current || !current.active || current.password_hash !== user.password_hash) fail(401, 'Email અથવા password ખોટો છે, અથવા account બંધ છે.');
        const token = randomBytes(32).toString('hex');
        db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
        if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token), user.id, randomBytes(32).toString('hex'), Date.now() + SESSION_MS);
        res.set('Set-Cookie', cookie(req, token, SESSION_MS / 1000));
        res.json({ message: 'Login સફળ.', role: current.role });
    });

    app.get('/api/auth/me', authenticated, (req, res) => res.json(publicAccount(req.account)));
    app.post('/api/auth/logout', authenticated, (req, res) => {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
        res.set('Set-Cookie', cookie(req, '', 0)).json({ message: 'Logout થયું.' });
    });
    app.post('/api/auth/password', authenticated, async (req, res) => {
        const currentPassword = req.body.currentPassword;
        if (typeof currentPassword !== 'string' || currentPassword.length > 128) fail(400, 'હાલનો password દાખલ કરો.');
        const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.account.id);
        rateLimit('password:' + user.id, 8, 15 * 60 * 1000);
        if (!await verifyPassword(currentPassword, user.password_hash)) fail(400, 'હાલનો password ખોટો છે.');
        const hash = await hashPassword(passwordValue(req.body.password));
        const changed = db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=? AND active=1')
            .run(hash, user.id, user.password_hash);
        if (!changed.changes) fail(409, 'Account બદલાયું છે. ફરી login કરો.');
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
        audit(user.id, 'password.change', user.id);
        res.set('Set-Cookie', cookie(req, '', 0)).json({ message: 'Password બદલાયો. બધા ઉપકરણમાંથી logout થયું. ફરી login કરો.' });
    });

    app.use('/api/admin', authenticated, roles('admin'));
    app.get('/api/admin/schools', (req, res) => {
        const schools = db.prepare(`SELECT schools.*, users.name AS principal_name, users.email AS principal_email,
            (SELECT COUNT(*) FROM users AS t WHERE t.school_id=schools.id AND t.role='teacher') AS teacher_count
            FROM schools JOIN users ON users.school_id=schools.id AND users.role='principal'
            ORDER BY schools.created_at DESC`).all();
        const counts = db.prepare(`SELECT school_id, value FROM documents WHERE kind IN ('students','std2students')`).all();
        const totals = new Map();
        for (const record of counts) {
            totals.set(record.school_id, (totals.get(record.school_id) || 0) + JSON.parse(record.value).length);
        }
        res.json(schools.map(school => ({ ...school, student_count: totals.get(school.id) || 0 })));
    });
    app.patch('/api/admin/schools/:id', (req, res) => {
        const school = db.prepare('SELECT * FROM schools WHERE id=?').get(req.params.id);
        if (!school) fail(404, 'શાળા મળી નથી.');
        const { status, validUntil } = req.body;
        if (!['pending', 'active', 'blocked'].includes(status)) fail(400, 'માન્ય school status પસંદ કરો.');
        const expires = validUntil ? parseExpiry(validUntil) : null;
        if (status === 'active' && (!expires || expires < Date.now())) fail(400, 'Active કરવા ભવિષ્યની validity તારીખ જરૂરી છે.');
        transaction(db, () => {
            db.prepare('UPDATE schools SET status=?,valid_until=? WHERE id=?').run(status, expires, school.id);
            audit(req.account.id, 'school.' + status, school.id);
        });
        res.json({ message: 'શાળાનું status/validity સાચવાયું.' });
    });
    app.post('/api/admin/schools/:id/reset-password', async (req, res) => {
        const user = db.prepare("SELECT id FROM users WHERE school_id=? AND role='principal'").get(req.params.id);
        if (!user) fail(404, 'Principal મળ્યા નથી.');
        const hash = await hashPassword(passwordValue(req.body.password));
        transaction(db, () => {
            db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
            db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
            audit(req.account.id, 'principal.password.reset', user.id);
        });
        res.json({ message: 'Principal password બદલાયો. સુરક્ષિત રીતે Principalને આપો.' });
    });

    app.use('/api/school', authenticated, schoolActive);
    app.get('/api/school/teachers', roles('principal'), (req, res) => {
        res.json(db.prepare("SELECT id,name,email,active FROM users WHERE school_id=? AND role='teacher' ORDER BY created_at")
            .all(req.account.school_id));
    });
    app.post('/api/school/teachers', roles('principal'), async (req, res) => {
        const name = text(req.body.name, 'શિક્ષકનું નામ');
        const email = emailAddress(req.body.email);
        const hash = await hashPassword(passwordValue(req.body.password));
        if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) fail(409, 'આ Email વપરાયેલ છે.');
        // Recheck the caller after asynchronous hashing.
        assertPrincipal(req.account.id, req.account.school_id);
        const id = randomUUID();
        transaction(db, () => {
            db.prepare("INSERT INTO users(id,school_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,'teacher',?)")
                .run(id, req.account.school_id, name, email, hash, Date.now());
            audit(req.account.id, 'teacher.create', id);
        });
        res.status(201).json({ message: 'શિક્ષક account બન્યું.' });
    });
    app.patch('/api/school/teachers/:id', roles('principal'), async (req, res) => {
        const teacher = db.prepare("SELECT id FROM users WHERE id=? AND school_id=? AND role='teacher'")
            .get(req.params.id, req.account.school_id);
        if (!teacher) fail(404, 'શિક્ષક મળ્યા નથી.');
        if (typeof req.body.active !== 'boolean') fail(400, 'શિક્ષકનું active status આપો.');
        const hash = req.body.password === undefined ? null : await hashPassword(passwordValue(req.body.password));
        assertPrincipal(req.account.id, req.account.school_id);
        transaction(db, () => {
            db.prepare('UPDATE users SET active=?,password_hash=COALESCE(?,password_hash) WHERE id=?')
                .run(req.body.active ? 1 : 0, hash, teacher.id);
            db.prepare('DELETE FROM sessions WHERE user_id=?').run(teacher.id);
            audit(req.account.id, 'teacher.update', teacher.id);
        });
        res.json({ message: 'શિક્ષક account સાચવાયું. જૂના login બંધ થયા.' });
    });

    function assertPrincipal(userId, schoolId) {
        const active = db.prepare(`SELECT users.id FROM users JOIN schools ON users.school_id=schools.id
            WHERE users.id=? AND users.school_id=? AND users.active=1 AND users.role='principal'
            AND schools.status='active' AND schools.valid_until>?`).get(userId, schoolId, Date.now());
        if (!active) fail(403, 'શાળાની ઍક્સેસ બદલાઈ છે. ફરી login કરો.');
    }

    function documentKey(kind, key) {
        if (!['students', 'school', 'history', 'std2students', 'std2school', 'draft'].includes(kind)) fail(404, 'ડેટાનો પ્રકાર માન્ય નથી.');
        if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(key)) fail(400, 'ડેટાની key માન્ય નથી.');
        if (['students', 'school'].includes(kind) && !/^[1-8]$/.test(key)) fail(400, 'માન્ય ધોરણ પસંદ કરો.');
        if (['std2students', 'std2school'].includes(kind) && key !== '2') fail(400, 'ધોરણ 2ની key જરૂરી છે.');
    }

    function serializeValue(kind, value) {
        if (value === undefined) fail(400, 'ડેટા જરૂરી છે.');
        if (['students', 'std2students'].includes(kind) && (!Array.isArray(value) || value.length > 5000 ||
            value.some(student => !student || typeof student !== 'object' || Array.isArray(student)))) {
            fail(400, 'માન્ય વિદ્યાર્થી યાદી મોકલો (વધુમાં વધુ 5000).');
        }
        if (['school', 'std2school'].includes(kind) && value !== null &&
            (typeof value !== 'object' || Array.isArray(value))) fail(400, 'માન્ય શાળાની માહિતી મોકલો.');
        const serialized = JSON.stringify(value);
        if (Buffer.byteLength(serialized) > 20 * 1024 * 1024) fail(413, 'ડેટા 20 MBથી મોટો છે. ફોટાની સાઇઝ ઓછી કરો.');
        return serialized;
    }

    app.get('/api/school/export', roles('principal'), (req, res) => {
        const rows = db.prepare('SELECT kind,record_key,value FROM documents WHERE school_id=?')
            .all(req.account.school_id);
        res.json({
            format: 'parinam-school-backup-v1', schoolName: req.account.school_name,
            exportedAt: new Date().toISOString(),
            documents: rows.map(row => ({ kind: row.kind, key: row.record_key, value: JSON.parse(row.value) }))
        });
    });
    app.post('/api/school/import', roles('principal'), (req, res) => {
        if (req.body.format !== 'parinam-school-backup-v1' || !Array.isArray(req.body.documents) || req.body.documents.length > 10000) {
            fail(400, 'માન્ય પરિણામ school backup પસંદ કરો.');
        }
        const records = req.body.documents.map(record => {
            if (!record || typeof record !== 'object') fail(400, 'Backup record ખોટો છે.');
            documentKey(record.kind, record.key);
            return { ...record, serialized: serializeValue(record.kind, record.value) };
        });
        transaction(db, () => {
            for (const record of records) {
                const current = db.prepare('SELECT value FROM documents WHERE school_id=? AND kind=? AND record_key=?')
                    .get(req.account.school_id, record.kind, record.key);
                if (current) fail(409, 'આ પ્રકારનો server ડેટા પહેલેથી છે. Import અટકાવ્યો; કોઈ ફેરફાર થયો નથી.');
                db.prepare('INSERT INTO documents(school_id,kind,record_key,value) VALUES(?,?,?,?)')
                    .run(req.account.school_id, record.kind, record.key, record.serialized);
            }
            audit(req.account.id, 'school.import', req.account.school_id);
        });
        res.json({ message: `${records.length} records import થયા. અન્ય ખુલ્લા પેજ refresh કરો.` });
    });
    app.post('/api/school/promote', roles('principal'), (req, res) => {
        const schoolId = req.account.school_id;
        const date = new Date().toISOString().slice(0, 10);
        transaction(db, () => {
            const all = {};
            const set = db.prepare(`INSERT INTO documents(school_id,kind,record_key,value,version) VALUES(?,?,?,?,1)
                ON CONFLICT(school_id,kind,record_key) DO UPDATE SET value=excluded.value,version=documents.version+1`);
            for (let std = 3; std <= 8; std++) {
                const students = db.prepare("SELECT value FROM documents WHERE school_id=? AND kind='students' AND record_key=?").get(schoolId, String(std));
                const school = db.prepare("SELECT value FROM documents WHERE school_id=? AND kind='school' AND record_key=?").get(schoolId, String(std));
                all[std] = students ? JSON.parse(students.value) : [];
                const key = 'std' + std + '_' + date;
                if (db.prepare("SELECT 1 FROM documents WHERE school_id=? AND kind='history' AND record_key=?").get(schoolId, key)) {
                    fail(409, 'આજે promotion પહેલેથી થયું છે અથવા history છે. ફરી promotion અટકાવ્યું.');
                }
                set.run(schoolId, 'history', key, JSON.stringify({ students: all[std], info: school ? JSON.parse(school.value) : null }));
            }
            for (let std = 3; std <= 8; std++) {
                const promoted = std === 3 ? [] : all[std - 1].map(student => ({
                    ...student, std: String(std), attendance: '',
                    marks: new Array(42).fill(0), patrakB1: 0, patrakB2: 0,
                    patrakB1Cats: null, patrakB2Cats: null
                }));
                set.run(schoolId, 'students', String(std), JSON.stringify(promoted));
            }
            audit(req.account.id, 'school.promote', schoolId);
        });
        res.json({ message: 'ધોરણ 3–8નું promotion અને જૂના ડેટાની history એકસાથે સાચવાયાં.' });
    });

    app.get('/api/school/data/:kind/:key', (req, res) => {
        const { kind, key } = req.params;
        documentKey(kind, key);
        const row = db.prepare('SELECT value,version FROM documents WHERE school_id=? AND kind=? AND record_key=?')
            .get(req.account.school_id, kind, key);
        res.json({ value: row ? JSON.parse(row.value) : null, version: row ? row.version : 0 });
    });
    app.put('/api/school/data/:kind/:key', (req, res) => {
        const { kind, key } = req.params;
        documentKey(kind, key);
        if (['school', 'std2school', 'history'].includes(kind) && req.account.role !== 'principal') fail(403, 'આ માહિતી ફક્ત Principal સાચવી શકે.');
        const { value, version } = req.body;
        if (!Number.isSafeInteger(version) || version < 0) fail(400, 'માન્ય version જરૂરી છે.');
        const serialized = serializeValue(kind, value);
        transaction(db, () => {
            const row = db.prepare('SELECT version FROM documents WHERE school_id=? AND kind=? AND record_key=?')
                .get(req.account.school_id, kind, key);
            if ((row ? row.version : 0) !== version) fail(409, 'બીજા ઉપકરણ/શિક્ષકે માહિતી બદલી છે. નવી માહિતી લોડ કરવા પેજ refresh કરો; તમારા ફેરફારોની નકલ પહેલાં રાખો.');
            db.prepare(`INSERT INTO documents(school_id,kind,record_key,value,version) VALUES(?,?,?,?,?)
                ON CONFLICT(school_id,kind,record_key) DO UPDATE SET value=excluded.value,version=excluded.version`)
                .run(req.account.school_id, kind, key, serialized, version + 1);
        });
        res.json({ version: version + 1, message: 'માહિતી server પર સાચવાઈ.' });
    });

    app.use('/api/whatsapp', authenticated, schoolActive);
    return { authenticated, schoolActive, roles, ROLES };
}

module.exports = { installSaas, passwordValue, emailAddress };
