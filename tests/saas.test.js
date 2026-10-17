const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./saas-helpers.cjs');
const waModule = require('../whatsapp');
const { hashPassword, verifyPassword, digest, openStore } = require('../saas-store');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let env, admin, principal, teacher, second;
const futureDate = () => new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

before(async () => {
    env = await fixture();
    admin = await env.login('admin@example.test');
    principal = await env.login('principal@example.test');
    teacher = await env.login('teacher@example.test');
    env.store.prepare("INSERT INTO schools VALUES('school2','Second School','active',?,?)").run(Date.now() + 86400000, Date.now());
    const hash = env.store.prepare("SELECT password_hash FROM users WHERE id='principal1'").get().password_hash;
    env.store.prepare("INSERT INTO users VALUES('principal2','school2','Second Principal','second@example.test',?,'principal',1,?)").run(hash, Date.now());
    second = await env.login('second@example.test');
});
after(async () => { await env.close(); });

test('password hashing is salted, verifiable and never plaintext', async () => {
    const hash = await hashPassword(env.password);
    assert.notEqual(hash, env.password);
    assert.notEqual(hash, await hashPassword(env.password));
    assert.equal(await verifyPassword(env.password, hash), true);
    assert.equal(await verifyPassword('wrong', hash), false);
});

test('anonymous users cannot read pages, data or WhatsApp sessions', async () => {
    for (const url of ['/api/auth/me', '/api/school/data/students/8', '/api/admin/schools', '/api/whatsapp/status', '/api/whatsapp/qr']) {
        assert.equal((await env.request(url)).status, 401, url);
    }
    const page = await env.request('/marksheet.html?std=8');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login.html');
    assert.equal((await env.request('/login.html')).status, 200);
});

test('server secrets and source are never static assets, even when authenticated', async () => {
    for (const url of ['/server.js', '/saas-store.js', '/saas-api.js', '/package.json', '/package-lock.json',
        '/.env', '/.git/config', '/data/parinam.sqlite', '/whatsapp_sessions/business_school1/creds.json', '/tests/saas.test.js']) {
        assert.equal((await env.request(url, principal)).status, 404, url);
    }
    const page = await env.request('/index.html', principal);
    assert.match(await page.text(), /<head><script src="\/auth-client.js"><\/script>/);
});

test('school registration stays pending until Admin approves with validity', async () => {
    const values = { schoolName: 'New School', name: 'New Principal', email: 'NEW@example.test', password: env.password };
    assert.equal((await env.request('/api/auth/register', null, 'POST', values)).status, 201);
    assert.equal((await env.request('/api/auth/register', null, 'POST', values)).status, 409);
    const pending = await env.login('new@example.test');
    assert.equal(pending.account.schoolStatus, 'pending');
    assert.equal((await env.request('/api/school/data/students/8', pending)).status, 403);
    assert.equal((await env.request('/api/whatsapp/qr', pending)).status, 403);
    assert.equal((await env.request('/index.html', pending)).headers.get('location'), '/account.html');
    assert.equal((await env.request('/account.html', pending)).status, 200);
    const url = `/api/admin/schools/${pending.account.schoolId}`;
    assert.equal((await env.request(url, admin, 'PATCH', { status: 'active' })).status, 400);
    assert.equal((await env.request(url, admin, 'PATCH', { status: 'active', validUntil: '2030-02-30' })).status, 400);
    assert.equal((await env.request(url, admin, 'PATCH', { status: 'active', validUntil: futureDate() })).status, 200);
    assert.equal((await env.request('/api/school/data/students/8', pending)).status, 200);
});

test('CSRF, cross-origin and stale-account requests are rejected', async () => {
    const url = '/api/school/data/students/8';
    const noCsrf = { headers: { cookie: principal.cookie, 'Content-Type': 'application/json' } };
    assert.equal((await env.request(url, noCsrf, 'PUT', { value: [], version: 0 })).status, 403);
    const crossOrigin = { headers: { ...principal.headers, Origin: 'https://evil.invalid' } };
    assert.equal((await env.request(url, crossOrigin, 'PUT', { value: [], version: 0 })).status, 403);
    const stale = { headers: { ...principal.headers, 'X-Account-Id': 'principal2' } };
    assert.equal((await env.request(url, stale)).status, 401);
    const loggedOut = { headers: { ...principal.headers, cookie: 'parinam_session=bad' } };
    assert.equal((await env.request(url, loggedOut)).status, 401);
});

test('roles enforce Admin versus Principal versus teacher boundaries', async () => {
    assert.equal((await env.request('/api/admin/schools', principal)).status, 403);
    assert.equal((await env.request('/api/admin/schools', teacher)).status, 403);
    assert.equal((await env.request('/api/school/teachers', teacher)).status, 403);
    assert.equal((await env.request('/api/school/data/students/8', admin)).status, 403);
    assert.equal((await env.request('/api/school/data/school/8', teacher, 'PUT', { value: { schoolName: 'Changed' }, version: 0 })).status, 403);
    assert.equal((await env.request('/api/school/promote', teacher, 'POST', {})).status, 403);
    assert.equal((await env.request('/school_info.html?std=8', teacher)).status, 403);
    assert.equal((await env.request('/school_admin.html', teacher)).status, 403);
    assert.equal((await env.request('/marksheet.html?std=8', teacher)).status, 200);
});

test('school data is tenant-scoped and teacher may edit all standards', async () => {
    for (const std of ['1', '3', '8']) {
        const response = await env.request('/api/school/data/students/' + std, teacher, 'PUT', {
            value: [{ id: 1, std, name: 'School One Student', marks: [10, 20] }],
            version: 0, schoolId: 'school2'
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await (await env.request('/api/school/data/students/' + std, second)).json(), { value: null, version: 0 });
        const own = await (await env.request('/api/school/data/students/' + std, principal)).json();
        assert.equal(own.value[0].name, 'School One Student');
    }
    assert.equal((await env.request('/api/school/data/students/9', principal)).status, 400);
    assert.equal((await env.request('/api/school/data/unknown/8', principal)).status, 404);
});

test('concurrent edits cannot silently overwrite newer data', async () => {
    const url = '/api/school/data/students/8';
    assert.equal((await env.request(url, principal, 'PUT', { value: [{ name: 'Updated' }], version: 1 })).status, 200);
    assert.equal((await env.request(url, teacher, 'PUT', { value: [{ name: 'Stale' }], version: 1 })).status, 409);
    assert.equal((await (await env.request(url, principal)).json()).value[0].name, 'Updated');
});

test('Std 2 and HPC drafts are stored on the server separately for each school', async () => {
    for (const [kind, key, value] of [
        ['std2students', '2', [{ id: 'two', std: 2, name: 'Std 2 Student' }]],
        ['draft', 'abc123', [{ value: 'HPC answer', checked: true }]]
    ]) {
        const url = `/api/school/data/${kind}/${key}`;
        assert.equal((await env.request(url, teacher, 'PUT', { value, version: 0 })).status, 200);
        assert.deepEqual((await (await env.request(url, principal)).json()).value, value);
        assert.equal((await (await env.request(url, second)).json()).value, null);
    }
});

test('school blocking or expiry immediately gates existing sessions including WhatsApp', async () => {
    for (const [status, expiry] of [['blocked', Date.now() + 86400000], ['active', Date.now() - 1000]]) {
        env.store.prepare("UPDATE schools SET status=?,valid_until=? WHERE id='school2'").run(status, expiry);
        assert.equal((await env.request('/api/school/data/students/8', second)).status, 403);
        assert.equal((await env.request('/api/whatsapp/status', second)).status, 403);
        assert.equal((await env.request('/api/auth/me', second)).status, 200);
    }
    assert.equal((await env.request('/api/admin/schools/school2', admin, 'PATCH', { status: 'active', validUntil: futureDate() })).status, 200);
    assert.equal((await env.request('/api/school/data/students/8', second)).status, 200);
});

test('WhatsApp status, QR, reset and sends use the authenticated school only', async () => {
    const saved = {};
    const seen = [];
    for (const name of ['getWhatsAppStatus', 'getWhatsAppSession', 'resetWhatsAppSession', 'sendWhatsAppMessage']) saved[name] = waModule[name];
    waModule.getWhatsAppStatus = id => { seen.push(['status', id]); return { connected: true, error: null }; };
    waModule.getWhatsAppSession = async id => { seen.push(['qr', id]); return {}; };
    waModule.resetWhatsAppSession = async id => { seen.push(['reset', id]); };
    waModule.sendWhatsAppMessage = async id => { seen.push(['send', id]); return { success: true }; };
    try {
        assert.equal((await env.request('/api/whatsapp/status?schoolId=school1', second)).status, 200);
        assert.equal((await env.request('/api/whatsapp/qr?schoolId=school1', second)).status, 200);
        assert.equal((await env.request('/api/whatsapp/reset', second, 'POST', { businessId: 'school1' })).status, 200);
        assert.equal((await env.request('/api/whatsapp/send', second, 'POST', { phone: '9876500001', message: 'Test', schoolId: 'school1' })).status, 200);
        assert.ok(seen.length >= 4);
        assert.ok(seen.every(([, id]) => id === 'school2'));
    } finally { Object.assign(waModule, saved); }
});

test('Principal creates teachers; foreign principals cannot update them; disabled sessions stop', async () => {
    const values = { name: 'New Teacher', email: 'newteacher@example.test', password: env.password };
    assert.equal((await env.request('/api/school/teachers', principal, 'POST', values)).status, 201);
    const teachers = await (await env.request('/api/school/teachers', principal)).json();
    const created = teachers.find(item => item.email === values.email);
    assert.ok(created);
    const loggedIn = await env.login(values.email);
    const url = `/api/school/teachers/${created.id}`;
    assert.equal((await env.request(url, second, 'PATCH', { active: false })).status, 404);
    assert.equal((await env.request(url, principal, 'PATCH', { active: false })).status, 200);
    assert.equal((await env.request('/api/auth/me', loggedIn)).status, 401);
    assert.equal((await env.request('/api/school/teachers', principal, 'POST', values)).status, 409);
});

test('backup import is atomic, isolated, Principal-only and refuses overwrites', async () => {
    const backup = {
        format: 'parinam-school-backup-v1',
        documents: [{ kind: 'students', key: '6', value: [{ name: 'Imported' }] }, { kind: 'school', key: '6', value: { schoolName: 'Second School' } }]
    };
    assert.equal((await env.request('/api/school/import', teacher, 'POST', backup)).status, 403);
    assert.equal((await env.request('/api/school/import', second, 'POST', backup)).status, 200);
    const collision = { ...backup, documents: [{ kind: 'school', key: '7', value: {} }, ...backup.documents] };
    assert.equal((await env.request('/api/school/import', second, 'POST', collision)).status, 409);
    assert.equal((await (await env.request('/api/school/data/school/7', second)).json()).value, null);
    assert.equal((await (await env.request('/api/school/data/students/6', principal)).json()).value, null);
    const exported = await (await env.request('/api/school/export', second)).json();
    assert.equal(exported.format, backup.format);
    assert.equal(exported.documents.length, 2);
    assert.equal((await env.request('/api/school/export', teacher)).status, 403);
});

test('promotion is atomic, preserves history and cannot repeat the same day', async () => {
    const before = await (await env.request('/api/school/data/students/3', principal)).json();
    assert.equal((await env.request('/api/school/promote', principal, 'POST', {})).status, 200);
    const promoted = await (await env.request('/api/school/data/students/4', principal)).json();
    assert.equal(promoted.value[0].name, before.value[0].name);
    assert.ok(promoted.value[0].marks.every(value => value === 0));
    const history = await (await env.request('/api/school/data/history/std3_' + new Date().toISOString().slice(0, 10), principal)).json();
    assert.deepEqual(history.value.students, before.value);
    assert.equal((await env.request('/api/school/promote', principal, 'POST', {})).status, 409);
    assert.deepEqual(await (await env.request('/api/school/data/students/4', principal)).json(), promoted);
});

test('Admin reset and password change revoke all old sessions', async () => {
    const url = '/api/admin/schools/school2/reset-password';
    const newPassword = 'Replacement-password-456!';
    assert.equal((await env.request(url, admin, 'POST', { password: newPassword })).status, 200);
    assert.equal((await env.request('/api/auth/me', second)).status, 401);
    const resetLogin = await env.login('second@example.test', newPassword);
    assert.equal((await env.request('/api/auth/password', resetLogin, 'POST', {
        currentPassword: 'wrong', password: env.password
    })).status, 400);
    assert.equal((await env.request('/api/auth/password', resetLogin, 'POST', {
        currentPassword: newPassword, password: env.password
    })).status, 200);
    assert.equal((await env.request('/api/auth/me', resetLogin)).status, 401);
    second = await env.login('second@example.test');
});

test('logout revokes the session and cookie is HttpOnly with SameSite', async () => {
    const another = await env.login('teacher@example.test');
    assert.equal((await env.request('/api/auth/logout', another, 'POST', {})).status, 200);
    assert.equal((await env.request('/api/auth/me', another)).status, 401);
    const login = await env.request('/api/auth/login', null, 'POST', { email: 'teacher@example.test', password: env.password });
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);
    const stored = env.store.prepare('SELECT token_hash FROM sessions LIMIT 1').get().token_hash;
    assert.match(stored, /^[a-f0-9]{64}$/);
    assert.notEqual(stored, teacher.cookie.split('=')[1]);
    assert.equal(typeof digest('test'), 'string');
});

test('bad credentials are generic and repeated attempts are rate limited', async () => {
    for (let index = 0; index < 12; index++) {
        const response = await env.request('/api/auth/login', null, 'POST', { email: 'unknown@example.test', password: 'bad' });
        assert.equal(response.status, 401);
    }
    assert.equal((await env.request('/api/auth/login', null, 'POST', { email: 'unknown@example.test', password: 'bad' })).status, 429);
    assert.equal((await env.request('/api/auth/register', null, 'POST', { schoolName: 'A', name: 'A', email: 'bad', password: 'short' })).status, 400);
});

test('expired sessions are denied and school summaries omit password hashes', async () => {
    const expiring = await env.login('teacher@example.test');
    env.store.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(Date.now() - 1, digest(expiring.cookie.split('=')[1]));
    assert.equal((await env.request('/api/auth/me', expiring)).status, 401);
    const list = await (await env.request('/api/admin/schools', admin)).json();
    assert.ok(list.length >= 2);
    assert.ok(list.every(school => !('password_hash' in school)));
    const renewalDate = futureDate();
    assert.equal((await env.request('/api/admin/schools/school2', admin, 'PATCH', { status: 'active', validUntil: renewalDate })).status, 200);
    const stored = env.store.prepare("SELECT valid_until FROM schools WHERE id='school2'").get().valid_until;
    assert.equal(stored, Date.parse(renewalDate + 'T23:59:59.999+05:30'));
});

test('SQLite survives reopening and bootstrap CLI creates only explicit admins', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parinam-saas-test-'));
    const filename = path.join(directory, 'test.sqlite');
    try {
        const first = openStore(filename);
        first.prepare("INSERT INTO schools VALUES('persistent','Persistent School','pending',NULL,?)").run(Date.now());
        first.close();
        const secondStore = openStore(filename);
        assert.equal(secondStore.prepare("SELECT name FROM schools WHERE id='persistent'").get().name, 'Persistent School');
        secondStore.close();
        const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'manage-admin.js')], {
            cwd: directory, encoding: 'utf8', env: { ...process.env, DATABASE_PATH: filename, ADMIN_EMAIL: 'bootstrap@example.test', ADMIN_PASSWORD: env.password }
        });
        assert.equal(result.status, 0, result.stderr);
        const reopened = openStore(filename);
        assert.equal(reopened.prepare("SELECT role FROM users WHERE email='bootstrap@example.test'").get().role, 'admin');
        reopened.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
