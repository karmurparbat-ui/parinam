/* global window, document */
(() => {
    const rawFetch = window.fetch.bind(window);
    const publicPage = location.pathname === '/login.html';
    const versions = new Map();
    let writeQueue = Promise.resolve();
    window.escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,
        character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    // Only use a copy at HTML template boundaries; stored data and form values remain unchanged.
    window.htmlRecord = function htmlRecord(value) {
        if (typeof value === 'string') return window.escapeHTML(value);
        if (Array.isArray(value)) return value.map(htmlRecord);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, htmlRecord(item)]));
        return value;
    };

    function showError(error) {
        let banner = document.getElementById('school-error');
        if (!banner) {
            banner = document.createElement('p');
            banner.id = 'school-error';
            banner.setAttribute('role', 'alert');
            banner.style.cssText = 'display:block;box-sizing:border-box;width:100%;position:relative;z-index:99999;padding:12px;background:#ffe0e0;color:#8b1111;margin:0;text-align:center;font:14px sans-serif;';
            document.documentElement.insertBefore(banner, document.body);
        }
        banner.textContent = error.message;
    }

    window.schoolReady = rawFetch('/api/auth/me', { cache: 'no-store' }).then(async response => {
        if (response.status === 401) {
            if (!publicPage) location.replace('/login.html');
            return null;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Session ચકાસી શકાયું નથી.');
        return data;
    });
    window.schoolReady.catch(error => {
        if (document.body) showError(error);
        else document.addEventListener('DOMContentLoaded', () => showError(error), { once: true });
    });

    window.schoolApi = async function (url, options = {}) {
        const account = await window.schoolReady;
        const headers = new Headers(options.headers);
        if (account) {
            headers.set('X-CSRF-Token', account.csrfToken);
            headers.set('X-Account-Id', account.id);
        }
        if (options.body !== undefined) headers.set('Content-Type', 'application/json');
        const response = await rawFetch(url, { ...options, headers, cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) {
            if (response.status === 401 && !publicPage) location.replace('/login.html');
            if (data.code === 'SCHOOL_INACTIVE' && location.pathname !== '/account.html') location.replace('/account.html');
            throw new Error(data.error || 'વિનંતી નિષ્ફળ.');
        }
        return data;
    };

    window.cloudRead = async function (kind, key) {
        const url = `/api/school/data/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`;
        const result = await window.schoolApi(url);
        versions.set(url, result.version);
        return result.value;
    };
    window.cloudWrite = function (kind, key, value) {
        const url = `/api/school/data/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`;
        const work = writeQueue.then(async () => {
            if (!versions.has(url)) await window.cloudRead(kind, key);
            const result = await window.schoolApi(url, {
                method: 'PUT', body: JSON.stringify({ value, version: versions.get(url) })
            });
            versions.set(url, result.version);
            return true;
        });
        writeQueue = work.catch(() => {});
        return work;
    };
    window.draftStorageKey = async function (key) {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
        return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
    };
    window.addEventListener('unhandledrejection', event => {
        showError(event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
    });

    document.addEventListener('DOMContentLoaded', async () => {
        try {
            const account = await window.schoolReady;
            if (!account || publicPage) return;
            document.documentElement.dataset.role = account.role;
            document.querySelectorAll('[data-school-name]').forEach(element => {
                element.textContent = account.schoolName || '';
            });
            const bar = document.createElement('nav');
            bar.id = 'school-session-bar';
            const label = document.createElement('span');
            const roleLabel = { admin: 'Super Admin', principal: 'Principal', teacher: 'શિક્ષક' };
            label.className = 'ssb-label';
            label.textContent = `${account.schoolName || 'પરિણામ SaaS'} — ${account.name} (${roleLabel[account.role]})`;
            bar.append(label);
            const links = account.role === 'admin'
                ? [['/admin.html', 'Admin panel']]
                : [['/index.html', 'ધોરણ પસંદ કરો'], ...(account.role === 'principal' ? [['/school_admin.html', 'શાળા સંચાલન']] : [])];
            links.push(['/account.html', 'Account / Password']);
            for (const [href, title] of links) {
                const link = document.createElement('a');
                link.href = href;
                link.textContent = title;
                link.className = 'ssb-link';
                bar.append(link);
            }
            const logout = document.createElement('button');
            logout.textContent = 'Logout';
            logout.type = 'button';
            logout.className = 'ssb-logout';
            logout.addEventListener('click', async () => {
                logout.disabled = true;
                try {
                    await window.schoolApi('/api/auth/logout', { method: 'POST', body: '{}' });
                    location.replace('/login.html');
                } catch (error) {
                    showError(error);
                    logout.disabled = false;
                }
            });
            bar.append(logout);
            document.documentElement.insertBefore(bar, document.body);
            const style = document.createElement('style');
            style.textContent = `
                [data-role="teacher"] #promoteButton,
                [data-role="teacher"] [onclick*="school_info.html"],
                [data-role="teacher"] [href*="school_info.html"] { display:none !important; }
                #school-session-bar { box-sizing:border-box; position:sticky; top:0; z-index:9999; display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; width:100%; margin:0; padding:8px 16px; background:#14234b; color:#fff; font:14px/1.4 'Noto Sans Gujarati', sans-serif; box-shadow:0 2px 8px rgba(0,0,0,.25); }
                #school-session-bar .ssb-label { font-weight:700; flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
                #school-session-bar .ssb-link { color:#fff; margin:0; text-decoration:underline; font:inherit; white-space:nowrap; }
                #school-session-bar .ssb-logout { padding:5px 14px; margin:0 0 0 auto; cursor:pointer; border:0; border-radius:6px; background:#ffd54f; color:#14234b; font:inherit; font-weight:700; }
                @media (max-width:600px) {
                    #school-session-bar { padding:8px 10px; font-size:13px; gap:6px 12px; }
                    #school-session-bar .ssb-label { flex-basis:100%; }
                    #school-session-bar .ssb-logout { padding:6px 12px; }
                }
                @media print { #school-session-bar, #school-error { display:none !important; } }`;
            document.head.append(style);
            if (account.role === 'teacher') {
                document.querySelectorAll('[onclick*="school_info.html"],[href*="school_info.html"],#promoteButton')
                    .forEach(element => { element.hidden = true; });
            }
        } catch (error) {
            showError(error);
        }
    });
})();
