/* global html2canvas */
window.createWhatsAppResultSender = function (options) {
    const panel = document.querySelector('.control-panel');
    const editor = document.createElement('div');
    editor.innerHTML = `
        <label for="whatsapp-message"><strong>WhatsApp સાથે મોકલવાનો સંદેશ</strong></label>
        <textarea id="whatsapp-message" rows="7" maxlength="1024"
            style="width:100%;padding:8px;font:inherit;resize:vertical;"
            aria-describedby="whatsapp-message-help"></textarea>
        <small id="whatsapp-message-help">
            સંપૂર્ણ પરિણામની image સાથે આ સંદેશ જશે.
            {name}, {school}, {std}, {exam}, {percentage}, {result} આપોઆપ ભરાશે.
            ખાલી રાખશો તો ફક્ત image જશે. વધુમાં વધુ 1024 અક્ષર.
        </small>
        <p id="whatsapp-progress" role="status" aria-live="polite"></p>`;
    panel.appendChild(editor);
    const statusBox = document.createElement('div');
    statusBox.style.cssText = 'padding:8px;border-radius:8px;font-size:13px;font-weight:700;text-align:center;';
    statusBox.innerHTML = `
        <div id="whatsapp-connection" role="status" aria-live="polite">⏳ WhatsApp સ્ટેટસ તપાસાય છે...</div>
        <a href="whatsapp_setup.html" target="_blank" rel="opener" id="whatsapp-login-link"
            style="display:block;margin-top:6px;padding:7px;border-radius:6px;background:#2D72B8;color:#fff;text-decoration:none;">
            📱 WhatsApp લોગિન / QR સ્કેન કરો</a>`;
    const firstWhatsAppButton = panel.querySelector('button[onclick*="sendWhatsapp"]');
    panel.insertBefore(statusBox, firstWhatsAppButton || null);
    const connectionText = statusBox.querySelector('#whatsapp-connection');
    const loginLink = statusBox.querySelector('#whatsapp-login-link');
    let checkingStatus = false;

    async function refreshConnection() {
        if (checkingStatus) return null;
        checkingStatus = true;
        let connected = false;
        let message;
        try {
            const response = await fetch('/api/whatsapp/status', { cache: 'no-store' });
            const data = await response.json();
            connected = Boolean(data.connected);
            message = data.error ? '🔴 ' + data.error : (connected ? '🟢 WhatsApp Connected' : '🔴 WhatsApp Connected નથી');
        } catch (error) {
            message = '🔴 સર્વર ચાલુ નથી (node server.js)';
        } finally {
            checkingStatus = false;
        }
        connectionText.textContent = message;
        statusBox.style.background = connected ? '#C8E6C9' : '#FFCDD2';
        statusBox.style.color = connected ? '#1B5E20' : '#B71C1C';
        loginLink.style.display = connected ? 'none' : 'block';
        return connected;
    }

    refreshConnection();
    setInterval(() => { if (!document.hidden) refreshConnection(); }, 5000);
    window.addEventListener('focus', refreshConnection);

    const messageBox = editor.querySelector('textarea');
    const progress = editor.querySelector('#whatsapp-progress');
    messageBox.value = '*{school}*\nધોરણ: {std} | {exam}\nવિદ્યાર્થી: {name}\nટકાવારી: {percentage}%\nપરિણામ: {result}\nસંપૂર્ણ પરિણામ સાથે જોડેલ છે.';
    let sending = false;

    function captionFor(student, template) {
        const values = options.getMessageValues(student);
        const caption = template.replace(/\{(name|school|std|exam|percentage|result)\}/g,
            (_, key) => String(values[key] ?? ''));
        if (caption.length > 1024) {
            throw new Error('વિદ્યાર્થીની માહિતી ભર્યા પછી સંદેશ 1024 અક્ષરથી મોટો છે. સંદેશ ટૂંકો કરો.');
        }
        return caption;
    }

    async function capture(student) {
        if (typeof html2canvas !== 'function') {
            throw new Error('Image બનાવવા માટેની લાઇબ્રેરી લોડ નથી થઈ. server.js ફરી ચાલુ કરીને પેજ refresh કરો.');
        }
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:-20000px;top:0;pointer-events:none;';
        const report = options.createReport(student);
        host.appendChild(report);
        document.body.appendChild(host);
        try {
            await document.fonts.ready;
            const imageSources = Array.from(report.querySelectorAll('img'), image => image.src);
            imageSources.push(new URL('frame.png', document.baseURI).href);
            await Promise.all(imageSources.map(src => new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = resolve;
                image.onerror = () => reject(new Error('પરિણામનો ફોટો, લોગો, સહી અથવા ફ્રેમ લોડ થઈ નથી. તપાસીને ફરી મોકલો.'));
                image.src = src;
            })));
            const canvas = await html2canvas(report, {
                scale: 2,
                backgroundColor: '#ffffff',
                useCORS: true,
                logging: false,
                windowWidth: Math.max(1440, report.scrollWidth),
                onclone: clonedDocument => {
                    clonedDocument.querySelectorAll('[data-whatsapp-report]').forEach(element => {
                        element.style.boxShadow = 'none';
                    });
                }
            });
            return canvas.toDataURL('image/jpeg', 0.92);
        } finally {
            host.remove();
        }
    }

    async function sendStudent(student, template) {
        let phone = String(student.contact || '').replace(/\D/g, '');
        if (phone.length === 10) phone = '91' + phone;
        if (!/^[1-9]\d{10,14}$/.test(phone)) {
            throw new Error('માન્ય સંપર્ક નંબર નથી: ' + (student.name || 'વિદ્યાર્થી'));
        }
        const message = captionFor(student, template);
        const image = await capture(student);
        let response;
        try {
            response = await fetch('/api/whatsapp/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, message, image })
            });
        } catch (error) {
            throw new Error('સર્વર સાથે જોડાણ નથી. server.js ચાલુ છે તેની ખાતરી કરો. ' + error.message);
        }
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || 'પરિણામની image મોકલી શકાઈ નથી.');
        }
    }

    async function send(selected, bulk) {
        if (sending) return;
        if (!selected.length) {
            alert('મોકલવા માટે વિદ્યાર્થીનો ડેટા નથી.');
            return;
        }
        const template = messageBox.value;
        if (await refreshConnection() === false) {
            if (confirm('WhatsApp Connected નથી. QR સ્કેન કરવા માટે લોગિન પેજ ખોલવું છે?')) {
                window.open('whatsapp_setup.html', '_blank');
            }
            return;
        }
        if (sending) return;
        if (bulk && !confirm(`${selected.length} વિદ્યાર્થીને તેમનું સંપૂર્ણ પરિણામ image અને આ સંદેશ સાથે મોકલવું છે?`)) return;
        sending = true;
        const buttons = Array.from(panel.querySelectorAll('button'));
        const disabledStates = buttons.map(button => button.disabled);
        buttons.forEach(button => { button.disabled = true; });
        messageBox.disabled = true;
        let successCount = 0;
        const failures = [];
        try {
            for (let index = 0; index < selected.length; index++) {
                const student = selected[index];
                progress.textContent = `${index + 1} / ${selected.length}: ${student.name || 'વિદ્યાર્થી'} — image મોકલાઈ રહી છે...`;
                try {
                    await sendStudent(student, template);
                    successCount++;
                } catch (error) {
                    console.error('WhatsApp result failed:', student.name, error);
                    failures.push(`${student.name || 'વિદ્યાર્થી'}: ${error.message}`);
                }
                if (index < selected.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
            progress.textContent = `સફળ: ${successCount} | નિષ્ફળ: ${failures.length}`;
            alert(`${progress.textContent}${failures.length ? '\n' + failures.join('\n') : '\nસંપૂર્ણ પરિણામની image મોકલાઈ ગઈ.'}`);
        } finally {
            sending = false;
            buttons.forEach((button, index) => { button.disabled = disabledStates[index]; });
            messageBox.disabled = false;
        }
    }

    return {
        sendCurrent: () => send(options.getCurrentStudents(), false),
        sendBulk: () => send(options.getStudents(), true)
    };
};
