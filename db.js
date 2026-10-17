// ============================================================
// db.js - Multi-Standard Server Database Helper
// ============================================================
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
async function openDB() {
    const account = await window.schoolReady;
    if (!account) throw new Error('પહેલાં school login કરો.');
    return account;
}

async function migrateOldData() { return openDB(); }

// ============================================================
// STUDENTS
// ============================================================
async function getStudents(std) {
    return (await cloudRead('students', String(std))) || [];
}

function saveStudents(students, std) {
    return cloudWrite('students', String(std), students.map((student, index) => ({
        ...student, std: String(std), id: student.id || index + 1
    })));
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
    return cloudWrite('school', String(std), info);
}

async function getSchoolInfoDB(std) {
    const info = await cloudRead('school', String(std));
    const account = await window.schoolReady;
    return { schoolName: account.schoolName, ...(info || {}) };
}

// ============================================================
// HISTORY
// ============================================================
function saveHistory(key, data) {
    return cloudWrite('history', key, data);
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