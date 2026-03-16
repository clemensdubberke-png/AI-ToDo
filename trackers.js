/* =========================================================
   Claude Chat PWA – Tracker System
   Scheduled AI-powered web search + Push Notifications
   ========================================================= */

'use strict';

// ── IndexedDB Helper ─────────────────────────────────────────
const TrackerDB = {
  _db: null,

  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('claude-trackers', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('trackers')) {
          db.createObjectStore('trackers', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('results')) {
          const rs = db.createObjectStore('results', { keyPath: 'id' });
          rs.createIndex('trackerId', 'trackerId', { unique: false });
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async getAll(store) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  },

  async get(store, key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },

  async put(store, item) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const req = db.transaction(store, 'readwrite').objectStore(store).put(item);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },

  async delete(store, key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  },

  async getResultsByTracker(trackerId, limit = 10) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const idx = db.transaction('results', 'readonly')
        .objectStore('results')
        .index('trackerId')
        .getAll(trackerId);
      idx.onsuccess = () => {
        const sorted = (idx.result || []).sort((a, b) => b.timestamp - a.timestamp);
        res(sorted.slice(0, limit));
      };
      idx.onerror = () => rej(idx.error);
    });
  },

  async getKv(key) { const r = await this.get('kv', key); return r?.value; },
  async setKv(key, value) { await this.put('kv', { key, value }); },
};

// ── Schedule Helpers ─────────────────────────────────────────
const FREQ_LABELS = {
  daily: 'Täglich',
  hourly: 'Stündlich',
  weekly: 'Wöchentlich',
};

function nextRunTimestamp(tracker) {
  const now = new Date();
  const { frequency, hour, minute } = tracker.schedule;

  if (frequency === 'hourly') {
    // Next full hour (or at :00 of the next hour)
    const next = new Date(now);
    next.setMinutes(minute || 0, 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);
    return next.getTime();
  }

  if (frequency === 'daily') {
    const next = new Date(now);
    next.setHours(hour || 9, minute || 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  if (frequency === 'weekly') {
    const next = new Date(now);
    next.setHours(hour || 9, minute || 0, 0, 0);
    // Find next Monday (or same day if same weekday and future)
    const targetDay = tracker.schedule.weekday || 1; // 0=Sun, 1=Mon
    const diff = (targetDay - next.getDay() + 7) % 7 || 7;
    next.setDate(next.getDate() + (next <= now ? diff : diff === 7 ? 0 : diff));
    if (next <= now) next.setDate(next.getDate() + 7);
    return next.getTime();
  }

  return now.getTime() + 60 * 60 * 1000; // fallback: 1h
}

function formatNextRun(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = d - now;
  if (diffMs < 0) return 'Überfällig';
  const diffH = Math.floor(diffMs / 3600000);
  const diffM = Math.floor((diffMs % 3600000) / 60000);
  if (diffH < 1) return `in ${diffM} Min.`;
  if (diffH < 24) return `in ${diffH}h ${diffM}min`;
  return d.toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

// ── Notification Permission ──────────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

// ── Periodic Background Sync Registration ───────────────────
async function registerPeriodicSync() {
  if (!('serviceWorker' in navigator) || !('periodicSync' in ServiceWorkerRegistration.prototype)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.periodicSync.register('tracker-check', {
      minInterval: 60 * 60 * 1000, // 1h minimum (browser may enforce more)
    });
  } catch (e) {
    console.info('Periodic sync not available:', e.message);
  }
}

// ── Claude API: Web Search ────────────────────────────────────
async function runTrackerSearch(tracker, apiKey, model) {
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const prompt = `Heute ist ${today}.
Bitte suche nach den aktuellsten Informationen zu folgendem Thema und beantworte es auf Deutsch:

Thema: "${tracker.query}"

Fasse die wichtigsten 3-5 Neuigkeiten/Punkte prägnant zusammen.
Erwähne konkrete Details (Namen, Zahlen, Daten).
Schreibe am Ende 2-3 Quellen als Links.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': 'web-search-2025-03-05',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API Fehler ${response.status}`);
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  if (!text) throw new Error('Leere Antwort von Claude');
  return text;
}

// ── Run a Single Tracker ─────────────────────────────────────
async function executeTracker(tracker) {
  const apiKey = localStorage.getItem('claude_api_key') || await TrackerDB.getKv('apiKey');
  const model  = localStorage.getItem('claude_model') || 'claude-sonnet-4-6';

  if (!apiKey) throw new Error('Kein API-Key konfiguriert');

  const summary = await runTrackerSearch(tracker, apiKey, model);

  const result = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    trackerId: tracker.id,
    summary,
    timestamp: Date.now(),
  };

  await TrackerDB.put('results', result);

  // Update tracker's last run + next run
  tracker.lastRun = Date.now();
  tracker.nextRun = nextRunTimestamp(tracker);
  tracker.lastSummary = summary.slice(0, 120) + (summary.length > 120 ? '…' : '');
  await TrackerDB.put('trackers', tracker);

  return result;
}

// ── In-App Scheduler ─────────────────────────────────────────
let schedulerTimeout = null;
const runningTrackers = new Set();

async function checkDueTrackers() {
  const trackers = await TrackerDB.getAll('trackers');
  const now = Date.now();

  for (const tracker of trackers) {
    if (!tracker.enabled || runningTrackers.has(tracker.id)) continue;
    if (tracker.nextRun && tracker.nextRun > now) continue;

    runningTrackers.add(tracker.id);
    console.log(`[Tracker] Executing: ${tracker.name}`);

    try {
      const result = await executeTracker(tracker);
      showTrackerInAppNotification(tracker, result);
      if (typeof window.addTrackerResultToChat === 'function') {
        window.addTrackerResultToChat(tracker, result);
      }
    } catch (err) {
      console.error(`[Tracker] Failed: ${tracker.name}`, err);
      showToastGlobal(`Tracker "${tracker.name}" fehlgeschlagen: ${err.message}`, 'error');
    } finally {
      runningTrackers.delete(tracker.id);
    }
  }
  renderTrackerList();
}

async function scheduleNextRun() {
  if (schedulerTimeout) { clearTimeout(schedulerTimeout); schedulerTimeout = null; }
  const trackers = await TrackerDB.getAll('trackers');
  const now = Date.now();
  const active = trackers.filter(t => t.enabled && t.nextRun);
  if (active.length === 0) return;
  const nextDue = Math.min(...active.map(t => t.nextRun));
  const delay = Math.max(0, nextDue - now);
  schedulerTimeout = setTimeout(async () => {
    await checkDueTrackers();
    scheduleNextRun();
  }, delay + 500);
}

function initScheduler() {
  // Check immediately for missed trackers (after 3s to let DB open)
  setTimeout(checkDueTrackers, 3000);
  // Set up precise scheduler for future runs
  setTimeout(scheduleNextRun, 3500);
  // Refresh countdown display every minute
  setInterval(renderTrackerList, 60_000);
}

// ── In-App Notification Banner ───────────────────────────────
function showTrackerInAppNotification(tracker, result) {
  // Show browser notification if permission granted
  if (Notification.permission === 'granted' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(reg => {
      reg.showNotification(`🔍 ${tracker.name}`, {
        body: tracker.lastSummary,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: `tracker-${tracker.id}`,
        data: { trackerId: tracker.id, resultId: result.id },
        requireInteraction: false,
        vibrate: [200, 100, 200],
      });
    });
  }

  // Also show in-app banner
  const banner = document.createElement('div');
  banner.className = 'tracker-banner';
  banner.innerHTML = `
    <div class="tracker-banner-icon">🔍</div>
    <div class="tracker-banner-body">
      <strong>${escapeTrackerHtml(tracker.name)}</strong>
      <span>${escapeTrackerHtml(tracker.lastSummary || '')}</span>
    </div>
    <button class="tracker-banner-btn">Anzeigen</button>
    <button class="tracker-banner-close">✕</button>
  `;
  banner.querySelector('.tracker-banner-btn').addEventListener('click', () => {
    openTrackerResult(tracker.id);
    banner.remove();
  });
  banner.querySelector('.tracker-banner-close').addEventListener('click', () => banner.remove());
  document.body.appendChild(banner);
  setTimeout(() => banner.classList.add('visible'), 50);
  setTimeout(() => { banner.classList.remove('visible'); setTimeout(() => banner.remove(), 400); }, 12000);
}

function escapeTrackerHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToastGlobal(msg, type) {
  if (typeof showToast === 'function') showToast(msg, type);
}

// ── Tracker List (Sidebar) ────────────────────────────────────
async function renderTrackerList() {
  const container = document.getElementById('tracker-list');
  if (!container) return;
  const trackers = await TrackerDB.getAll('trackers');

  if (trackers.length === 0) {
    container.innerHTML = `<div style="padding:10px;font-size:12px;color:var(--text-muted);text-align:center">Keine Tracker</div>`;
    return;
  }

  container.innerHTML = '';
  trackers.forEach(t => {
    const item = document.createElement('div');
    item.className = 'tracker-item' + (runningTrackers.has(t.id) ? ' running' : '');
    item.innerHTML = `
      <div class="tracker-item-icon">${t.icon || '🔍'}</div>
      <div class="tracker-item-body">
        <span class="tracker-item-name">${escapeTrackerHtml(t.name)}</span>
        <span class="tracker-item-meta">${FREQ_LABELS[t.schedule?.frequency] || ''} · ${formatNextRun(t.nextRun)}</span>
      </div>
      <div class="tracker-item-actions">
        <button class="tracker-icon-btn" title="Ergebnis anzeigen">📋</button>
        <button class="tracker-icon-btn" title="Jetzt ausführen">▶</button>
        <button class="tracker-icon-btn danger" title="Löschen">✕</button>
      </div>
    `;
    const [btnResult, btnRun, btnDelete] = item.querySelectorAll('.tracker-icon-btn');
    btnResult.addEventListener('click', () => openTrackerResult(t.id));
    btnRun.addEventListener('click', () => runTrackerNow(t.id));
    btnDelete.addEventListener('click', () => deleteTrackerById(t.id));
    container.appendChild(item);
  });
}

// ── Run Now ──────────────────────────────────────────────────
async function runTrackerNow(trackerId) {
  if (runningTrackers.has(trackerId)) return;
  const tracker = await TrackerDB.get('trackers', trackerId);
  if (!tracker) return;

  runningTrackers.add(trackerId);
  renderTrackerList();
  showToastGlobal(`🔍 "${tracker.name}" wird gesucht…`);

  try {
    const result = await executeTracker(tracker);
    showTrackerInAppNotification(tracker, result);
    renderTrackerList();
    openTrackerResult(trackerId);
  } catch (err) {
    showToastGlobal(`Fehler: ${err.message}`, 'error');
  } finally {
    runningTrackers.delete(trackerId);
    renderTrackerList();
  }
}

async function deleteTrackerById(trackerId) {
  await TrackerDB.delete('trackers', trackerId);
  renderTrackerList();
  showToastGlobal('Tracker gelöscht');
}

// ── Tracker Result Panel ──────────────────────────────────────
async function openTrackerResult(trackerId) {
  const tracker = await TrackerDB.get('trackers', trackerId);
  if (!tracker) return;
  const results = await TrackerDB.getResultsByTracker(trackerId, 5);

  const panel = document.getElementById('tracker-result-panel');
  const title = document.getElementById('tracker-result-title');
  const body  = document.getElementById('tracker-result-body');
  if (!panel || !title || !body) return;

  title.textContent = tracker.name;

  if (results.length === 0) {
    body.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:40px 0">Noch keine Ergebnisse.<br>Klicke ▶ um jetzt zu suchen.</p>`;
  } else {
    body.innerHTML = results.map((r, i) => `
      <div class="tracker-result-entry${i === 0 ? ' latest' : ''}">
        <div class="tracker-result-ts">${new Date(r.timestamp).toLocaleString('de-DE')}</div>
        <div class="tracker-result-text">${typeof marked !== 'undefined' ? DOMPurify.sanitize(marked.parse(r.summary)) : escapeTrackerHtml(r.summary).replace(/\n/g,'<br>')}</div>
      </div>
    `).join('');
  }

  panel.classList.add('open');
}

function closeTrackerResultPanel() {
  const panel = document.getElementById('tracker-result-panel');
  if (panel) panel.classList.remove('open');
}

// ── Create / Edit Modal ───────────────────────────────────────
function openTrackerModal(trackerId = null) {
  const modal = document.getElementById('tracker-modal');
  if (!modal) return;

  // Reset form
  document.getElementById('tracker-name-input').value = '';
  document.getElementById('tracker-query-input').value = '';
  document.getElementById('tracker-freq-select').value = 'daily';
  document.getElementById('tracker-hour-input').value = '9';
  document.getElementById('tracker-icon-input').value = '🔍';
  document.getElementById('tracker-modal-id').value = '';
  document.getElementById('tracker-modal-title').textContent = 'Neuer Tracker';

  if (trackerId) {
    TrackerDB.get('trackers', trackerId).then(t => {
      if (!t) return;
      document.getElementById('tracker-name-input').value  = t.name;
      document.getElementById('tracker-query-input').value = t.query;
      document.getElementById('tracker-freq-select').value = t.schedule?.frequency || 'daily';
      document.getElementById('tracker-hour-input').value  = t.schedule?.hour ?? 9;
      document.getElementById('tracker-icon-input').value  = t.icon || '🔍';
      document.getElementById('tracker-modal-id').value    = t.id;
      document.getElementById('tracker-modal-title').textContent = 'Tracker bearbeiten';
    });
  }

  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('tracker-name-input').focus(), 100);
}

function closeTrackerModal() {
  const modal = document.getElementById('tracker-modal');
  if (modal) modal.classList.add('hidden');
}

async function saveTracker() {
  const name  = document.getElementById('tracker-name-input').value.trim();
  const query = document.getElementById('tracker-query-input').value.trim();
  const freq  = document.getElementById('tracker-freq-select').value;
  const hour  = parseInt(document.getElementById('tracker-hour-input').value, 10) || 9;
  const icon  = document.getElementById('tracker-icon-input').value.trim() || '🔍';
  const existingId = document.getElementById('tracker-modal-id').value;

  if (!name || !query) {
    showToastGlobal('Name und Thema sind Pflichtfelder', 'error');
    return;
  }

  const tracker = {
    id: existingId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
    name,
    query,
    icon,
    schedule: { frequency: freq, hour, minute: 0 },
    enabled: true,
    createdAt: existingId ? undefined : Date.now(),
    lastRun: null,
    nextRun: null,
    lastSummary: null,
  };

  // Preserve createdAt if editing
  if (existingId) {
    const old = await TrackerDB.get('trackers', existingId);
    if (old) tracker.createdAt = old.createdAt;
  }

  tracker.nextRun = nextRunTimestamp(tracker);

  await TrackerDB.put('trackers', tracker);
  closeTrackerModal();
  renderTrackerList();
  scheduleNextRun();
  showToastGlobal(`Tracker "${name}" gespeichert`, 'success');

  // Ensure notifications are enabled
  const perm = await requestNotificationPermission();
  if (!perm) showToastGlobal('Benachrichtigungen nicht erlaubt – bitte in Browser-Einstellungen aktivieren', 'error');
  else registerPeriodicSync();
}

// ── Notification Permission Banner ───────────────────────────
async function showNotifPermissionBannerIfNeeded() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  const trackers = await TrackerDB.getAll('trackers');
  if (trackers.length === 0) return;

  const existing = document.getElementById('notif-permission-banner');
  if (existing) return;

  const banner = document.createElement('div');
  banner.id = 'notif-permission-banner';
  banner.className = 'notif-permission-banner';
  banner.innerHTML = `
    <span>🔔 Benachrichtigungen aktivieren, damit Tracker-Updates ankommen</span>
    <button id="btn-allow-notif">Aktivieren</button>
    <button id="btn-dismiss-notif">✕</button>
  `;
  banner.querySelector('#btn-allow-notif').addEventListener('click', async () => {
    await requestNotificationPermission();
    await registerPeriodicSync();
    banner.remove();
  });
  banner.querySelector('#btn-dismiss-notif').addEventListener('click', () => banner.remove());
  document.body.prepend(banner);
}

// ── Service Worker Message Listener ──────────────────────────
function listenForSwMessages() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'OPEN_TRACKER') {
      openTrackerResult(event.data.trackerId);
    }
  });
}

// ── Chat-based Tracker Creation ───────────────────────────────
window.createTrackerFromChat = async function({ query, frequency, hour }) {
  const tracker = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: query.length > 40 ? query.slice(0, 37) + '…' : query,
    query,
    icon: '🔍',
    schedule: { frequency: frequency || 'daily', hour: hour || 9, minute: 0 },
    enabled: true,
    createdAt: Date.now(),
    lastRun: null,
    nextRun: null,
    lastSummary: null,
  };
  tracker.nextRun = nextRunTimestamp(tracker);
  await TrackerDB.put('trackers', tracker);
  renderTrackerList();
  scheduleNextRun();
  const perm = await requestNotificationPermission();
  if (perm) registerPeriodicSync();
  return tracker;
};

// ── Sync API key to IndexedDB (so SW can access it) ──────────
async function syncApiKeyToDb(key) {
  await TrackerDB.setKv('apiKey', key);
  await TrackerDB.setKv('model', localStorage.getItem('claude_model') || 'claude-sonnet-4-6');
}

// ── Init ─────────────────────────────────────────────────────
async function initTrackers() {
  await TrackerDB.open();

  // Sync API key to IndexedDB
  const apiKey = localStorage.getItem('claude_api_key');
  if (apiKey) await syncApiKeyToDb(apiKey);

  renderTrackerList();
  initScheduler();
  listenForSwMessages();

  // After short delay, show notification banner if trackers exist
  setTimeout(showNotifPermissionBannerIfNeeded, 2000);

  // Bind modal events
  const btnNew = document.getElementById('btn-new-tracker');
  if (btnNew) btnNew.addEventListener('click', () => openTrackerModal());

  const btnSave = document.getElementById('btn-save-tracker');
  if (btnSave) btnSave.addEventListener('click', saveTracker);

  const btnClose = document.getElementById('btn-close-tracker-modal');
  if (btnClose) btnClose.addEventListener('click', closeTrackerModal);

  const btnCancelTracker = document.getElementById('btn-cancel-tracker');
  if (btnCancelTracker) btnCancelTracker.addEventListener('click', closeTrackerModal);

  const trackerModal = document.getElementById('tracker-modal');
  if (trackerModal) {
    trackerModal.addEventListener('click', (e) => {
      if (e.target === trackerModal) closeTrackerModal();
    });
  }

  const btnCloseResult = document.getElementById('btn-close-tracker-result');
  if (btnCloseResult) btnCloseResult.addEventListener('click', closeTrackerResultPanel);
}

// Check due date when app regains focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkDueTrackers();
});

// ── Bootstrap ─────────────────────────────────────────────────
initTrackers();
