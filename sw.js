const CACHE_NAME = 'claude-chat-v4';
const BASE = self.location.pathname.replace(/\/sw\.js$/, '');
const APP_SHELL = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/style.css`,
  `${BASE}/app.js`,
  `${BASE}/trackers.js`,
  `${BASE}/manifest.json`,
  `${BASE}/icons/icon-192.png`,
  `${BASE}/icons/icon-512.png`,
];

// Install: cache the app shell fresh from network (no-cache)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map(url =>
          fetch(url, { cache: 'no-store' })
            .then(res => { if (res.ok) cache.put(url, res); })
            .catch(() => {})
        )
      )
    )
  );
  self.skipWaiting();
});

// Activate: clean up old caches, then notify all clients to reload
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(() =>
        self.clients.matchAll({ type: 'window' }).then((clients) =>
          clients.forEach((client) => client.postMessage({ type: 'SW_UPDATED' }))
        )
      )
  );
});

// ── Tracker: Periodic Background Sync ──────────────────────────
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'tracker-check') {
    event.waitUntil(swRunDueTrackers());
  }
});

// ── Notification Click ──────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { trackerId } = event.notification.data || {};
  const targetUrl = self.location.origin + self.location.pathname.replace('/sw.js', '/') + (trackerId ? `?tracker=${trackerId}` : '');

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.focus();
          if (trackerId) client.postMessage({ type: 'OPEN_TRACKER', trackerId });
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// ── IndexedDB helper (SW context) ────────────────────────────
function swDbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('claude-trackers', 1);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function swDbGetAll(db, store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

function swDbPut(db, store, item) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(item);
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}

function swDbGetKv(db, key) {
  return new Promise((res) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    req.onsuccess = () => res(req.result?.value);
    req.onerror = () => res(null);
  });
}

// ── Claude API call (no streaming, for background use) ───────
async function swCallClaudeSearch(query, apiKey, model) {
  const today = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const prompt = `Heute ist ${today}.\nBitte suche nach den aktuellsten Informationen zu: "${query}"\nFasse die wichtigsten 3-5 Punkte auf Deutsch zusammen und nenne 2-3 Quellen.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
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

  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// ── Run all due trackers from SW context ─────────────────────
async function swRunDueTrackers() {
  let db;
  try { db = await swDbOpen(); } catch { return; }

  const trackers = await swDbGetAll(db, 'trackers');
  const apiKey = await swDbGetKv(db, 'apiKey');
  const model  = await swDbGetKv(db, 'model') || 'claude-sonnet-4-6';
  const now = Date.now();

  for (const tracker of trackers) {
    if (!tracker.enabled) continue;
    if (tracker.nextRun && tracker.nextRun > now) continue;

    try {
      const summary = await swCallClaudeSearch(tracker.query, apiKey, model);
      const resultId = now.toString(36) + Math.random().toString(36).slice(2, 5);

      await swDbPut(db, 'results', {
        id: resultId, trackerId: tracker.id, summary, timestamp: now,
      });

      // Update nextRun (simple daily fallback)
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(tracker.schedule?.hour || 9, 0, 0, 0);
      tracker.lastRun = now;
      tracker.nextRun = next.getTime();
      tracker.lastSummary = summary.slice(0, 120) + (summary.length > 120 ? '…' : '');
      await swDbPut(db, 'trackers', tracker);

      await self.registration.showNotification(`🔍 ${tracker.name}`, {
        body: tracker.lastSummary,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: `tracker-${tracker.id}`,
        data: { trackerId: tracker.id },
        vibrate: [200, 100, 200],
      });
    } catch (err) {
      console.error('[SW Tracker]', tracker.name, err);
    }
  }
}

// Fetch: network-first (always fresh when online, cache fallback when offline)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Pass through API calls and cross-origin requests
  if (url.hostname !== self.location.hostname) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first: try network, update cache, fall back to cache offline
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match(`${BASE}/index.html`);
          }
        })
      )
  );
});
