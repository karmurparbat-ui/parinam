# Parinam school SaaS

School result software with school registration, approval, Principal/teacher
accounts, school-isolated server data, and school-specific WhatsApp connections.

## Local setup (Node.js 24 or newer)

1. Run `npm install`.
2. Copy `.env.example` to `.env`.
3. In `.env`, set your own `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12–128 characters).
4. Run `npm run admin:create` once. There is no default Admin or default password.
5. Remove `ADMIN_PASSWORD` from `.env` after the Admin account is created.
6. Run `npm start` and open `http://localhost:3001/login.html`.

Do not open the HTML files directly or use GitHub Pages: login and data storage
require the Node server. `.env`, `data/`, `node_modules/`, and
`whatsapp_sessions/` must remain outside Git.

## Account workflow

- A school registers its Principal's name, school name, email and password.
- It remains **pending** until the Super Admin approves it and assigns validity.
- Pending, blocked and expired schools can sign in to view their account or
  change their password, but cannot access school data or WhatsApp.
- The Admin panel lists schools, student/teacher counts, approvals, blocks,
  expiry and manual renewal. Validity ends at 23:59:59 Indian time on the
  selected date. Online payments are not included.
- Principals manage school settings and teachers, reset teacher passwords,
  download/import backups, and promote standards 3–8.
- Teachers can manage students, marks, results, printing and WhatsApp across
  **all standards within their own school**. They cannot change school settings,
  manage accounts, import/export school backups or promote standards.
- Users can change their own password. Admins reset Principal passwords;
  Principals reset teacher passwords. Reset/change revokes existing sessions.
  Self-service email recovery, OTP and email verification are not implemented.
- School blocking and expiry gate existing sessions as well as new logins.
  Email/password login has IP/account rate limits.

## Data and backups

SQLite defaults to `data/parinam.sqlite`. Set `DATABASE_PATH` to an absolute
private location if needed. Students, marks, school information, history and
Std 1 HPC form drafts are stored per school; Std 2 retains its separate record
format. Legacy browser databases are not read automatically by result pages.

Principal → **શાળા સંચાલન** provides:

- **આ browserનો જૂનો ડેટા Import**: reads the old IndexedDB databases and
  Std 1 localStorage drafts from the same browser **and origin**. Log in on the
  original `localhost:3001` origin for this migration. It does not delete the
  original browser data.
- **શાળાનો JSON Backup** and JSON import for transferring a school's records to
  another installation/domain. Imports are atomic and refuse to overwrite
  any existing record. Import into a fresh school before using result pages.
  These backups contain private student information; store/share them securely.

Saving uses record versions: another teacher/device's newer save returns a
conflict rather than being silently overwritten. Preserve unsaved changes
before refreshing a conflicting page. Internet/server access is required;
there is no offline synchronisation.

The Admin panel does not provide a password bypass or student-data editing.
School JSON exports do not contain accounts, password hashes or WhatsApp keys.
For a full server backup, stop the server cleanly and back up the private
`data/` and `whatsapp_sessions/` directories securely together. Do not copy only
the live SQLite main file while WAL writes are in progress.

## WhatsApp

Each school must scan its own QR from the marksheet/Patrak F connection link.
An older installation's shared `business_school1` credentials are not
automatically assigned to a registered school. QR scanning must be repeated
for each school. Keep only one application instance using a session directory.

Result images and editable captions remain supported. Automated tests mock
delivery; they do not establish that an actual WhatsApp message was delivered.

## Before VPS deployment

This change does not deploy the site, alter DNS, or change GitHub visibility.

- Use a non-root application service with a private writable database/session
  directory. This SQLite deployment is intended for a single application
  instance on one VPS, not multiple independent replicas.
- Put the server behind HTTPS on your chosen subdomain. Bind/protect the
  application port so it is not publicly reachable behind the proxy.
- Set `TRUST_PROXY=1` only with a trusted single-hop proxy that overwrites
  forwarded headers. HTTPS requests then receive `Secure` session cookies.
  Never use plain HTTP for production credentials.
- Increase the proxy request-size limit for result images and backup imports
  (the app accepts up to 50 MB JSON; each data record is limited to 20 MB).
- Create the production Admin with the command above; do not publish its
  credentials. Plan encrypted off-server backups, retention, monitoring and
  restore testing before storing real school/student records.
- The existing Baileys fork has a known critical npm audit advisory with no
  automatic fix reported. Evaluate/update the WhatsApp dependency before a
  public production launch.

## Tests

Run `npm test`. Tests use temporary/in-memory stores and fake WhatsApp sockets.
They cover registration, approval, expiry, tenant separation, role checks,
CSRF/session handling, password resets, conflicts, backups, persistence,
promotion, browser data helpers and the existing WhatsApp lifecycle/media paths.
