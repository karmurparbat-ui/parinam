// ============================================================
// db.js - Multi-Standard IndexedDB Helper
// ============================================================
const DB_NAME = 'SchoolResultDB';
const DB_VERSION = 2;
const STUDENTS_STORE = 'students';
const SCHOOL_STORE = 'schoolInfo';
const HISTORY_STORE = 'history';

let db = null;

// ============================================================
// SUBJECTS CONFIG
// ============================================================
const SUBJECTS_CONFIG = {
    '3': ['ગુજરાતી', 'ગણિત', 'અંગ્રેજી', 'સૌની આસપાસ'],
    '4': ['ગુજરાતી', 'ગણિત', 'હિન્દી', 'અંગ્રેજી', 'સૌની આસપાસ'],
    '5': ['ગુજરાતી', 'ગણિત', 'હિન્દી', 'અંગ્રેજી', 'સૌની આસપાસ'],
    '6': ['ગુજરાતી', 'ગણિત', 'હિન્દી', 'અંગ્રેજી', 'વિજ્ઞાન', 'સામાજિક વિજ્ઞાન', 'સંસ્કૃત'],
    '7': ['ગુજરાતી', 'ગણિત', 'હિન્દી', 'અંગ્રેજી', 'વિજ્ઞાન', 'સામાજિક વિજ્ઞાન', 'સંસ્કૃત'],
    '8': ['ગુજરાતી', 'ગણિત', 'હિન્દી', 'અંગ્રેજી', 'વિજ્ઞાન', 'સામાજિક વિજ્ઞાન', 'સંસ્કૃત']
};

// ============================================================
// SEMESTER-SPECIFIC SUBJECTS
// Std 4: Hindi available only in Sem2
// ============================================================
const SEM_SPECIFIC_SUBJECTS = {
    '4': {
        'હિન્દી': ['Sem2']
    }
};

// ============================================================
// PATRAK-B CONFIG
// Std 3-5: 40 × 5 = 200 | Std 6-8: 40 × 10 = 400
// ============================================================
const PATRAK_B_CONFIG = {
    '3': { maxPerCat: 5, maxTotal: 200 },
    '4': { maxPerCat: 5, maxTotal: 200 },
    '5': { maxPerCat: 5, maxTotal: 200 },
    '6': { maxPerCat: 10, maxTotal: 400 },
    '7': { maxPerCat: 10, maxTotal: 400 },
    '8': { maxPerCat: 10, maxTotal: 400 }
};

const ACTIVE_STANDARDS = ['3', '4', '5', '6', '7', '8'];

// ============================================================
// DATABASE INIT
// ============================================================
let _migrationDone = false;

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            if (!_migrationDone) {
                _migrationDone = true;
                _runMigration().then(() => resolve(db)).catch(() => resolve(db));
            } else {
                resolve(db);
            }
        };
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STUDENTS_STORE)) {
                database.createObjectStore(STUDENTS_STORE, { keyPath: 'id', autoIncrement: true });
            }
            if (!database.objectStoreNames.contains(SCHOOL_STORE)) {
                database.createObjectStore(SCHOOL_STORE, { keyPath: 'key' });
            }
            if (!database.objectStoreNames.contains(HISTORY_STORE)) {
                database.createObjectStore(HISTORY_STORE, { keyPath: 'key' });
            }
        };
    });
}

function _runMigration() {
    return new Promise((resolve) => {
        try {
            const tx = db.transaction([STUDENTS_STORE], 'readwrite');
            const store = tx.objectStore(STUDENTS_STORE);
            const req = store.getAll();
            req.onsuccess = () => {
                const all = req.result || [];
                let count = 0;
                all.forEach(rec => {
                    if (!rec.std) { rec.std = '8'; store.put(rec); count++; }
                });
                if (count > 0) console.log('✅ Migrated', count, 'students to std 8');
            };
            tx.oncomplete = () => {
                const tx2 = db.transaction([SCHOOL_STORE], 'readwrite');
                const store2 = tx2.objectStore(SCHOOL_STORE);
                const req2 = store2.get('info');
                req2.onsuccess = () => {
                    if (req2.result && req2.result.data) {
                        store2.put({ key: 'info_8', data: req2.result.data });
                        store2.delete('info');
                    }
                };
                tx2.oncomplete = () => resolve(true);
                tx2.onerror = () => resolve(true);
            };
            tx.onerror = () => resolve(true);
        } catch (e) { resolve(true); }
    });
}

async function migrateOldData() { return _runMigration(); }

// ============================================================
// STUDENTS
// ============================================================
function getStudents(std) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STUDENTS_STORE], 'readonly');
        const request = tx.objectStore(STUDENTS_STORE).getAll();
        request.onsuccess = () => {
            const all = request.result || [];
            resolve(all.filter(s => String(s.std || '8') === String(std)));
        };
        request.onerror = () => reject(request.error);
    });
}

function saveStudents(students, std) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STUDENTS_STORE], 'readwrite');
        const store = tx.objectStore(STUDENTS_STORE);
        const getAllReq = store.getAll();
        getAllReq.onsuccess = () => {
            const all = getAllReq.result || [];
            all.forEach(rec => {
                if (String(rec.std || '8') === String(std)) store.delete(rec.id);
            });
            students.forEach(s => {
                const newRec = Object.assign({}, s, { std: String(std) });
                delete newRec.id;
                store.add(newRec);
            });
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

// ============================================================
// SCHOOL INFO
// ============================================================
function getSchoolAddressParts(school = {}) {
    const parts = String(school.address || '').split(/[,，]/).map(part => part.trim()).filter(Boolean);
    const valueFromAddress = (pattern) => {
        const part = parts.find(item => pattern.test(item));
        return part ? part.replace(pattern, '').trim() : '';
    };

    return {
        village: school.village || valueFromAddress(/^(?:મુ(?:કામ)?\.?|ગું\.?|ગામ)\s*[:.-]?\s*/),
        taluka: school.taluka || valueFromAddress(/^(?:તા(?:લુકો)?\.?|તાલુકા)\s*[:.-]?\s*/),
        district: school.district || valueFromAddress(/^(?:જિ(?:લ્લો)?\.?|જિલ્લા)\s*[:.-]?\s*/)
    };
}

function formatSchoolAddress(school = {}, fallback = '') {
    const addressParts = getSchoolAddressParts(school);
    const formatted = [
        addressParts.village && `મુ. ${addressParts.village}`,
        addressParts.taluka && `તા. ${addressParts.taluka}`,
        addressParts.district && `જિ. ${addressParts.district}`
    ].filter(Boolean).join(', ');

    return formatted || school.address || fallback;
}

function saveSchoolInfoDB(info, std) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([SCHOOL_STORE], 'readwrite');
        tx.objectStore(SCHOOL_STORE).put({ key: 'info_' + std, data: info });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

function getSchoolInfoDB(std) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([SCHOOL_STORE], 'readonly');
        const request = tx.objectStore(SCHOOL_STORE).get('info_' + std);
        request.onsuccess = () => resolve(request.result ? request.result.data : null);
        request.onerror = () => reject(request.error);
    });
}

// ============================================================
// HISTORY
// ============================================================
function saveHistory(key, data) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([HISTORY_STORE], 'readwrite');
        tx.objectStore(HISTORY_STORE).put({ key: key, data: data });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

// ============================================================
// UTILITIES
// ============================================================
function getSubjects(std) {
    return SUBJECTS_CONFIG[String(std)] || SUBJECTS_CONFIG['8'];
}

function getPatrakBConfig(std) {
    return PATRAK_B_CONFIG[String(std)] || PATRAK_B_CONFIG['8'];
}

// ✅ Check if subject is available in a given semester
// Std 4: Hindi only in Sem2
function isSubjectInSem(std, subject, sem) {
    const special = SEM_SPECIFIC_SUBJECTS[String(std)];
    if (!special || !special[subject]) return true;
    return special[subject].includes(sem);
}

// ✅ Get subject max marks for std + exam type
// Example: Std 4 Hindi - Sem1: 0, Sem2: 100, Annual: 100
function getSubjectMax(std, subject, examType) {
    const sem1 = isSubjectInSem(std, subject, 'Sem1');
    const sem2 = isSubjectInSem(std, subject, 'Sem2');
    
    if (examType === 'Sem1') return sem1 ? 100 : 0;
    if (examType === 'Sem2') return sem2 ? 100 : 0;
    // Annual
    let max = 0;
    if (sem1) max += 100;
    if (sem2) max += 100;
    return max;
}

function getUrlParam(name, defaultVal) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name) || defaultVal;
}