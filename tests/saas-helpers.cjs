const { randomUUID } = require('node:crypto');
const { openStore, hashPassword } = require('../saas-store');
const { createApp } = require('../server');

const password = 'Test-only-password-123!';
async function fixture(store = openStore(':memory:')) {
    const hash = await hashPassword(password);
    const schoolId = 'school1';
    store.prepare("INSERT INTO schools(id,name,status,valid_until,created_at) VALUES(?,?,'active',?,?)")
        .run(schoolId, 'Test School One', Date.now() + 86400000, Date.now());
    for (const [id, role, school, email] of [
        ['admin1', 'admin', null, 'admin@example.test'],
        ['principal1', 'principal', schoolId, 'principal@example.test'],
        ['teacher1', 'teacher', schoolId, 'teacher@example.test']
    ]) {
        store.prepare('INSERT INTO users(id,school_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)')
            .run(id, school, role, email, hash, role, Date.now());
    }
    const app = createApp({ store });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function login(email, userPassword = password) {
        const response = await fetch(base + '/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: userPassword })
        });
        if (!response.ok) throw new Error('Test login failed: ' + await response.text());
        const cookie = response.headers.get('set-cookie').split(';')[0];
        const me = await fetch(base + '/api/auth/me', { headers: { cookie } });
        const account = await me.json();
        return {
            cookie, account,
            headers: { cookie, 'X-CSRF-Token': account.csrfToken, 'X-Account-Id': account.id, 'Content-Type': 'application/json' }
        };
    }
    async function request(url, auth, method = 'GET', body) {
        return fetch(base + url, {
            method, headers: auth ? auth.headers : { 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: 'manual'
        });
    }
    async function close() {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        store.close();
    }
    return { app, store, server, base, login, request, close, schoolId, password, randomUUID };
}

module.exports = { fixture, password };
