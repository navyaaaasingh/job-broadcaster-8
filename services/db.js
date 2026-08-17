const fs = require('fs');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const dataDir = path.join(__dirname, '..', 'data');
const file = path.join(dataDir, 'db.json');

// Ensure the data directory exists on disk. This matters because
// data/db.json is (deliberately) gitignored, and Git doesn't track empty
// directories — so on a fresh clone (e.g. a hosting platform pulling from
// GitHub), the whole `data/` folder simply doesn't exist yet. Without this,
// lowdb's FileSync adapter crashes with ENOENT trying to write the initial
// file into a directory that was never created.
fs.mkdirSync(dataDir, { recursive: true });

const adapter = new FileSync(file);
const db = low(adapter);

// recipients: [{ email, name, addedAt }] — the fixed broadcast list.
// sentJobs: [{ jobId, email, title, sentAt }] — one row per (job, recipient)
// pair that has actually been emailed, so the same posting is never sent
// to the same person twice, independent of anyone else's send history.
// jobCache: { [jobId]: job } — most recent search results, persisted so
// selections survive a Render free-tier sleep/wake cycle between searching
// and sending.
db.defaults({ recipients: [], sentJobs: [], jobCache: {} }).write();

module.exports = db;
