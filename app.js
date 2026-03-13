/* =========================================================
   Claude Chat PWA – Application Logic
   ========================================================= */

'use strict';

// ── Constants ──────────────────────────────────────────────
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_HISTORY_MESSAGES = 40; // keep last 40 messages in context

const LS = {
  API_KEY:       'claude_api_key',
  MODEL:         'claude_model',
  SYSTEM_PROMPT: 'claude_system_prompt',
  CHATS:         'claude_chats',
  THEME:         'claude_theme',
  ACTIVE_CHAT:   'claude_active_chat',
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
  state.systemPrompt  = localStorage.getItem(LS.SYSTEM_PROMPT) || '';
  const theme         = localStorage.getItem(LS.THEME) || 'dark';
  applyTheme(theme);
}

function openSettings() {
  dom.apiKeyInput.value       = state.apiKey;
  dom.modelSelect.value       = state.model;
  dom.systemPromptInput.value = state.systemPrompt;
  updateApiKeyStatus();
  dom.settingsModal.classList.remove('hidden');
  setTimeout(() => dom.apiKeyInput.focus(), 100);
}

function closeSettings() {
  dom.settingsModal.classList.add('hidden');
}

function saveSettings() {
  const key    = dom.apiKeyInput.value.trim();
  const model  = dom.modelSelect.value;
  const system = dom.systemPromptInput.value.trim();

  state.apiKey       = key;
  state.model        = model;
  state.systemPrompt = system;

  localStorage.setItem(LS.API_KEY,       key);
  localStorage.setItem(LS.MODEL,         model);
  localStorage.setItem(LS.SYSTEM_PROMPT, system);

  updateHeaderModel();
  updateApiWarning();
  closeSettings();
  showToast('Einstellungen gespeichert', 'success');
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
  const avatarChar = isUser ? '👤' : '✦';

  let contentHtml = '';
  if (isUser) {
    contentHtml = `<div class="message-bubble">${escapeHtml(msg.content).replace(/\n/g, '<br>')}</div>`;
  } else {
    contentHtml = `<div class="message-bubble">${renderMarkdown(msg.content)}</div>`;
  }

  el.innerHTML = `
    <div class="message-avatar">${avatarChar}</div>
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

// ── Typing Indicator ─────────────────────────────────────────
function showTypingIndicator() {
  dom.welcomeScreen.style.display = 'none';
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.id = 'typing-indicator';
  el.innerHTML = `
    <div class="message-avatar" style="background:linear-gradient(135deg,#7c3aed,#4f46e5)">✦</div>
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
  };
  if (state.systemPrompt) {
    body.system = state.systemPrompt;
  }

  let fullText = '';
  let streamStarted = false;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': state.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
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
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            fullText += event.delta.text;
            updateStreamingBubble(fullText);
          }
        } catch { /* malformed JSON, skip */ }
      }
    }

  } catch (err) {
    removeTypingIndicator();
    if (err.name === 'AbortError') {
      // User stopped – finalize whatever was streamed
      if (streamStarted && fullText) {
        finalizeStreamingMessage(fullText);
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

  // Streaming complete
  finalizeStreamingMessage(fullText);

  // Save assistant message
  const assistantMsg = { id: generateId(), role: 'assistant', content: fullText, time: formatTime() };
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
    }
  });
}

// ── Service Worker Registration ──────────────────────────────
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then(reg => console.log('SW registered:', reg.scope))
        .catch(err => console.warn('SW registration failed:', err));
    });
  }
}

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
