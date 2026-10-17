const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function client(records = new Map()) {
    const context = vm.createContext({
        console, Headers, TextEncoder, structuredClone,
        crypto: require('node:crypto').webcrypto,
        location: { pathname: '/index.html', replace() {} },
        document: { addEventListener() {} },
        window: {
            addEventListener() {},
            fetch: async (url, options = {}) => {
                if (url === '/api/auth/me') return Response.json({ id: 'user1', role: 'principal', schoolName: 'Own School', csrfToken: 'csrf' });
                const current = records.get(url) || { value: null, version: 0 };
                if (options.method === 'PUT') {
                    const body = JSON.parse(options.body);
                    assert.equal(options.headers.get('X-CSRF-Token'), 'csrf');
                    if (body.version !== current.version) return Response.json({ error: 'Conflict: refresh page' }, { status: 409 });
                    const saved = { value: body.value, version: body.version + 1 };
                    records.set(url, saved);
                    return Response.json({ version: saved.version });
                }
                return Response.json(current);
            }
        }
    });
    for (const filename of ['auth-client.js', 'db.js', 'std2_db.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context, { filename });
        if (filename === 'auth-client.js') {
            for (const [key, value] of Object.entries(context.window)) context[key] = value;
        }
    }
    return { context, records, run: script => vm.runInContext(script, context) };
}

test('existing standard helper signatures persist full student data without changing text', async () => {
    const c = client();
    await c.run('openDB()');
    await c.run(`saveStudents([{name:'Student "A" & <B>', marks:[12,20], photo:'data:image/png;base64,abc='}], '8')`);
    const students = await c.run("getStudents('8')");
    assert.equal(students[0].name, 'Student "A" & <B>');
    assert.equal(students[0].std, '8');
    assert.equal(students[0].id, 1);
    assert.deepEqual(Array.from(students[0].marks), [12, 20]);
    await c.run("saveSchoolInfoDB({schoolName:'School Name'}, '8')");
    assert.equal((await c.run("getSchoolInfoDB('8')")).schoolName, 'School Name');
});

test('two client snapshots conflict rather than silently replacing newer data', async () => {
    const records = new Map();
    const first = client(records);
    const second = client(records);
    await first.run("getStudents('8')");
    await second.run("getStudents('8')");
    await first.run("saveStudents([{name:'New'}], '8')");
    await assert.rejects(second.run("saveStudents([{name:'Stale'}], '8')"), /Conflict/);
    assert.equal((await first.run("getStudents('8')"))[0].name, 'New');
});

test('Std 2 serializes queued changes and retains optimistic concurrency', async () => {
    const records = new Map();
    const c = client(records);
    await c.run("s2GetAllStudents()");
    await c.run("Promise.all([s2SaveStudent({id:'one',std:2,name:'One'}),s2SaveStudent({id:'two',std:2,name:'Two'})])");
    const students = await c.run('s2GetAllStudents()');
    assert.equal(students.length, 2);
    const other = client(records);
    await other.run('s2GetAllStudents()');
    await c.run("s2SaveStudent({id:'one',std:2,name:'Edited'})");
    await assert.rejects(other.run("s2SaveStudent({id:'two',std:2,name:'Stale'})"), /Conflict/);
    await c.run("s2DeleteStudent('two')");
    assert.equal((await c.run('s2GetAllStudents()')).length, 1);
});

test('HTML template copies escape user data without mutating stored text', () => {
    const c = client();
    const result = c.run(`(() => {
        const raw = {name:'<img src=x onerror="bad()">', marks:[20], school:"School & Class"};
        return {raw, safe:htmlRecord(raw)};
    })()`);
    assert.equal(result.raw.name, '<img src=x onerror="bad()">');
    assert.equal(result.safe.name, '&lt;img src=x onerror=&quot;bad()&quot;&gt;');
    assert.equal(result.safe.school, 'School &amp; Class');
    assert.equal(result.safe.marks[0], 20);
});

test('Std 1 draft keys are deterministic and support Gujarati identities', async () => {
    const c = client();
    const first = await c.run("draftStorageKey('parinam-hpc-std1-sem1-વિદ્યાર્થી')");
    const second = await c.run("draftStorageKey('parinam-hpc-std1-sem1-વિદ્યાર્થી')");
    const next = await c.run("draftStorageKey('parinam-hpc-std1-sem2-વિદ્યાર્થી')");
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, second);
    assert.notEqual(first, next);
});

test('new standards default to the logged-in school rather than another school', async () => {
    const c = client();
    assert.equal((await c.run("getSchoolInfoDB('7')")).schoolName, 'Own School');
    assert.equal((await c.run('s2GetSchool()')).schoolName, 'Own School');
    assert.equal(c.records.size, 0);
});
