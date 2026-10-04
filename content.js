const ATTR = 'data-nrl';
const LABEL_ATTR = 'data-nrl-label';
const DATE_ATTR = 'data-nrl-date';
// Wide layout: cards are buttons keyed by job id. Narrow layout: cards are links.
const KEY_PREFIX = 'job-card-component-ref-';
const CARD_SELECTOR = `[componentkey^="${KEY_PREFIX}"]`;
const LINK_SELECTOR = 'a[href*="/jobs/view/"]';
const LIST_SELECTOR = '[data-testid="lazy-column"]';
// LinkedIn's own listing date drifts a little from the original one even for
// brand new jobs, so only a gap of a day or more counts as a repost.
const MIN_GAP_MS = 24 * 60 * 60 * 1000;
const LOOKUP_DELAY_MS = 50;
const CONCURRENCY = 4;
const FRESH_TTL_MS = 24 * 60 * 60 * 1000;
const BACKOFF_MS = 5 * 60 * 1000;
const MAX_STORED = 5000;

let mode = 'hide'; // 'hide' | 'label' | 'off'
let minAgeDays = 0; // only flag reposts first posted at least this long ago
const reposted = new Map(); // job id -> original listing timestamp
const fresh = new Map(); // job id -> when it was checked and found not reposted
const queue = [];
const queued = new Set();
let running = 0;
let pausedUntil = 0;
let saveTimer = null;
let applyTimer = null;
let lastSummary = '';

const DEBUG = false; // set to true to log lookups in the page console

function log(...args) {
  if (DEBUG) console.log('[NRL]', ...args);
}

function jobIdOf(el) {
  const key = el.getAttribute('componentkey');
  if (key?.startsWith(KEY_PREFIX)) return key.slice(KEY_PREFIX.length).match(/^\d+/)?.[0] || null;
  return (el.getAttribute('href') || '').match(/\/jobs\/view\/(?:[^/?#]*-)?(\d+)/)?.[1] || null;
}

// A link only counts as a card if it sits right under the results list (or in
// an old-style <li>); the job title link in the detail pane is nested deeper.
function isCardLink(link) {
  if (link.closest(CARD_SELECTOR)) return false;
  if (link.closest('li')) return true;
  let el = link;
  for (let i = 0; i < 3 && el; i++) {
    el = el.parentElement;
    if (el?.matches(LIST_SELECTOR)) return true;
  }
  return false;
}

function findCards() {
  const cards = [];
  document.querySelectorAll(CARD_SELECTOR).forEach((el) => {
    if (el.parentElement?.closest(CARD_SELECTOR)) return;
    const id = jobIdOf(el);
    if (id) cards.push({ id, el });
  });
  document.querySelectorAll(LINK_SELECTOR).forEach((el) => {
    const id = jobIdOf(el);
    if (id && isCardLink(el)) cards.push({ id, el });
  });
  return cards;
}

// The row is the largest wrapper around the card that holds only this job.
function rowOf(el, id) {
  for (let i = 0; i < 5; i++) {
    const parent = el.parentElement;
    if (
      !parent ||
      parent === document.body ||
      parent.tagName === 'MAIN' ||
      parent.matches(LIST_SELECTOR) ||
      ![...parent.querySelectorAll(`${CARD_SELECTOR}, ${LINK_SELECTOR}`)].every(
        (other) => jobIdOf(other) === id
      )
    ) {
      break;
    }
    el = parent;
    if (el.tagName === 'LI') break;
  }
  return el;
}

function findDates(node, acc = {}) {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'listedAt' || key === 'originalListedAt') && typeof value === 'number') {
        acc[key] ??= value;
      } else if (key === 'repostedJob' && typeof value === 'boolean') {
        acc.repostedJob ??= value;
      } else {
        findDates(value, acc);
      }
    }
  }
  return acc;
}

function ageOf(timestamp) {
  const days = Math.max(1, Math.round((Date.now() - timestamp) / 86400000));
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  if (days < 730) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

async function lookup(id) {
  const csrf = document.cookie.match(/JSESSIONID="?([^";]+)/)?.[1];
  if (!csrf) {
    log('no JSESSIONID cookie visible, cannot look up', id);
    return false;
  }
  const res = await fetch(`/voyager/api/jobs/jobPostings/${id}`, {
    headers: {
      'csrf-token': csrf,
      accept: 'application/json',
      'x-restli-protocol-version': '2.0.0',
    },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    log('lookup', id, 'HTTP', res.status);
    // Back off rather than keep knocking if LinkedIn starts refusing.
    if ([401, 403, 429, 999].includes(res.status)) pausedUntil = Date.now() + BACKOFF_MS;
    return false;
  }
  const { listedAt, originalListedAt, repostedJob } = findDates(await res.json());
  const gap = listedAt && originalListedAt ? listedAt - originalListedAt : 0;
  log('lookup', id, 'gapDays', (gap / 86400000).toFixed(1), 'dates found', !!listedAt, !!originalListedAt);
  if (repostedJob === true || gap >= MIN_GAP_MS) {
    reposted.set(id, originalListedAt || 0);
  } else {
    fresh.set(id, Date.now());
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1000);
  return true;
}

function save() {
  chrome.storage.local.set({
    repostedJobs: Object.fromEntries([...reposted].slice(-MAX_STORED)),
    // Failed lookups are stored as 0 in memory and not persisted.
    freshJobs: Object.fromEntries([...fresh].filter(([, at]) => at).slice(-MAX_STORED)),
  });
}

async function runQueue() {
  if (running >= CONCURRENCY) return;
  running++;
  while (queue.length && mode !== 'off' && Date.now() >= pausedUntil) {
    const id = queue.shift();
    let done = false;
    try {
      done = await lookup(id);
    } catch (err) {
      log('lookup', id, 'threw', String(err));
    }
    queued.delete(id);
    // A failed lookup is left unknown for this page view instead of retried in a loop.
    if (!done) fresh.set(id, 0);
    scheduleApply();
    await new Promise((resolve) => setTimeout(resolve, LOOKUP_DELAY_MS));
  }
  running--;
}

function enqueue(id) {
  if (queued.has(id) || Date.now() < pausedUntil) return;
  queued.add(id);
  queue.push(id);
  runQueue();
}

// A repost only counts once the job is as old as the user's threshold.
function isStale(id) {
  if (!reposted.has(id)) return false;
  const original = reposted.get(id);
  return !original || Date.now() - original >= minAgeDays * 86400000;
}

function apply() {
  const marked = new Set();
  const cards = findCards();
  if (mode !== 'off') {
    cards.forEach(({ id, el }) => {
      if (!reposted.has(id)) {
        if (!fresh.has(id)) enqueue(id);
        return;
      }
      if (!isStale(id)) return;
      const target = mode === 'hide' ? rowOf(el, id) : el;
      marked.add(target);
      if (target.getAttribute(ATTR) !== mode) target.setAttribute(ATTR, mode);
      if (mode === 'label') {
        const original = reposted.get(id);
        const label = original ? `First posted ${ageOf(original)} ago` : 'Reposted';
        if (target.getAttribute(LABEL_ATTR) !== label) target.setAttribute(LABEL_ATTR, label);
        // Shown in place of the label while the card is hovered.
        const date = original
          ? `First posted ${new Date(original).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
          : label;
        if (target.getAttribute(DATE_ATTR) !== date) target.setAttribute(DATE_ATTR, date);
      }
    });
  }
  const summary = `mode=${mode} cards=${cards.length} marked=${marked.size} known=${reposted.size} queued=${queue.length}`;
  if (summary !== lastSummary) {
    lastSummary = summary;
    log(summary);
  }
  document.querySelectorAll(`[${ATTR}]`).forEach((el) => {
    if (!marked.has(el)) {
      el.removeAttribute(ATTR);
      el.removeAttribute(LABEL_ATTR);
      el.removeAttribute(DATE_ATTR);
    }
  });
}

function scheduleApply() {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(apply, 150);
}

log('v0.2 loaded on', location.pathname);
chrome.storage.local.remove('reposted');
chrome.storage.local.get({ repostedJobs: {}, freshJobs: {} }, (data) => {
  for (const [id, original] of Object.entries(data.repostedJobs)) reposted.set(id, original);
  // A job that was new yesterday can be reposted later, so these expire.
  for (const [id, at] of Object.entries(data.freshJobs)) {
    if (Date.now() - at < FRESH_TTL_MS && !fresh.has(id)) fresh.set(id, at);
  }
  scheduleApply();
});
chrome.storage.sync.get({ mode: 'hide', minAgeDays: 0 }, (data) => {
  mode = data.mode;
  minAgeDays = data.minAgeDays;
  scheduleApply();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.mode) mode = changes.mode.newValue;
  if (changes.minAgeDays) minAgeDays = changes.minAgeDays.newValue;
  if (changes.mode || changes.minAgeDays) scheduleApply();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'nrl-stats') {
    const ids = new Set(findCards().map((card) => card.id));
    sendResponse({
      onPage: [...ids].filter(isStale).length,
      total: ids.size,
      pending: queue.length,
      paused: Date.now() < pausedUntil,
    });
  }
});

new MutationObserver(scheduleApply).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
