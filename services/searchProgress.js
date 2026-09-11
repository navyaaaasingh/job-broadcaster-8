const { AsyncLocalStorage } = require('node:async_hooks');

const progressContext = new AsyncLocalStorage();
const progressStore = new Map();
const PROGRESS_TTL_MS = 30 * 60 * 1000;

function startProgress(id, kind) {
  if (!id) return;
  progressStore.set(id, {
    id,
    kind,
    status: 'running',
    percent: 2,
    stage: kind === 'resume' ? 'Reading your resume' : 'Understanding your search',
    detail: 'This may take a few moments...',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
  setTimeout(() => progressStore.delete(id), PROGRESS_TTL_MS);
}

function getProgress(id) {
  return id ? progressStore.get(id) || null : null;
}

function updateProgress(id, percent, stage, detail = '') {
  const current = getProgress(id);
  if (!current || current.status !== 'running') return;
  current.percent = Math.max(current.percent, Math.min(99, Math.round(percent)));
  if (stage) current.stage = stage;
  if (detail) current.detail = detail;
  current.updatedAt = Date.now();
}

function completeProgress(id, detail = '') {
  const current = getProgress(id);
  if (!current || current.status !== 'running') return;
  current.status = 'complete';
  current.percent = 100;
  current.stage = '✓ Search complete';
  current.detail = detail;
  current.updatedAt = Date.now();
}

function failProgress(id, message) {
  const current = getProgress(id);
  if (!current || current.status !== 'running') return;
  current.status = 'error';
  current.stage = 'Search could not be completed';
  current.detail = message || 'Something went wrong. Please try again.';
  current.updatedAt = Date.now();
}

function cancelProgress(id) {
  const current = getProgress(id);
  if (!current || current.status !== 'running') return;
  current.status = 'cancelled';
  current.stage = 'Search cancelled';
  current.detail = 'You can start another search whenever you are ready.';
  current.updatedAt = Date.now();
}

function getCurrentContext() {
  return progressContext.getStore() || null;
}

function mapStageForKind(kind, stage) {
  if (kind !== 'resume') return stage;
  const map = {
    'Understanding your search': 'Finding relevant jobs',
    'Analysing job requirements': 'Finding relevant jobs',
    'Matching jobs to your criteria': 'Matching jobs to your experience',
  };
  return map[stage] || stage;
}

function reportProgress(percent, stage, detail = '') {
  const context = getCurrentContext();
  if (!context?.id) return;

  const mappedPercent = context.kind === 'resume' ? 30 + (percent * 0.65) : percent;
  updateProgress(context.id, mappedPercent, mapStageForKind(context.kind, stage), detail);
}

function startResumeFile() {
  const context = getCurrentContext();
  if (!context || context.kind !== 'resume') return null;
  context.resumeFileIndex = (context.resumeFileIndex || 0) + 1;
  return context.resumeFileIndex - 1;
}

function reportResumeProgress(fileIndex, phasePercent, stage, detail = '') {
  const context = getCurrentContext();
  if (!context?.id || context.kind !== 'resume') return;
  const total = Math.max(1, Number(context.resumeFileCount) || 1);
  const perFile = 25 / total;
  const phase = Math.max(0, Math.min(100, phasePercent));
  const percent = 5 + ((fileIndex + phase / 100) * perFile);
  updateProgress(context.id, percent, stage, detail);
}

function setResumeFileCount(count) {
  const context = getCurrentContext();
  if (context?.kind === 'resume') context.resumeFileCount = Math.max(1, Number(count) || 1);
}

function runWithProgressContext(id, kind, callback) {
  const context = { id, kind, resumeFileCount: 1, resumeFileIndex: 0 };
  return progressContext.run(context, callback);
}

module.exports = {
  progressContext,
  startProgress,
  getProgress,
  updateProgress,
  completeProgress,
  failProgress,
  cancelProgress,
  reportProgress,
  startResumeFile,
  reportResumeProgress,
  setResumeFileCount,
  runWithProgressContext,
};
