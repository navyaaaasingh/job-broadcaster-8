const db = require('./db');

function listRecipients() {
  return db.get('recipients').value();
}

function addRecipient(email, name = '') {
  const clean = String(email).trim().toLowerCase();
  if (!clean || !clean.includes('@') || !clean.includes('.')) return null;
  const cleanName = String(name || '').trim();
  const existing = db.get('recipients').find({ email: clean }).value();
  if (existing) {
    // Allow updating the name on a re-add without duplicating the entry.
    if (cleanName && cleanName !== existing.name) {
      db.get('recipients').find({ email: clean }).assign({ name: cleanName }).write();
      return { ...existing, name: cleanName };
    }
    return existing;
  }
  const record = { email: clean, name: cleanName, addedAt: new Date().toISOString() };
  db.get('recipients').push(record).write();
  return record;
}

/**
 * Add many at once (pasted list or uploaded file content). Each entry can be
 * a bare email ("jane@example.com") or "email,name" / "email, name" pairs —
 * matches how people naturally paste a two-column list or export a CSV
 * with name and email columns.
 */
function addRecipients(entries) {
  const added = [];
  const skipped = [];
  for (const raw of entries) {
    const parts = String(raw).split(',').map((p) => p.trim());
    const clean = (parts[0] || '').toLowerCase();
    const cleanName = parts[1] || '';
    if (!clean) continue;
    if (!clean.includes('@') || !clean.includes('.')) {
      skipped.push(raw);
      continue;
    }
    const existing = db.get('recipients').find({ email: clean }).value();
    if (existing) continue; // silently skip duplicates
    added.push({ email: clean, name: cleanName, addedAt: new Date().toISOString() });
  }
  if (added.length > 0) {
    db.get('recipients').push(...added).write();
  }
  return { added, skipped };
}

function removeRecipient(email) {
  db.get('recipients').remove({ email: String(email).trim().toLowerCase() }).write();
}

module.exports = { listRecipients, addRecipient, addRecipients, removeRecipient };
