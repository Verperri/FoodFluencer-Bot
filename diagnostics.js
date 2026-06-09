// ── Diagnostics page ──────────────────────────────────────────────────────────
// Standalone tab (NOT the extension popup) that runs and displays the silent
// feasibility probes (RUN_DIAGNOSTICS → testSilentInstagram / testSilentTikTok,
// see background.js). Read-only — nothing is posted, nothing is written to the
// activity log beyond the technical (DIAGNOSTIC) log entries for export/monitoring.
//
// WHY A SEPARATE TAB: `chrome.windows.create()` steals OS focus, which makes
// Chrome auto-close the *extension popup* — so running this inside the popup
// meant it could vanish mid-test with no way to watch progress. A normal browser
// tab does not auto-close on blur, so this page can simply stay open for the
// whole run. It still renders purely from `chrome.storage.local.silentTestResults`
// (current state on load + live `chrome.storage.onChanged` updates), so it's
// fully resilient even if the user navigates away and comes back, or the tab
// itself gets reloaded mid-run.

(() => {
  const btn = document.getElementById('runDiagnosticBtn');
  const out = document.getElementById('diagnosticResults');
  if (!btn || !out) return;

  // Pulls the named, pass/fail-bearing checks out of a probe result's step log
  // and numbers them as business-friendly "Test Case #N" entries. (Steps without
  // an `ok` flag are progress markers / contextual readings and are skipped —
  // only actual pass/fail tests are listed; the overall verdict is shown
  // separately below the checklist.)
  function platformTests(result) {
    return (result?.steps || [])
      .filter(s => typeof s.ok === 'boolean')
      .map((s, i) => ({ name: `Test Case #${i + 1} - ${s.label}`, ok: s.ok, detail: s.detail }));
  }

  function renderPlatform(container, title, result) {
    if (!result) return;
    const section = document.createElement('div');
    section.style.marginBottom = '12px';

    const tests = platformTests(result);
    const passed = tests.filter(t => t.ok).length;

    const heading = document.createElement('div');
    heading.style.fontWeight = '600';
    heading.textContent = result.running
      ? `${title} — running… (${passed}/${tests.length} checks so far)`
      : `${title} — ${passed}/${tests.length} passed`;
    section.appendChild(heading);

    const list = document.createElement('div');
    list.style.cssText = 'margin:4px 0 0';
    tests.forEach(t => {
      // Each test case is a <details> drawer — collapsed by default, showing only
      // the pass/fail icon and name; click to expand and see its detail line.
      const row = document.createElement('details');
      row.style.cssText = 'margin:2px 0';
      const summary = document.createElement('summary');
      summary.style.cssText = 'cursor:pointer;display:flex;gap:5px;align-items:baseline';
      summary.textContent = `${t.ok ? '✅' : '❌'} ${t.name}`;
      row.appendChild(summary);
      if (t.detail) {
        const body = document.createElement('div');
        body.style.cssText = 'margin:3px 0 3px 20px;color:var(--muted,#888)';
        body.textContent = t.detail;
        row.appendChild(body);
      }
      list.appendChild(row);
    });
    if (result.running) {
      const hint = document.createElement('div');
      hint.style.cssText = 'font-style:italic;margin-top:4px';
      hint.textContent = '⏳ test in progress — feel free to leave this tab open, progress updates live…';
      list.appendChild(hint);
    }
    section.appendChild(list);

    if (result.error) {
      const err = document.createElement('div');
      err.style.cssText = 'margin-top:4px;color:var(--error,#c0392b)';
      err.textContent = `✖ ${result.error}`;
      section.appendChild(err);
    } else if (result.verdict) {
      const verdict = document.createElement('div');
      verdict.style.cssText = 'margin-top:4px;font-style:italic';
      verdict.textContent = `⇒ ${result.verdict}`;
      section.appendChild(verdict);
    }

    container.appendChild(section);
  }

  function render(results) {
    const ig = results?.instagram;
    const tt = results?.tiktok;
    if (!ig && !tt) {
      out.classList.add('hidden');
      out.innerHTML = '';
      return;
    }
    out.classList.remove('hidden');
    out.innerHTML = '';
    renderPlatform(out, '📷 Instagram', ig);
    renderPlatform(out, '🎵 TikTok', tt);

    const running = ig?.running || tt?.running;
    btn.disabled = running;
    btn.textContent = running ? '🧪 Running diagnostic test…' : '🧪 Run Diagnostic Test';
  }

  function loadAndRender() {
    chrome.storage.local.get({ silentTestResults: {} }, ({ silentTestResults }) => render(silentTestResults));
  }

  // Live updates — fires for any progress made anywhere (background, this tab, etc.)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.silentTestResults) render(changes.silentTestResults.newValue);
  });

  // Restore whatever state exists (in-flight or completed) when the page loads —
  // including a run that was already started from the popup before this tab opened.
  loadAndRender();

  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = '🧪 Running diagnostic test…';
    out.classList.remove('hidden');
    out.textContent = 'Starting diagnostic test — opening Instagram in a minimised window…';
    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, () => loadAndRender());
  });
})();
