const searchForm = document.getElementById('search-form');
const aiSearchForm = document.getElementById('ai-search-form');
const searchMeta = document.getElementById('search-meta');
const includeSentCheckbox = document.getElementById('include-sent');
const jobResults = document.getElementById('job-results');
const exportExcelBtn = document.getElementById('export-excel-btn');
const exportStatus = document.getElementById('export-status');

const resumeSearchForm = document.getElementById('resume-search-form');
const resumeUploadInput = document.getElementById('resume-upload');
const resumeFileList = document.getElementById('resume-file-list');
const resumeLocationInput = document.getElementById('resume-location');
const resumeSearchBtn = document.getElementById('resume-search-btn');
const resumeProfilesEl = document.getElementById('resume-profiles');

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

// ---------- Search filters ----------
// Keep the existing text-search behavior while adding native, searchable
// suggestion lists. Browsers allow users to type custom values as well as
// select a suggestion from the dropdown.

const FILTER_OPTIONS = {
  keywords: [
    'remote',
    'hybrid',
    'internship',
    'graduate',
    'entry level',
    'full time',
    'part time',
    'immediate start',
    'flexible working',
  ],
  locations: [
    'London',
    'Manchester',
    'Birmingham',
    'Leeds',
    'Liverpool',
    'Bristol',
    'Edinburgh',
    'Glasgow',
    'Blackpool',
    'Remote',
  ],
};

function addDatalist(input, id, options) {
  if (!input) return;

  let datalist = document.getElementById(id);
  if (!datalist) {
    datalist = document.createElement('datalist');
    datalist.id = id;
    document.body.appendChild(datalist);
  }

  datalist.innerHTML = options
    .map((option) => `<option value="${option}"></option>`)
    .join('');
  input.setAttribute('list', id);
}

function setupSearchDropdowns() {
  const keywordsInput = document.querySelector('#search-form input[name="keywords"]');
  const locationInput = document.querySelector('#search-form input[name="location"]');

  addDatalist(keywordsInput, 'keywords-options', FILTER_OPTIONS.keywords);
  addDatalist(locationInput, 'location-options', FILTER_OPTIONS.locations);
  addDatalist(resumeLocationInput, 'resume-location-options', FILTER_OPTIONS.locations);

  // The original experience select may still contain the old narrow brackets.
  // Replace only its options so existing form submission/state behavior stays
  // unchanged.
  const experienceSelect = document.querySelector('#search-form select[name="experience"]');
  if (experienceSelect) {
    const currentValue = experienceSelect.value;
    experienceSelect.innerHTML = `
      <option value="">Career status — any</option>
      <option value="0-3 years">Early Career Professionals: 0–3 years</option>
      <option value="3-5 years">Senior Roles: 3–5 years</option>
      <option value="5-8 years">Experienced Professionals: 5–8 years</option>
      <option value="8+ years">Leadership / Senior Leadership: 8+ years</option>
    `;
    if ([...experienceSelect.options].some((option) => option.value === currentValue)) {
      experienceSelect.value = currentValue;
    }
  }
}

function injectResponsiveWorkspaceStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .wrap {
      max-width: 1400px;
      padding: 32px 32px 72px;
    }
    .card {
      padding: 28px;
    }
    .inline-form {
      display: grid;
      grid-template-columns: minmax(180px, 1.15fr) minmax(180px, 1fr) minmax(180px, 1fr) minmax(230px, 1.2fr) auto;
      align-items: center;
    }
    .inline-form input,
    .inline-form select {
      min-width: 0;
    }
    .jobs {
      max-height: 62vh;
    }
    .job {
      padding: 14px 16px;
    }
    .job-title {
      font-size: 15px;
    }
    .job-desc {
      font-size: 13.5px;
      max-width: 1100px;
    }
    @media (max-width: 1000px) {
      .inline-form {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .inline-form button {
        width: 100%;
      }
    }
    @media (max-width: 700px) {
      .wrap {
        padding: 20px 14px 50px;
      }
      .inline-form {
        display: flex;
      }
      .inline-form input,
      .inline-form select,
      .inline-form button {
        width: 100%;
        flex: 1 1 100%;
      }
      .jobs {
        max-height: 55vh;
      }
    }
  `;
  document.head.appendChild(style);
}

setupSearchDropdowns();
injectResponsiveWorkspaceStyles();

// ---------- Search method tabs ----------

const searchTabs = document.querySelectorAll('.search-tab');
const searchPanels = document.querySelectorAll('.search-tab-panel');

searchTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    searchTabs.forEach((t) => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');

    const target = tab.dataset.tab;
    searchPanels.forEach((panel) => {
      panel.hidden = panel.dataset.panel !== target;
    });
  });
});

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
    div.innerHTML = `
      <strong>${p.candidateName || p.fileName}</strong>
      <span class="hint">${p.experienceLevel || 'experience unclear'} — suggested: ${p.suggestedRoles.join(', ') || 'n/a'}</span>
      <span class="hint">Top skills: ${(p.topSkills || []).join(', ') || 'none detected'}</span>
      <span class="hint">${p.jobsFound ?? 0} job(s) found for this profile</span>
    `;
    resumeProfilesEl.appendChild(div);
  }
  if (failed && failed.length > 0) {
    const div = document.createElement('div');
    div.className = 'resume-profile resume-profile-error';
    div.textContent = `Could not process: ${failed.map((f) => f.fileName).join(', ')}`;
    resumeProfilesEl.appendChild(div);
  }
}

// ---------- Export selected jobs to Excel ----------
// Works the same regardless of which tab (Search, AI Search, From Resume)
// produced the current selection — all three share the same selectedJobIds
// set and the same server-side job cache.

exportExcelBtn.addEventListener('click', async () => {
  const jobIds = [...selectedJobIds];
  if (jobIds.length === 0) {
    exportStatus.textContent = 'Select at least one job first.';
    return;
  }

  exportExcelBtn.disabled = true;
  exportStatus.textContent = 'Preparing file…';

  try {
    const res = await fetch('/api/export/excel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobIds }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Export failed.');
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'selected-jobs.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    exportStatus.textContent = `Downloaded ${jobIds.length} job(s).`;
  } catch (err) {
    exportStatus.textContent = err.message;
  } finally {
    exportExcelBtn.disabled = false;
  }
});

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
