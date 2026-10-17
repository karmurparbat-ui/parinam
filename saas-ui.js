/* global schoolApi, schoolReady */
(() => {
    const byId = id => document.getElementById(id);
    const page = document.body.dataset.page;
    const stateLabels = { pending: 'Approval બાકી', active: 'Active', blocked: 'Blocked', expired: 'Validity પૂરી' };
    const dateLabel = timestamp => timestamp ? new Date(timestamp).toLocaleDateString('gu-IN', { timeZone: 'Asia/Kolkata' }) : 'આપેલ નથી';
    const inputDate = timestamp => timestamp ? new Date(timestamp + 19800000).toISOString().slice(0, 10) : '';

    function message(text, error = false) {
        const element = byId('message');
        element.textContent = text;
        element.className = 'message' + (error ? ' error' : '');
    }
    function node(tag, content, className) {
        const element = document.createElement(tag);
        if (content !== undefined) element.textContent = content;
        if (className) element.className = className;
        return element;
    }
    async function run(button, work) {
        button.disabled = true;
        try { await work(); }
        catch (error) { message(error.message, true); }
        finally { button.disabled = false; }
    }
    function form(id, work) {
        const element = byId(id);
        element.addEventListener('submit', event => {
            event.preventDefault();
            const values = Object.fromEntries(new FormData(element));
            run(element.querySelector('[type="submit"]'), () => work(values, element));
        });
    }
    function post(url, data, method = 'POST') {
        return schoolApi(url, { method, body: JSON.stringify(data) });
    }
    function confirmPassword(values) {
        if (values.password !== values.confirmPassword) throw new Error('બંને password સરખા નથી.');
    }
    function button(label, className, work) {
        const element = node('button', label, className);
        element.type = 'button';
        element.addEventListener('click', () => run(element, () => work(element)));
        return element;
    }
    function passwordResetForm(parent, submit) {
        const reset = node('form');
        const label = node('label', 'નવો password (ઓછામાં ઓછા 12 અક્ષર)');
        const input = node('input');
        input.type = 'password';
        input.minLength = 12;
        input.maxLength = 128;
        input.required = true;
        input.autocomplete = 'new-password';
        label.append(input);
        const save = node('button', 'Password reset કરો', 'secondary');
        save.type = 'submit';
        reset.append(label, save);
        reset.addEventListener('submit', event => {
            event.preventDefault();
            run(save, async () => {
                await submit(input.value);
                reset.reset();
            });
        });
        parent.append(reset);
    }
    function statusOf(school) {
        return school.status === 'active' && (!school.valid_until || school.valid_until < Date.now()) ? 'expired' : school.status;
    }

    async function loginPage() {
        const account = await schoolReady;
        if (account) {
            location.replace(account.role === 'admin' ? '/admin.html' : '/index.html');
            return;
        }
        const show = register => {
            byId('register-card').hidden = !register;
            byId('login-card').hidden = register;
            message('');
        };
        byId('show-register').addEventListener('click', () => show(true));
        byId('show-login').addEventListener('click', () => show(false));
        form('login-form', async values => {
            const result = await post('/api/auth/login', values);
            location.replace(result.role === 'admin' ? '/admin.html' : '/index.html');
        });
        form('register-form', async (values, element) => {
            confirmPassword(values);
            const result = await post('/api/auth/register', values);
            element.reset();
            show(false);
            message(result.message);
        });
    }

    async function adminPage() {
        let schools = [];
        function render() {
            const search = byId('school-search').value.toLowerCase();
            const filter = byId('school-filter').value;
            const counts = schools.reduce((all, school) => {
                all[statusOf(school)]++;
                all.students += school.student_count;
                return all;
            }, { pending: 0, active: 0, blocked: 0, expired: 0, students: 0 });
            byId('summary').textContent = `કુલ શાળા: ${schools.length} | Approval બાકી: ${counts.pending} | Active: ${counts.active} | Blocked: ${counts.blocked} | Expired: ${counts.expired} | વિદ્યાર્થી: ${counts.students}`;
            const container = byId('schools');
            container.replaceChildren();
            for (const school of schools.filter(item =>
                (!filter || statusOf(item) === filter) &&
                `${item.name} ${item.principal_email} ${item.principal_name}`.toLowerCase().includes(search))) {
                const card = node('section', undefined, 'card');
                const state = statusOf(school);
                card.append(node('h2', school.name), node('span', stateLabels[state], 'badge ' + state),
                    node('p', `${school.principal_name} — ${school.principal_email}`),
                    node('p', `વિદ્યાર્થી: ${school.student_count} | શિક્ષક: ${school.teacher_count} | Validity: ${dateLabel(school.valid_until)}`));
                const settings = node('form');
                const statusLabel = node('label', 'શાળાનું status');
                const status = node('select');
                for (const key of ['pending', 'active', 'blocked']) {
                    const option = node('option', stateLabels[key]);
                    option.value = key;
                    status.append(option);
                }
                status.value = school.status;
                statusLabel.append(status);
                const expiryLabel = node('label', 'Validityની છેલ્લી તારીખ (ભારતીય સમય મુજબ)');
                const expiry = node('input');
                expiry.type = 'date';
                expiry.value = inputDate(school.valid_until);
                expiryLabel.append(expiry);
                const save = node('button', 'Approval / Status / Renewal સાચવો');
                save.type = 'submit';
                settings.append(statusLabel, expiryLabel, save);
                settings.addEventListener('submit', event => {
                    event.preventDefault();
                    run(save, async () => {
                        const result = await post(`/api/admin/schools/${school.id}`, { status: status.value, validUntil: expiry.value }, 'PATCH');
                        message(result.message);
                        await load();
                    });
                });
                card.append(settings);
                passwordResetForm(card, async password => {
                    const result = await post(`/api/admin/schools/${school.id}/reset-password`, { password });
                    message(result.message);
                });
                container.append(card);
            }
            if (!container.childElementCount) container.append(node('p', 'શાળા મળી નથી.'));
        }
        async function load() {
            schools = await schoolApi('/api/admin/schools');
            render();
        }
        byId('school-search').addEventListener('input', render);
        byId('school-filter').addEventListener('change', render);
        byId('refresh').addEventListener('click', event => run(event.target, load));
        await load();
    }

    async function schoolPage() {
        const account = await schoolReady;
        byId('school-details').textContent = `${account.schoolName} | Validity: ${dateLabel(account.validUntil)}`;
        async function loadTeachers() {
            const teachers = await schoolApi('/api/school/teachers');
            const container = byId('teachers');
            container.replaceChildren();
            for (const teacher of teachers) {
                const card = node('section', undefined, 'card');
                card.append(node('h3', teacher.name), node('p', teacher.email), node('span', teacher.active ? 'Active' : 'બંધ', 'badge'));
                card.append(button(teacher.active ? 'શિક્ષક account બંધ કરો' : 'શિક્ષક account ચાલુ કરો', 'secondary', async () => {
                    const result = await post(`/api/school/teachers/${teacher.id}`, { active: !teacher.active }, 'PATCH');
                    message(result.message);
                    await loadTeachers();
                }));
                passwordResetForm(card, async password => {
                    const result = await post(`/api/school/teachers/${teacher.id}`, { active: Boolean(teacher.active), password }, 'PATCH');
                    message(result.message);
                });
                container.append(card);
            }
            if (!teachers.length) container.append(node('p', 'હજુ શિક્ષક ઉમેર્યા નથી.'));
        }
        form('teacher-form', async (values, element) => {
            const result = await post('/api/school/teachers', values);
            message(result.message);
            element.reset();
            await loadTeachers();
        });
        byId('export-data').addEventListener('click', event => run(event.target, async () => {
            const backup = await schoolApi('/api/school/export');
            const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
            const link = node('a');
            link.href = url;
            link.download = 'parinam-school-backup-' + new Date().toISOString().slice(0, 10) + '.json';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            message('Backup download શરૂ થયો. આ ફાઇલમાં વિદ્યાર્થીની ખાનગી માહિતી છે; સુરક્ષિત રાખો.');
        }));
        async function importBackup(backup) {
            if (!backup || !Array.isArray(backup.documents) || backup.format !== 'parinam-school-backup-v1') throw new Error('માન્ય પરિણામ backup પસંદ કરો.');
            if (!backup.documents.length) throw new Error('Import કરવા ડેટા મળ્યો નથી.');
            if (!confirm(`${account.schoolName}માં ${backup.documents.length} records import કરવા છે? ખાતરી કરો કે ડેટા આ શાળાનો જ છે. હાલનો ડેટા overwrite નહીં થાય.`)) return;
            const result = await post('/api/school/import', backup);
            message(result.message);
        }
        byId('import-json').addEventListener('click', event => run(event.target, async () => {
            const file = byId('import-file').files[0];
            if (!file) throw new Error('પહેલાં JSON backup ફાઇલ પસંદ કરો.');
            if (file.size > 45 * 1024 * 1024) throw new Error('Backup 45 MBથી મોટો છે. Adminનો સંપર્ક કરો.');
            await importBackup(JSON.parse(await file.text()));
        }));
        byId('import-browser').addEventListener('click', event => run(event.target, async () => {
            await importBackup(await readLegacyData());
        }));
        await loadTeachers();
    }

    async function readLegacyData() {
        const documents = [];
        async function readDatabase(name) {
            const databases = await indexedDB.databases();
            if (!databases.some(database => database.name === name)) return {};
            const database = await new Promise((resolve, reject) => {
                const request = indexedDB.open(name);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            try {
                const records = {};
                for (const storeName of database.objectStoreNames) {
                    records[storeName] = await new Promise((resolve, reject) => {
                        const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                }
                return records;
            } finally { database.close(); }
        }
        const main = await readDatabase('SchoolResultDB');
        for (const std of ['1', '2', '3', '4', '5', '6', '7', '8']) {
            const students = (main.students || []).filter(student => String(student.std || '8') === std);
            if (students.length) documents.push({ kind: 'students', key: std, value: students });
        }
        for (const record of main.schoolInfo || []) {
            const std = record.key === 'info' ? '8' : String(record.key).replace('info_', '');
            if (!/^[1-8]$/.test(std)) throw new Error('જૂની school infoની key માન્ય નથી.');
            const entry = { kind: 'school', key: std, value: record.data };
            const existing = documents.findIndex(item => item.kind === 'school' && item.key === std);
            if (existing === -1) documents.push(entry);
            else if (record.key !== 'info') documents[existing] = entry;
        }
        for (const record of main.history || []) documents.push({ kind: 'history', key: record.key, value: record.data });
        const second = await readDatabase('SchoolResultDB_Std2');
        if (second.students && second.students.length) documents.push({ kind: 'std2students', key: '2', value: second.students });
        const info = (second.school || []).find(item => item.id === 'main');
        if (info) documents.push({ kind: 'std2school', key: '2', value: info });
        // Prefer the session-specific Std 1 key over the older Sem 1 key.
        const drafts = new Map();
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (!key.startsWith('parinam-hpc-std1-')) continue;
            const normalized = /^parinam-hpc-std1-sem[12]-/.test(key) ? key : key.replace('parinam-hpc-std1-', 'parinam-hpc-std1-sem1-');
            if (!drafts.has(normalized) || normalized === key) drafts.set(normalized, JSON.parse(localStorage.getItem(key)));
        }
        for (const [key, value] of drafts) documents.push({ kind: 'draft', key: await window.draftStorageKey(key), value });
        return { format: 'parinam-school-backup-v1', documents };
    }

    async function accountPage() {
        const account = await schoolReady;
        byId('account-name').textContent = account.name;
        byId('account-details').textContent = `${account.email} | ${account.role} | ${account.schoolName || 'Super Admin'}`;
        const active = account.role === 'admin' || (account.schoolStatus === 'active' && account.validUntil > Date.now());
        byId('account-state').textContent = account.role === 'admin' ? 'Super Admin account' :
            `સ્થિતિ: ${stateLabels[account.schoolStatus]} | Validity: ${dateLabel(account.validUntil)}${!active ? '\nApproval / renewal માટે Super Adminનો સંપર્ક કરો. હાલ વિદ્યાર્થી ડેટાની ઍક્સેસ બંધ છે.' : ''}`;
        byId('continue-link').hidden = !active;
        byId('continue-link').href = account.role === 'admin' ? '/admin.html' : '/index.html';
        byId('check-approval').addEventListener('click', () => location.reload());
        form('password-form', async values => {
            confirmPassword(values);
            await post('/api/auth/password', values);
            location.replace('/login.html');
        });
    }

    const start = { login: loginPage, admin: adminPage, school: schoolPage, account: accountPage }[page];
    if (start) start().catch(error => message(error.message, true));
})();
