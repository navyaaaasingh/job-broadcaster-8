const db = require('./db');

// Persisted to disk (not just in-memory) so search results survive Render's
// free-tier sleep/wake cycle — without this, selecting jobs and then taking
// a few minutes to add recipients or write a message could hit a spin-down
// in between, wiping an in-memory cache and causing "None of the selected
// jobs were found" errors on send even though nothing was actually wrong
// with the selection itself.
//
// Stored as an object keyed by job id (not an array) so repeated searches
// just overwrite/add entries rather than growing unbounded.

function storeJobs(jobs) {
  const current = db.get('jobCache').value() || {};
  for (const job of jobs) {
    if (job.id) current[job.id] = job;
  }
  db.set('jobCache', current).write();
}

function getJobsByIds(ids) {
  const current = db.get('jobCache').value() || {};
  return ids.map((id) => current[id]).filter(Boolean);
}

module.exports = { storeJobs, getJobsByIds };
