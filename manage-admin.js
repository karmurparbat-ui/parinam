const { randomUUID } = require('node:crypto');
const { openStore, hashPassword, transaction } = require('./saas-store');
const { emailAddress, passwordValue } = require('./saas-api');

async function main() {
    if (require('node:fs').existsSync('.env')) process.loadEnvFile();
    const email = emailAddress(process.env.ADMIN_EMAIL);
    const password = passwordValue(process.env.ADMIN_PASSWORD);
    const db = openStore();
    try {
        const existing = db.prepare('SELECT id,role FROM users WHERE email=?').get(email);
        if (existing) throw new Error('આ Email પહેલેથી વપરાયેલ છે. નવું Admin બનાવાયું નથી.');
        const hash = await hashPassword(password);
        transaction(db, () => {
            db.prepare(`INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?, 'admin', ?)`)
                .run(randomUUID(), 'Super Admin', email, hash, Date.now());
        });
        console.log('Super Admin બન્યો. /login.html પરથી login કરો. .envમાંથી ADMIN_PASSWORD કાઢી નાખો.');
    } finally {
        db.close();
    }
}

main().catch(error => {
    console.error('Admin બનાવી શકાયો નથી:', error.message);
    process.exitCode = 1;
});
