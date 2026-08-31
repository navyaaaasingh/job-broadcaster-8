const searchForm = document.getElementById('search-form');
const aiSearchForm = document.getElementById('ai-search-form');
const searchMeta = document.getElementById('search-meta');
const resumeSearchForm = document.getElementById('resume-search-form');
const resumeUploadInput = document.getElementById('resume-upload');
const resumeFileList = document.getElementById('resume-file-list');
const resumeLocationInput = document.getElementById('resume-location');
const resumeSearchBtn = document.getElementById('resume-search-btn');
const resumeProfilesEl = document.getElementById('resume-profiles');
const jobResults = document.getElementById('job-results');
const includeSentCheckbox = document.getElementById('include-sent');

const singleNameInput = document.getElementById('single-name');
const singleEmailInput = document.getElementById('single-email');
const addSingleBtn = document.getElementById('add-single');
const bulkEmailsInput = document.getElementById('bulk-emails');
const addBulkBtn = document.getElementById('add-bulk');
const fileUpload = document.getElementById('file-upload');
const recipientsMeta = document.getElementById('recipients-meta');
const recipientsList = document.getElementById('recipients-list');

const sendForm = document.getElementById('send-form');
const sendStatus = document.getElementById('send-status');
const sendBtn = document.getElementById('send-btn');

let selectedJobIds = new Set();

// ---------- Step 1 & 2: search + select ----------

aiSearchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(aiSearchForm);
  const prompt = (fd.get('prompt') || '').trim();
  if (!prompt) return;

  const includeSent = includeSentCheckbox.checked;
  searchMeta.textContent = 'AI searching the web — this takes longer than a regular search…';
  jobResults.innerHTML = '';

  try {
    const res = await fetch('/api/ai-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, includeSent }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI search failed.');

    searchMeta.textContent = `${data.count} result(s) from AI search.`;
    renderJobResults(data.jobs);
  } catch (err) {
    searchMeta.textContent = err.message;
  }
});

// ---------- Resume upload search ----------  

resumeUploadInput.addEventListener('change', () => {
  const files = [...resumeUploadInput.files];
  resumeFileList.innerHTML = files.map((f) => `<span class="resume-file-chip">${f.name}</span>`).join('');
  resumeSearchBtn.disabled = files.length === 0;
});

resumeSearchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = [...resumeUploadInput.files];
  if (files.length === 0) return;

  const location = resumeLocationInput.value.trim();
  const includeSent = includeSentCheckbox.checked;

  resumeSearchBtn.disabled = true;
  searchMeta.textContent = `Reading ${files.length} resume(s) and searching for matching jobs — this takes a while…`;
  jobResults.innerHTML = '';
  resumeProfilesEl.innerHTML = '';

  const formData = new FormData();
  for (const file of files) formData.append('resumes', file);
  formData.append('location', location);
  formData.append('includeSent', String(includeSent));

  try {
    const res = await fetch('/api/ai-search/resumes', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      let message = data.error || 'Resume search failed.';
      if (Array.isArray(data.failed) && data.failed.length > 0) {
        message += ' — ' + data.failed.map((f) => `${f.fileName}: ${f.error}`).join('; ');
      }
      throw new Error(message);
    }

    renderResumeProfiles(data.profiles, data.failed);
    searchMeta.textContent = `${data.count} result(s) based on ${data.profiles.length} resume(s).`;
    renderJobResults(data.jobs);
  } catch (err) {
    searchMeta.textContent = err.message;
  } finally {
    resumeSearchBtn.disabled = false;
  }
});
function renderResumeProfiles(profiles, failed) {
  resumeProfilesEl.innerHTML = '';

  if (!profiles || profiles.length === 0) return;

  for (const p of profiles) {
    const div = document.createElement('div');
    div.className = 'resume-profile';

const skills = Array.isArray(p.topSkills)
  ? p.topSkills
  : Array.isArray(p.skills)
    ? p.skills
    : [];

const skillsText = skills.length > 0
  ? skills.join(', ')
  : 'none detected';

const rolesText = Array.isArray(p.suggestedRoles)
  && p.suggestedRoles.length > 0
  ? p.suggestedRoles.join(', ')
  : 'n/a';

div.innerHTML = `
  <strong>${p.candidateName || p.fileName}</strong>

  <span class="hint">
    ${p.experienceLevel || 'experience unclear'}
    — suggested: ${rolesText}
  </span>

  <span class="hint">
    Skills: ${skillsText}
  </span>

  <span class="hint">
    ${p.jobsFound ?? 0} job(s) found for this profile
  </span>
`;
    resumeProfilesEl.appendChild(div);
  }

  if (failed && failed.length > 0) {
    const div = document.createElement('div');
    div.className = 'resume-profile resume-profile-error';

    div.textContent =
      `Could not process: ${failed.map((f) => f.fileName).join(', ')}`;

    resumeProfilesEl.appendChild(div);
  }
}
searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(searchForm);
  const role = fd.get('role') || '';
  const keywords = fd.get('keywords') || '';
  const location = fd.get('location') || '';
  const experience = fd.get('experience') || '';
  const includeSent = includeSentCheckbox.checked;

  searchMeta.textContent = 'Searching Adzuna, Reed and Jooble…';
  jobResults.innerHTML = '';

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, keywords, location, experience, includeSent }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed.');

    searchMeta.textContent = `${data.count} result(s). Check the ones you want to send.`;
    renderJobResults(data.jobs);
  } catch (err) {
    searchMeta.textContent = err.message;
  }
});

function truncate(text, maxLen) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen).trim() + '…' : clean;
}

function buildJobItemHtml(job) {
  const descSnippet = truncate(job.description, 220);
  return `
    <label class="job-select">
      <input type="checkbox" data-id="${job.id}" ${selectedJobIds.has(job.id) ? 'checked' : ''} ${job.alreadySent ? 'disabled' : ''} />
      <span>
        <span class="job-title">${job.title}</span>
        <a class="job-link" href="${job.url}" target="_blank" rel="noopener">View job ↗</a>
        ${job.alreadySent ? '<span class="already-sent-badge">Already sent</span>' : ''}<br/>
        <span class="job-meta"><span class="job-source">${job.source}</span>${job.company} — ${job.location || 'n/a'}</span>
        ${descSnippet ? `<p class="job-desc">${descSnippet}</p>` : ''}
      </span>
    </label>
  `;
}

function renderJobResults(jobs) {
  jobResults.innerHTML = '';
  if (jobs.length === 0) {
    jobResults.innerHTML = '<li class="empty">No results. Try a different job title, keywords, or location.</li>';
    return;
  }

  const strongMatches = jobs.filter((j) => j.matchesKeywords !== false);
  const weakMatches = jobs.filter((j) => j.matchesKeywords === false);
  const showGrouped = weakMatches.length > 0 && strongMatches.length > 0;

  function appendJobItems(jobList) {
    for (const job of jobList) {
      const li = document.createElement('li');
      li.className = 'job selectable-job' + (job.alreadySent ? ' job-already-sent' : '');
      li.innerHTML = buildJobItemHtml(job);
      jobResults.appendChild(li);
    }
  }

  if (showGrouped) {
    const strongHeader = document.createElement('li');
    strongHeader.className = 'job-group-header';
    strongHeader.textContent = `Matching your keywords (${strongMatches.length})`;
    jobResults.appendChild(strongHeader);
    appendJobItems(strongMatches);

    const weakHeader = document.createElement('li');
    weakHeader.className = 'job-group-header';
    weakHeader.textContent = `Also matching the role, but not your keywords (${weakMatches.length})`;
    jobResults.appendChild(weakHeader);
    appendJobItems(weakMatches);
  } else {
    appendJobItems(jobs);
  }

  jobResults.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) selectedJobIds.add(box.dataset.id);
      else selectedJobIds.delete(box.dataset.id);
    });
  });
}

// ---------- Step 3: recipients ----------

async function loadRecipients() {
  const res = await fetch('/api/recipients');
  const list = await res.json();
  renderRecipients(list);
}

function renderRecipients(list) {
  recipientsMeta.textContent = list.length === 0
    ? 'No recipients yet.'
    : `${list.length} recipient(s) on the list.`;
  recipientsList.innerHTML = '';
  for (const r of list) {
    const li = document.createElement('li');
    li.className = 'recipient';
    li.innerHTML = `<span>${r.name ? `<strong>${r.name}</strong> — ` : ''}${r.email}</span><button class="remove-recipient" data-email="${r.email}">&times;</button>`;
    recipientsList.appendChild(li);
  }
  recipientsList.querySelectorAll('.remove-recipient').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/recipients/${encodeURIComponent(btn.dataset.email)}`, { method: 'DELETE' });
      loadRecipients();
    });
  });
}

addSingleBtn.addEventListener('click', async () => {
  const email = singleEmailInput.value.trim();
  const name = singleNameInput.value.trim();
  if (!email) return;
  const res = await fetch('/api/recipients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name }),
  });
  const data = await res.json();
  if (res.ok) {
    singleEmailInput.value = '';
    singleNameInput.value = '';
    loadRecipients();
  } else {
    recipientsMeta.textContent = data.error;
  }
});

function parseEntryList(text) {
  return text
    .split('\n')
    .map((e) => e.trim())
    .filter(Boolean);
}

async function bulkAdd(entries) {
  if (entries.length === 0) return;
  const res = await fetch('/api/recipients/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: entries }),
  });
  const data = await res.json();
  if (res.ok) {
    recipientsMeta.textContent = `Added ${data.added.length}. Skipped ${data.skipped.length} invalid.`;
    loadRecipients();
  } else {
    recipientsMeta.textContent = data.error;
  }
}

addBulkBtn.addEventListener('click', () => {
  const entries = parseEntryList(bulkEmailsInput.value);
  bulkAdd(entries);
  bulkEmailsInput.value = '';
});

fileUpload.addEventListener('change', () => {
  const file = fileUpload.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const entries = parseEntryList(String(reader.result));
    bulkAdd(entries);
    fileUpload.value = '';
  };
  reader.readAsText(file);
});

// ---------- Step 4: send ----------

sendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const jobIds = [...selectedJobIds];

  if (jobIds.length === 0) {
    sendStatus.textContent = 'Select at least one job first.';
    sendStatus.className = 'form-status err';
    return;
  }

  sendBtn.disabled = true;
  sendStatus.textContent = 'Sending…';
  sendStatus.className = 'form-status';

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobIds,
        experience: {},
        subject: '',
        message: '',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed.');

    let statusMsg = `Sent to ${data.sent}/${data.recipientsTotal} recipients`;
    if (data.alreadyCaughtUp > 0) {
      statusMsg += ` — ${data.alreadyCaughtUp} already had every selected job, so skipped`;
    }
    if (data.failed.length > 0) {
      statusMsg += ` — ${data.failed.length} failed (see server logs)`;
    }
    sendStatus.textContent = statusMsg + '.';
    sendStatus.className = data.failed.length ? 'form-status err' : 'form-status ok';
  } catch (err) {
    sendStatus.textContent = err.message;
    sendStatus.className = 'form-status err';
  } finally {
    sendBtn.disabled = false;
  }
});

// ---------- init ----------
loadRecipients();
