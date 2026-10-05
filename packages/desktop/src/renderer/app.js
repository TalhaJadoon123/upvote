/**
 * Upvote desktop renderer.
 *
 * Plain DOM, no framework: the app has a handful of views and the surface area
 * of an SPA would be pure risk for no benefit. Every privileged call goes
 * through `window.upvote`, the contextBridge API.
 */
'use strict';

const api = window.upvote;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let state = null;
let activeDraft = null;
let rescoreTimer = null;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('is-error', Boolean(isError));
  el.classList.remove('is-hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('is-hidden'), 4200);
}

function scoreClass(score) {
  if (score >= 92) return 's-good';
  if (score >= 85) return 's-mid';
  if (score >= 75) return 's-warn';
  return 's-bad';
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label || 'Working…';
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

async function call(promise, busyButton, busyLabel) {
  if (busyButton) setBusy(busyButton, true, busyLabel);
  try {
    const result = await promise;
    if (!result || result.ok !== true) {
      toast(result?.error ?? 'Something went wrong.', true);
      return null;
    }
    return result.data;
  } catch (error) {
    toast(String(error?.message ?? error), true);
    return null;
  } finally {
    if (busyButton) setBusy(busyButton, false);
  }
}

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */

const TITLES = {
  drafts: 'Drafts',
  voice: 'Voice',
  calendar: 'Calendar',
  analytics: 'Analytics',
  settings: 'Settings',
};

function show(view) {
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-hidden', v.dataset.view !== view));
  $('#view-title').textContent = TITLES[view] || 'Upvote';
  if (view === 'calendar') loadCalendar();
  if (view === 'analytics') loadAnalytics();
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

async function loadStatus() {
  const status = await api.status();
  if (!status.ok) return;
  const s = status.data;
  $('#plan-pill').textContent = s.plan;
  $('#status-foot').textContent = [
    `v${s.version} · ${s.platform}`,
    `drafts: ${s.draftCount} (${s.scheduledCount} scheduled)`,
    `published: ${s.postedCount}`,
    `voice: ${s.hasVoiceProfile ? `${s.sampleCount} samples` : 'not trained'}`,
    `model: ${s.modelConfigured ? 'configured' : 'offline composer'}`,
    `github: ${s.githubConnected ? 'connected' : 'not connected'}`,
    `reddit: ${s.redditConnected ? 'connected' : 'not connected'}`,
  ].join('\n');
  $('#data-path').textContent = `Data: ${s.dataPath}`;
  $('#about-text').textContent =
    'Upvote turns your commits, releases and learnings into authentic Reddit posts in your voice. ' +
    'Nothing posts without your approval.';
}

/* ------------------------------------------------------------------ */
/* drafts                                                              */
/* ------------------------------------------------------------------ */

async function loadDrafts() {
  const result = await api.state();
  if (!result.ok) return;
  state = result.data;

  const list = $('#draft-list');
  if (!state.drafts.length) {
    list.innerHTML = '<div class="card muted">No drafts yet. Describe something you shipped above.</div>';
    return;
  }

  list.innerHTML = state.drafts
    .map(
      (d) => `
      <article class="draft" data-id="${esc(d.id)}">
        <div class="draft-head">
          <span class="tag">${esc(String(d.style).replace(/_/g, ' '))}</span>
          <span class="tag">${d.primarySubreddit ? 'r/' + esc(d.primarySubreddit) : 'unmatched'}</span>
          <span class="tag">${esc(d.status)}</span>
          <span class="score-num ${scoreClass(d.authenticityScore)}">${Number(d.authenticityScore).toFixed(0)}</span>
        </div>
        <div class="draft-title">${esc(d.title)}</div>
        <div class="draft-body">${esc(d.body)}</div>
      </article>`,
    )
    .join('');

  list.querySelectorAll('.draft').forEach((el) => {
    el.addEventListener('click', () => openDraft(el.dataset.id));
  });
}

function openDraft(id) {
  activeDraft = state.drafts.find((d) => d.id === id);
  if (!activeDraft) return;

  $('#drawer-title').textContent = activeDraft.title;
  $('#drawer-meta').textContent =
    `${String(activeDraft.style).replace(/_/g, ' ')} · r/${activeDraft.primarySubreddit ?? 'unmatched'} · ${activeDraft.status}`;
  $('#edit-title').value = activeDraft.title;
  $('#edit-body').value = activeDraft.body;
  $('#edit-comment').value = activeDraft.firstComment || '';
  $('#edit-subreddit').value = activeDraft.primarySubreddit || '';
  $('#drawer-hint').textContent = '';
  renderScore(activeDraft.authenticityScore, activeDraft.authenticity || {});

  const suggestions = (activeDraft.suggestedSubreddits || [])
    .filter((s) => (s.violations || []).length === 0)
    .map(
      (s) =>
        `<div class="row" style="margin:0"><button class="btn btn-ghost" data-sub="${esc(s.subreddit)}">r/${esc(s.subreddit)} · ${Math.round(s.fit)}</button></div>`,
    )
    .join('');
  $('#suggest-list').innerHTML = suggestions || '<div class="hint">No compliant subreddit matched yet.</div>';
  $$('#suggest-list [data-sub]').forEach((b) => {
    b.addEventListener('click', () => {
      $('#edit-subreddit').value = b.dataset.sub;
    });
  });

  $('#drawer').classList.remove('is-hidden');
}

function closeDrawer() {
  $('#drawer').classList.add('is-hidden');
  activeDraft = null;
}

function renderScore(score, breakdown) {
  const rows = Object.entries(breakdown || {})
    .map(([k, v]) => {
      const value = Number(v);
      const cls = value >= 90 ? 's-good' : value >= 70 ? 's-warn' : 's-bad';
      const label = k.replace(/([A-Z])/g, ' $1').toLowerCase();
      return `<div><span>${esc(label)}</span><b class="${cls}">${value.toFixed(0)}</b></div>`;
    })
    .join('');
  $('#score-block').innerHTML = `
    <div class="score-head">
      <span class="score-big ${scoreClass(score)}">${Number(score).toFixed(0)}</span>
      <span class="muted small" style="margin:0">voice match · gate is 85</span>
    </div>
    <div class="bar"><i style="width:${Math.max(2, Math.min(100, score))}%"></i><u style="left:85%"></u></div>
    <div class="bd">${rows}</div>`;
}

function scheduleRescore() {
  if (!activeDraft) return;
  clearTimeout(rescoreTimer);
  rescoreTimer = setTimeout(async () => {
    const result = await api.drafts.rescore({
      id: activeDraft.id,
      title: $('#edit-title').value,
      body: $('#edit-body').value,
    });
    if (!result.ok) return;
    renderScore(result.data.score, result.data.breakdown);
    const directives = result.data.directives || [];
    let block = $('#score-block .directives');
    if (!block) {
      block = document.createElement('div');
      block.className = 'directives';
      $('#score-block').appendChild(block);
    }
    block.innerHTML = directives
      .slice(0, 5)
      .map((d) => `<div>→ ${esc(d)}</div>`)
      .join('');
  }, 400);
}

/* ------------------------------------------------------------------ */
/* voice                                                               */
/* ------------------------------------------------------------------ */

async function trainVoice(button) {
  const text = $('#voice-input').value;
  const data = await call(api.voice.train({ text }), button, 'Reading your writing…');
  if (!data) return;
  toast(`Trained on ${data.sampleCount} samples.`);
  $('#voice-result').innerHTML = `
    <div class="card">
      <h2>Your voice</h2>
      <p class="muted">${esc(data.summary)}</p>
      <div class="stats">
        <div class="stat"><span>quality</span><b>${data.quality.score}</b></div>
        <div class="stat"><span>samples</span><b>${data.sampleCount}</b></div>
        <div class="stat"><span>status</span><b>${data.quality.readyForProduction ? 'ready' : 'learning'}</b></div>
      </div>
      ${
        data.profile.signaturePhrases.length
          ? `<h3 style="font-size:13px;margin:14px 0 6px">Signature phrasing</h3><div class="row" style="flex-wrap:wrap;margin:0">${data.profile.signaturePhrases
              .slice(0, 8)
              .map((p) => `<span class="tag">${esc(p)}</span>`)
              .join('')}</div>`
          : ''
      }
      ${
        data.quality.warnings.length
          ? `<h3 style="font-size:13px;margin:14px 0 6px">Still needs</h3><div class="muted small">${data.quality.warnings
              .map(esc)
              .join('<br>')}</div>`
          : ''
      }
    </div>`;
  await loadStatus();
}

/* ------------------------------------------------------------------ */
/* calendar + analytics                                                */
/* ------------------------------------------------------------------ */

async function loadCalendar() {
  const result = await api.calendar.get();
  if (!result.ok) return;
  const grid = $('#calendar-grid');
  if (!result.data.calendar.length) {
    grid.innerHTML = '<div class="card muted">Nothing scheduled.</div>';
    return;
  }
  grid.innerHTML = result.data.calendar
    .map(
      (day) => `
      <div class="day ${day.blocked ? 'is-blocked' : ''}">
        <div class="day-date">${esc(day.date)}</div>
        ${day.items
          .map(
            (i) =>
              `<div class="day-item"><b>${esc(new Date(i.runAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</b>r/${esc(i.subreddit)}</div>`,
          )
          .join('')}
      </div>`,
    )
    .join('');
}

async function loadAnalytics() {
  const result = await api.analytics.report();
  if (!result.ok) return;
  const rows = result.data.rows;
  const report = result.data.report;

  if (!rows.length) {
    $('#analytics-root').innerHTML =
      '<div class="card muted">Nothing published yet. Post a draft and the numbers land here.</div>';
    return;
  }

  const total = rows.reduce(
    (acc, r) => ({
      up: acc.up + r.upvotes,
      cmt: acc.cmt + r.comments,
      sign: acc.sign + r.signups,
    }),
    { up: 0, cmt: 0, sign: 0 },
  );

  $('#analytics-root').innerHTML = `
    <div class="stats">
      <div class="stat"><span>posts</span><b>${rows.length}</b></div>
      <div class="stat"><span>upvotes</span><b>${total.up}</b></div>
      <div class="stat"><span>comments</span><b>${total.cmt}</b></div>
      <div class="stat"><span>signups</span><b>${total.sign}</b></div>
      <div class="stat"><span>voice vs reach</span><b>${report.correlation.coefficient}</b></div>
    </div>
    <div class="card">
      <h2>Posts</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="color:var(--muted);text-align:left">
          <th style="padding:6px 0">Title</th><th>Sub</th><th>Voice</th><th>Up</th>
        </tr></thead>
        <tbody>
        ${rows
          .map(
            (r) => `<tr style="border-top:1px solid var(--line)">
              <td style="padding:8px 0">${esc(r.title)}</td>
              <td style="color:var(--muted)">r/${esc(r.subreddit)}</td>
              <td class="${scoreClass(r.voiceScore)}">${r.voiceScore.toFixed(0)}</td>
              <td>${r.upvotes}</td>
            </tr>`,
          )
          .join('')}
        </tbody>
      </table>
    </div>
    <div class="card">
      <h2>Next week</h2>
      <div class="muted">${report.recommendations.map((r) => '→ ' + esc(r)).join('<br>')}</div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function wire() {
  $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.view)));
  $('#drawer-close').addEventListener('click', closeDrawer);

  $('#generate-btn').addEventListener('click', async (e) => {
    const moment = $('#moment-input').value.trim();
    if (moment.length < 20) {
      toast('Describe what you shipped in a sentence or two.', true);
      return;
    }
    const data = await call(api.drafts.generate({ moment }), e.currentTarget, 'Writing…');
    if (!data) return;
    const rejected = (data.rejected || []).length;
    toast(
      `${data.drafts.length} drafts ready${rejected ? `, ${rejected} below the voice gate` : ''}.`,
    );
    await loadDrafts();
  });

  $('#train-btn').addEventListener('click', (e) => trainVoice(e.currentTarget));

  $('#edit-title').addEventListener('input', scheduleRescore);
  $('#edit-body').addEventListener('input', scheduleRescore);

  $('#approve-btn').addEventListener('click', async (e) => {
    if (!activeDraft) return;
    const subreddit = $('#edit-subreddit').value.replace(/^\/?r\//, '').trim();
    if (!subreddit) {
      toast('Pick a subreddit first.', true);
      return;
    }
    const data = await call(
      api.drafts.approve({ id: activeDraft.id, subreddit }),
      e.currentTarget,
      'Scheduling…',
    );
    if (!data) return;
    toast(`Scheduled for r/${data.subreddit} at ${new Date(data.scheduledFor).toLocaleString()}.`);
    await loadDrafts();
    await loadStatus();
  });

  $('#post-btn').addEventListener('click', async (e) => {
    if (!activeDraft) return;
    const data = await call(api.drafts.post({ id: activeDraft.id }), e.currentTarget, 'Posting…');
    if (!data) return;
    toast('Posted.');
    closeDrawer();
    await loadDrafts();
    await loadStatus();
    if (data.firstComment) {
      window.confirm('Post is live.\n\nSuggested first comment:\n\n' + data.firstComment);
    }
  });

  $('#save-settings').addEventListener('click', async (e) => {
    const data = await call(
      api.config.save({
        product: { url: $('#product-url').value.trim() || undefined },
        github: { token: $('#gh-token').value.trim() || undefined, connected: Boolean($('#gh-token').value.trim()) },
      }),
      e.currentTarget,
      'Saving…',
    );
    if (!data) return;
    $('#settings-hint').textContent = 'Saved.';
    await loadStatus();
  });

  $('#git-sync').addEventListener('click', async (e) => {
    const data = await call(api.git.sync({}), e.currentTarget, 'Reading git log…');
    if (!data) return;
    $('#git-hint').textContent = data.skipped
      ? `Nothing worth posting: ${data.detail || 'the commits were noise.'}`
      : `Found: ${data.whatChanged}`;
    if (!data.skipped) $('#moment-input').value = `${data.whatChanged}. ${data.lesson || ''}`.trim();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
}

async function boot() {
  wire();
  await loadStatus();
  await loadDrafts();

  const stateResult = await api.state();
  if (stateResult.ok) {
    $('#product-url').value = stateResult.data.product?.url || '';
    $('#gh-token').value = stateResult.data.github?.token || '';
  }
}

boot();