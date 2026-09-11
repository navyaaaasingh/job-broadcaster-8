require('dotenv').config();
const express = require('express');
const path = require('path');
const broadcastRoutes = require('./routes/broadcast');
const {
  startProgress,
  getProgress,
  cancelProgress,
  setResumeFileCount,
  runWithProgressContext,
  failProgress,
  completeProgress,
} = require('./services/searchProgress');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Search progress is lightweight polling so it fits the existing request /
// response architecture. The search pipeline itself reports real milestones.
app.use((req, res, next) => {
  const progressId = String(req.query.progressId || '').trim();
  const isAiSearch = req.method === 'POST' && req.path === '/api/ai-search';
  const isResumeSearch = req.method === 'POST' && req.path === '/api/ai-search/resumes';

  if (!progressId || (!isAiSearch && !isResumeSearch)) {
    return next();
  }

  const kind = isResumeSearch ? 'resume' : 'ai';
  startProgress(progressId, kind);

  res.on('finish', () => {
    if (res.statusCode >= 400) {
      failProgress(progressId, 'The search could not be completed. Please try again.');
    } else {
      completeProgress(progressId);
    }
  });

  req.on('close', () => {
    // A normal request also emits close, so only treat it as cancellation if
    // the response has not already finished.
    if (!res.writableEnded) cancelProgress(progressId);
  });

  return runWithProgressContext(progressId, kind, () => {
    if (kind === 'resume') {
      setResumeFileCount(Number(req.query.resumeCount) || 1);
    }
    return next();
  });
});

app.use('/api', broadcastRoutes);

app.get('/api/search-progress/:id', (req, res) => {
  const progress = getProgress(req.params.id);
  if (!progress) {
    return res.status(404).json({ error: 'Progress session not found.' });
  }
  res.set('Cache-Control', 'no-store');
  return res.json(progress);
});

app.post('/api/search-progress/:id/cancel', (req, res) => {
  cancelProgress(req.params.id);
  return res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Job Broadcaster running at http://localhost:${PORT}`);
});
