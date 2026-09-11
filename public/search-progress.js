(() => {
  const originalFetch = window.fetch.bind(window);
  const trackedEndpoints = ['/api/ai-search', '/api/ai-search/resumes'];
  let activeSearch = null;
  let lastSearchKind = null;

  function isTrackedUrl(input) {
    const url = typeof input === 'string' ? input : input?.url || '';
    return trackedEndpoints.some((endpoint) => url.includes(endpoint));
  }

  function endpointKind(input) {
    const url = typeof input === 'string' ? input : input?.url || '';
    return url.includes('/api/ai-search/resumes') ? 'resume' : 'ai';
  }

  function createId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `search-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function ensureStyles() {
    if (document.getElementById('search-progress-styles')) return;
    const style = document.createElement('style');
    style.id = 'search-progress-styles';
    style.textContent = `
      .search-progress { margin:16px 0 18px; padding:18px 20px; border:1px solid rgba(100,116,139,.18); border-radius:14px; background:rgba(248,250,252,.88); }
      .search-progress[hidden] { display:none; }
      .search-progress-head { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:10px; }
      .search-progress-stage { font-weight:650; line-height:1.35; }
      .search-progress-percent { font-variant-numeric:tabular-nums; font-weight:700; white-space:nowrap; }
      .search-progress-track { height:9px; overflow:hidden; border-radius:999px; background:rgba(100,116,139,.15); }
      .search-progress-fill { height:100%; width:2%; border-radius:inherit; background:currentColor; transition:width .45s ease; }
      .search-progress-fill.running { animation:search-progress-pulse 1.7s ease-in-out infinite; }
      .search-progress-detail { display:flex; justify-content:space-between; align-items:center; gap:14px; margin-top:9px; font-size:.86rem; }
      .search-progress-eta { opacity:.72; }
      .search-progress-actions { display:flex; gap:12px; align-items:center; }
      .search-progress-action { border:0; background:transparent; padding:2px 0; text-decoration:underline; cursor:pointer; opacity:.68; }
      .search-progress-error { border-color:rgba(185,28,28,.25); }
      .search-progress-error .search-progress-fill { background:#b91c1c; }
      @keyframes search-progress-pulse { 0%,100% { opacity:1; } 50% { opacity:.62; } }
      @media (max-width:600px) { .search-progress { padding:15px; } .search-progress-detail { align-items:flex-start; flex-direction:column; gap:5px; } }
    `;
    document.head.appendChild(style);
  }

  function ensureElement() {
    ensureStyles();
    let el = document.getElementById('search-progress');
    if (el) return el;

    el = document.createElement('div');
    el.id = 'search-progress';
    el.className = 'search-progress';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `
      <div class="search-progress-head"><span class="search-progress-stage"></span><span class="search-progress-percent">0%</span></div>
      <div class="search-progress-track" aria-hidden="true"><div class="search-progress-fill running"></div></div>
      <div class="search-progress-detail">
        <span class="search-progress-eta">This may take a few moments...</span>
        <span class="search-progress-actions">
          <button type="button" class="search-progress-action search-progress-retry" hidden>Retry</button>
          <button type="button" class="search-progress-action search-progress-cancel">Cancel</button>
        </span>
      </div>
    `;

    const anchor = document.getElementById('search-meta');
    if (anchor?.parentNode) anchor.parentNode.insertBefore(el, anchor);
    else document.body.prepend(el);

    el.querySelector('.search-progress-cancel').addEventListener('click', () => {
      if (activeSearch) activeSearch.cancel();
    });
    el.querySelector('.search-progress-retry').addEventListener('click', () => {
      const formId = lastSearchKind === 'resume' ? 'resume-search-form' : 'ai-search-form';
      document.getElementById(formId)?.requestSubmit();
    });
    return el;
  }

  function setProgress(state) {
    const el = ensureElement();
    const percent = Math.max(0, Math.min(100, Number(state.percent) || 0));
    const isError = state.status === 'error';
    el.hidden = false;
    el.classList.toggle('search-progress-error', isError);
    el.querySelector('.search-progress-stage').textContent = state.stage || 'Working on your search';
    el.querySelector('.search-progress-percent').textContent = `${percent}%`;
    el.querySelector('.search-progress-fill').style.width = `${Math.max(2, percent)}%`;
    el.querySelector('.search-progress-eta').textContent = state.detail || 'This may take a few moments...';
    el.querySelector('.search-progress-cancel').hidden = state.status !== 'running';
    el.querySelector('.search-progress-retry').hidden = !isError;
    el.querySelector('.search-progress-fill').classList.toggle('running', state.status === 'running');
  }

  function estimateEta(progress, startedAt) {
    const percent = Number(progress.percent) || 0;
    const elapsed = Math.max(0, Date.now() - startedAt);
    if (percent < 15 || elapsed < 1800) return null;
    const secondsRemaining = Math.max(1, Math.ceil((elapsed / percent) * (100 - percent) / 1000));
    if (!Number.isFinite(secondsRemaining) || secondsRemaining > 300) return null;
    return secondsRemaining;
  }

  async function pollProgress(id, startedAt, signal) {
    while (!signal.aborted) {
      try {
        const res = await originalFetch(`/api/search-progress/${encodeURIComponent(id)}`, { cache:'no-store', signal });
        if (res.ok) {
          const state = await res.json();
          const nextState = { ...state };
          const eta = state.status === 'running' ? estimateEta(state, startedAt) : null;
          if (state.status === 'running' && eta !== null) {
            nextState.detail = `About ${eta} second${eta === 1 ? '' : 's'} remaining`;
          }
          setProgress(nextState);
          if (['complete','error','cancelled'].includes(state.status)) return state;
        }
      } catch (err) {
        if (err.name === 'AbortError') return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return null;
  }

  function addProgressId(input, id, kind) {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const url = new URL(rawUrl, window.location.href);
    url.searchParams.set('progressId', id);
    if (kind === 'resume') {
      url.searchParams.set('resumeCount', String(document.getElementById('resume-upload')?.files?.length || 1));
    }
    return url.toString();
  }

  window.fetch = async function trackedFetch(input, init = {}) {
    if (!isTrackedUrl(input)) return originalFetch(input, init);

    const kind = endpointKind(input);
    const id = createId();
    lastSearchKind = kind;
    const startedAt = Date.now();
    const controller = new AbortController();
    const existingSignal = init.signal || (input instanceof Request ? input.signal : null);
    const requestInit = { ...init, signal: existingSignal || controller.signal };
    const url = addProgressId(input, id, kind);

    if (kind === 'resume' && requestInit.body instanceof FormData) {
      requestInit.body.append('progressId', id);
      requestInit.body.append('resumeCount', String(document.getElementById('resume-upload')?.files?.length || 1));
    }

    if (kind === 'ai' && typeof requestInit.body === 'string') {
      try {
        const body = JSON.parse(requestInit.body);
        body.progressId = id;
        requestInit.body = JSON.stringify(body);
      } catch (_) {}
    }

    const pollController = new AbortController();
    let cancelled = false;
    const searchHandle = {
      cancel: () => {
        cancelled = true;
        controller.abort();
        pollController.abort();
        setProgress({ status:'cancelled', percent:0, stage:'Search cancelled', detail:'You can start another search whenever you are ready.' });
        originalFetch(`/api/search-progress/${encodeURIComponent(id)}/cancel`, { method:'POST', keepalive:true }).catch(() => {});
      },
    };
    activeSearch = searchHandle;

    setProgress({ status:'running', percent:2, stage:kind === 'resume' ? 'Reading your resume' : 'Understanding your search', detail:'This may take a few moments...' });
    const pollPromise = pollProgress(id, startedAt, pollController.signal);

    try {
      const response = await originalFetch(url, requestInit);
      pollController.abort();
      if (!response.ok) {
        setProgress({ status:'error', percent:0, stage:'Search could not be completed', detail:'Please check the error below and try again.' });
      } else if (!cancelled) {
        setProgress({ status:'complete', percent:100, stage:'✓ Search complete', detail:'Preparing your results...' });
      }
      return response;
    } catch (err) {
      pollController.abort();
      if (cancelled || err.name === 'AbortError') {
        setProgress({ status:'cancelled', percent:0, stage:'Search cancelled', detail:'You can start another search whenever you are ready.' });
      } else {
        setProgress({ status:'error', percent:0, stage:'Search could not be completed', detail:'A network error occurred. Please try again.' });
      }
      throw err;
    } finally {
      await pollPromise.catch(() => {});
      if (activeSearch === searchHandle) activeSearch = null;
    }
  };

  window.addEventListener('pagehide', () => {
    if (activeSearch) activeSearch.cancel();
  });
})();
