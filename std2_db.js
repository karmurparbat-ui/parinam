// std2_db.js — ધોરણ ૨ માટે અલગ IndexedDB (Std 3-8 થી પૂરી છૂટી)
const STD2_DB_NAME = 'SchoolResultDB_Std2';
const STD2_DB_VERSION = 1;
let _s2db = null;

function openStd2DB() {
  return new Promise((res, rej) => {
    if (_s2db) return res(_s2db);
    const req = indexedDB.open(STD2_DB_NAME, STD2_DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('students')) {
        const st = db.createObjectStore('students', { keyPath: 'id' });
        st.createIndex('std', 'std', { unique: false });
      }
      if (!db.objectStoreNames.contains('school'))
        db.createObjectStore('school', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings'))
        db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => { _s2db = req.result; res(_s2db); };
    req.onerror = () => rej(req.error);
  });
}

async function s2GetAllStudents(std = 2) {
  const db = await openStd2DB();
  return new Promise(res => {
    const tx = db.transaction('students', 'readonly');
    const idx = tx.objectStore('students').index('std');
    const r = idx.getAll(std);
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => res([]);
  });
}

async function s2SaveStudent(s) {
  const db = await openStd2DB();
  return new Promise((res, rej) => {
    const tx = db.transaction('students', 'readwrite');
    const r = tx.objectStore('students').put(s);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

async function s2DeleteStudent(id) {
  const db = await openStd2DB();
  return new Promise((res, rej) => {
    const tx = db.transaction('students', 'readwrite');
    const r = tx.objectStore('students').delete(id);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

async function s2GetSchool() {
  const db = await openStd2DB();
  return new Promise(res => {
    const tx = db.transaction('school', 'readonly');
    const r = tx.objectStore('school').get('main');
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => res(null);
  });
}

async function s2SaveSchool(data) {
  const db = await openStd2DB();
  return new Promise((res, rej) => {
    const tx = db.transaction('school', 'readwrite');
    const r = tx.objectStore('school').put({ id: 'main', ...data });
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}