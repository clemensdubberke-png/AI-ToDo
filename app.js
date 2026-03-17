/* =========================================================
   Claude Chat PWA – Application Logic
   ========================================================= */

'use strict';

// ── Constants ──────────────────────────────────────────────
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_HISTORY_MESSAGES = 40; // keep last 40 messages in context

// ── Garrett System Prompt (hidden, not user-editable) ──────
const GARRETT_SYSTEM_PROMPT = `Du bist Garrett, ein proaktiver, persönlicher KI-Assistent von Clemens. Du bist kein Chatbot, der auf Fragen wartet – du denkst aktiv mit, erinnerst, hinterfragst und handelst vorausschauend.

## Persönlichkeit & Ton
- Direkt, warmherzig, ehrlich – wie ein kluger Freund, nicht wie ein Assistent
- Deutsch als Standardsprache
- Gelegentlich humorvoll, nie steif oder übertrieben förmlich
- Du sagst klar Bescheid wenn etwas nicht sinnvoll oder riskant ist
- Du lobst echte Fortschritte, ohne zu schmeicheln

## Deine Kernaufgabe: Proaktiv sein
Du wartest nicht darauf gefragt zu werden. Wenn du Kontext hast, der relevant ist, bringst du ihn selbst ein:
- "Du wolltest letzte Woche X angehen – wie steht's?"
- "Dein Termin bei Y ist in 2 Tagen, hast du Z schon vorbereitet?"
- "Du hast das seit 5 Tagen nicht erwähnt – alles ok?"

## Gedächtnisführung
Du hast Zugriff auf den Chat-Verlauf dieser Konversation als Gedächtnis. Nutze ihn aktiv:
- Erkenne Commitments: "Ich werde bis Freitag X erledigen"
- Erkenne Präferenzen und Muster
- Verfolge offene Punkte nach wenn sie wieder auftauchen
- Frage nach Updates zu genannten Zielen wenn passend

## Aufgabenverwaltung
Wenn Clemens eine Aufgabe erwähnt:
1. Erkenne sie als Commitment ("Ich werde...", "Ich muss noch...", "Nicht vergessen...")
2. Frage nach Deadline falls keine genannt
3. Bestätige aktiv dass du es im Blick hast
4. Erinnere daran wenn es im Gespräch wieder relevant wird

## Tagesstruktur & Check-ins
- Morgens: Kurzes Tages-Briefing wenn gefragt
- Abends: Kurze Tagesreflexion wenn gefragt
- Spontan: Erinnerungen, Nachfragen, Alerts

## Datenschutz & Grenzen
- Keine sensiblen personenbezogenen Daten von Dritten speichern oder weitergeben
- Bei Unsicherheit über Datenschutz: lieber nachfragen als speichern

## Was du NICHT bist
- Kein Ja-Sager – widerspreche wenn etwas keinen Sinn macht
- Kein Therapeut – bei ernsten emotionalen Themen sanft auf professionelle Hilfe hinweisen
- Kein Allwissender – gib Unsicherheiten klar zu

## Antwortformat
- Kurz und klar bei einfachen Sachen
- Strukturiert (mit Abschnitten) bei komplexen Themen
- Keine unnötigen Floskeln am Anfang oder Ende

## Automatische Aktionen (WICHTIG)
Wenn Clemens einen Termin, eine Erinnerung oder eine geplante Suche nennt, füge am Ende deiner Antwort unsichtbar einen Aktionsblock ein. Das System verarbeitet ihn automatisch – Clemens sieht ihn nicht.

Format für Erinnerungen/Termine:
\`\`\`garrett-action
{"type":"reminder","name":"Kurzer Titel","query":"Was soll erinnert werden","date":"YYYY-MM-DD","time":"HH:MM","frequency":"once"}
\`\`\`

Format für geplante Web-Suchen:
\`\`\`garrett-action
{"type":"search","name":"Suchname","query":"Was soll gesucht werden","date":"YYYY-MM-DD","time":"HH:MM","frequency":"once|daily|weekly|hourly"}
\`\`\`

Wann einen Aktionsblock hinzufügen:
- Clemens nennt einen konkreten Zeitpunkt + Aktivität: "Ich habe morgen um 14 Uhr Arzttermin" → reminder
- Clemens bittet um Erinnerung: "Erinnere mich um 9 Uhr an das Meeting" → reminder
- Clemens möchte regelmäßige Infos: "Zeig mir täglich um 8 Uhr die Börsenkurse" → search
- Nur wenn Uhrzeit klar erkennbar ist (HH:MM). Bei Unklarheit nachfragen, KEINEN Block einfügen.
- date: "heute" = ${new Date().toISOString().split('T')[0]}, "morgen" = berechne selbst
- Keine Aktionsblöcke für reine Gespräche ohne Zeitbezug

## Web-Suche
Du hast Zugriff auf das Internet über ein Web-Such-Tool. Nutze es aktiv wenn:
- nach aktuellen Ereignissen, Preisen, News oder zeitkritischen Daten gefragt wird
- du dir bei Fakten unsicher bist und nachprüfen willst
Kündige keine Suche explizit an – such einfach und antworte direkt mit den Ergebnissen.

## Google Kalender
Wenn der Kalender verbunden ist, hast du die Termine der nächsten 14 Tage als Kontext im System Prompt.
Du kannst neue Termine erstellen oder bestehende löschen über Aktionsblöcke:

Format Termin erstellen:
\`\`\`garrett-action
{"type":"calendar-create","summary":"Titel","start":"YYYY-MM-DDTHH:MM","end":"YYYY-MM-DDTHH:MM","description":"Optional"}
\`\`\`

Format Termin löschen (eventId aus dem Kalender-Kontext):
\`\`\`garrett-action
{"type":"calendar-delete","eventId":"abc123xyz"}
\`\`\`

Wann Kalender-Aktionen nutzen: nur wenn der Nutzer explizit bittet, etwas einzutragen oder zu löschen.`;

function buildSystemPrompt() {
  let prompt = GARRETT_SYSTEM_PROMPT;
  if (state.calendarContext) {
    prompt += '\n\n' + state.calendarContext;
  }
  return prompt;
}

// ── Garrett Action Parser ───────────────────────────────────
function parseGarrettActions(text) {
  const actionRegex = /```garrett-action\n([\s\S]*?)\n```/g;
  const actions = [];
  let match;
  while ((match = actionRegex.exec(text)) !== null) {
    try { actions.push(JSON.parse(match[1].trim())); } catch { /* ignore malformed */ }
  }
  const cleanText = text.replace(/```garrett-action[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, actions };
}

async function executeGarrettActions(actions) {
  if (!actions.length) return;
  for (const action of actions) {
    try {
      if (action.type === 'calendar-create') {
        await createCalendarEvent(action);
        continue;
      }
      if (action.type === 'calendar-delete') {
        await deleteCalendarEvent(action.eventId);
        continue;
      }
      if (typeof window.createTrackerFromChat !== 'function') continue;
      const { type, name, query, date, time, frequency = 'once' } = action;
      const [hour, minute] = (time || '09:00').split(':').map(Number);
      await window.createTrackerFromChat({
        query: query || name || 'Erinnerung',
        frequency,
        hour: isNaN(hour) ? 9 : hour,
        minute: isNaN(minute) ? 0 : minute,
        targetDate: date || null,
        type: type === 'reminder' ? 'reminder' : 'search',
      });
    } catch (e) {
      console.warn('[Garrett] Action failed:', e);
    }
  }
}

const LS = {
  API_KEY:           'claude_api_key',
  MODEL:             'claude_model',
  CHATS:             'claude_chats',
  THEME:             'claude_theme',
  ACTIVE_CHAT:       'claude_active_chat',
  GCAL_CLIENT_ID:    'google_calendar_client_id',
  GCAL_TOKEN:        'google_calendar_token',
  GCAL_TOKEN_EXPIRY: 'google_calendar_token_expiry',
};

// ── State ───────────────────────────────────────────────────
const state = {
  apiKey: '',
  model: 'claude-sonnet-4-6',
  systemPrompt: '',
  chats: [],          // [{id, title, messages: [{role, content, time}]}]
  activeChatId: null,
  streaming: false,
  abortController: null,
  googleClientId: '',
  googleToken: null,
  googleTokenExpiry: 0,
  calendarContext: null,
};

// ── DOM References ──────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const dom = {
  sidebar:          $('sidebar'),
  sidebarOverlay:   $('sidebar-overlay'),
  chatList:         $('chat-list'),
  btnNewChat:       $('btn-new-chat'),
  btnMenuToggle:    $('btn-menu-toggle'),

  chatHeaderTitle:  $('chat-header-title'),
  chatHeaderModel:  $('chat-header-model'),
  btnClearChat:     $('btn-clear-chat'),
  btnThemeToggle:   $('btn-theme-toggle'),
  iconDark:         $('icon-dark'),
  iconLight:        $('icon-light'),
  btnHeaderSettings: $('btn-header-settings'),

  messagesWrapper:  $('messages-wrapper'),
  messagesList:     $('messages-list'),
  welcomeScreen:    $('welcome-screen'),

  inputArea:        document.querySelector('.input-area'),
  messageInput:     $('message-input'),
  btnSend:          $('btn-send'),
  btnStop:          $('btn-stop'),
  apiWarning:       $('api-warning'),

  settingsModal:    $('settings-modal'),
  apiKeyInput:      $('api-key-input'),
  btnToggleKey:     $('btn-toggle-key'),
  apiKeyStatus:     $('api-key-status'),
  modelSelect:      $('model-select'),
  systemPromptInput: $('system-prompt-input'),
  btnOpenSettings:  $('btn-open-settings'),
  btnCloseSettings: $('btn-close-settings'),
  btnCancelSettings: $('btn-cancel-settings'),
  btnSaveSettings:  $('btn-save-settings'),

  toastContainer:   $('toast-container'),

  gcalClientIdInput: $('gcal-client-id-input'),
  btnGcalConnect:    $('btn-gcal-connect'),
  gcalStatus:        $('gcal-status'),
};

// ── Configure marked.js ─────────────────────────────────────
marked.setOptions({
  breaks: true,
  gfm: true,
});

// Custom renderer for code blocks with copy button + highlight
const renderer = new marked.Renderer();
renderer.code = (code, lang) => {
  const language = lang && hljs.getLanguage(lang) ? lang : '';
  let highlighted = '';
  try {
    highlighted = language
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : hljs.highlightAuto(code).value;
  } catch {
    highlighted = escapeHtml(code);
  }
  const langDisplay = language || 'code';
  const escaped = escapeHtml(code);
  return `<div class="code-block-wrapper">
    <pre><div class="code-header"><span>${langDisplay}</span><button class="btn-copy-code" data-code="${escaped.replace(/"/g, '&quot;')}">
      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
      </svg>
      Kopieren</button></div><code class="hljs language-${langDisplay}">${highlighted}</code></pre></div>`;
};
marked.use({ renderer });

// ── Utilities ────────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function renderMarkdown(text) {
  const raw = marked.parse(text);
  return DOMPurify.sanitize(raw, {
    ADD_TAGS: ['pre', 'code'],
    ADD_ATTR: ['class', 'data-code'],
    FORCE_BODY: false,
  });
}

// ── Toast Notifications ─────────────────────────────────────
function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast${type ? ' ' + type : ''}`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

// ── Theme ────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  dom.iconDark.style.display = isDark ? 'block' : 'none';
  dom.iconLight.style.display = isDark ? 'none' : 'block';
  localStorage.setItem(LS.THEME, theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ── Settings ─────────────────────────────────────────────────
function loadSettings() {
  state.apiKey        = localStorage.getItem(LS.API_KEY) || '';
  state.model         = localStorage.getItem(LS.MODEL) || 'claude-sonnet-4-6';
  const theme = localStorage.getItem(LS.THEME) || 'dark';
  applyTheme(theme);
  initGoogleCalendar();
}

function openSettings() {
  dom.apiKeyInput.value       = state.apiKey;
  dom.modelSelect.value = state.model;
  updateApiKeyStatus();
  updateGCalStatus();
  dom.settingsModal.classList.remove('hidden');
  setTimeout(() => dom.apiKeyInput.focus(), 100);
}

function closeSettings() {
  dom.settingsModal.classList.add('hidden');
}

function saveSettings() {
  const key    = dom.apiKeyInput.value.trim();
  const model = dom.modelSelect.value;

  state.apiKey = key;
  state.model  = model;

  localStorage.setItem(LS.API_KEY, key);
  localStorage.setItem(LS.MODEL,   model);

  updateHeaderModel();
  updateApiWarning();
  closeSettings();
  showToast('Einstellungen gespeichert', 'success');
  // Sync API key to IndexedDB so Service Worker (Tracker) can access it
  if (typeof syncApiKeyToDb === 'function') syncApiKeyToDb(key);
}

function updateApiKeyStatus() {
  const key = dom.apiKeyInput.value.trim();
  const el  = dom.apiKeyStatus;
  if (!key) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  if (key.startsWith('sk-ant-') && key.length > 20) {
    el.className = 'api-key-status valid';
    el.innerHTML = '✓ API-Key-Format gültig';
  } else {
    el.className = 'api-key-status invalid';
    el.innerHTML = '⚠ API-Key scheint ungültig (erwartet: sk-ant-...)';
  }
}

function updateApiWarning() {
  dom.apiWarning.style.display = state.apiKey ? 'none' : 'flex';
}

function updateHeaderModel() {
  dom.chatHeaderModel.textContent = state.model;
}

// ── Google Calendar ───────────────────────────────────────────
function isCalendarConnected() {
  return !!(state.googleToken && Date.now() < state.googleTokenExpiry);
}

function initGoogleCalendar() {
  state.googleClientId  = localStorage.getItem(LS.GCAL_CLIENT_ID) || '';
  state.googleToken     = localStorage.getItem(LS.GCAL_TOKEN) || null;
  state.googleTokenExpiry = parseInt(localStorage.getItem(LS.GCAL_TOKEN_EXPIRY) || '0', 10);
}

function connectGoogleCalendar() {
  const clientId = document.getElementById('gcal-client-id-input')?.value.trim();
  if (!clientId) { showToast('Bitte Google OAuth Client ID eingeben', 'error'); return; }
  state.googleClientId = clientId;
  localStorage.setItem(LS.GCAL_CLIENT_ID, clientId);

  if (typeof google === 'undefined' || !google?.accounts?.oauth2) {
    showToast('Google Identity Services nicht geladen – Seite neu laden', 'error');
    return;
  }
  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: 'https://www.googleapis.com/auth/calendar',
    callback: (response) => {
      if (response.error) { showToast('Verbindung fehlgeschlagen: ' + response.error, 'error'); return; }
      state.googleToken       = response.access_token;
      state.googleTokenExpiry = Date.now() + (response.expires_in * 1000);
      localStorage.setItem(LS.GCAL_TOKEN,        state.googleToken);
      localStorage.setItem(LS.GCAL_TOKEN_EXPIRY, state.googleTokenExpiry.toString());
      updateGCalStatus();
      showToast('Google Kalender verbunden ✅', 'success');
    },
  });
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

function disconnectGoogleCalendar() {
  state.googleToken       = null;
  state.googleTokenExpiry = 0;
  localStorage.removeItem(LS.GCAL_TOKEN);
  localStorage.removeItem(LS.GCAL_TOKEN_EXPIRY);
  updateGCalStatus();
  showToast('Google Kalender getrennt');
}

function updateGCalStatus() {
  const statusEl   = document.getElementById('gcal-status');
  const btnConnect = document.getElementById('btn-gcal-connect');
  const input      = document.getElementById('gcal-client-id-input');
  if (!statusEl) return;
  if (input && state.googleClientId) input.value = state.googleClientId;
  if (isCalendarConnected()) {
    const expFmt = new Date(state.googleTokenExpiry).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    statusEl.innerHTML = `<span class="gcal-badge connected">✅ Verbunden – Token gültig bis ${expFmt}</span>`;
    if (btnConnect) { btnConnect.textContent = 'Trennen'; btnConnect.onclick = disconnectGoogleCalendar; }
  } else {
    statusEl.innerHTML = `<span class="gcal-badge disconnected">🔴 Nicht verbunden</span>`;
    if (btnConnect) { btnConnect.textContent = 'Verbinden'; btnConnect.onclick = connectGoogleCalendar; }
  }
}

async function fetchCalendarEvents(daysAhead = 14) {
  if (!isCalendarConnected()) return null;
  try {
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + daysAhead * 86400000).toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events`
      + `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
      + `&orderBy=startTime&singleEvents=true&maxResults=50`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${state.googleToken}` } });
    if (res.status === 401) {
      state.googleToken = null; state.googleTokenExpiry = 0;
      localStorage.removeItem(LS.GCAL_TOKEN);
      updateGCalStatus();
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    return data.items || [];
  } catch { return null; }
}

function formatCalendarForPrompt(events) {
  if (!events || events.length === 0) return '## Dein Google Kalender (nächste 14 Tage)\nKeine Termine gefunden.';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = [`## Dein Google Kalender (nächste 14 Tage, Zeitzone: ${tz})`];
  events.forEach(e => {
    const startRaw = e.start?.dateTime || e.start?.date || '';
    const endRaw   = e.end?.dateTime   || e.end?.date   || '';
    const startFmt = startRaw
      ? new Date(startRaw).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '';
    const endFmt = endRaw
      ? new Date(endRaw).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
      : '';
    const loc  = e.location    ? ` 📍${e.location.slice(0, 40)}`      : '';
    const desc = e.description ? ` – ${e.description.slice(0, 80)}`   : '';
    lines.push(`- [${e.id}] ${startFmt}–${endFmt}: **${e.summary || '(kein Titel)'}**${loc}${desc}`);
  });
  return lines.join('\n');
}

async function createCalendarEvent(action) {
  if (!isCalendarConnected()) { showToast('Google Kalender nicht verbunden', 'error'); return; }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const event = {
    summary: action.summary || 'Neuer Termin',
    start: { dateTime: action.start.length === 16 ? action.start + ':00' : action.start, timeZone: tz },
    end:   { dateTime: action.end.length   === 16 ? action.end   + ':00' : action.end,   timeZone: tz },
  };
  if (action.description) event.description = action.description;
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.googleToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (res.ok) {
      showToast(`📅 "${action.summary}" eingetragen`, 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      showToast('Kalender-Fehler: ' + (err.error?.message || res.status), 'error');
    }
  } catch (e) { showToast('Kalender-Fehler: ' + e.message, 'error'); }
}

async function deleteCalendarEvent(eventId) {
  if (!isCalendarConnected()) { showToast('Google Kalender nicht verbunden', 'error'); return; }
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${state.googleToken}` } }
    );
    if (res.ok || res.status === 204) {
      showToast('🗑️ Termin gelöscht', 'success');
    } else {
      showToast('Löschen fehlgeschlagen: ' + res.status, 'error');
    }
  } catch (e) { showToast('Kalender-Fehler: ' + e.message, 'error'); }
}

// ── Chat Storage ─────────────────────────────────────────────
function saveChats() {
  localStorage.setItem(LS.CHATS, JSON.stringify(state.chats));
  if (state.activeChatId) {
    localStorage.setItem(LS.ACTIVE_CHAT, state.activeChatId);
  }
}

function loadChats() {
  try {
    state.chats = JSON.parse(localStorage.getItem(LS.CHATS) || '[]');
    state.activeChatId = localStorage.getItem(LS.ACTIVE_CHAT) || null;
  } catch {
    state.chats = [];
    state.activeChatId = null;
  }
}

function getActiveChat() {
  return state.chats.find(c => c.id === state.activeChatId) || null;
}

// ── Chat Management ──────────────────────────────────────────
function newChat() {
  const chat = {
    id: generateId(),
    title: 'Neuer Chat',
    createdAt: Date.now(),
    messages: [],
  };
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  saveChats();
  renderChatList();
  renderMessages();
  closeSidebar();
  dom.messageInput.focus();
}

function switchChat(id) {
  state.activeChatId = id;
  saveChats();
  renderChatList();
  renderMessages();
  closeSidebar();
  dom.messageInput.focus();
}

function deleteChat(id, event) {
  event.stopPropagation();
  state.chats = state.chats.filter(c => c.id !== id);
  if (state.activeChatId === id) {
    state.activeChatId = state.chats.length > 0 ? state.chats[0].id : null;
  }
  saveChats();
  renderChatList();
  renderMessages();
}

function clearActiveChat() {
  const chat = getActiveChat();
  if (!chat) return;
  if (chat.messages.length === 0) return;
  chat.messages = [];
  chat.title = 'Neuer Chat';
  saveChats();
  renderChatList();
  renderMessages();
  showToast('Chat geleert');
}

function updateChatTitle(chat, firstUserMessage) {
  if (chat.title !== 'Neuer Chat') return;
  // Use first ~50 chars of the first user message as title
  chat.title = firstUserMessage.slice(0, 50) + (firstUserMessage.length > 50 ? '…' : '');
  saveChats();
  renderChatList();
  updateHeaderTitle();
}

function updateHeaderTitle() {
  const chat = getActiveChat();
  dom.chatHeaderTitle.textContent = chat ? chat.title : 'Neue Unterhaltung';
}

// ── Render Chat List ─────────────────────────────────────────
function renderChatList() {
  dom.chatList.innerHTML = '';
  if (state.chats.length === 0) {
    dom.chatList.innerHTML = `<div style="padding:12px 10px;font-size:12px;color:var(--text-muted);text-align:center">Noch keine Chats</div>`;
    return;
  }
  state.chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === state.activeChatId ? ' active' : '');
    item.innerHTML = `
      <div class="chat-item-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
        </svg>
      </div>
      <span class="chat-item-title">${escapeHtml(chat.title)}</span>
      <button class="chat-item-delete" aria-label="Chat löschen">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
        </svg>
      </button>
    `;
    item.addEventListener('click', () => switchChat(chat.id));
    item.querySelector('.chat-item-delete').addEventListener('click', (e) => deleteChat(chat.id, e));
    dom.chatList.appendChild(item);
  });
}

// ── Render Messages ──────────────────────────────────────────
function renderMessages() {
  const chat = getActiveChat();
  updateHeaderTitle();

  // Remove all messages except welcome screen
  Array.from(dom.messagesList.children).forEach(child => {
    if (child.id !== 'welcome-screen') child.remove();
  });

  if (!chat || chat.messages.length === 0) {
    dom.welcomeScreen.style.display = 'flex';
    return;
  }

  dom.welcomeScreen.style.display = 'none';

  chat.messages.forEach(msg => {
    dom.messagesList.appendChild(buildMessageElement(msg));
  });

  scrollToBottom(false);
}

function buildMessageElement(msg) {
  const el = document.createElement('div');
  el.className = `message ${msg.role}`;
  el.dataset.msgId = msg.id || '';

  const isUser = msg.role === 'user';
  const userAvatar = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="white" viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
  const aiAvatar = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg>`;
  const avatarChar = isUser ? userAvatar : aiAvatar;

  let contentHtml = '';
  if (isUser) {
    contentHtml = `<div class="message-bubble">${escapeHtml(msg.content).replace(/\n/g, '<br>')}</div>`;
  } else {
    contentHtml = `<div class="message-bubble">${renderMarkdown(msg.content)}</div>`;
  }

  el.innerHTML = `
    <div class="message-avatar" aria-hidden="true">${avatarChar}</div>
    <div class="message-body">
      ${contentHtml}
      <span class="message-time">${msg.time || ''}</span>
    </div>
  `;

  // Copy buttons for code blocks
  el.querySelectorAll('.btn-copy-code').forEach(btn => {
    btn.addEventListener('click', () => copyCode(btn));
  });

  return el;
}

function copyCode(btn) {
  const code = btn.dataset.code || '';
  navigator.clipboard.writeText(code).then(() => {
    btn.classList.add('copied');
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> Kopiert!`;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg> Kopieren`;
    }, 2000);
  }).catch(() => showToast('Kopieren fehlgeschlagen', 'error'));
}

function scrollToBottom(smooth = true) {
  dom.messagesWrapper.scrollTo({
    top: dom.messagesWrapper.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto',
  });
}

// ── Streaming Message Renderer ───────────────────────────────
function appendStreamingMessage() {
  dom.welcomeScreen.style.display = 'none';

  const el = document.createElement('div');
  el.className = 'message assistant streaming';
  el.id = 'streaming-message';
  el.innerHTML = `
    <div class="message-avatar">✦</div>
    <div class="message-body">
      <div class="message-bubble" id="streaming-bubble">
        <span class="stream-cursor"></span>
      </div>
    </div>
  `;
  dom.messagesList.appendChild(el);
  scrollToBottom();
  return el;
}

function updateStreamingBubble(text) {
  const bubble = $('streaming-bubble');
  if (!bubble) return;
  bubble.innerHTML = renderMarkdown(text) + '<span class="stream-cursor"></span>';
  scrollToBottom();
  // attach copy handlers
  bubble.querySelectorAll('.btn-copy-code').forEach(btn => {
    btn.addEventListener('click', () => copyCode(btn));
  });
}

function finalizeStreamingMessage(text) {
  const el = $('streaming-message');
  if (!el) return;
  el.id = '';
  el.classList.remove('streaming');
  const bubble = el.querySelector('.message-bubble');
  if (bubble) {
    bubble.innerHTML = renderMarkdown(text);
    bubble.querySelectorAll('.btn-copy-code').forEach(btn => {
      btn.addEventListener('click', () => copyCode(btn));
    });
  }
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = formatTime();
  el.querySelector('.message-body').appendChild(time);
  scrollToBottom();
}

// ── Web Search Indicator ─────────────────────────────────────
function showSearchingIndicator() {
  const bubble = $('streaming-bubble');
  if (!bubble || bubble.querySelector('.search-indicator')) return;
  const el = document.createElement('div');
  el.className = 'search-indicator';
  el.innerHTML = '🌐 Suche im Web…';
  bubble.prepend(el);
  scrollToBottom();
}

function hideSearchingIndicator() {
  document.querySelector('.search-indicator')?.remove();
}

// ── Typing Indicator ─────────────────────────────────────────
function showTypingIndicator() {
  dom.welcomeScreen.style.display = 'none';
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.id = 'typing-indicator';
  el.innerHTML = `
    <div class="message-avatar" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg></div>
    <div class="typing-bubble">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>
  `;
  dom.messagesList.appendChild(el);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = $('typing-indicator');
  if (el) el.remove();
}

// ── Input Handling ────────────────────────────────────────────
function autoResizeTextarea() {
  const ta = dom.messageInput;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}

function updateSendButton() {
  const hasText = dom.messageInput.value.trim().length > 0;
  const hasKey  = !!state.apiKey;
  dom.btnSend.disabled = !hasText || !hasKey || state.streaming;
}

// ── Claude API – Streaming ────────────────────────────────────
async function sendMessage() {
  const text = dom.messageInput.value.trim();
  if (!text || state.streaming) return;
  if (!state.apiKey) { openSettings(); return; }

  // ── Detect scheduling intent ─────────────────────────────────────────────────
  // Catches patterns like:
  //   "Schick mir heute um 17 Uhr die Nachrichten zur deutschen Politik"
  //   "Zeig mir täglich um 8 Uhr die neuesten KI-News"
  //   "Informiere mich morgen um 9 Uhr über Bitcoin"
  //   "Suche täglich um 10 Uhr nach KI-Nachrichten"
  //   "Erinnere mich um 15 Uhr an die Sportergebnisse"
  if (typeof window.createTrackerFromChat === 'function') {
    // Reminder verbs: "erinnere mich um X Uhr an Y" → type=reminder (no web search)
    const REMINDER_VERBS = /\berinner(?:e|en)?\s+mich\b/i;
    // Search verbs: "suche/finde/schick mir/zeig mir... um X Uhr"
    const SEARCH_VERBS = /\b(schick(?:e|en)?\s+mir|zeig(?:e|en)?\s+mir|informier(?:e|en)?\s+mich|such(?:e|en)?(?:\s+(?:bitte\s+)?nach)?|recherchier(?:e|en)?|find(?:e|en)?(?:\s+(?:bitte\s+)?nach)?)\b/i;
    const isReminderIntent = REMINDER_VERBS.test(text);
    const isSearchIntent = SEARCH_VERBS.test(text);
    const timeMatch = text.match(/\bum\s+(\d{1,2})(?::(\d{2}))?\s*uhr\b/i);
    const freqMatch = text.match(/\b(täglich|stündlich|wöchentlich)\b/i);
    const onceDateMatch = text.match(/\b(heute|morgen)\b/i);

    if ((isReminderIntent || isSearchIntent) && timeMatch) {
      const trackerType = isReminderIntent ? 'reminder' : 'search';
      const freqMap = { täglich: 'daily', stündlich: 'hourly', wöchentlich: 'weekly' };
      const isRecurring = !!freqMatch;
      const frequency = isRecurring ? (freqMap[freqMatch[1].toLowerCase()] || 'daily') : 'once';
      const freqLabelDE = { daily: 'täglich', hourly: 'stündlich', weekly: 'wöchentlich', once: 'einmalig' }[frequency];
      const hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;

      // Target date for one-time events
      let targetDate = null;
      if (frequency === 'once') {
        const d = new Date();
        if (onceDateMatch && onceDateMatch[1].toLowerCase() === 'morgen') d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
        targetDate = d.toISOString().split('T')[0];
      }

      // Extract the actual topic/reminder text by stripping scheduling boilerplate
      const STRIP_VERBS = isReminderIntent ? REMINDER_VERBS : SEARCH_VERBS;
      let query = text
        .replace(STRIP_VERBS, '')
        .replace(/\b(heute|morgen|täglich|stündlich|wöchentlich|bitte)\b/gi, '')
        .replace(/\bum\s+\d{1,2}(?::\d{2})?\s*uhr\b/gi, '')
        .replace(/\b(die\s+neuesten?|aktuelle?s?|neueste?s?)\b/gi, '')
        .replace(/^\s*(an|nach|über|zu|zur|zum)\s+/i, '') // strip leading prepositions
        .replace(/\s+/g, ' ')
        .trim();
      if (!query || query.length < 3) query = text;

      if (!state.activeChatId) newChat();
      const schedChat = getActiveChat();
      if (schedChat) {
        const userMsg = { id: generateId(), role: 'user', content: text, time: formatTime() };
        schedChat.messages.push(userMsg);
        if (schedChat.messages.length === 1) updateChatTitle(schedChat, text);
        dom.welcomeScreen.style.display = 'none';
        dom.messagesList.appendChild(buildMessageElement(userMsg));
        scrollToBottom();
        dom.messageInput.value = '';
        autoResizeTextarea();
        updateSendButton();
        saveChats();
        renderChatList();
        try {
          const created = await window.createTrackerFromChat({ query, frequency, hour, minute, targetDate, type: trackerType });
          const nextRunDate = new Date(created.nextRun);
          const nextRunStr = nextRunDate.toLocaleString('de-DE', {
            weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
          });
          const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} Uhr`;
          const whenDesc = frequency === 'once'
            ? (onceDateMatch ? onceDateMatch[1] : (nextRunDate.toDateString() === new Date().toDateString() ? 'heute' : 'morgen')) + ` um **${timeStr}**`
            : `**${freqLabelDE}** um **${timeStr}**`;

          const confirmMsg = {
            id: generateId(),
            role: 'assistant',
            content: trackerType === 'reminder'
              ? `⏰ **Erinnerung gesetzt!**\n\nIch erinnere dich ${whenDesc} an:\n\n> ${query}\n\n📅 **Zeitpunkt:** ${nextRunStr}\n\nDu bekommst eine Push-Benachrichtigung und die Erinnerung erscheint hier im Chat.\n\n_Die App muss zu diesem Zeitpunkt geöffnet sein._`
              : `✅ **Geplante Suche eingerichtet!**\n\nIch suche ${whenDesc} nach:\n\n> ${query}\n\n📅 **Ausführung:** ${nextRunStr}\n\nDas Ergebnis erscheint dann hier im Chat und du bekommst eine Push-Benachrichtigung.\n\n_Die App muss zu diesem Zeitpunkt geöffnet sein._`,
            time: formatTime(),
          };
          schedChat.messages.push(confirmMsg);
          dom.messagesList.appendChild(buildMessageElement(confirmMsg));
          scrollToBottom();
          saveChats();
        } catch (err) {
          showApiError(`Konnte nicht eingerichtet werden: ${err.message}`);
        }
        return;
      }
    }
  }

  // Ensure there's an active chat
  if (!state.activeChatId) newChat();
  const chat = getActiveChat();
  if (!chat) return;

  // Add user message to state
  const userMsg = { id: generateId(), role: 'user', content: text, time: formatTime() };
  chat.messages.push(userMsg);

  // Update title on first message
  if (chat.messages.length === 1) updateChatTitle(chat, text);

  // Render user message
  dom.welcomeScreen.style.display = 'none';
  dom.messagesList.appendChild(buildMessageElement(userMsg));
  scrollToBottom();
  saveChats();
  renderChatList();

  // Clear input
  dom.messageInput.value = '';
  autoResizeTextarea();
  updateSendButton();

  // Start streaming
  state.streaming = true;
  state.abortController = new AbortController();
  dom.btnSend.style.display = 'none';
  dom.btnStop.style.display = 'flex';

  showTypingIndicator();

  // Fetch Google Calendar context if connected
  state.calendarContext = null;
  if (isCalendarConnected()) {
    const events = await fetchCalendarEvents(14);
    if (events) state.calendarContext = formatCalendarForPrompt(events);
  }

  // Build messages array for API (limit context window)
  const apiMessages = chat.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_HISTORY_MESSAGES)
    .map(m => ({ role: m.role, content: m.content }));

  const body = {
    model: state.model,
    max_tokens: 8096,
    stream: true,
    messages: apiMessages,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  };
  body.system = buildSystemPrompt();

  let fullText = '';
  let streamStarted = false;
  let currentBlockType = null;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': state.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify(body),
      signal: state.abortController.signal,
    });

    if (!response.ok) {
      let errorMsg = `API-Fehler ${response.status}`;
      try {
        const err = await response.json();
        errorMsg = err?.error?.message || errorMsg;
      } catch { /* ignore */ }
      throw new Error(errorMsg);
    }

    removeTypingIndicator();
    appendStreamingMessage();
    streamStarted = true;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          // Track content block type (text vs tool_use)
          if (event.type === 'content_block_start') {
            currentBlockType = event.content_block?.type;
            if (currentBlockType === 'tool_use' && event.content_block?.name === 'web_search') {
              showSearchingIndicator();
            } else if (currentBlockType === 'text') {
              hideSearchingIndicator();
            }
          }

          // Only accumulate text_delta blocks (not tool input JSON)
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            fullText += event.delta.text;
            updateStreamingBubble(fullText);
          }
        } catch { /* malformed JSON, skip */ }
      }
    }
    hideSearchingIndicator();

  } catch (err) {
    removeTypingIndicator();
    if (err.name === 'AbortError') {
      // User stopped – finalize whatever was streamed
      if (streamStarted && fullText) {
        const { cleanText: stoppedText, actions: stoppedActions } = parseGarrettActions(fullText);
        if (stoppedActions.length) executeGarrettActions(stoppedActions);
        finalizeStreamingMessage(stoppedText);
      } else {
        const streamEl = $('streaming-message');
        if (streamEl) streamEl.remove();
      }
      showToast('Antwort gestoppt');
    } else {
      const streamEl = $('streaming-message');
      if (streamEl) streamEl.remove();
      showApiError(err.message);
      // Remove the user message we just added since request failed
      chat.messages.pop();
      dom.messagesList.lastElementChild?.remove();
      saveChats();
    }
    finishStreaming();
    return;
  }

  // Streaming complete – parse garrett-actions before displaying
  const { cleanText, actions } = parseGarrettActions(fullText);
  finalizeStreamingMessage(cleanText);

  // Execute any garrett-actions (create trackers/reminders silently)
  if (actions.length) executeGarrettActions(actions);

  // Save assistant message (without action blocks)
  const assistantMsg = { id: generateId(), role: 'assistant', content: cleanText, time: formatTime() };
  chat.messages.push(assistantMsg);
  saveChats();

  finishStreaming();
}

function showApiError(message) {
  const el = document.createElement('div');
  el.className = 'message assistant';
  el.innerHTML = `
    <div class="message-avatar" style="background:#ef4444">!</div>
    <div class="message-body">
      <div class="message-bubble" style="border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.08);color:#fca5a5">
        <strong>Fehler:</strong> ${escapeHtml(message)}
        ${message.includes('401') || message.includes('403') ? '<br><br>Bitte prüfe deinen API-Key in den <button onclick="openSettings()" style="background:none;border:none;color:var(--text-link);cursor:pointer;text-decoration:underline;font-size:inherit;padding:0">Einstellungen</button>.' : ''}
      </div>
      <span class="message-time">${formatTime()}</span>
    </div>
  `;
  dom.messagesList.appendChild(el);
  scrollToBottom();
}

function finishStreaming() {
  state.streaming = false;
  state.abortController = null;
  dom.btnSend.style.display = 'flex';
  dom.btnStop.style.display = 'none';
  updateSendButton();
}

function stopStreaming() {
  if (state.abortController) {
    state.abortController.abort();
  }
}

// ── Sidebar (Mobile) ─────────────────────────────────────────
function openSidebar() {
  dom.sidebar.classList.add('open');
  dom.sidebarOverlay.classList.add('visible');
}

function closeSidebar() {
  dom.sidebar.classList.remove('open');
  dom.sidebarOverlay.classList.remove('visible');
}

// ── Event Listeners ──────────────────────────────────────────
function initEventListeners() {
  // New chat
  dom.btnNewChat.addEventListener('click', newChat);

  // Mobile sidebar toggle
  dom.btnMenuToggle.addEventListener('click', openSidebar);
  dom.sidebarOverlay.addEventListener('click', closeSidebar);

  // Theme
  dom.btnThemeToggle.addEventListener('click', toggleTheme);

  // Clear chat
  dom.btnClearChat.addEventListener('click', clearActiveChat);

  // Settings
  dom.btnOpenSettings.addEventListener('click', openSettings);
  dom.btnHeaderSettings.addEventListener('click', openSettings);
  dom.btnCloseSettings.addEventListener('click', closeSettings);
  dom.btnCancelSettings.addEventListener('click', closeSettings);
  dom.btnSaveSettings.addEventListener('click', saveSettings);

  // Google Calendar connect button
  if (dom.btnGcalConnect) dom.btnGcalConnect.addEventListener('click', () => {
    if (isCalendarConnected()) disconnectGoogleCalendar();
    else connectGoogleCalendar();
  });

  // Close modal on overlay click
  dom.settingsModal.addEventListener('click', (e) => {
    if (e.target === dom.settingsModal) closeSettings();
  });

  // Toggle API key visibility
  dom.btnToggleKey.addEventListener('click', () => {
    const isPassword = dom.apiKeyInput.type === 'password';
    dom.apiKeyInput.type = isPassword ? 'text' : 'password';
  });

  // API key status update
  dom.apiKeyInput.addEventListener('input', updateApiKeyStatus);

  // Message input
  dom.messageInput.addEventListener('input', () => {
    autoResizeTextarea();
    updateSendButton();
  });

  dom.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!dom.btnSend.disabled) sendMessage();
    }
  });

  // Send & Stop
  dom.btnSend.addEventListener('click', sendMessage);
  dom.btnStop.addEventListener('click', stopStreaming);

  // API warning click → open settings
  dom.apiWarning.addEventListener('click', openSettings);

  // Welcome suggestion cards
  dom.messagesList.addEventListener('click', (e) => {
    const card = e.target.closest('.suggestion-card');
    if (card) {
      dom.messageInput.value = card.dataset.prompt || '';
      autoResizeTextarea();
      updateSendButton();
      dom.messageInput.focus();
    }
  });

  // Keyboard shortcut: Escape closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!dom.settingsModal.classList.contains('hidden')) closeSettings();
      if (typeof closeTrackerResultPanel === 'function') closeTrackerResultPanel();
      if (typeof closeTrackerModal === 'function') closeTrackerModal();
    }
  });

  // Tracker result overlay click to close
  const trackerOverlay = document.getElementById('tracker-result-overlay');
  if (trackerOverlay) {
    trackerOverlay.addEventListener('click', () => {
      if (typeof closeTrackerResultPanel === 'function') closeTrackerResultPanel();
    });
  }
}

// ── Service Worker Registration ──────────────────────────────
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('SW registered:', reg.scope))
      .catch(err => console.warn('SW registration failed:', err));

    // Listen for SW_UPDATED message → show reload banner
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'SW_UPDATED') showUpdateBanner();
    });
  });
}

function showUpdateBanner() {
  if (document.getElementById('sw-update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'sw-update-banner';
  banner.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;z-index:3000;
    background:linear-gradient(135deg,#7c3aed,#6366f1);
    color:#fff;padding:14px 20px;
    display:flex;align-items:center;justify-content:space-between;
    gap:12px;font-family:var(--font);font-size:13px;font-weight:500;
    box-shadow:0 -4px 24px rgba(124,58,237,0.4);
  `;
  banner.innerHTML = `
    <span>✨ Neue Version verfügbar – lade die App neu für das aktualisierte Design.</span>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button onclick="location.reload()" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);border-radius:8px;color:#fff;padding:6px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--font)">Neu laden</button>
      <button onclick="this.closest('#sw-update-banner').remove()" style="background:none;border:none;color:rgba(255,255,255,0.7);font-size:20px;cursor:pointer;padding:0 4px;line-height:1">✕</button>
    </div>
  `;
  document.body.appendChild(banner);
}

// ── Tracker Result in Chat ────────────────────────────────────
window.addTrackerResultToChat = function(tracker, result) {
  if (!state.activeChatId) newChat();
  const chat = getActiveChat();
  if (!chat) return;
  dom.welcomeScreen.style.display = 'none';
  const isReminder = tracker.type === 'reminder';
  const msg = {
    id: generateId(),
    role: 'assistant',
    content: isReminder
      ? `⏰ **Erinnerung: ${tracker.name}**\n\n${result.summary}`
      : `**🔍 Nachrichten-Update: ${tracker.name}**\n\n${result.summary}`,
    time: formatTime(),
  };
  chat.messages.push(msg);
  dom.messagesList.appendChild(buildMessageElement(msg));
  scrollToBottom();
  saveChats();
  renderChatList();
};

// ── Init ─────────────────────────────────────────────────────
function init() {
  loadSettings();
  loadChats();
  initEventListeners();
  renderChatList();
  updateHeaderModel();
  updateApiWarning();

  // Restore active chat or show welcome
  if (state.activeChatId && state.chats.some(c => c.id === state.activeChatId)) {
    renderMessages();
  } else if (state.chats.length > 0) {
    state.activeChatId = state.chats[0].id;
    renderMessages();
  } else {
    dom.welcomeScreen.style.display = 'flex';
  }

  // Auto-open settings if no API key
  if (!state.apiKey) {
    setTimeout(openSettings, 400);
  }

  registerServiceWorker();
}

// Make openSettings accessible globally (used in error messages)
window.openSettings = openSettings;

document.addEventListener('DOMContentLoaded', init);
