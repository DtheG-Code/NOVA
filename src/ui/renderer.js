'use strict';
/* NOVA Browser — Chrome-UI Logik v2 (Spaces, Split View, Previews, …) */

const $ = (sel) => document.querySelector(sel);
const PARTITION = 'persist:nova';
const NEWTAB = 'nova://newtab/';

const ACCENT_COLORS = {
  cyan: ['#00e5ff', '#7c4dff'], violet: ['#a78bfa', '#ec4899'], magenta: ['#f471b5', '#7c3aed'],
  lime: ['#a3e635', '#22d3ee'], amber: ['#fbbf24', '#fb7185'], ice: ['#7dd3fc', '#818cf8'],
};

const SP_ICONS = [
  'i-sp-home', 'i-sp-work', 'i-sp-game', 'i-sp-music', 'i-sp-code', 'i-star',
  'i-sp-heart', 'i-sp-flask', 'i-sp-book', 'i-sp-film', 'i-sp-cart', 'i-globe',
];
// Migration alter Emoji-Spaces auf SVG-Icons
const EMOJI_ICON_MAP = {
  '🏠': 'i-sp-home', '✨': 'i-star', '🎮': 'i-sp-game', '🎵': 'i-sp-music',
  '💼': 'i-sp-work', '❤️': 'i-sp-heart', '📚': 'i-sp-book', '🎬': 'i-sp-film',
};
function spaceIcon(ic) {
  if (ic && typeof ic === 'string' && ic.startsWith('i-')) return ic;
  return EMOJI_ICON_MAP[ic] || 'i-sp-home';
}

const state = {
  tabs: [],
  spaces: [],
  currentSpaceId: null,
  activeId: null,
  tabCounter: 0,
  spaceCounter: 0,
  closedStack: [],
  settings: {},
  bookmarks: [],
  webviewPreload: '',
  versions: {},
  blockedPerTab: {},
  totalBlocked: 0,
  omniFocused: false,
  suggestSeq: 0,
  dragTabId: null,
};

// Erst nach dem Start (Session-Restore) Warp-Animationen zulassen
let warpReady = false;

/* ============================================================ helpers */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function icon(name, cls = 'ic') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + name);
  svg.appendChild(use);
  return svg;
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function isWebUrl(url) { return /^https?:/i.test(url || ''); }
function isInternal(url) { return /^nova:/i.test(url || ''); }
function fmtBytes(n) {
  if (!n || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log2(n) / 10));
  return (n / 2 ** (10 * i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}
function faviconEl(url, cls, knownSrc) {
  const host = hostOf(url);
  const wrap = el('div', cls + ' letter');
  wrap.textContent = (host[0] || '•').toUpperCase();
  if (knownSrc || host) {
    const img = document.createElement('img');
    img.className = cls;
    img.src = knownSrc || `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
    img.onerror = () => img.replaceWith(wrap);
    img.onload = () => { if (img.naturalWidth <= 4) img.replaceWith(wrap); };
    return img;
  }
  return wrap;
}
function toast(msg, iconName = 'i-check') {
  const t = el('div', 'toast');
  t.appendChild(icon(iconName));
  t.appendChild(el('span', null, msg));
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 2600);
}
// Markiert Suchtreffer fett
function emphasize(container, text, q) {
  container.textContent = '';
  const idx = q ? (text || '').toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (idx < 0) { container.textContent = text || ''; return; }
  container.append(
    document.createTextNode(text.slice(0, idx)),
    Object.assign(el('b'), { textContent: text.slice(idx, idx + q.length) }),
    document.createTextNode(text.slice(idx + q.length)),
  );
}

/* ============================================================ accent */
function applyAccent() {
  const sp = currentSpace();
  const acc = (sp && sp.accent) || state.settings.accent || 'cyan';
  document.body.dataset.accent = acc;
  if (acc === 'custom') {
    const ca = state.settings.customAccent || {};
    document.body.style.setProperty('--acc', ca.a || '#00e5ff');
    document.body.style.setProperty('--acc2', ca.b || '#7c4dff');
  } else {
    document.body.style.removeProperty('--acc');
    document.body.style.removeProperty('--acc2');
  }
}

/* ============================================================ spaces */
function currentSpace() { return state.spaces.find((s) => s.id === state.currentSpaceId); }
function spaceTabs(spaceId = state.currentSpaceId) {
  const tabs = state.tabs.filter((t) => t.spaceId === spaceId);
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
}

function createSpace({ name = 'Space', icon = 'i-star', accent = null } = {}) {
  const sp = {
    id: 'sp' + (++state.spaceCounter) + Date.now().toString(36),
    name, icon, accent, activeTabId: null, splitTabId: null, splitRatio: 0.5,
  };
  state.spaces.push(sp);
  return sp;
}

function renderSpaces() {
  const row = $('#spaces-row');
  row.innerHTML = '';
  for (const sp of state.spaces) {
    const chip = el('div', 'space-chip' + (sp.id === state.currentSpaceId ? ' active' : ''));
    chip.appendChild(icon(spaceIcon(sp.icon)));
    chip.title = sp.name;
    chip.addEventListener('click', () => switchSpace(sp.id));
    chip.addEventListener('contextmenu', (e) => { e.preventDefault(); openSpaceEditor(sp, chip); });
    row.appendChild(chip);
  }
  const add = el('div', 'space-chip add');
  add.appendChild(icon('i-plus'));
  add.title = 'Neuer Space';
  add.addEventListener('click', () => openSpaceEditor(null, add));
  row.appendChild(add);
  const cur = currentSpace();
  $('#space-name').textContent = cur ? cur.name : '';
}

function switchSpace(id) {
  if (id === state.currentSpaceId || !state.spaces.some((s) => s.id === id)) return;
  state.currentSpaceId = id;
  hideTabPreview();
  applyAccent();
  renderSpaces();
  renderTabList();
  const sp = currentSpace();
  const tabs = spaceTabs(id);
  if (tabs.length === 0) {
    createTab(NEWTAB, { spaceId: id });
  } else {
    const target = tabs.find((t) => t.id === sp.activeTabId) || tabs[0];
    activateTab(target.id);
  }
  saveSession();
}

/* ---- space editor popover */
let editingSpace = null;
function openSpaceEditor(space, anchor) {
  editingSpace = space;
  const pop = $('#space-edit');
  $('#se-name').value = space ? space.name : '';
  $('#se-name').placeholder = 'Name des Space';
  $('#se-delete').classList.toggle('hidden', !space || state.spaces.length < 2);

  const icoBox = $('#se-icons');
  icoBox.innerHTML = '';
  let selIcon = space ? spaceIcon(space.icon) : 'i-star';
  for (const name of SP_ICONS) {
    const b = el('button', 'se-icon-btn' + (name === selIcon ? ' sel' : ''));
    b.appendChild(icon(name));
    b.addEventListener('click', () => {
      selIcon = name;
      [...icoBox.children].forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
    });
    icoBox.appendChild(b);
  }
  pop._getIcon = () => selIcon;

  const accBox = $('#se-accents');
  accBox.innerHTML = '';
  const opts = [null, ...Object.keys(ACCENT_COLORS)];
  let selected = space ? space.accent : null;
  for (const key of opts) {
    const dot = el('div', 'se-dot' + (key === null ? ' none' : '') + (selected === key ? ' sel' : ''));
    if (key) dot.style.background = `linear-gradient(135deg, ${ACCENT_COLORS[key][0]}, ${ACCENT_COLORS[key][1]})`;
    dot.title = key || 'Globale Akzentfarbe';
    dot.addEventListener('click', () => {
      selected = key;
      [...accBox.children].forEach((c) => c.classList.remove('sel'));
      dot.classList.add('sel');
    });
    accBox.appendChild(dot);
  }
  pop._getAccent = () => selected;

  const r = anchor.getBoundingClientRect();
  pop.classList.remove('hidden');
  pop.style.left = Math.min(r.left, innerWidth - 280) + 'px';
  pop.style.top = r.bottom + 8 + 'px';
  $('#se-name').focus();
}
function closeSpaceEditor() { $('#space-edit').classList.add('hidden'); editingSpace = null; }

$('#se-save').addEventListener('click', () => {
  const name = $('#se-name').value.trim() || 'Space';
  const iconTxt = $('#space-edit')._getIcon() || 'i-star';
  const accent = $('#space-edit')._getAccent();
  if (editingSpace) {
    Object.assign(editingSpace, { name, icon: iconTxt, accent });
  } else {
    const sp = createSpace({ name, icon: iconTxt, accent });
    closeSpaceEditor();
    switchSpace(sp.id);
    return;
  }
  closeSpaceEditor();
  applyAccent();
  renderSpaces();
  saveSession();
});
$('#se-delete').addEventListener('click', () => {
  if (!editingSpace || state.spaces.length < 2) return;
  const doomed = editingSpace;
  closeSpaceEditor();
  for (const t of state.tabs.filter((t) => t.spaceId === doomed.id)) {
    t.wrap.remove(); t.el.remove();
  }
  state.tabs = state.tabs.filter((t) => t.spaceId !== doomed.id);
  state.spaces = state.spaces.filter((s) => s.id !== doomed.id);
  if (state.currentSpaceId === doomed.id) {
    state.currentSpaceId = null;
    switchSpace(state.spaces[0].id);
  } else {
    renderSpaces();
  }
  toast(`Space „${doomed.name}" gelöscht`, 'i-trash');
  saveSession();
});
$('#se-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#se-save').click();
  if (e.key === 'Escape') closeSpaceEditor();
});

/* ============================================================ tabs */
function getTab(id) { return state.tabs.find((t) => t.id === id); }
function activeTab() { return getTab(state.activeId); }
function tabByWcId(wcId) { return state.tabs.find((t) => t.wcId === wcId); }

function createTab(url = NEWTAB, opts = {}) {
  const id = ++state.tabCounter;
  const tab = {
    id, url,
    spaceId: opts.spaceId || state.currentSpaceId,
    pinned: !!opts.pinned,
    title: opts.title || 'Neuer Tab', favicon: null, loading: false,
    wcId: null, audible: false, muted: false, pendingUrl: opts.lazy ? url : null,
    thumb: null, thumbTs: 0, lastActive: Date.now(), suspended: false,
  };

  const wrap = el('div', 'wv-wrap');
  $('#webviews').appendChild(wrap);
  tab.wrap = wrap;
  mountWebview(tab, opts.lazy ? 'about:blank' : url);

  tab.el = buildTabElement(tab);

  const idx = opts.afterId ? state.tabs.findIndex((t) => t.id === opts.afterId) + 1 : state.tabs.length;
  state.tabs.splice(idx > 0 ? idx : state.tabs.length, 0, tab);

  if (tab.spaceId === state.currentSpaceId) renderTabList();
  if (!opts.background) {
    if (isWebUrl(url) && !opts.lazy && warpReady) warp.begin(tab);
    activateTab(id);
  }
  saveSession();
  return tab;
}

// Webview in tab.wrap erzeugen + verdrahten (für createTab UND wakeTab/RAM-Sparen)
function mountWebview(tab, src) {
  const wv = document.createElement('webview');
  wv.setAttribute('partition', PARTITION);
  wv.setAttribute('allowpopups', '');
  if (state.webviewPreload) wv.setAttribute('preload', state.webviewPreload);
  wv.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=no,backgroundThrottling=no');
  wv.setAttribute('src', src);
  tab.wrap.appendChild(buildPaneBar(tab, wv));
  tab.wrap.appendChild(wv);
  tab.wv = wv;
  wireWebview(tab);
  return wv;
}

/* ---- RAM sparen: inaktive Tabs pausieren (Renderer-Prozess freigeben) ---- */
function suspendTab(tab) {
  if (!tab || tab.suspended || tab.id === state.activeId) return;
  const sp = state.spaces.find((s) => s.id === tab.spaceId);
  if (sp && sp.splitTabId === tab.id) return;   // im Split sichtbar
  if (tab.audible || tab.loading) return;        // spielt Audio / lädt gerade
  const u = tab.pendingUrl || tab.url;
  if (!isWebUrl(u)) return;                       // interne Seiten sind billig
  tab.suspendedUrl = u;
  try { tab.wv && tab.wv.remove(); } catch {}
  tab.wrap.innerHTML = '';
  tab.wv = null; tab.wcId = null; tab.suspended = true;
  tab.el.classList.add('suspended');
}
function wakeTab(tab) {
  if (!tab || !tab.suspended) return;
  tab.suspended = false;
  tab.el.classList.remove('suspended');
  tab.wrap.innerHTML = '';
  mountWebview(tab, tab.suspendedUrl || tab.url || NEWTAB);
}
// regelmäßig prüfen: lange inaktive Hintergrund-Tabs pausieren
setInterval(() => {
  if (state.settings.tabSuspend === false) return;
  const limit = Math.max(1, state.settings.tabSuspendMin || 15) * 60000;
  const now = Date.now();
  for (const t of state.tabs) {
    if (t.suspended || t.id === state.activeId) continue;
    if (now - (t.lastActive || now) >= limit) suspendTab(t);
  }
}, 60000);

/* ---- Pro-Pane-Navigationsleiste (Split View) */
function buildPaneBar(tab, wv) {
  const bar = el('div', 'pane-bar');

  const mkBtn = (ic, title, fn) => {
    const b = el('button', 'icon-btn');
    b.appendChild(icon(ic));
    b.title = title;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
    return b;
  };
  const back = mkBtn('i-back', 'Zurück', () => { try { tab.wv.goBack(); } catch {} });
  const fwd = mkBtn('i-fwd', 'Vorwärts', () => { try { tab.wv.goForward(); } catch {} });
  const reload = mkBtn('i-reload', 'Neu laden', () => { try { tab.loading ? tab.wv.stop() : tab.wv.reload(); } catch {} });

  const omni = el('div', 'pane-omni');
  omni.appendChild(icon('i-search'));
  const input = el('input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = 'Suchen oder Adresse …';
  omni.appendChild(input);

  input.addEventListener('focus', () => {
    tab.paneFocused = true;
    if (isWebUrl(tab.url)) input.value = tab.url;
    requestAnimationFrame(() => input.select());
    markPaneFocus(tab);
  });
  input.addEventListener('blur', () => { tab.paneFocused = false; });
  input.addEventListener('keydown', async (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      const text = input.value.trim();
      if (!text) return;
      const direct = resolveInput(text);
      const dest = direct || await window.nova.omni.searchUrl(text);
      input.blur();
      navigate(tab, dest);
    } else if (ev.key === 'Escape') {
      input.blur();
    }
  });

  const closeSplit = mkBtn('i-x', 'Split schließen', () => {
    const sp = currentSpace();
    if (sp) { sp.splitTabId = null; updateWebviewLayout(); syncTabActiveClasses(); saveSession(); }
  });

  bar.append(back, fwd, reload, omni, closeSplit);
  bar.addEventListener('mousedown', () => markPaneFocus(tab));

  tab.paneBar = bar;
  tab.paneInput = input;
  tab.paneBack = back;
  tab.paneFwd = fwd;
  tab.paneReload = reload;
  return bar;
}

function markPaneFocus(tab) {
  for (const t of state.tabs) t.wrap.classList.toggle('pane-focus', t.id === tab.id);
}

function updatePaneBar(tab) {
  if (!tab.paneInput) return;
  if (!tab.paneFocused) {
    tab.paneInput.value = (isInternal(tab.url) || tab.url === 'about:blank') ? '' : tab.url;
  }
  try {
    tab.paneBack.disabled = !tab.wv.canGoBack();
    tab.paneFwd.disabled = !tab.wv.canGoForward();
  } catch {}
  if (tab.paneReload) {
    tab.paneReload.innerHTML = '';
    tab.paneReload.appendChild(icon(tab.loading ? 'i-x' : 'i-reload'));
  }
}

function buildTabElement(tab) {
  const e = el('div', 'tab');
  e.dataset.id = tab.id;
  e.draggable = true;

  const favSlot = el('div', 'tab-fav-slot');
  const title = el('span', 'tab-title', tab.title);
  const audio = el('button', 'tab-audio hidden');
  audio.appendChild(icon('i-audio'));
  const close = el('button', 'tab-close');
  close.appendChild(icon('i-x'));
  close.title = 'Tab schließen';

  e.append(favSlot, title, audio, close);
  tab.titleEl = title;
  tab.favSlot = favSlot;
  tab.audioEl = audio;
  updateTabFavicon(tab);

  e.addEventListener('click', (ev) => {
    if (ev.target.closest('.tab-close') || ev.target.closest('.tab-audio')) return;
    activateTab(tab.id);
  });
  e.addEventListener('auxclick', (ev) => { if (ev.button === 1) closeTab(tab.id); });
  e.addEventListener('contextmenu', (ev) => tabCtxMenu(ev, tab));
  close.addEventListener('click', () => closeTab(tab.id));
  audio.addEventListener('click', () => toggleMute(tab.id));

  e.addEventListener('dragstart', () => { state.dragTabId = tab.id; hideTabPreview(); });
  e.addEventListener('dragover', (ev) => { ev.preventDefault(); e.classList.add('dragover'); });
  e.addEventListener('dragleave', () => e.classList.remove('dragover'));
  e.addEventListener('drop', (ev) => {
    ev.preventDefault();
    e.classList.remove('dragover');
    if (state.dragTabId && state.dragTabId !== tab.id) reorderTab(state.dragTabId, tab.id);
  });

  e.addEventListener('mouseenter', () => scheduleTabPreview(tab));
  e.addEventListener('mouseleave', hideTabPreview);
  e.addEventListener('mousedown', hideTabPreview);

  return e;
}

function renderTabList() {
  const topMode = state.settings.tabBarPosition === 'top';
  const list = $('#tab-list');
  const grid = $('#pinned-grid');
  const strip = $('#tabstrip-tabs');
  list.innerHTML = '';
  grid.innerHTML = '';
  strip.innerHTML = '';
  const tabs = spaceTabs();
  if (topMode) {
    for (const t of tabs) { t.el.classList.toggle('pinned-mini', !!t.pinned); strip.appendChild(t.el); }
  } else {
    for (const t of tabs) { t.el.classList.remove('pinned-mini'); (t.pinned ? grid : list).appendChild(t.el); }
  }
  $('#tab-count').textContent = tabs.length;
  filterTabs();
  syncTabActiveClasses();
  if (topMode) $('#tab-overflow').classList.add('hidden');
  else requestAnimationFrame(updateTabOverflow);
}

// Tab-Leiste seitlich oder oben
function applyTabBarMode() {
  document.body.classList.toggle('tabs-top', state.settings.tabBarPosition === 'top');
  renderTabList();
}
$('#tabstrip-new').addEventListener('click', () => createTab());

// Zeigt unten an, wie viele Tabs außerhalb des sichtbaren Bereichs liegen.
function updateTabOverflow() {
  const list = $('#tab-list');
  const ov = $('#tab-overflow');
  const tabsEls = [...list.querySelectorAll('.tab')].filter((t) => !t.classList.contains('hidden'));
  if (tabsEls.length === 0) { ov.classList.add('hidden'); return; }
  const listRect = list.getBoundingClientRect();
  const below = tabsEls.filter((t) => t.getBoundingClientRect().top >= listRect.bottom - 6).length;
  if (below > 0) {
    ov.querySelector('span').textContent = `${below} weitere${below === 1 ? 'r Tab' : ' Tabs'}`;
    ov.classList.remove('hidden');
  } else {
    ov.classList.add('hidden');
  }
}
$('#tab-list').addEventListener('scroll', () => requestAnimationFrame(updateTabOverflow), { passive: true });
$('#tab-overflow').addEventListener('click', () => {
  $('#tab-list').scrollBy({ top: $('#tab-list').clientHeight * 0.85, behavior: 'smooth' });
});
window.addEventListener('resize', () => requestAnimationFrame(updateTabOverflow));

/* ---- Sidebar-Filter (Tabs + Favoriten) */
let currentFilter = '';
function filterTabs() {
  for (const t of spaceTabs()) {
    const hay = ((t.title || '') + ' ' + (t.pendingUrl || t.url || '')).toLowerCase();
    t.el.classList.toggle('hidden', !!currentFilter && !hay.includes(currentFilter));
  }
}
function setFilter(q) {
  currentFilter = (q || '').trim().toLowerCase();
  $('#filter-clear').classList.toggle('hidden', !currentFilter);
  filterTabs();
  renderBookmarks();
}
$('#filter-input').addEventListener('input', (e) => setFilter(e.target.value));
$('#filter-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = '';
    setFilter('');
    e.target.blur();
  }
});
$('#filter-clear').addEventListener('click', () => {
  $('#filter-input').value = '';
  setFilter('');
});

function syncTabActiveClasses() {
  const sp = currentSpace();
  for (const t of state.tabs) {
    t.el.classList.toggle('active', t.id === state.activeId);
    t.el.classList.toggle('in-split', !!sp && sp.splitTabId === t.id);
  }
  $('#btn-split').classList.toggle('active-tool', !!(sp && sp.splitTabId));
}

function updateTabFavicon(tab) {
  const slot = tab.favSlot;
  const url = tab.pendingUrl || tab.url;
  slot.innerHTML = '';
  if (tab.loading) {
    slot.appendChild(el('div', 'tab-spinner'));
  } else if (isInternal(url) || url === 'about:blank') {
    const d = el('div', 'tab-fav letter', 'N');
    d.style.fontFamily = 'var(--font-disp)';
    slot.appendChild(d);
  } else {
    slot.appendChild(faviconEl(url, 'tab-fav', tab.favicon));
  }
}

function activateTab(id) {
  const tab = getTab(id);
  if (!tab) return;
  tab.lastActive = Date.now();
  if (tab.suspended) wakeTab(tab); // pausierten Tab aufwecken
  if (tab.spaceId !== state.currentSpaceId) {
    state.currentSpaceId = tab.spaceId;
    applyAccent();
    renderSpaces();
    renderTabList();
  }
  const sp = currentSpace();
  if (sp) {
    // Klick auf den Split-Partner: Rollen tauschen
    if (sp.splitTabId === id && state.activeId && state.activeId !== id) {
      sp.splitTabId = state.activeId;
    }
    sp.activeTabId = id;
  }
  state.activeId = id;

  if (tab.pendingUrl) {
    tab.wv.src = tab.pendingUrl;
    tab.pendingUrl = null;
  }
  updateWebviewLayout();
  syncTabActiveClasses();
  syncOmnibox(tab);
  syncNavButtons(tab);
  syncStar(tab);
  syncShieldBadge();
  $('#loadbar').classList.toggle('on', !!tab.loading);
  $('#link-preview').classList.add('hidden');
  closeFindbar(false);
  saveSession();
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  const sp = state.spaces.find((s) => s.id === tab.spaceId);
  if (isWebUrl(tab.url)) state.closedStack.push({ url: tab.url, title: tab.title });
  if (sp && sp.splitTabId === id) sp.splitTabId = null;
  tab.wrap.remove();
  tab.el.remove();
  state.tabs.splice(idx, 1);

  const remaining = spaceTabs(tab.spaceId);
  if (tab.spaceId === state.currentSpaceId) {
    if (remaining.length === 0) {
      createTab(NEWTAB, { spaceId: tab.spaceId });
      return;
    }
    if (state.activeId === id) {
      const all = state.tabs.filter((t) => t.spaceId === tab.spaceId);
      const next = all[Math.min(idx, all.length - 1)] || remaining[0];
      activateTab(next.id);
    } else {
      updateWebviewLayout();
      syncTabActiveClasses();
    }
  }
  saveSession();
}

function reorderTab(dragId, dropId) {
  const drag = getTab(dragId);
  const drop = getTab(dropId);
  if (!drag || !drop || drag.spaceId !== drop.spaceId) return;
  const from = state.tabs.indexOf(drag);
  state.tabs.splice(from, 1);
  state.tabs.splice(state.tabs.indexOf(drop), 0, drag);
  drag.pinned = drop.pinned;
  renderTabList();
  saveSession();
}

function togglePin(id) {
  const tab = getTab(id);
  if (!tab) return;
  tab.pinned = !tab.pinned;
  renderTabList();
  saveSession();
}

function toggleMute(id) {
  const tab = getTab(id);
  if (!tab || !tab.wcId) return;
  tab.muted = !tab.muted;
  try { tab.wv.setAudioMuted(tab.muted); } catch {}
  syncAudioIcon(tab);
}

function syncAudioIcon(tab) {
  const show = tab.audible || tab.muted;
  tab.audioEl.classList.toggle('hidden', !show);
  tab.audioEl.innerHTML = '';
  tab.audioEl.appendChild(icon(tab.muted ? 'i-mute' : 'i-audio'));
  tab.audioEl.title = tab.muted ? 'Ton einschalten' : 'Tab stummschalten';
}

// Ist der Tab gerade als Pane sichtbar (aktiv ODER Split-Partner)?
function paneVisible(tab) {
  if (!tab) return false;
  if (tab.id === state.activeId) return true;
  const sp = currentSpace();
  return !!(sp && sp.splitTabId === tab.id);
}

function navigate(tab, url) {
  if (!tab) return;
  hideError(tab);
  if (tab.pendingUrl) tab.pendingUrl = null;
  // Hyperspace-Sprung im Bereich des jeweiligen Panes (Split: nur dort).
  if (isWebUrl(url) && paneVisible(tab) && warpReady) warp.begin(tab);
  tab.wv.src = url;
}

function cycleTab(dir) {
  const tabs = spaceTabs();
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === state.activeId);
  activateTab(tabs[(idx + dir + tabs.length) % tabs.length].id);
}

function reopenClosedTab() {
  const last = state.closedStack.pop();
  if (last) createTab(last.url);
  else toast('Keine geschlossenen Tabs', 'i-warn');
}

// Alle Tabs des aktuellen Space schließen (in den Wiederherstellen-Stack legen)
function closeAllTabsInSpace() {
  const tabs = spaceTabs();
  if (tabs.length === 0) return;
  const webTabs = tabs.filter((t) => isWebUrl(t.url));
  for (const t of tabs) {
    if (isWebUrl(t.url)) state.closedStack.push({ url: t.url, title: t.title });
    const sp = state.spaces.find((s) => s.id === t.spaceId);
    if (sp && sp.splitTabId === t.id) sp.splitTabId = null;
    t.wrap.remove();
    t.el.remove();
    const idx = state.tabs.indexOf(t);
    if (idx >= 0) state.tabs.splice(idx, 1);
  }
  const fresh = createTab(NEWTAB, { spaceId: state.currentSpaceId });
  activateTab(fresh.id);
  toast(`${tabs.length} Tab${tabs.length > 1 ? 's' : ''} geschlossen`, 'i-trash');
  saveSession();
}

/* ---- tab context menu */
function tabCtxMenu(e, tab) {
  e.preventDefault();
  hideTabPreview();
  const items = [
    { label: 'Neu laden', ic: 'i-reload', run: () => { try { tab.wv.reload(); } catch {} } },
    { label: 'Duplizieren', ic: 'i-copy', run: () => createTab(tab.pendingUrl || tab.url, { afterId: tab.id }) },
    { label: tab.pinned ? 'Lösen' : 'Anpinnen', ic: 'i-pin', run: () => togglePin(tab.id) },
    { label: tab.muted ? 'Ton einschalten' : 'Stummschalten', ic: tab.muted ? 'i-audio' : 'i-mute', run: () => toggleMute(tab.id) },
    { label: 'Split View', ic: 'i-split', run: () => toggleSplitWith(tab.id) },
  ];
  const others = state.spaces.filter((s) => s.id !== tab.spaceId);
  if (others.length) {
    items.push({ sep: true });
    for (const sp of others) {
      items.push({ label: `Nach ${sp.name} verschieben`, ic: spaceIcon(sp.icon), run: () => moveTabToSpace(tab, sp) });
    }
  }
  items.push(
    { sep: true },
    { label: 'Schließen', ic: 'i-x', run: () => closeTab(tab.id) },
    { label: 'Andere Tabs schließen', ic: 'i-x', danger: true, run: () => {
        for (const t of spaceTabs().filter((t) => t.id !== tab.id && !t.pinned)) closeTab(t.id);
      } },
  );
  showCtxMenu(e.clientX, e.clientY, items);
}

function moveTabToSpace(tab, sp) {
  const wasActive = state.activeId === tab.id;
  const curSp = currentSpace();
  if (curSp && curSp.splitTabId === tab.id) curSp.splitTabId = null;
  tab.spaceId = sp.id;
  tab.pinned = false;
  renderTabList();
  if (wasActive) {
    const rest = spaceTabs();
    if (rest.length === 0) createTab();
    else activateTab(rest[0].id);
  } else {
    updateWebviewLayout();
  }
  toast(`Tab nach „${sp.name}" verschoben`, 'i-ext');
  saveSession();
}

/* ============================================================ split view */
function toggleSplitWith(tabId) {
  const sp = currentSpace();
  if (!sp) return;
  if (sp.splitTabId === tabId || (tabId === state.activeId && sp.splitTabId)) {
    sp.splitTabId = null;
  } else if (tabId === state.activeId) {
    const others = spaceTabs().filter((t) => t.id !== tabId);
    const partner = others[0] || createTab(NEWTAB, { background: true });
    sp.splitTabId = partner.id;
  } else {
    sp.splitTabId = tabId;
  }
  if (sp.splitTabId) { const pt = getTab(sp.splitTabId); if (pt && pt.suspended) wakeTab(pt); }
  updateWebviewLayout();
  syncTabActiveClasses();
}

function updateWebviewLayout() {
  const sp = currentSpace();
  const act = activeTab();
  const partner = sp && sp.splitTabId ? getTab(sp.splitTabId) : null;
  const divider = $('#split-divider');

  for (const t of state.tabs) {
    t.wrap.classList.remove('active', 'split-left', 'split-right');
    t.wrap.style.removeProperty('--split');
  }
  if (act && partner && partner.id !== act.id && partner.spaceId === state.currentSpaceId) {
    const p = Math.round((sp.splitRatio || 0.5) * 100) + '%';
    act.wrap.classList.add('active', 'split-left');
    act.wrap.style.setProperty('--split', p);
    partner.wrap.classList.add('active', 'split-right');
    partner.wrap.style.setProperty('--split', p);
    divider.style.left = `calc(${p} - 3px)`;
    divider.classList.remove('hidden');
    if (partner.pendingUrl) { partner.wv.src = partner.pendingUrl; partner.pendingUrl = null; }
    updatePaneBar(act);
    updatePaneBar(partner);
    markPaneFocus(act);
  } else {
    if (sp && partner == null) sp.splitTabId = null;
    if (act) act.wrap.classList.add('active');
    for (const t of state.tabs) t.wrap.classList.remove('pane-focus');
    divider.classList.add('hidden');
  }
}

$('#split-divider').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const sp = currentSpace();
  if (!sp) return;
  $('#split-divider').classList.add('dragging');
  $('#drag-shield').classList.remove('hidden');
  document.body.classList.add('split-dragging');   // Panes folgen sofort (keine Transition-Verzögerung)
  const area = $('#webviews').getBoundingClientRect();
  const onMove = (ev) => {
    sp.splitRatio = Math.min(0.85, Math.max(0.15, (ev.clientX - area.left) / area.width));
    updateWebviewLayout();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    $('#split-divider').classList.remove('dragging');
    $('#drag-shield').classList.add('hidden');
    document.body.classList.remove('split-dragging');
    saveSession();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

/* ============================================================ tab preview */
let previewTimer = null;
function scheduleTabPreview(tab) {
  clearTimeout(previewTimer);
  if (state.dragTabId) return;
  previewTimer = setTimeout(async () => {
    if (!getTab(tab.id)) return;
    const card = $('#tab-preview');
    card.querySelector('.tp-title').textContent = displayTitle(tab);
    card.querySelector('.tp-url').textContent = tab.pendingUrl || tab.url;
    const imgBox = card.querySelector('.tp-img');
    const img = imgBox.querySelector('img');
    imgBox.classList.add('none');
    img.removeAttribute('src');
    if (tab.wcId && !tab.pendingUrl && !isInternal(tab.url)) {
      if (tab.thumb && Date.now() - tab.thumbTs < 4000) {
        img.src = tab.thumb;
        imgBox.classList.remove('none');
      } else {
        const data = await window.nova.tabs.thumb(tab.wcId);
        if (data) {
          tab.thumb = data;
          tab.thumbTs = Date.now();
          img.src = data;
          imgBox.classList.remove('none');
        }
      }
    }
    const r = tab.el.getBoundingClientRect();
    const sb = $('#sidebar').getBoundingClientRect();
    card.classList.remove('hidden');
    const ch = card.getBoundingClientRect().height;
    card.style.left = sb.right + 10 + 'px';
    card.style.top = Math.min(Math.max(8, r.top), innerHeight - ch - 10) + 'px';
  }, 430);
}
function hideTabPreview() {
  clearTimeout(previewTimer);
  $('#tab-preview').classList.add('hidden');
}

/* ============================================================ webview wiring */
// Erzwingt ein Neu-Compositing des Webviews (behebt schwarze/leere Videos in Electron)
function repaintWebview(tab) {
  if (!tab || !tab.wv) return;
  const wv = tab.wv;
  requestAnimationFrame(() => {
    wv.style.transform = 'translateZ(0)';
    requestAnimationFrame(() => { wv.style.transform = ''; });
  });
}

function wireWebview(tab) {
  const wv = tab.wv;

  wv.addEventListener('dom-ready', () => {
    if (!tab.wcId) {
      try { tab.wcId = wv.getWebContentsId(); } catch {}
    }
    // Electron-Compositing-Bug: Videos bleiben gelegentlich schwarz, bis ein
    // Reflow passiert. Ein winziger Layout-Nudge erzwingt das Neuzeichnen,
    // sodass YouTube-Videos sofort beim ersten Mal erscheinen.
    repaintWebview(tab);
  });

  wv.addEventListener('did-start-loading', () => {
    tab.loading = true;
    hideError(tab);
    updateTabFavicon(tab);
    updatePaneBar(tab);
    if (tab.id === state.activeId) {
      $('#loadbar').classList.add('on');
      setReloadButton(true);
    }
  });

  // Sobald die Navigation feststeht: bei Webseiten den Sprung starten,
  // bei internen Seiten (Neuer Tab) einen evtl. laufenden Sprung abbrechen.
  wv.addEventListener('load-commit', (e) => {
    if (!e.isMainFrame || !paneVisible(tab) || !warpReady) return;
    if (isWebUrl(e.url)) warp.begin(tab);
    else warp.cancel(tab);
  });

  wv.addEventListener('did-stop-loading', () => {
    tab.loading = false;
    tab.thumbTs = 0;
    updateTabFavicon(tab);
    updatePaneBar(tab);
    warp.end(tab);
    if (tab.id === state.activeId) {
      $('#loadbar').classList.remove('on');
      setReloadButton(false);
      syncNavButtons(tab);
      repaintWebview(tab);
    }
  });

  wv.addEventListener('page-title-updated', (e) => {
    tab.title = e.title || tab.title;
    tab.titleEl.textContent = displayTitle(tab);
    if (isWebUrl(tab.url)) window.nova.history.add({ url: tab.url, title: e.title });
    saveSession();
  });

  wv.addEventListener('page-favicon-updated', (e) => {
    tab.favicon = e.favicons?.[0] || null;
    updateTabFavicon(tab);
  });

  const onNav = (url) => {
    tab.url = url;
    tab.titleEl.textContent = displayTitle(tab);
    updatePaneBar(tab);
    if (isWebUrl(url)) window.nova.history.add({ url, title: tab.title });
    if (tab.id === state.activeId) {
      syncOmnibox(tab);
      syncNavButtons(tab);
      syncStar(tab);
      syncShieldBadge();
      if (typeof security !== 'undefined') security.updateChip(tab);   // Security-Report-Punkt am Schloss
    }
    saveSession();
  };
  wv.addEventListener('did-navigate', (e) => {
    tab.favicon = null;
    if (tab.wcId != null) {
      state.blockedPerTab[tab.wcId] = 0;
      window.nova.adblock.resetTab(tab.wcId);
    }
    onNav(e.url);
    applyStoredZoom(tab);
  });
  wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) onNav(e.url); });

  wv.addEventListener('did-fail-load', (e) => {
    warp.end(tab);
    if (!e.isMainFrame || e.errorCode === -3 || e.errorCode === 0) return;
    showError(tab, e);
  });

  wv.addEventListener('enter-html-full-screen', () => $('#app').classList.add('content-fs'));
  wv.addEventListener('leave-html-full-screen', () => $('#app').classList.remove('content-fs'));

  wv.addEventListener('update-target-url', (e) => {
    const lp = $('#link-preview');
    if (e.url && tab.id === state.activeId) {
      lp.textContent = e.url;
      lp.classList.remove('hidden');
    } else {
      lp.classList.add('hidden');
    }
  });

  wv.addEventListener('found-in-page', (e) => {
    if (e.result) $('#find-count').textContent = `${e.result.activeMatchOrdinal}/${e.result.matches}`;
  });

  // Startseite → Agent-Modus: Suchbegriff als Ziel an den Operator übergeben (läuft im Hintergrund)
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'nova-agent') {
      const goal = (e.args && e.args[0]) || '';
      if (tab.id !== state.activeId) activateTab(tab.id);
      if (goal) operator.run(goal);
    } else if (e.channel && e.channel.indexOf('vault-') === 0) {
      try { vault.onWebviewMessage(wv, e.channel, (e.args && e.args[0]) || {}); } catch {}
    }
  });
}

function displayTitle(tab) {
  if (isInternal(tab.url) && !tab.pendingUrl) return 'Neuer Tab';
  return tab.title || hostOf(tab.pendingUrl || tab.url) || 'Neuer Tab';
}

function showError(tab, e) {
  hideError(tab);
  const box = el('div', 'wv-error');
  const ic = el('div', 'err-ic');
  ic.appendChild(icon('i-warn'));
  const h = el('h3', null, 'Seite konnte nicht geladen werden');
  const p = el('p', null, `${e.errorDescription || 'Unbekannter Fehler'} (${e.errorCode})\n${e.validatedURL || ''}`);
  const btn = el('button', 'btn primary');
  btn.appendChild(icon('i-reload'));
  btn.appendChild(el('span', null, 'Erneut versuchen'));
  btn.addEventListener('click', () => { hideError(tab); tab.wv.reload(); });
  box.append(ic, h, p, btn);
  tab.wrap.appendChild(box);
  tab.errorEl = box;
}
function hideError(tab) {
  if (tab.errorEl) { tab.errorEl.remove(); tab.errorEl = null; }
}

/* ============================================================ zoom (mit Seiten-Gedächtnis) */
function applyStoredZoom(tab) {
  const host = hostOf(tab.url);
  if (!host) return;
  const lvl = (state.settings.zoomLevels || {})[host] || 0;
  try { if (tab.wv.getZoomLevel() !== lvl) tab.wv.setZoomLevel(lvl); } catch {}
}

let zoomSaveTimer;
function zoom(delta) {
  const tab = activeTab();
  if (!tab?.wcId) return;
  try {
    const lvl = delta == null ? 0 : Math.min(7, Math.max(-6, tab.wv.getZoomLevel() + delta));
    tab.wv.setZoomLevel(lvl);
    toast(`Zoom: ${Math.round(Math.pow(1.2, lvl) * 100)} %`, 'i-search');
    const host = hostOf(tab.url);
    if (host) {
      const zl = { ...(state.settings.zoomLevels || {}) };
      if (lvl === 0) delete zl[host];
      else zl[host] = lvl;
      state.settings.zoomLevels = zl;
      clearTimeout(zoomSaveTimer);
      zoomSaveTimer = setTimeout(() => window.nova.settings.set({ zoomLevels: zl }), 500);
    }
  } catch {}
}

/* ============================================================ topbar sync */
function syncOmnibox(tab) {
  syncSecChip(tab);
  const isWeb = tab && isWebUrl(tab.url);
  $('#btn-copyurl').classList.toggle('hidden', !isWeb);
  if (state.omniFocused) return;
  const input = $('#omni-input');
  input.value = (!tab || isInternal(tab.url) || tab.url === 'about:blank') ? '' : tab.url;
}

function syncSecChip(tab) {
  const chip = $('#omni-sec');
  chip.className = 'sec-chip';
  chip.innerHTML = '';
  const url = tab?.url || '';
  if (isInternal(url) || url === 'about:blank' || !url) {
    chip.classList.add('internal');
    chip.appendChild(icon('i-bolt'));
    chip.title = 'NOVA Startseite';
  } else if (url.startsWith('https:')) {
    chip.classList.add('secure');
    chip.appendChild(icon('i-lock'));
    chip.title = 'Sichere Verbindung (HTTPS)';
  } else {
    chip.classList.add('insecure');
    chip.appendChild(icon('i-warn'));
    chip.title = 'Nicht sichere Verbindung';
  }
}

function syncNavButtons(tab) {
  let canBack = false, canFwd = false;
  try { canBack = tab?.wv?.canGoBack() || false; canFwd = tab?.wv?.canGoForward() || false; } catch {}
  $('#btn-back').disabled = !canBack;
  $('#btn-fwd').disabled = !canFwd;
}

function setReloadButton(loading) {
  const b = $('#btn-reload');
  b.innerHTML = '';
  b.appendChild(icon(loading ? 'i-x' : 'i-reload'));
  b.title = loading ? 'Laden abbrechen' : 'Neu laden';
}

async function syncStar(tab) {
  const btn = $('#btn-star');
  if (!tab || !isWebUrl(tab.url)) { btn.classList.remove('starred'); return; }
  const found = await window.nova.bookmarks.find(tab.url);
  btn.classList.toggle('starred', !!found);
  btn.title = found ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen (Strg D)';
}

function syncShieldBadge() {
  const tab = activeTab();
  const n = (tab && tab.wcId != null ? state.blockedPerTab[tab.wcId] : 0) || 0;
  const badge = $('#shield-badge');
  badge.textContent = n > 999 ? '1k+' : n;
  badge.classList.toggle('zero', n === 0 || !state.settings.adblockEnabled);
  $('#mini-shield-count').textContent = state.totalBlocked.toLocaleString('de-DE');
}

/* ============================================================ omnibox */
function resolveInput(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^(nova|view-source|about):/i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (/^localhost(:\d+)?([/?#]|$)/i.test(t)) return 'http://' + t;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && /\.[a-z]{2,}([/?#:]|$)/i.test(t)) return 'https://' + t;
  return null;
}

async function omniSubmit(text, { newTab = false } = {}) {
  const direct = resolveInput(text);
  const url = direct || await window.nova.omni.searchUrl(text.trim());
  closeOmniDrop();
  $('#omni-input').blur();
  if (newTab) createTab(url);
  else navigate(activeTab(), url);
}

const omniInput = $('#omni-input');
let omniDropItems = [];
let omniDropSel = 0;

omniInput.addEventListener('focus', () => {
  state.omniFocused = true;
  const tab = activeTab();
  if (tab && isWebUrl(tab.url)) omniInput.value = tab.url;
  requestAnimationFrame(() => omniInput.select());
});
omniInput.addEventListener('blur', () => {
  state.omniFocused = false;
  setTimeout(() => closeOmniDrop(), 150);
  syncOmnibox(activeTab());
});
omniInput.addEventListener('input', () => updateOmniDrop(omniInput.value));
omniInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const sel = omniDropItems[omniDropSel];
    if (sel && !$('#omni-drop').classList.contains('hidden')) sel.run(e.altKey);
    else omniSubmit(omniInput.value, { newTab: e.altKey });
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (omniDropItems.length === 0) return;
    omniDropSel = (omniDropSel + (e.key === 'ArrowDown' ? 1 : -1) + omniDropItems.length) % omniDropItems.length;
    renderOmniSelection();
  } else if (e.key === 'Escape') {
    closeOmniDrop();
    omniInput.blur();
  }
});

async function updateOmniDrop(q) {
  q = q.trim();
  if (!q) { closeOmniDrop(); return; }
  const seq = ++state.suggestSeq;

  const items = [];
  const direct = resolveInput(q);
  if (direct) {
    items.push({ kind: 'url', main: direct, icon: 'i-globe',
      run: (nt) => nt ? createTab(direct) : (closeOmniDrop(), navigate(activeTab(), direct)) });
  }
  items.push({ kind: 'suche', main: q, icon: 'i-search', run: (nt) => omniSubmit(q, { newTab: nt }) });

  const ql = q.toLowerCase();
  const bmHits = [];
  walkTree(state.bookmarks, (n) => {
    if (n.type === 'url' && bmHits.length < 3 &&
        ((n.name || '').toLowerCase().includes(ql) || n.url.toLowerCase().includes(ql))) bmHits.push(n);
  });
  for (const b of bmHits) {
    items.push({ kind: 'favorit', main: b.name, sub: hostOf(b.url), favUrl: b.url, url: b.url,
      run: (nt) => nt ? createTab(b.url) : (closeOmniDrop(), navigate(activeTab(), b.url)) });
  }

  const [histHits, suggestions] = await Promise.all([
    window.nova.history.query({ q, limit: 4 }),
    window.nova.omni.suggest(q),
  ]);
  if (seq !== state.suggestSeq) return;

  for (const h of histHits) {
    if (items.some((i) => i.url === h.url)) continue;
    items.push({ kind: 'verlauf', main: h.title, sub: hostOf(h.url), favUrl: h.url, url: h.url,
      run: (nt) => nt ? createTab(h.url) : (closeOmniDrop(), navigate(activeTab(), h.url)) });
  }
  for (const s of suggestions) {
    if (s.toLowerCase() === ql) continue;
    items.push({ kind: 'suche', main: s, icon: 'i-search', run: (nt) => omniSubmit(s, { newTab: nt }) });
  }

  omniDropItems = items.slice(0, 9);
  omniDropSel = 0;
  renderOmniDrop(q);
}

function renderOmniDrop(q) {
  const drop = $('#omni-drop');
  if (omniDropItems.length === 0) { closeOmniDrop(); return; }
  drop.innerHTML = '';
  omniDropItems.forEach((item, i) => {
    const row = el('div', 'od-row' + (i === omniDropSel ? ' sel' : ''));
    if (item.favUrl) row.appendChild(faviconEl(item.favUrl, 'od-fav'));
    else row.appendChild(icon(item.icon));
    const main = el('span', 'od-main');
    emphasize(main, item.main, q);
    row.appendChild(main);
    if (item.sub) row.appendChild(el('span', 'od-sub', item.sub));
    row.appendChild(el('span', 'od-kind', item.kind));
    row.addEventListener('mousedown', (e) => { e.preventDefault(); item.run(e.altKey); });
    row.addEventListener('mouseenter', () => { omniDropSel = i; renderOmniSelection(); });
    drop.appendChild(row);
  });
  const rect = $('#omnibox').getBoundingClientRect();
  drop.style.left = rect.left + 'px';
  drop.style.width = rect.width + 'px';
  drop.style.top = rect.bottom + 7 + 'px';
  drop.classList.remove('hidden');
}
function renderOmniSelection() {
  [...$('#omni-drop').children].forEach((c, i) => c.classList.toggle('sel', i === omniDropSel));
}
function closeOmniDrop() {
  $('#omni-drop').classList.add('hidden');
  omniDropItems = [];
}

/* ============================================================ bookmarks */
function walkTree(nodes, fn) {
  for (const n of nodes || []) {
    if (fn(n) === false) return false;
    if (n.children && walkTree(n.children, fn) === false) return false;
  }
  return true;
}

/* ---- Lesezeichen Drag & Drop ---- */
let bmDragId = null;
function bmParentAndIndex(id) {
  let res = null;
  const walk = (nodes, pid) => {
    for (let i = 0; i < (nodes || []).length; i++) {
      const n = nodes[i];
      if (n.id === id) { res = { parentId: pid, index: i }; return true; }
      if (n.children && walk(n.children, n.id)) return true;
    }
    return false;
  };
  walk(state.bookmarks, null);
  return res;
}
function clearBmDropMarks() {
  document.querySelectorAll('.bm-row.bm-drop-into, .bm-row.bm-drop-before, .bm-row.bm-drop-after')
    .forEach((r) => r.classList.remove('bm-drop-into', 'bm-drop-before', 'bm-drop-after'));
}
function wireBmDnD(row, node) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    bmDragId = node.id; row.classList.add('bm-dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', node.id); } catch {}
    e.stopPropagation();
  });
  row.addEventListener('dragend', () => { bmDragId = null; row.classList.remove('bm-dragging'); clearBmDropMarks(); });
  row.addEventListener('dragover', (e) => {
    if (!bmDragId || bmDragId === node.id) return;
    e.preventDefault(); e.stopPropagation();
    clearBmDropMarks();
    if (node.type === 'folder') row.classList.add('bm-drop-into');
    else {
      const r = row.getBoundingClientRect();
      row.classList.add(e.clientY < r.top + r.height / 2 ? 'bm-drop-before' : 'bm-drop-after');
    }
  });
  row.addEventListener('dragleave', () => row.classList.remove('bm-drop-into', 'bm-drop-before', 'bm-drop-after'));
  row.addEventListener('drop', async (e) => {
    if (!bmDragId || bmDragId === node.id) return;
    e.preventDefault(); e.stopPropagation();
    const before = row.classList.contains('bm-drop-before');
    const dragId = bmDragId; bmDragId = null;
    clearBmDropMarks();
    if (node.type === 'folder') {
      await window.nova.bookmarks.move({ id: dragId, targetParentId: node.id });
    } else {
      const pi = bmParentAndIndex(node.id);
      if (pi) {
        let idx = pi.index + (before ? 0 : 1);
        const src = bmParentAndIndex(dragId);
        if (src && src.parentId === pi.parentId && src.index < idx) idx -= 1;
        await window.nova.bookmarks.move({ id: dragId, targetParentId: pi.parentId, index: idx });
      }
    }
  });
}

function renderBookmarks() {
  const tree = $('#bookmark-tree');
  tree.innerHTML = '';
  let count = 0;
  walkTree(state.bookmarks, (n) => { if (n.type === 'url') count++; });
  $('#bm-count').textContent = count.toLocaleString('de-DE');

  // Filtermodus: flache Trefferliste statt Baum
  if (currentFilter) {
    const matches = [];
    walkTree(state.bookmarks, (n) => {
      if (n.type === 'url' && matches.length < 80 &&
          ((n.name || '').toLowerCase().includes(currentFilter) || n.url.toLowerCase().includes(currentFilter))) {
        matches.push(n);
      }
    });
    $('#bm-count').textContent = matches.length.toLocaleString('de-DE');
    if (matches.length === 0) {
      tree.appendChild(el('div', 'wl-empty', 'Keine Treffer in den Favoriten'));
      return;
    }
    for (const node of matches) {
      const row = el('div', 'bm-row');
      row.appendChild(faviconEl(node.url, 'bm-fav'));
      row.appendChild(el('span', 'bm-name', node.name));
      row.title = node.url;
      row.addEventListener('click', () => navigate(activeTab(), node.url));
      row.addEventListener('auxclick', (e) => { if (e.button === 1) createTab(node.url, { background: true }); });
      row.addEventListener('contextmenu', (e) => bookmarkCtxMenu(e, node));
      tree.appendChild(row);
    }
    return;
  }

  const build = (nodes, container) => {
    for (const node of nodes) {
      if (node.type === 'folder') {
        const row = el('div', 'bm-row' + (node.open ? ' open' : ''));
        row.appendChild(icon('i-chev', 'ic chev'));
        row.appendChild(icon('i-folder', 'ic bm-folder-ic'));
        row.appendChild(el('span', 'bm-name', node.name));
        row.appendChild(el('span', 'pill-mini', String((node.children || []).length)));
        container.appendChild(row);

        const childBox = el('div', 'bm-children');
        if (!node.open) childBox.style.display = 'none';
        container.appendChild(childBox);
        if (node.open) build(node.children || [], childBox);

        row.addEventListener('click', () => {
          node.open = !node.open;
          row.classList.toggle('open', node.open);
          window.nova.bookmarks.setOpen({ id: node.id, open: node.open });
          if (node.open) {
            childBox.innerHTML = '';
            build(node.children || [], childBox);
            childBox.style.display = '';
          } else {
            childBox.style.display = 'none';
          }
        });
        row.addEventListener('contextmenu', (e) => bookmarkCtxMenu(e, node));
        wireBmDnD(row, node);
      } else {
        const row = el('div', 'bm-row');
        row.appendChild(faviconEl(node.url, 'bm-fav'));
        row.appendChild(el('span', 'bm-name', node.name));
        row.title = node.url;
        row.addEventListener('click', () => navigate(activeTab(), node.url));
        row.addEventListener('auxclick', (e) => { if (e.button === 1) createTab(node.url, { background: true }); });
        row.addEventListener('contextmenu', (e) => bookmarkCtxMenu(e, node));
        wireBmDnD(row, node);
        container.appendChild(row);
      }
    }
  };
  build(state.bookmarks, tree);
}

function bookmarkCtxMenu(e, node) {
  e.preventDefault();
  e.stopPropagation();
  const items = [];
  if (node.type === 'url') {
    items.push(
      { label: 'Öffnen', ic: 'i-globe', run: () => navigate(activeTab(), node.url) },
      { label: 'In neuem Tab öffnen', ic: 'i-ext', run: () => createTab(node.url) },
      { sep: true },
    );
  } else {
    const urls = [];
    walkTree([node], (n) => { if (n.type === 'url') urls.push(n.url); });
    if (urls.length > 0 && urls.length <= 20) {
      items.push(
        { label: `Alle öffnen (${urls.length})`, ic: 'i-ext', run: () => {
            urls.forEach((u, i) => createTab(u, { background: i > 0 }));
          } },
        { sep: true },
      );
    }
  }
  items.push(
    { label: 'Umbenennen', ic: 'i-edit', run: () => renameBookmarkInline(node) },
    { label: 'Löschen', ic: 'i-trash', danger: true, run: async () => {
        await window.nova.bookmarks.remove(node.id);
        toast(node.type === 'folder' ? 'Ordner gelöscht' : 'Favorit gelöscht', 'i-trash');
      } },
  );
  showCtxMenu(e.clientX, e.clientY, items);
}

function renameBookmarkInline(node) {
  const rows = [...$('#bookmark-tree').querySelectorAll('.bm-row')];
  const row = rows.find((r) => r.querySelector('.bm-name')?.textContent === node.name);
  if (!row) return;
  const nameEl = row.querySelector('.bm-name');
  const input = el('input', 'bm-rename-input');
  input.value = node.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  const done = async (commit) => {
    if (commit && input.value.trim()) {
      await window.nova.bookmarks.rename({ id: node.id, name: input.value.trim() });
    } else {
      renderBookmarks();
    }
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') done(true);
    if (ev.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(false));
  input.addEventListener('click', (ev) => ev.stopPropagation());
}

function showCtxMenu(x, y, items) {
  const menu = $('#ctx-menu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it.sep) { menu.appendChild(el('div', 'ctx-sep')); continue; }
    const b = el('button', 'ctx-item' + (it.danger ? ' danger' : ''));
    if (it.emoji) b.appendChild(el('span', 'ctx-emoji', it.emoji));
    else b.appendChild(icon(it.ic));
    b.appendChild(el('span', null, it.label));
    b.addEventListener('click', () => { hideCtxMenu(); it.run(); });
    menu.appendChild(b);
  }
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function hideCtxMenu() { $('#ctx-menu').classList.add('hidden'); }

async function toggleBookmarkCurrent() {
  const tab = activeTab();
  if (!tab || !isWebUrl(tab.url)) return;
  if (typeof bmSave !== 'undefined' && bmSave.isOpen()) { bmSave.close(); return; }
  const found = await window.nova.bookmarks.find(tab.url);
  bmSave.open({ url: tab.url, title: tab.title, existing: found });
}

/* ============================================================ shield popover */
async function toggleShieldPop() {
  const pop = $('#shield-pop');
  if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
  const tab = activeTab();
  const host = tab ? hostOf(tab.url) : '';
  $('#sp-tab-count').textContent = ((tab && tab.wcId != null ? state.blockedPerTab[tab.wcId] : 0) || 0).toLocaleString('de-DE');
  $('#sp-total-count').textContent = state.totalBlocked.toLocaleString('de-DE');
  $('#sp-global').checked = !!state.settings.adblockEnabled;
  $('#sp-host').textContent = host || 'dieser Seite';
  $('#sp-site-row').style.display = host ? '' : 'none';
  $('#sp-site').checked = (state.settings.whitelist || []).includes(host);

  const trackBox = $('#sp-trackers');
  trackBox.innerHTML = '';
  if (tab?.wcId) {
    const detail = await window.nova.adblock.tabDetail(tab.wcId);
    if (detail.length > 0) {
      trackBox.appendChild(el('div', 'sp-tr-head', 'Meistgeblockt auf dieser Seite'));
      for (const { host: h, n } of detail) {
        const row = el('div', 'sp-tracker');
        row.appendChild(el('span', null, h));
        row.appendChild(el('b', null, '×' + n));
        trackBox.appendChild(row);
      }
    }
  }

  const rect = $('#btn-shield').getBoundingClientRect();
  pop.style.top = rect.bottom + 9 + 'px';
  pop.style.left = Math.min(rect.left - 140, innerWidth - 326) + 'px';
  pop.classList.remove('hidden');
}

$('#sp-global').addEventListener('change', async (e) => {
  await window.nova.settings.set({ adblockEnabled: e.target.checked });
  toast(e.target.checked ? 'Adblock aktiviert' : 'Adblock deaktiviert', 'i-shield');
});
$('#sp-site').addEventListener('change', async (e) => {
  const tab = activeTab();
  const host = tab ? hostOf(tab.url) : '';
  if (!host) return;
  const wl = await window.nova.adblock.site({ host, allow: e.target.checked });
  state.settings.whitelist = wl;
  toast(e.target.checked ? `Werbung auf ${host} erlaubt` : `Adblock auf ${host} aktiv`, 'i-shield');
  tab.wv.reload();
});

/* ============================================================ screenshot */
async function takeScreenshot() {
  const tab = activeTab();
  if (!tab?.wcId) return;
  const file = await window.nova.tabs.screenshot(tab.wcId);
  toast(file ? 'Screenshot kopiert & in Bilder/Nova Screenshots gespeichert' : 'Screenshot fehlgeschlagen', file ? 'i-camera' : 'i-warn');
}

/* ============================================================ findbar */
function openFindbar() {
  $('#findbar').classList.remove('hidden');
  $('#find-input').focus();
  $('#find-input').select();
}
function closeFindbar(clear = true) {
  const fb = $('#findbar');
  if (fb.classList.contains('hidden')) return;
  fb.classList.add('hidden');
  $('#find-count').textContent = '';
  const tab = activeTab();
  if (clear && tab?.wcId) { try { tab.wv.stopFindInPage('clearSelection'); } catch {} }
}
$('#find-input').addEventListener('input', (e) => {
  const tab = activeTab();
  if (!tab?.wcId) return;
  const q = e.target.value;
  if (!q) { tab.wv.stopFindInPage('clearSelection'); $('#find-count').textContent = ''; return; }
  tab.wv.findInPage(q, { findNext: false });
});
$('#find-input').addEventListener('keydown', (e) => {
  const tab = activeTab();
  if (e.key === 'Enter' && tab?.wcId && e.target.value) {
    tab.wv.findInPage(e.target.value, { forward: !e.shiftKey, findNext: true });
  }
  if (e.key === 'Escape') closeFindbar();
});
$('#find-next').addEventListener('click', () => {
  const tab = activeTab();
  if (tab?.wcId && $('#find-input').value) tab.wv.findInPage($('#find-input').value, { forward: true, findNext: true });
});
$('#find-prev').addEventListener('click', () => {
  const tab = activeTab();
  if (tab?.wcId && $('#find-input').value) tab.wv.findInPage($('#find-input').value, { forward: false, findNext: true });
});
$('#find-close').addEventListener('click', () => closeFindbar());

/* ============================================================ hub */
function openHub(panel = 'history') {
  $('#hub').classList.remove('hidden');
  for (const btn of document.querySelectorAll('.hub-nav-btn[data-panel]')) {
    btn.classList.toggle('active', btn.dataset.panel === panel);
  }
  for (const p of document.querySelectorAll('.hub-panel')) p.classList.remove('active');
  $('#panel-' + panel).classList.add('active');
  if (panel === 'history') renderHistory();
  if (panel === 'downloads') renderDownloads();
  if (panel === 'settings') renderSettings();
  if (panel === 'plugins') renderPlugins();
}
function closeHub() { $('#hub').classList.add('hidden'); }
$('#hub-close').addEventListener('click', closeHub);
$('#hub').addEventListener('mousedown', (e) => { if (e.target === $('#hub')) closeHub(); });
for (const btn of document.querySelectorAll('.hub-nav-btn[data-panel]')) {
  btn.addEventListener('click', () => openHub(btn.dataset.panel));
}

/* ---- history panel */
async function renderHistory(q = '') {
  const items = await window.nova.history.query({ q, limit: 400 });
  const list = $('#history-list');
  list.innerHTML = '';
  if (items.length === 0) {
    const es = el('div', 'empty-state');
    es.appendChild(icon('i-clock'));
    es.appendChild(el('span', null, q ? 'Keine Treffer' : 'Noch kein Verlauf'));
    list.appendChild(es);
    return;
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = today.getTime() - 86400000;
  let lastDay = '';
  for (const it of items) {
    const d = new Date(it.ts);
    const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
    let label;
    if (dayStart.getTime() === today.getTime()) label = 'Heute';
    else if (dayStart.getTime() === yesterday) label = 'Gestern';
    else label = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
    if (label !== lastDay) {
      list.appendChild(el('div', 'h-day', label));
      lastDay = label;
    }
    const row = el('div', 'h-row');
    row.appendChild(el('span', 'h-time', d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })));
    row.appendChild(faviconEl(it.url, 'h-fav'));
    row.appendChild(el('span', 'h-title', it.title || it.url));
    row.appendChild(el('span', 'h-host', hostOf(it.url)));
    const del = el('button', 'icon-btn slim h-del');
    del.appendChild(icon('i-x'));
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await window.nova.history.delete(it.url);
      renderHistory($('#history-search').value);
    });
    row.appendChild(del);
    row.addEventListener('click', () => { createTab(it.url); closeHub(); });
    list.appendChild(row);
  }
}
let histSearchTimer;
$('#history-search').addEventListener('input', (e) => {
  clearTimeout(histSearchTimer);
  histSearchTimer = setTimeout(() => renderHistory(e.target.value), 200);
});
$('#history-clear').addEventListener('click', async () => {
  await window.nova.history.clear();
  renderHistory();
  toast('Verlauf gelöscht', 'i-trash');
});

/* ---- downloads panel */
const dlState = new Map();
const dlPrev = new Map();
function renderDownloads() {
  window.nova.downloads.list().then((items) => {
    dlState.clear();
    for (const it of items) dlState.set(it.id, it);
    paintDownloads();
  });
}
function paintDownloads() {
  const list = $('#downloads-list');
  list.innerHTML = '';
  const items = [...dlState.values()].sort((a, b) => b.ts - a.ts);
  if (items.length === 0) {
    const es = el('div', 'empty-state');
    es.appendChild(icon('i-download'));
    es.appendChild(el('span', null, 'Keine Downloads in dieser Sitzung'));
    list.appendChild(es);
    return;
  }
  const stateLabel = { progressing: 'Lädt …', completed: 'Fertig', cancelled: 'Abgebrochen', interrupted: 'Unterbrochen' };
  for (const it of items) {
    const row = el('div', 'dl-row');
    const ic = el('div', 'dl-ic');
    ic.appendChild(icon('i-file'));
    const info = el('div', 'dl-info');
    info.appendChild(el('div', 'dl-name', it.file));
    const pct = it.total > 0 ? Math.round((it.received / it.total) * 100) : 0;
    const speed = it._speed > 1024 ? ` · ${fmtBytes(it._speed)}/s` : '';
    const meta = el('div', 'dl-meta',
      it.state === 'progressing'
        ? `${fmtBytes(it.received)} / ${fmtBytes(it.total)} — ${pct}%${speed}${it.paused ? ' (pausiert)' : ''}`
        : `${stateLabel[it.state] || it.state} — ${fmtBytes(it.received)}`);
    info.appendChild(meta);
    if (it.state === 'progressing') {
      const bar = el('div', 'dl-bar');
      const fill = el('i');
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      info.appendChild(bar);
    }
    const actions = el('div', 'dl-actions');
    const act = (icName, title, action) => {
      const b = el('button', 'icon-btn');
      b.appendChild(icon(icName));
      b.title = title;
      b.addEventListener('click', () => window.nova.downloads.action({ id: it.id, action }).then(() => {
        if (action === 'cancel') { it.state = 'cancelled'; paintDownloads(); }
      }));
      return b;
    };
    if (it.state === 'progressing') {
      actions.appendChild(it.paused ? act('i-play', 'Fortsetzen', 'resume') : act('i-pause', 'Pausieren', 'pause'));
      actions.appendChild(act('i-x', 'Abbrechen', 'cancel'));
    } else if (it.state === 'completed') {
      actions.appendChild(act('i-ext', 'Datei öffnen', 'open'));
      actions.appendChild(act('i-folder', 'Im Ordner anzeigen', 'show'));
    }
    row.append(ic, info, actions);
    list.appendChild(row);
  }
}
function syncDlBadge() {
  const active = [...dlState.values()].filter((d) => d.state === 'progressing').length;
  for (const id of ['#dl-badge', '#dl-badge-top']) {
    const badge = $(id);
    if (!badge) continue;
    badge.textContent = active;
    badge.classList.toggle('zero', active === 0);
    badge.classList.toggle('pulse', active > 0);
  }
}
window.nova.downloads.onUpdate((meta) => {
  const prev = dlPrev.get(meta.id);
  const now = Date.now();
  if (prev && meta.state === 'progressing' && now > prev.t && meta.received >= prev.r) {
    const inst = ((meta.received - prev.r) / (now - prev.t)) * 1000;
    meta._speed = prev.s ? prev.s * 0.6 + inst * 0.4 : inst; // geglättet
  } else if (prev) { meta._speed = prev.s || 0; }
  dlPrev.set(meta.id, { r: meta.received, t: now, s: meta._speed || 0 });
  dlState.set(meta.id, meta);
  syncDlBadge();
  if (!$('#hub').classList.contains('hidden') && $('#panel-downloads').classList.contains('active')) paintDownloads();
  if (typeof dlPop !== 'undefined' && dlPop.isOpen()) dlPop.paint();
  if (meta.state === 'completed') toast(`Download fertig: ${meta.file}`, 'i-download');
});

/* ---- settings panel */
/* ============================================================ Plugin-Store */
// Eingebaute NOVA-Plugins (Verhalten lebt in webview-preload.js). 'adblock' ist ein
// Sonderfall, der die bestehende Netzwerk-Engine über adblockEnabled schaltet.
const PLUGIN_CATALOG = [
  { id: 'adblock', special: 'adblock', ic: 'i-shield', cat: 'Datenschutz', name: 'Werbe- & Tracker-Blocker', desc: 'Blockiert Werbung, Tracker und Cookie-Banner netzwerkweit mit der AdGuard-Filterengine.' },
  { id: 'cookiekill', ic: 'i-trash-sm', cat: 'Datenschutz', name: 'Cookie-Banner wegklicken', desc: 'Bestätigt oder entfernt nervige Cookie-/Consent-Banner automatisch.' },
  { id: 'darkmode', ic: 'i-moon', cat: 'Aussehen', name: 'Dunkelmodus erzwingen', desc: 'Invertiert helle Webseiten zu einem augenschonenden Dunkeldesign (für Seiten ohne eigenen Dark Mode).' },
  { id: 'unblock', ic: 'i-eye', cat: 'Produktivität', name: 'Rechtsklick & Kopieren erzwingen', desc: 'Hebt Sperren für Rechtsklick, Markieren und Kopieren auf Webseiten auf.' },
  { id: 'videospeed', ic: 'i-gauge', cat: 'Medien', name: 'Video-Geschwindigkeit', desc: 'Steuere jedes HTML5-Video per Tastatur: S langsamer, D schneller, R zurück, X/Z springen.' },
  { id: 'scrolltop', ic: 'i-up-down', cat: 'Produktivität', name: 'Nach-oben-Button', desc: 'Blendet einen schwebenden Button ein, um schnell zum Seitenanfang zu springen.' },
  { id: 'autohttps', ic: 'i-shield', cat: 'Datenschutz', name: 'HTTPS erzwingen', desc: 'Leitet unsichere http-Seiten automatisch auf die verschlüsselte https-Variante um.' },
  { id: 'cinematicSpace', ic: 'i-rocket', cat: 'Startseite', name: 'Cinematic Space Flight', desc: 'Ersetzt die Startseiten-Animation durch einen 4K-Flug durchs All: futuristisches Raumschiff, Planeten, Asteroiden & Lichteffekte. Aus → Standard-Universum kommt zurück.' },
];

const plugState = { native: {}, userscripts: [], extensions: [], tab: 'discover' };

async function renderPlugins() {
  try {
    const st = await window.nova.plugins.state();
    plugState.native = st.native || {};
    plugState.userscripts = st.userscripts || [];
    plugState.extensions = st.extensions || [];
  } catch {}
  // adblock-Status aus den Einstellungen spiegeln
  plugState.native.adblock = !!state.settings.adblockEnabled;
  // Sub-Tabs verdrahten (einmalig)
  if (!renderPlugins._wired) {
    renderPlugins._wired = true;
    for (const t of document.querySelectorAll('#plug-tabs .plug-tab')) {
      t.addEventListener('click', () => {
        plugState.tab = t.dataset.ptab;
        for (const x of document.querySelectorAll('#plug-tabs .plug-tab')) x.classList.toggle('active', x === t);
        paintPlugins();
      });
    }
  }
  for (const x of document.querySelectorAll('#plug-tabs .plug-tab')) x.classList.toggle('active', x.dataset.ptab === plugState.tab);
  paintPlugins();
}

function paintPlugins() {
  const body = $('#plugins-body');
  body.innerHTML = '';
  if (plugState.tab === 'discover') paintPluginDiscover(body);
  else if (plugState.tab === 'scripts') paintUserscripts(body);
  else paintExtensions(body);
}

function paintPluginDiscover(body) {
  const intro = el('p', 'plug-intro', 'Eingebaute NOVA-Plugins — sofort einsatzbereit, kein Download nötig. Änderungen greifen beim nächsten Laden einer Seite.');
  body.appendChild(intro);
  const cats = [...new Set(PLUGIN_CATALOG.map((p) => p.cat))];
  for (const cat of cats) {
    body.appendChild(el('div', 'plug-cat', cat));
    const grid = el('div', 'plug-grid');
    for (const p of PLUGIN_CATALOG.filter((x) => x.cat === cat)) {
      const on = !!plugState.native[p.id];
      const card = el('div', 'plug-card' + (on ? ' on' : ''));
      const head = el('div', 'plug-card-head');
      const ico = el('div', 'plug-ico'); ico.appendChild(icon(p.ic)); head.appendChild(ico);
      const sw = el('label', 'switch');
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = on;
      inp.addEventListener('change', async () => {
        card.classList.toggle('on', inp.checked);
        if (p.special === 'adblock') {
          state.settings.adblockEnabled = inp.checked;
          await window.nova.settings.set({ adblockEnabled: inp.checked });
        } else {
          plugState.native = await window.nova.plugins.setNative({ id: p.id, on: inp.checked });
          pushPluginsToNewtabs(plugState.native);
        }
      });
      sw.appendChild(inp); sw.appendChild(el('i')); head.appendChild(sw);
      card.appendChild(head);
      card.appendChild(el('div', 'plug-name', p.name));
      card.appendChild(el('div', 'plug-desc', p.desc));
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }
}

function paintUserscripts(body) {
  const bar = el('div', 'plug-bar');
  bar.appendChild(el('p', 'plug-intro', 'Eigene JavaScript-Skripte, die auf passenden Seiten laufen — wie Tampermonkey/Greasemonkey.'));
  const add = el('button', 'btn primary'); add.appendChild(icon('i-plus')); add.appendChild(el('span', null, 'Neues Skript'));
  add.addEventListener('click', () => openUserscriptEditor());
  bar.appendChild(add);
  body.appendChild(bar);

  if (!plugState.userscripts.length) {
    const es = el('div', 'empty-state'); es.appendChild(icon('i-code'));
    es.appendChild(el('span', null, 'Noch keine Userscripts. Lege eins an, um z. B. Layouts anzupassen oder Funktionen hinzuzufügen.'));
    body.appendChild(es); return;
  }
  for (const us of plugState.userscripts) {
    const row = el('div', 'us-row');
    const sw = el('label', 'switch');
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = us.enabled !== false;
    inp.addEventListener('change', async () => { plugState.userscripts = await window.nova.plugins.toggleUserscript({ id: us.id, on: inp.checked }); });
    sw.appendChild(inp); sw.appendChild(el('i'));
    const info = el('div', 'us-info');
    info.appendChild(el('b', null, us.name || 'Skript'));
    info.appendChild(el('span', null, us.matches || '*'));
    const edit = el('button', 'icon-btn slim'); edit.title = 'Bearbeiten'; edit.appendChild(icon('i-sliders'));
    edit.addEventListener('click', () => openUserscriptEditor(us));
    const del = el('button', 'icon-btn slim'); del.title = 'Löschen'; del.appendChild(icon('i-trash-sm'));
    del.addEventListener('click', async () => { plugState.userscripts = await window.nova.plugins.removeUserscript(us.id); paintPlugins(); });
    row.append(sw, info, edit, del);
    body.appendChild(row);
  }
}

function openUserscriptEditor(us) {
  const ov = el('div', 'us-editor-ov');
  const box = el('div', 'us-editor');
  box.appendChild(el('h3', null, us ? 'Skript bearbeiten' : 'Neues Userscript'));
  const nameI = el('input', 'set-input'); nameI.placeholder = 'Name (z. B. „GitHub Wide")'; nameI.value = us?.name || '';
  const matchI = el('input', 'set-input'); matchI.placeholder = 'Seiten-Muster, z. B. https://github.com/*  (mehrere mit Komma; * = alle)'; matchI.value = us?.matches || '*';
  const codeT = el('textarea', 'us-code'); codeT.placeholder = '// JavaScript, läuft auf passenden Seiten\ndocument.body.style.background = "#101018";'; codeT.value = us?.code || '';
  box.append(labelWrap('Name', nameI), labelWrap('Läuft auf', matchI), labelWrap('Code', codeT));
  const foot = el('div', 'us-editor-foot');
  const cancel = el('button', 'btn', 'Abbrechen'); cancel.addEventListener('click', () => ov.remove());
  const save = el('button', 'btn primary', 'Speichern');
  save.addEventListener('click', async () => {
    plugState.userscripts = await window.nova.plugins.saveUserscript({
      id: us?.id, name: nameI.value.trim() || 'Skript', matches: matchI.value.trim() || '*', code: codeT.value, enabled: us ? us.enabled !== false : true,
    });
    ov.remove(); paintPlugins();
  });
  foot.append(cancel, save);
  box.appendChild(foot);
  ov.appendChild(box);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
  setTimeout(() => nameI.focus(), 30);
}
function labelWrap(label, inputEl) {
  const w = el('div', 'us-field');
  w.appendChild(el('label', null, label));
  w.appendChild(inputEl);
  return w;
}

function paintExtensions(body) {
  body.appendChild(el('p', 'plug-intro', 'Echte Chrome-Erweiterungen — such direkt im offiziellen Chrome Web Store und installiere mit einem Klick. Hinweis: nicht jede Erweiterung ist in NOVA voll funktionsfähig (manche brauchen Funktionen, die nur der echte Chrome bietet).'));

  // 1) Im Chrome Web Store suchen → echte Store-Seite öffnen, dort 1-Klick-Installation
  const search = el('div', 'ext-store');
  const sinp = el('input', 'set-input');
  sinp.placeholder = 'Erweiterung im Chrome Web Store suchen (z. B. „NordPass", „Bitwarden") …';
  const sgo = el('button', 'btn primary'); sgo.appendChild(icon('i-search')); sgo.appendChild(el('span', null, 'Suchen'));
  const doSearch = () => {
    const q = sinp.value.trim();
    const url = q ? 'https://chromewebstore.google.com/search/' + encodeURIComponent(q) : 'https://chromewebstore.google.com/';
    createTab(url);
    closeHub();
  };
  sgo.addEventListener('click', doSearch);
  sinp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  search.append(sinp, sgo);
  body.appendChild(search);

  const hint = el('div', 'ext-hint');
  hint.appendChild(icon('i-info'));
  hint.appendChild(el('span', null, 'Der Store öffnet sich als Tab. Auf der Seite einer Erweiterung erscheint unten rechts der Button „➕ In NOVA installieren". Danach taucht sie hier und (mit Icon) in der Topbar auf.'));
  body.appendChild(hint);

  // 2) Fortgeschritten: Link/ID einfügen oder Ordner laden
  const adv = el('details', 'ext-adv');
  adv.appendChild(el('summary', null, 'Erweitert: per Link/ID oder entpacktem Ordner'));
  const store = el('div', 'ext-store');
  const inp = el('input', 'set-input');
  inp.placeholder = 'Store-Link oder Erweiterungs-ID einfügen …';
  const go = el('button', 'btn'); go.appendChild(icon('i-download')); go.appendChild(el('span', null, 'Installieren'));
  const doInstall = async () => {
    const val = inp.value.trim();
    if (!val) { inp.focus(); return; }
    go.disabled = true; const lbl = go.querySelector('span'); const old = lbl.textContent; lbl.textContent = 'Lädt …';
    const r = await window.nova.plugins.installFromStore(val);
    go.disabled = false; lbl.textContent = old;
    if (r && r.ok) { inp.value = ''; toast(`„${r.ext.name}" installiert — Seiten neu laden, damit sie greift.`); renderPlugins(); }
    else toast('Installation fehlgeschlagen: ' + ((r && r.error) || 'unbekannt'), 'i-x');
  };
  go.addEventListener('click', doInstall);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doInstall(); });
  store.append(inp, go);
  adv.appendChild(store);
  const folderBar = el('div', 'plug-bar');
  folderBar.appendChild(el('span', 'ext-or', 'oder eine entpackte Erweiterung vom Ordner:'));
  const add = el('button', 'btn'); add.appendChild(icon('i-puzzle-add')); add.appendChild(el('span', null, 'Ordner laden'));
  add.addEventListener('click', async () => {
    const r = await window.nova.plugins.loadExtension();
    if (r && r.ok) { toast(`Erweiterung „${r.ext.name}" geladen — Seiten neu laden, damit sie greift.`); renderPlugins(); }
    else if (r && !r.canceled) toast('Konnte Erweiterung nicht laden: ' + (r.error || 'unbekannt'), 'i-x');
  });
  folderBar.appendChild(add);
  adv.appendChild(folderBar);
  body.appendChild(adv);

  if (!plugState.extensions.length) {
    const es = el('div', 'empty-state'); es.appendChild(icon('i-plugin'));
    es.appendChild(el('span', null, 'Keine Erweiterungen geladen. Tipp: entpacke eine Erweiterung (z. B. aus dem Chrome Web Store via .crx) und wähle ihren Ordner.'));
    body.appendChild(es); return;
  }
  for (const ex of plugState.extensions) {
    const row = el('div', 'us-row');
    const sw = el('label', 'switch');
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = ex.enabled !== false;
    inp.addEventListener('change', async () => { plugState.extensions = await window.nova.plugins.toggleExtension({ id: ex.id, on: inp.checked }); paintPlugins(); });
    sw.appendChild(inp); sw.appendChild(el('i'));
    const info = el('div', 'us-info');
    info.appendChild(el('b', null, ex.name || 'Erweiterung'));
    info.appendChild(el('span', null, ex.error ? '⚠ ' + ex.error : (ex.version ? 'v' + ex.version + ' · ' : '') + ex.path));
    const del = el('button', 'icon-btn slim'); del.title = 'Entfernen'; del.appendChild(icon('i-trash-sm'));
    del.addEventListener('click', async () => { plugState.extensions = await window.nova.plugins.removeExtension(ex.id); paintPlugins(); });
    row.append(sw, info, del);
    body.appendChild(row);
  }
}

function renderSettings() {
  const s = state.settings;
  const body = $('#settings-body');
  body.innerHTML = '';

  const group = (title) => {
    const g = el('div', 'set-group');
    g.appendChild(el('h3', null, title));
    body.appendChild(g);
    return g;
  };
  const switchRow = (label, desc, key, onChange) => {
    const row = el('div', 'set-row');
    const lab = el('div', 'set-label');
    lab.appendChild(el('b', null, label));
    if (desc) lab.appendChild(el('span', null, desc));
    const sw = el('label', 'switch');
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = !!s[key];
    inp.addEventListener('change', async () => {
      await window.nova.settings.set({ [key]: inp.checked });
      if (onChange) onChange(inp.checked);
    });
    sw.appendChild(inp);
    sw.appendChild(el('i'));
    row.append(lab, sw);
    return row;
  };
  const inputRow = (label, desc, key, placeholder) => {
    const row = el('div', 'set-row');
    const lab = el('div', 'set-label');
    lab.appendChild(el('b', null, label));
    if (desc) lab.appendChild(el('span', null, desc));
    const inp = el('input', 'set-input');
    inp.type = 'text';
    inp.value = s[key] || '';
    inp.placeholder = placeholder || '';
    const commit = () => window.nova.settings.set({ [key]: inp.value.trim() });
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); inp.blur(); } });
    row.append(lab, inp);
    return row;
  };
  const buttonRow = (label, desc, btnText, fn, primary = false) => {
    const row = el('div', 'set-row');
    const lab = el('div', 'set-label');
    lab.appendChild(el('b', null, label));
    if (desc) lab.appendChild(el('span', null, desc));
    const btn = el('button', 'btn' + (primary ? ' primary' : ''), btnText);
    btn.addEventListener('click', () => fn(btn));
    row.append(lab, btn);
    return row;
  };
  const rangeRow = (label, desc, key, min, max, step, fmt) => {
    const row = el('div', 'set-row');
    const lab = el('div', 'set-label');
    lab.appendChild(el('b', null, label));
    if (desc) lab.appendChild(el('span', null, desc));
    const wrap = el('div', 'range-wrap');
    const out = el('span', 'range-val', fmt(s[key] ?? min));
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.className = 'set-range';
    inp.min = min; inp.max = max; inp.step = step;
    inp.value = s[key] ?? min;
    inp.addEventListener('input', () => { out.textContent = fmt(+inp.value); });
    inp.addEventListener('change', () => {
      state.settings[key] = +inp.value;
      window.nova.settings.set({ [key]: +inp.value });
    });
    wrap.append(inp, out);
    row.append(lab, wrap);
    return row;
  };

  // Allgemein
  const gGen = group('Allgemein');
  const genCard = el('div', 'set-card');
  genCard.appendChild(inputRow('Dein Name', 'Für die Begrüßung auf der Startseite', 'userName', 'Name'));
  gGen.appendChild(genCard);

  // KI-Agent
  const gAgent = group('KI-Agent');
  const agentCard = el('div', 'set-card');
  const stepRow = el('div', 'set-row');
  const stepLab = el('div', 'set-label');
  stepLab.appendChild(el('b', null, 'Maximale Schritte pro Auftrag'));
  stepLab.appendChild(el('span', null, 'Höchstzahl an Aktionen, bevor der Agent stoppt. „Unbegrenzt" läuft bis zum Ziel — jederzeit über den Stopp-Button in der Agenten-Ansicht abbrechbar.'));
  const stepChips = el('div', 'step-chips');
  const curSteps = (s.agentMaxSteps === 0 || s.agentMaxSteps === '0') ? '0' : String(s.agentMaxSteps || 12);
  for (const [val, label] of [['8', '8'], ['12', '12'], ['20', '20'], ['30', '30'], ['0', 'Unbegrenzt']]) {
    const chip = el('button', 'step-chip' + (curSteps === val ? ' sel' : ''), label);
    chip.addEventListener('click', async () => {
      const v = val === '0' ? 0 : +val;
      state.settings.agentMaxSteps = v;
      await window.nova.settings.set({ agentMaxSteps: v });
      renderSettings();
    });
    stepChips.appendChild(chip);
  }
  stepRow.append(stepLab, stepChips);
  agentCard.appendChild(stepRow);
  gAgent.appendChild(agentCard);

  // Sicherheit & Web-Datenbank
  const gSec = group('Sicherheit');
  const secCard = el('div', 'set-card');
  secCard.appendChild(inputRow('GitHub-Token (optional)', 'Nur damit trägt dieses Gerät neue Security-Scans zur geteilten Web-Datenbank bei (repo-Scope). Leer lassen = nur lesen. Liegt lokal.', 'securityToken', 'ghp_…'));
  secCard.appendChild(buttonRow('Web-Datenbank', 'Geteilte Security-Reports von anderen Geräten jetzt synchronisieren.', 'Jetzt synchronisieren', async (btn) => {
    btn.disabled = true; const r = await window.nova.security.pull(); btn.disabled = false;
    toast(r && r.ok ? ('Datenbank synchronisiert (' + (r.merged || 0) + ' neu)') : 'Sync fehlgeschlagen', r && r.ok ? 'i-check' : 'i-warn');
  }));
  gSec.appendChild(secCard);

  // Suchmaschine
  const gEngine = group('Suchmaschine');
  const engines = [
    ['google', 'Google', 'G'], ['ddg', 'DuckDuckGo', 'D'], ['bing', 'Bing', 'B'], ['brave', 'Brave', 'Br'],
  ];
  const grid = el('div', 'engine-grid');
  for (const [key, name, letter] of engines) {
    const card = el('div', 'engine-card' + (s.searchEngine === key ? ' sel' : ''));
    card.appendChild(el('div', 'engine-letter', letter));
    card.appendChild(el('span', null, name));
    card.addEventListener('click', async () => {
      await window.nova.settings.set({ searchEngine: key });
      renderSettings();
    });
    grid.appendChild(card);
  }
  gEngine.appendChild(grid);

  // Design
  const gDesign = group('Design');
  const aRow = el('div', 'accent-row');
  for (const [key, [c1, c2]] of Object.entries(ACCENT_COLORS)) {
    const dot = el('div', 'accent-dot' + (s.accent === key ? ' sel' : ''));
    dot.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
    dot.title = key;
    dot.addEventListener('click', async () => {
      await window.nova.settings.set({ accent: key });
      renderSettings();
    });
    aRow.appendChild(dot);
  }
  const customDot = el('div', 'accent-dot custom' + (s.accent === 'custom' ? ' sel' : ''));
  customDot.title = 'Eigene Farben';
  customDot.addEventListener('click', async () => {
    await window.nova.settings.set({ accent: 'custom' });
    renderSettings();
  });
  aRow.appendChild(customDot);
  gDesign.appendChild(aRow);

  if (s.accent === 'custom') {
    const pick = el('div', 'color-pick');
    pick.style.padding = '13px 2px 0';
    const ca = s.customAccent || { a: '#00e5ff', b: '#7c4dff' };
    const mk = (key, val, label) => {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = val;
      inp.title = label;
      inp.addEventListener('change', async () => {
        const next = { ...(state.settings.customAccent || {}), [key]: inp.value };
        await window.nova.settings.set({ customAccent: next });
      });
      return inp;
    };
    pick.append(mk('a', ca.a, 'Primärfarbe'), mk('b', ca.b, 'Sekundärfarbe'), el('span', 'wl-empty', 'Eigener Farbverlauf'));
    gDesign.appendChild(pick);
  }
  const designCard = el('div', 'set-card');
  designCard.style.marginTop = '13px';
  designCard.appendChild(switchRow('Dark Mode für Webseiten', 'Webseiten erhalten das Signal, ihr dunkles Design zu verwenden', 'forceDarkWeb'));
  // Nebula-Qualität (Startseiten-Hintergrund): CSS / GPU leicht / GPU stark
  const nebRow = el('div', 'set-row');
  const nebLab = el('div', 'set-label');
  nebLab.appendChild(el('b', null, 'Nebula-Grafik (Startseite)'));
  nebLab.appendChild(el('span', null, 'Niedrig = schlicht (CSS, sparsam) · Mittel = echte 3D-Nebula (GPU, effizient) · Hoch = volle 3D-Nebula mit Planeten & HDR. Hintergrund-Tabs pausieren automatisch.'));
  const nebChips = el('div', 'step-chips');
  const curNeb = s.nebulaQuality || 'mid';
  for (const [val, label] of [['low', 'Niedrig'], ['mid', 'Mittel'], ['high', 'Hoch']]) {
    const chip = el('button', 'step-chip' + (curNeb === val ? ' sel' : ''), label);
    chip.addEventListener('click', async () => {
      state.settings.nebulaQuality = val;
      await window.nova.settings.set({ nebulaQuality: val });
      pushNebulaToNewtabs(val);
      try { chromeNebula.apply(val); } catch {}
      renderSettings();
      toast('Nebula-Grafik: ' + label, 'i-bolt');
    });
    nebChips.appendChild(chip);
  }
  nebRow.append(nebLab, nebChips);
  designCard.appendChild(nebRow);
  gDesign.appendChild(designCard);

  // Tab-Leiste (seitlich / oben)
  const gTabs = group('Tab-Leiste');
  const tabsGrid = el('div', 'tabbar-grid');
  const TAB_MODES = [
    ['side', 'Seitlich', 'i-side', 'Vertikale Tabs in der Seitenleiste'],
    ['top', 'Oben', 'i-maxi', 'Horizontale Tab-Leiste mit Nebula-Animation'],
  ];
  const curMode = s.tabBarPosition || 'side';
  for (const [val, label, ic, desc] of TAB_MODES) {
    const card = el('div', 'tabbar-card' + (curMode === val ? ' sel' : ''));
    const head = el('div', 'tabbar-card-head');
    head.appendChild(icon(ic));
    head.appendChild(el('b', null, label));
    card.appendChild(head);
    card.appendChild(el('span', null, desc));
    card.addEventListener('click', async () => {
      await window.nova.settings.set({ tabBarPosition: val });
      state.settings.tabBarPosition = val;
      applyTabBarMode();
      renderSettings();
    });
    tabsGrid.appendChild(card);
  }
  gTabs.appendChild(tabsGrid);

  // Startseite
  const gStart = group('Startseite');
  const startCard = el('div', 'set-card');
  startCard.appendChild(switchRow('Wetter anzeigen', 'Aktuelle Temperatur auf der Startseite (open-meteo)', 'weatherEnabled'));
  startCard.appendChild(inputRow('Wetter-Stadt', 'Leer lassen für automatische Standorterkennung', 'weatherCity', 'Automatisch (IP-basiert)'));
  gStart.appendChild(startCard);

  // Animationen & Effekte
  const gFx = group('Animationen & Effekte');
  const fxCard = el('div', 'set-card');
  fxCard.appendChild(switchRow('Hyperspace-Sprung', 'Kurze Universum-Animation beim Öffnen einer Seite', 'warpEnabled'));
  fxCard.appendChild(rangeRow('Dauer der Animation', 'Wie lange der Hyperraum-Sprung dauert', 'warpDuration', 500, 3000, 100, (v) => (v / 1000).toFixed(1) + ' s'));
  gFx.appendChild(fxCard);

  // Adblock
  const gAb = group('NOVA Shield — AdGuard Adblock & Tracking-Schutz');
  const abCard = el('div', 'set-card');
  abCard.appendChild(switchRow('Adblock aktiviert', 'Blockiert Werbung, Tracker & Cookie-Banner mit der AdGuard-Filterengine', 'adblockEnabled'));
  abCard.appendChild(switchRow('Element-Ausblendung (Cosmetic)', 'Versteckt Werbeflächen & Banner direkt auf der Seite', 'cosmeticEnabled'));
  abCard.appendChild(buttonRow('Filterlisten aktualisieren',
    'Lädt alle aktivierten AdGuard- & Zusatzlisten neu — Auto-Update alle 3 Tage',
    'Aktualisieren', async (btn) => {
      btn.textContent = 'Lädt …';
      btn.disabled = true;
      const ok = await window.nova.adblock.refresh();
      btn.textContent = 'Aktualisieren';
      btn.disabled = false;
      toast(ok ? 'Filterlisten aktualisiert' : 'Aktualisierung fehlgeschlagen', ok ? 'i-shield' : 'i-warn');
    }));
  gAb.appendChild(abCard);

  // Filterlisten-Katalog (einzeln zuschaltbar)
  const listsTitle = el('div', 'set-label');
  listsTitle.style.padding = '14px 2px 6px';
  listsTitle.appendChild(el('b', null, 'Filterlisten'));
  listsTitle.appendChild(el('span', null, 'Lege fest, welche AdGuard-Listen aktiv sind'));
  gAb.appendChild(listsTitle);
  const listsCard = el('div', 'set-card');
  listsCard.appendChild(el('div', 'wl-empty', 'Lädt Katalog …'));
  gAb.appendChild(listsCard);
  window.nova.adblock.catalog().then((catalog) => {
    listsCard.innerHTML = '';
    let pending = null;
    const saveLists = (key, on) => {
      const next = { ...(state.settings.filterLists || {}) };
      next[key] = on;
      state.settings.filterLists = next;
      clearTimeout(pending);
      pending = setTimeout(async () => {
        await window.nova.settings.set({ filterLists: next });
        toast('Filterlisten werden neu aufgebaut …', 'i-shield');
      }, 600);
    };
    for (const item of catalog) {
      const row = el('div', 'set-row');
      const lab = el('div', 'set-label');
      lab.appendChild(el('b', null, item.name));
      const sw = el('label', 'switch');
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = item.enabled;
      inp.addEventListener('change', () => saveLists(item.key, inp.checked));
      sw.append(inp, el('i'));
      row.append(lab, sw);
      listsCard.appendChild(row);
    }
  });

  // Eigene Filterregeln
  const customTitle = el('div', 'set-label');
  customTitle.style.padding = '14px 2px 6px';
  customTitle.appendChild(el('b', null, 'Eigene Filterregeln'));
  customTitle.appendChild(el('span', null, 'Eine Regel pro Zeile — z. B. ||beispiel.de^ oder example.com##.werbung'));
  gAb.appendChild(customTitle);
  const ta = el('textarea', 'set-textarea');
  ta.placeholder = '||tracker.example.com^\nexample.com##.ad-banner\n@@||erlaubt.de^';
  ta.value = s.customFilters || '';
  ta.spellcheck = false;
  let customTimer;
  ta.addEventListener('input', () => {
    clearTimeout(customTimer);
    customTimer = setTimeout(() => {
      state.settings.customFilters = ta.value;
      window.nova.settings.set({ customFilters: ta.value });
    }, 700);
  });
  gAb.appendChild(ta);

  const wlTitle = el('div', 'set-label');
  wlTitle.style.padding = '14px 2px 6px';
  wlTitle.appendChild(el('b', null, 'Ausnahmen (Werbung erlaubt auf)'));
  gAb.appendChild(wlTitle);
  const wl = s.whitelist || [];
  if (wl.length === 0) {
    gAb.appendChild(el('div', 'wl-empty', 'Keine Ausnahmen — Shield läuft überall.'));
  } else {
    const chips = el('div', 'wl-chips');
    for (const host of wl) {
      const chip = el('span', 'wl-chip');
      chip.appendChild(el('span', null, host));
      const x = el('button');
      x.appendChild(icon('i-x'));
      x.addEventListener('click', async () => {
        state.settings.whitelist = await window.nova.adblock.site({ host, allow: false });
        renderSettings();
      });
      chip.appendChild(x);
      chips.appendChild(chip);
    }
    gAb.appendChild(chips);
  }

  // Verhalten
  const gBe = group('Verhalten');
  const beCard = el('div', 'set-card');
  beCard.appendChild(switchRow('Sitzung wiederherstellen', 'Beim Start die Tabs & Spaces der letzten Sitzung öffnen', 'restoreSession'));
  beCard.appendChild(switchRow('Tabs automatisch pausieren', 'Inaktive Hintergrund-Tabs nach einiger Zeit entladen — spart deutlich Arbeitsspeicher (Tab lädt beim Anklicken neu)', 'tabSuspend'));
  beCard.appendChild(rangeRow('Pausieren nach', 'Inaktivität bis ein Tab pausiert wird', 'tabSuspendMin', 2, 60, 1, (v) => v + ' min'));
  gBe.appendChild(beCard);

  // Favoriten
  const gBm = group('Favoriten');
  const bmCard = el('div', 'set-card');
  bmCard.appendChild(buttonRow('Edge-Favoriten importieren', 'Ersetzt die aktuellen Favoriten durch deine Microsoft-Edge-Favoriten', 'Importieren', async (btn) => {
    btn.textContent = '…';
    const res = await window.nova.bookmarks.importEdge();
    btn.textContent = 'Importieren';
    toast(res.ok ? `${res.count} Favoriten importiert` : 'Keine Edge-Favoriten gefunden', res.ok ? 'i-check' : 'i-warn');
  }));
  bmCard.appendChild(buttonRow('Favoriten sichern', 'Exportiert alle Favoriten als JSON-Datei', 'Exportieren', async () => {
    const ok = await window.nova.bookmarks.export();
    if (ok) toast('Favoriten exportiert', 'i-check');
  }));
  bmCard.appendChild(buttonRow('Favoriten wiederherstellen', 'Importiert eine zuvor exportierte JSON-Datei (ersetzt aktuelle)', 'Importieren', async () => {
    const res = await window.nova.bookmarks.importJson();
    if (res.ok) toast('Favoriten importiert', 'i-check');
    else if (res.error) toast('Import fehlgeschlagen: ' + res.error, 'i-warn');
  }));
  gBm.appendChild(bmCard);

  // System
  const gSys = group('System');
  const sysCard = el('div', 'set-card');
  sysCard.appendChild(buttonRow('Als Standardbrowser festlegen', 'Registriert NOVA in Windows und öffnet die Standard-Apps-Einstellungen', 'Einrichten', async () => {
    await window.nova.sys.registerDefault();
    toast('Wähle „Nova Browser" in den Windows-Einstellungen', 'i-check');
  }, true));
  sysCard.appendChild(buttonRow('Desktop-Verknüpfung', 'Erstellt eine Verknüpfung auf dem Desktop', 'Erstellen', async () => {
    const ok = await window.nova.sys.createShortcut();
    toast(ok ? 'Verknüpfung erstellt' : 'Fehler beim Erstellen', ok ? 'i-check' : 'i-warn');
  }));
  sysCard.appendChild(buttonRow('Cache leeren', 'Entfernt zwischengespeicherte Dateien', 'Leeren', async (btn) => {
    btn.textContent = '…';
    await window.nova.sys.clearData('cache');
    btn.textContent = 'Leeren';
    toast('Cache geleert', 'i-check');
  }));
  sysCard.appendChild(buttonRow('Cookies & Websitedaten löschen', 'Meldet dich überall ab', 'Löschen', async (btn) => {
    btn.textContent = '…';
    await window.nova.sys.clearData('cookies');
    btn.textContent = 'Löschen';
    toast('Cookies gelöscht', 'i-check');
  }));
  sysCard.appendChild(buttonRow('Nach Updates suchen', 'Prüft GitHub auf eine neue NOVA-Version (Update nur mit deiner Zustimmung)', 'Suchen', async (btn) => {
    btn.textContent = '…';
    await updater.check(true);
    btn.textContent = 'Suchen';
  }));
  gSys.appendChild(sysCard);

  // Über
  const gAbout = group('Über');
  gAbout.appendChild(el('div', 'about-logo', 'NOVA'));
  gAbout.appendChild(el('div', 'about-line', `Version ${state.versions.app} — Electron ${state.versions.electron} · Chromium ${state.versions.chrome}`));
  gAbout.appendChild(el('div', 'about-line', `${state.totalBlocked.toLocaleString('de-DE')} Werbeanzeigen & Tracker insgesamt geblockt`));
}

/* ============================================================ command palette */
function openPalette() {
  $('#palette').classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  input.focus();
  updatePalette('');
}
function closePalette() { $('#palette').classList.add('hidden'); }
$('#palette').addEventListener('mousedown', (e) => { if (e.target === $('#palette')) closePalette(); });

let palItems = [];
let palSel = 0;

function paletteCommands() {
  return [
    { label: 'Neuer Tab', ic: 'i-plus', run: () => createTab() },
    { label: 'Tab schließen', ic: 'i-x', run: () => closeTab(state.activeId) },
    { label: 'Alle Tabs schließen', ic: 'i-trash', run: closeAllTabsInSpace },
    { label: 'Geschlossenen Tab wiederherstellen', ic: 'i-reload', run: reopenClosedTab },
    { label: 'Tab anpinnen / lösen', ic: 'i-pin', run: () => togglePin(state.activeId) },
    { label: 'Split View umschalten', ic: 'i-split', run: () => toggleSplitWith(state.activeId) },
    { label: 'Screenshot aufnehmen', ic: 'i-camera', run: takeScreenshot },
    { label: 'Musik öffnen (Spotify & Apple Music)', ic: 'i-music', run: () => music.toggle(true) },
    { label: 'Neuer Space', ic: 'i-plus', run: () => openSpaceEditor(null, $('#spaces-row')) },
    { label: 'Verlauf öffnen', ic: 'i-clock', run: () => openHub('history') },
    { label: 'Downloads öffnen', ic: 'i-download', run: () => openHub('downloads') },
    { label: 'Einstellungen öffnen', ic: 'i-gear', run: () => openHub('settings') },
    { label: 'Plugin-Store öffnen', ic: 'i-plugin', run: () => openHub('plugins') },
    { label: 'Adblock umschalten', ic: 'i-shield', run: async () => {
        await window.nova.settings.set({ adblockEnabled: !state.settings.adblockEnabled });
        toast(state.settings.adblockEnabled ? 'Adblock aktiviert' : 'Adblock deaktiviert', 'i-shield');
      } },
    { label: 'Seitenleiste umschalten', ic: 'i-side', run: toggleSidebar },
    { label: 'Auf Seite suchen', ic: 'i-search', run: openFindbar },
    { label: 'Tastenkürzel anzeigen', ic: 'i-keys', run: openCheats },
    { label: 'Seite drucken', ic: 'i-file', run: () => { try { activeTab()?.wv.print(); } catch {} } },
    { label: 'DevTools öffnen', ic: 'i-bolt', run: () => { try { activeTab()?.wv.openDevTools(); } catch {} } },
    { label: 'Bei Google anmelden (sicheres Fenster)', ic: 'i-shield', run: () => { try { window.nova.google.login(); } catch {} } },
    { label: 'Favoriten exportieren', ic: 'i-star', run: async () => { if (await window.nova.bookmarks.export()) toast('Favoriten exportiert'); } },
    { label: 'Cache leeren', ic: 'i-trash', run: async () => { await window.nova.sys.clearData('cache'); toast('Cache geleert'); } },
  ];
}

function updatePalette(q) {
  const ql = q.trim().toLowerCase();
  const items = [];
  const match = (s) => !ql || (s || '').toLowerCase().includes(ql);

  if (!ql && state.closedStack.length > 0) {
    for (const c of state.closedStack.slice(-3).reverse()) {
      items.push({ group: 'Kürzlich geschlossen', label: c.title || c.url, sub: hostOf(c.url), favUrl: c.url,
        run: () => createTab(c.url) });
    }
  }
  for (const sp of state.spaces) {
    if (sp.id !== state.currentSpaceId && match('space ' + sp.name)) {
      items.push({ group: 'Spaces', label: `${sp.icon} Zu „${sp.name}" wechseln`, ic: 'i-ext', run: () => switchSpace(sp.id) });
    }
  }
  for (const c of paletteCommands()) {
    if (match(c.label)) items.push({ group: 'Befehle', label: c.label, ic: c.ic, run: c.run });
  }
  for (const t of state.tabs) {
    if (t.id !== state.activeId && (match(t.title) || match(t.url))) {
      const sp = state.spaces.find((s) => s.id === t.spaceId);
      items.push({ group: 'Offene Tabs', label: displayTitle(t), sub: (sp && sp.id !== state.currentSpaceId ? sp.icon + ' ' : '') + hostOf(t.pendingUrl || t.url),
        favUrl: t.pendingUrl || t.url, run: () => activateTab(t.id) });
    }
  }
  if (ql) {
    let n = 0;
    walkTree(state.bookmarks, (node) => {
      if (node.type === 'url' && n < 5 && (match(node.name) || match(node.url))) {
        n++;
        items.push({ group: 'Favoriten', label: node.name, sub: hostOf(node.url), favUrl: node.url, run: () => createTab(node.url) });
      }
    });
    items.push({ group: 'Suche', label: `„${q.trim()}" suchen`, ic: 'i-search', run: () => omniSubmit(q.trim()) });
  }

  palItems = items.slice(0, 15);
  palSel = 0;
  const box = $('#palette-results');
  box.innerHTML = '';
  let lastGroup = '';
  palItems.forEach((item, i) => {
    if (item.group !== lastGroup) {
      box.appendChild(el('div', 'pal-group', item.group));
      lastGroup = item.group;
    }
    const row = el('div', 'pal-row' + (i === palSel ? ' sel' : ''));
    if (item.favUrl) row.appendChild(faviconEl(item.favUrl, 'pal-fav'));
    else row.appendChild(icon(item.ic || 'i-bolt'));
    row.appendChild(el('span', 'pal-main', item.label));
    if (item.sub) row.appendChild(el('span', 'pal-sub', item.sub));
    row.addEventListener('mousedown', (e) => { e.preventDefault(); closePalette(); item.run(); });
    row.addEventListener('mouseenter', () => {
      palSel = i;
      [...box.querySelectorAll('.pal-row')].forEach((r) => r.classList.toggle('sel', +r.dataset.idx === palSel));
    });
    row.dataset.idx = i;
    box.appendChild(row);
  });
}
$('#palette-input').addEventListener('input', (e) => updatePalette(e.target.value));
$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePalette();
  else if (e.key === 'Enter') {
    e.preventDefault();
    const item = palItems[palSel];
    if (item) { closePalette(); item.run(); }
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (palItems.length === 0) return;
    palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % palItems.length;
    const rows = [...$('#palette-results').querySelectorAll('.pal-row')];
    rows.forEach((r) => r.classList.toggle('sel', +r.dataset.idx === palSel));
    rows.find((r) => +r.dataset.idx === palSel)?.scrollIntoView({ block: 'nearest' });
  }
});

/* ============================================================ cheatsheet */
const CHEATS = [
  ['Tabs & Spaces', [
    ['Neuer Tab', ['Strg', 'T']],
    ['Tab schließen', ['Strg', 'W']],
    ['Alle Tabs schließen', ['Strg', 'Shift', 'W']],
    ['Tab wiederherstellen', ['Strg', 'Shift', 'T']],
    ['Tabs wechseln', ['Strg', 'Tab']],
    ['Tab 1–9', ['Strg', '1–9']],
    ['Space 1–9', ['Strg', 'Shift', '1–9']],
    ['Split View', ['Strg', 'Shift', 'D']],
  ]],
  ['Navigation', [
    ['Adressleiste fokussieren', ['Strg', 'L']],
    ['Zurück / Vorwärts', ['Alt', '← →']],
    ['Neu laden', ['F5']],
    ['Hart neu laden', ['Strg', 'Shift', 'R']],
  ]],
  ['Ansicht', [
    ['Seitenleiste', ['Strg', 'B']],
    ['Zoom', ['Strg', '+ −']],
    ['Zoom zurücksetzen', ['Strg', '0']],
    ['Vollbild', ['F11']],
  ]],
  ['Tools', [
    ['Befehlspalette', ['Strg', 'K']],
    ['Auf Seite suchen', ['Strg', 'F']],
    ['Verlauf', ['Strg', 'H']],
    ['Downloads', ['Strg', 'J']],
    ['Favorit speichern', ['Strg', 'D']],
    ['Screenshot', ['Strg', 'Shift', 'S']],
    ['Musik (Spotify/Apple)', ['Strg', 'Shift', 'M']],
    ['Drucken', ['Strg', 'P']],
    ['DevTools', ['F12']],
    ['Diese Übersicht', ['F1']],
  ]],
];
function openCheats() {
  const grid = $('#cheats-grid');
  if (!grid.childElementCount) {
    for (const [title, rows] of CHEATS) {
      const g = el('div', 'cheat-group');
      g.appendChild(el('h3', null, title));
      for (const [label, keys] of rows) {
        const row = el('div', 'cheat-row');
        row.appendChild(el('span', null, label));
        const ks = el('span', 'keys');
        for (const k of keys) ks.appendChild(el('kbd', null, k));
        row.appendChild(ks);
        g.appendChild(row);
      }
      grid.appendChild(g);
    }
  }
  $('#cheats').classList.remove('hidden');
}
$('#cheats-close').addEventListener('click', () => $('#cheats').classList.add('hidden'));
$('#cheats').addEventListener('mousedown', (e) => { if (e.target === $('#cheats')) $('#cheats').classList.add('hidden'); });

/* ============================================================ sidebar / window */
function toggleSidebar() {
  const collapsed = $('#app').classList.toggle('sb-collapsed');
  window.nova.settings.set({ sidebarCollapsed: collapsed });
  if (typeof operator !== 'undefined') operator.relayoutAnimated();   // Bühne SOFORT mit der Sidebar mit-animieren
  setTimeout(() => { if (typeof claude !== 'undefined') claude.relayout(); }, 320);
}
$('#bm-head').addEventListener('click', () => {
  const collapsed = $('#sidebar').classList.toggle('bm-collapsed');
  window.nova.settings.set({ bmCollapsed: collapsed });
});
$('#btn-sidebar').addEventListener('click', toggleSidebar);
$('#btn-newtab').addEventListener('click', () => createTab());
$('#btn-back').addEventListener('click', () => { try { activeTab()?.wv.goBack(); } catch {} });
$('#btn-fwd').addEventListener('click', () => { try { activeTab()?.wv.goForward(); } catch {} });
$('#btn-reload').addEventListener('click', () => {
  const tab = activeTab();
  if (!tab) return;
  try { tab.loading ? tab.wv.stop() : tab.wv.reload(); } catch {}
});
$('#btn-star').addEventListener('click', toggleBookmarkCurrent);
$('#btn-copyurl').addEventListener('click', async () => {
  const tab = activeTab();
  if (!tab || !isWebUrl(tab.url)) return;
  await navigator.clipboard.writeText(tab.url);
  toast('Link kopiert', 'i-copy');
});
$('#btn-screenshot').addEventListener('click', takeScreenshot);
$('#btn-split').addEventListener('click', () => toggleSplitWith(state.activeId));
$('#btn-shield').addEventListener('click', toggleShieldPop);
$('#btn-palette').addEventListener('click', openPalette);
$('#btn-cheats').addEventListener('click', openCheats);
$('#btn-history').addEventListener('click', () => openHub('history'));
$('#btn-downloads').addEventListener('click', () => openHub('downloads'));
$('#btn-settings').addEventListener('click', () => openHub('settings'));
$('#btn-plugins').addEventListener('click', () => openHub('plugins'));
$('#btn-close-all-tabs').addEventListener('click', closeAllTabsInSpace);
$('#win-min').addEventListener('click', () => window.nova.win.min());
$('#win-max').addEventListener('click', () => window.nova.win.max());
$('#win-close').addEventListener('click', () => window.nova.win.close());

window.nova.win.onMaximized((maxed) => {
  $('#win-max-ic').querySelector('use').setAttribute('href', maxed ? '#i-restore' : '#i-maxi');
});
window.nova.win.onFullscreen((fs) => $('#app').classList.toggle('content-fs', fs));

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#shield-pop') && !e.target.closest('#btn-shield')) $('#shield-pop').classList.add('hidden');
  if (!e.target.closest('#ctx-menu')) hideCtxMenu();
  if (!e.target.closest('#space-edit') && !e.target.closest('.space-chip')) closeSpaceEditor();
  if (!e.target.closest('#ext-popup') && !e.target.closest('.ext-tool')) extActions.closePopup();
});
// Klick in eine Webview (native Ebene → kein DOM-mousedown) schließt alle offenen Menüs
function closeAllTopMenus() {
  $('#shield-pop').classList.add('hidden');
  closeOmniDrop();
  hideCtxMenu();
  closeSpaceEditor();
  hideTabPreview();
  if (typeof dlPop !== 'undefined') dlPop.close();
  if (typeof netPop !== 'undefined') netPop.close();
  if (typeof teEdit !== 'undefined') teEdit.close();
  if (typeof bmSave !== 'undefined') bmSave.close();
  if (typeof extActions !== 'undefined') extActions.closePopup();
}
document.addEventListener('focusin', () => {
  if (document.activeElement?.tagName === 'WEBVIEW') closeAllTopMenus();
});
// Wenn eine Webview den Fokus übernimmt, verliert das Chrome-Fenster ihn → ebenfalls schließen
window.addEventListener('blur', () => setTimeout(closeAllTopMenus, 0));

/* ============================================================ shortcuts */
function handleShortcut(action) {
  const tab = activeTab();
  switch (action) {
    case 'new-tab': createTab(); $('#omni-input').focus(); break;
    case 'close-tab': closeTab(state.activeId); break;
    case 'close-all-tabs': closeAllTabsInSpace(); break;
    case 'reopen-tab': reopenClosedTab(); break;
    case 'next-tab': cycleTab(1); break;
    case 'prev-tab': cycleTab(-1); break;
    case 'focus-omnibox': $('#omni-input').focus(); break;
    case 'palette': openPalette(); break;
    case 'find': openFindbar(); break;
    case 'history': openHub('history'); break;
    case 'downloads': openHub('downloads'); break;
    case 'toggle-sidebar': toggleSidebar(); break;
    case 'bookmark': toggleBookmarkCurrent(); break;
    case 'print': try { tab?.wv.print(); } catch {} break;
    case 'reload': try { tab?.wv.reload(); } catch {} break;
    case 'hard-reload': try { tab?.wv.reloadIgnoringCache(); } catch {} break;
    case 'devtools': try { tab?.wv.openDevTools(); } catch {} break;
    case 'fullscreen': window.nova.win.fullscreen(); break;
    case 'nav-back': try { tab?.wv.goBack(); } catch {} break;
    case 'nav-forward': try { tab?.wv.goForward(); } catch {} break;
    case 'zoom-in': zoom(+0.5); break;
    case 'zoom-out': zoom(-0.5); break;
    case 'zoom-reset': zoom(null); break;
    case 'screenshot': takeScreenshot(); break;
    case 'split': toggleSplitWith(state.activeId); break;
    case 'music': music.toggle(); break;
    case 'cheatsheet':
      $('#cheats').classList.contains('hidden') ? openCheats() : $('#cheats').classList.add('hidden');
      break;
    default:
      if (action.startsWith('tab-')) {
        const n = parseInt(action.slice(4), 10);
        const tabs = spaceTabs();
        const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
        if (target) activateTab(target.id);
      } else if (action.startsWith('space-')) {
        const n = parseInt(action.slice(6), 10);
        const target = state.spaces[n - 1];
        if (target) switchSpace(target.id);
      }
  }
}
window.nova.onShortcut(handleShortcut);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#palette').classList.contains('hidden')) return closePalette();
    if (!$('#cheats').classList.contains('hidden')) return $('#cheats').classList.add('hidden');
    if (!$('#hub').classList.contains('hidden')) return closeHub();
    if (!$('#space-edit').classList.contains('hidden')) return closeSpaceEditor();
    if (!$('#shield-pop').classList.contains('hidden')) return $('#shield-pop').classList.add('hidden');
    closeFindbar();
  }
});

/* ============================================================ IPC push events */
window.nova.onOpenTab(({ url, background }) => createTab(url, { background }));

window.nova.onTabAudio(({ wcId, audible }) => {
  const tab = tabByWcId(wcId);
  if (!tab) return;
  tab.audible = audible;
  syncAudioIcon(tab);
});

window.nova.adblock.onStats(({ total, perTab }) => {
  state.totalBlocked = total;
  state.blockedPerTab = perTab;
  syncShieldBadge();
});

window.nova.settings.onChanged((s) => {
  state.settings = s;
  applyAccent();
  pushAccentToNewtabs();
  syncShieldBadge();
});

// Akzentfarbe live an alle offenen Startseiten (nova://newtab) schicken,
// damit sich Universum-Animation & Co. sofort umfärben (ohne Neuladen).
function pushAccentToNewtabs() {
  const payload = { accent: state.settings.accent || 'magenta', customAccent: state.settings.customAccent || null };
  for (const t of state.tabs) {
    const url = t.pendingUrl || t.url;
    if (isInternal(url) && t.wcId != null) {
      try { t.wv.send('newtab:accent', payload); } catch {}
    }
  }
}
// Plugin-Zustand (z. B. Startseiten-Animation) live an alle offenen Startseiten schicken
function pushPluginsToNewtabs(native) {
  for (const t of state.tabs) {
    const url = t.pendingUrl || t.url;
    if (isInternal(url) && t.wcId != null) {
      try { t.wv.send('newtab:plugins', native); } catch {}
    }
  }
}
// Nebula-Qualität live an alle offenen Startseiten schicken (die laden sich dann neu auf)
function pushNebulaToNewtabs(quality) {
  for (const t of state.tabs) {
    const url = t.pendingUrl || t.url;
    if (isInternal(url) && t.wcId != null) {
      try { t.wv.send('newtab:nebula', quality); } catch {}
    }
  }
}

window.nova.bookmarks.onChanged((tree) => {
  state.bookmarks = tree;
  renderBookmarks();
  syncStar(activeTab());
  if (typeof bmSave !== 'undefined' && bmSave.isOpen()) bmSave.renderFolders();
});

/* ============================================================ session */
let sessionTimer;
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const data = {
      v: 2,
      current: Math.max(0, state.spaces.findIndex((s) => s.id === state.currentSpaceId)),
      spaces: state.spaces.map((sp) => {
        const tabs = spaceTabs(sp.id).filter((t) => {
          const u = t.pendingUrl || t.url;
          return isWebUrl(u) || isInternal(u);
        });
        return {
          name: sp.name, icon: sp.icon, accent: sp.accent, splitRatio: sp.splitRatio,
          active: Math.max(0, tabs.findIndex((t) => t.id === sp.activeTabId)),
          tabs: tabs.map((t) => ({ url: t.pendingUrl || t.url, title: t.title, pinned: !!t.pinned })),
        };
      }),
    };
    window.nova.session.save(data);
  }, 800);
}

function restoreSession(sess, startUrl) {
  // Spaces aus Session bauen (auch ohne Tab-Restore die Space-Struktur erhalten)
  let spacesData = [];
  if (sess && sess.v === 2 && Array.isArray(sess.spaces) && sess.spaces.length) {
    spacesData = sess.spaces;
  } else if (Array.isArray(sess) && sess.length) {
    spacesData = [{ name: 'Home', icon: 'i-sp-home', accent: null, tabs: sess, active: sess.length - 1 }];
  } else if (sess && Array.isArray(sess.tabs) && sess.tabs.length) {
    spacesData = [{ name: 'Home', icon: 'i-sp-home', accent: null, tabs: sess.tabs, active: sess.active || 0 }];
  }
  if (spacesData.length === 0) {
    spacesData = [{ name: 'Home', icon: 'i-sp-home', accent: null, tabs: [], active: 0 }];
  }

  const restoreTabs = state.settings.restoreSession !== false;
  const currentIdx = Math.min(
    Math.max(0, (sess && sess.v === 2 && typeof sess.current === 'number') ? sess.current : 0),
    spacesData.length - 1,
  );

  spacesData.forEach((sd, i) => {
    const sp = createSpace({ name: sd.name || 'Space', icon: spaceIcon(sd.icon), accent: sd.accent || null });
    sp.splitRatio = sd.splitRatio || 0.5;
    sp._restoreTabs = restoreTabs ? (sd.tabs || []) : [];
    sp._restoreActive = sd.active || 0;
    if (i === currentIdx) state.currentSpaceId = sp.id;
  });

  applyAccent();
  renderSpaces();

  for (const sp of state.spaces) {
    const tabs = sp._restoreTabs || [];
    tabs.forEach((t, i) => {
      const isActiveTab = sp.id === state.currentSpaceId && i === Math.min(sp._restoreActive, tabs.length - 1) && !startUrl;
      const tab = createTab(t.url, { lazy: !isActiveTab, background: true, title: t.title, spaceId: sp.id, pinned: t.pinned });
      if (i === Math.min(sp._restoreActive, tabs.length - 1)) sp.activeTabId = tab.id;
    });
    delete sp._restoreTabs;
    delete sp._restoreActive;
  }

  renderTabList();
  if (startUrl) {
    createTab(startUrl);
  } else {
    const sp = currentSpace();
    const tabs = spaceTabs();
    if (tabs.length === 0) createTab();
    else activateTab((sp.activeTabId && tabs.some((t) => t.id === sp.activeTabId)) ? sp.activeTabId : tabs[0].id);
  }
}

/* ============================================================ app icon */
async function ensureIcon() {
  try {
    const ICON_V = '8'; // bei Design-Änderung erhöhen → einmalige Neugenerierung
    if (localStorage.getItem('novaIconV') === ICON_V && await window.nova.sys.iconExists()) return;

    const S = 256, M = S / 2;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    const squircle = () => { ctx.beginPath(); ctx.roundRect(6, 6, S - 12, S - 12, 62); };

    // ---- Inneres: Tiefraum + Nebula (innerhalb der Squircle-Maske) ----
    squircle(); ctx.save(); ctx.clip();

    const base = ctx.createRadialGradient(108, 96, 20, M, M, 205);
    base.addColorStop(0, '#1c1a42');
    base.addColorStop(0.5, '#0c0b22');
    base.addColorStop(1, '#05050d');
    ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);

    // additive Nebula-Wolken (HDR-Glow)
    ctx.globalCompositeOperation = 'lighter';
    const cloud = (x, y, r, rgb, a) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(0.5, `rgba(${rgb},${a * 0.4})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    };
    cloud(84, 80, 132, '0,229,255', 0.55);   // Cyan
    cloud(158, 138, 150, '124,77,255', 0.55); // Violett
    cloud(182, 196, 124, '255,61,154', 0.45); // Magenta
    cloud(120, 108, 74, '180,245,255', 0.35); // heller Kern
    ctx.globalCompositeOperation = 'source-over';

    // Sterne
    const stars = [[40, 60, 1.4], [70, 38, 1], [202, 48, 1.7], [222, 112, 1], [48, 182, 1.2],
      [210, 202, 1.5], [158, 66, 1], [100, 214, 1.1], [188, 152, 0.9], [58, 120, 1], [232, 158, 1.3], [138, 36, 0.9]];
    ctx.fillStyle = '#eaf6ff';
    for (const [x, y, r] of stars) { ctx.globalAlpha = 0.55 + r * 0.2; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;

    // Vignette, damit das N hervortritt
    const vig = ctx.createRadialGradient(M, 122, 44, M, M, 162);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(4,4,12,0.55)');
    ctx.fillStyle = vig; ctx.fillRect(0, 0, S, S);
    ctx.restore(); // Clip Ende

    // ---- Orbit-Ellipse ----
    ctx.save();
    ctx.translate(M, M); ctx.rotate(-25 * Math.PI / 180);
    ctx.beginPath(); ctx.ellipse(0, 0, 104, 40, 0, 0, 7);
    const og = ctx.createLinearGradient(-104, 0, 104, 0);
    og.addColorStop(0, '#00e5ff'); og.addColorStop(1, '#7c4dff');
    ctx.strokeStyle = og; ctx.lineWidth = 5; ctx.globalAlpha = 0.7;
    ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 12; ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1; ctx.shadowBlur = 0;

    // ---- N (kräftig, leuchtend) ----
    const ng = ctx.createLinearGradient(80, 70, 180, 186);
    ng.addColorStop(0, '#ffffff'); ng.addColorStop(0.5, '#a6ecff'); ng.addColorStop(1, '#bda3ff');
    ctx.beginPath();
    ctx.moveTo(90, 180); ctx.lineTo(90, 78); ctx.lineTo(166, 180); ctx.lineTo(166, 78);
    ctx.strokeStyle = ng; ctx.lineWidth = 23; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,229,255,0.95)'; ctx.shadowBlur = 24; ctx.stroke();
    ctx.shadowBlur = 0; ctx.stroke(); // zweiter Pass = sattere HDR-Kanten

    // ---- Stern am Orbit-Ende ----
    const sg = ctx.createRadialGradient(196, 68, 0, 196, 68, 12);
    sg.addColorStop(0, '#ffffff'); sg.addColorStop(1, '#00e5ff');
    ctx.beginPath(); ctx.arc(196, 68, 11, 0, 7);
    ctx.fillStyle = sg; ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 18; ctx.fill();
    ctx.shadowBlur = 0;

    // ---- Glanz oben + feiner Rand ----
    squircle(); ctx.save(); ctx.clip();
    const hl = ctx.createLinearGradient(0, 6, 0, 96);
    hl.addColorStop(0, 'rgba(255,255,255,0.12)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl; ctx.fillRect(0, 0, S, 96); ctx.restore();
    squircle(); ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 2; ctx.stroke();

    await window.nova.sys.setIcon(c.toDataURL('image/png'));
    localStorage.setItem('novaIconV', ICON_V);
  } catch (err) {
    console.error('icon gen failed', err);
  }
}

/* ============================================================ hyperspace warp */
// Universum-Sprung-Animation. Sie wird angezeigt, SOLANGE die neue Seite lädt,
// und blendet erst aus, wenn die Seite dahinter bereit ist — egal ob die
// Navigation aus der Omnibox, der Startseiten-Suche, einem Shortcut oder einem
// Link kommt. Gesteuert wird sie über die Lade-Events des aktiven Webviews.
const warp = (() => {
  const canvas = $('#warp-overlay');
  const app = document.getElementById('app');
  let gl = null, prog = null, buf, loc;
  let uRes, uTime, uDist, uWarp, uBoost, uAcc, uAcc2;
  let raf = 0, accColors = [[0, 0.9, 1], [0.49, 0.3, 1]];
  // Zustand
  let active = false;      // Animation läuft
  let pageReady = false;   // Zielseite hat fertig geladen
  let t0 = 0;              // Startzeitpunkt
  let lastT = 0;           // letzter Frame (für dt)
  let dist = 0;            // akkumulierte, geglättete Sprung-Distanz
  let closing = false, closeAt = 0;
  let lastBeginAt = -1e9;  // Zeitpunkt des letzten Starts (Cooldown)
  let holdTime = 1500;     // Soll-Dauer aus den Einstellungen (ms)
  const COOLDOWN = 2000;   // max. ein Sprung alle 2 s
  let RAMP_IN = 240, RAMP_OUT = 440;
  let warpWrap = null;     // der gerade bespielte Webview-Bereich (Pane)
  let warpTabId = null;    // Tab, dessen Sprung läuft

  const webviewsBox = document.getElementById('webviews');
  // Canvas exakt über den Pane legen (Vollbild im Single-, halb im Split-View)
  function positionTo(wrap) {
    if (!wrap) return;
    canvas.style.left = wrap.offsetLeft + 'px';
    canvas.style.top = wrap.offsetTop + 'px';
    canvas.style.width = wrap.offsetWidth + 'px';
    canvas.style.height = wrap.offsetHeight + 'px';
  }

  function hexToLin(hex) {
    hex = (hex || '').trim().replace('#', '');
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const f = (i) => Math.pow((parseInt(hex.slice(i, i + 2), 16) || 0) / 255, 2.2);
    return [f(0), f(2), f(4)];
  }
  function readAccents() {
    const cs = getComputedStyle(document.body);
    accColors = [hexToLin(cs.getPropertyValue('--acc')), hexToLin(cs.getPropertyValue('--acc2'))];
  }

  // Cinematic hyperspace: perspektivische Sternstreifen mit Kometenschweif,
  // chromatischer Aberration (wächst mit Tempo) und pulsierendem Kern.
  const FRAG = `
  precision highp float;
  uniform vec2 uRes; uniform float uTime; uniform float uDist; uniform float uWarp; uniform float uBoost;
  uniform vec3 uAcc; uniform vec3 uAcc2;
  const float TAU = 6.2831853;

  float hash11(float p){ p = fract(p*0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

  // Ein radiales Sternstreifen-Feld, ausgewertet bei Radius (r + rOff) für
  // chromatische Aberration. Liefert die Helligkeit an diesem Pixel.
  float field(float r, float ang, float rOff){
    r += rOff;
    float a = ang/TAU + 0.5;            // 0..1 rund um den Kreis
    float acc = 0.0;
    for(int k=0;k<3;k++){
      float fk = float(k);
      float sect = 130.0 * (1.0 + fk*0.85);   // Anzahl Winkel-Sektoren
      float speed = 0.5 + fk*0.26;             // Parallaxe: tiefere Schichten schneller
      float cell = floor(a*sect);
      float rnd  = hash11(cell + fk*71.3);
      float rnd2 = hash11(cell*1.31 + fk*23.7);
      float exists = step(0.42, rnd2);         // nur ein Teil der Zellen trägt einen Stern
      // Tiefe 0..1, perspektivische Kurve -> beschleunigt zum Rand
      float depth = fract(rnd - uDist*speed);
      float sr = depth*depth*1.3;              // Radius des Streifen-Kopfes
      // Kometen-Profil: scharfer Kopf + langer, weicher Schweif zum Zentrum
      float head = exp(-abs(r - sr)*26.0);
      float tail = exp(-max(sr - r, 0.0)*5.5) * smoothstep(0.0,0.02,r) * smoothstep(0.0,0.12,sr);
      // dünnes Winkelprofil innerhalb der Zelle
      float af = fract(a*sect) - 0.5;
      float thin = exp(-af*af*110.0);
      // einblenden wenn neu, ausblenden am Rand
      float life = smoothstep(0.0,0.06,depth) * smoothstep(1.0,0.72,depth);
      acc += exists * thin * (head + tail*0.65) * life * (0.45 + rnd*0.85);
    }
    return acc;
  }

  void main(){
    vec2 uv = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;
    float r = length(uv);
    float ang = atan(uv.y, uv.x);

    // Chromatische Aberration wächst mit dem Tempo (uBoost)
    float ca = 0.003 + uBoost*0.014;
    float sR = field(r, ang,  ca);
    float sG = field(r, ang,  0.0);
    float sB = field(r, ang, -ca);

    // Akzent-Tönung entlang des Winkels, Köpfe laufen ins Weiße
    vec3 tint = mix(uAcc, uAcc2, fract(ang/TAU + 0.5));
    vec3 col  = tint * (sG*1.7) + vec3(sR, sG, sB)*0.85;
    col += vec3(1.0) * pow(sG, 2.0) * 1.3;       // gleißende Streifen-Köpfe

    // Pulsierender Kern (stark beim Absprung), zieht ins Weiße
    float core = exp(-r*r*10.0);
    col += mix(uAcc, vec3(1.0), 0.65) * core * (0.45 + uBoost*2.4);

    // dezenter Tempo-Dunst füllt die Leere hinter den Sternen
    col += mix(vec3(0.012,0.016,0.045), uAcc*0.10, exp(-r*1.5));

    // Vignette
    col *= smoothstep(1.5, 0.08, r);

    float lum = max(max(col.r, col.g), col.b);
    float a = clamp(lum*1.15 + core*0.7 + 0.06, 0.0, 1.0);
    // Premultiplied-Alpha-Ausgabe (Kontext premultipliedAlpha:true). Ein einziges
    // uWarp blendet Farbe und Deckkraft gemeinsam sauber ein und aus.
    gl_FragColor = vec4(col * a, a) * uWarp;
  }`;
  const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p,0.0,1.0); }`;

  function init() {
    gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!gl) return false;
    const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); return sh; };
    prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    uRes = gl.getUniformLocation(prog, 'uRes');
    uTime = gl.getUniformLocation(prog, 'uTime');
    uDist = gl.getUniformLocation(prog, 'uDist');
    uWarp = gl.getUniformLocation(prog, 'uWarp');
    uBoost = gl.getUniformLocation(prog, 'uBoost');
    uAcc = gl.getUniformLocation(prog, 'uAcc');
    uAcc2 = gl.getUniformLocation(prog, 'uAcc2');
    gl.disable(gl.BLEND); // ein Vollbild-Dreieck pro Frame -> direktes Alpha
    return true;
  }
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.75);
    const r = canvas.getBoundingClientRect();
    const w = Math.max(2, Math.floor(r.width * dpr)), h = Math.max(2, Math.floor(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
  }
  // weiches Ease-In-Out (cubic) für die Intensität
  const easeIO = (k) => (k < 0.5 ? 4*k*k*k : 1 - Math.pow(-2*k+2, 3)/2);
  const easeOut = (k) => 1 - Math.pow(1 - k, 3);

  function frame() {
    const now = performance.now();
    const elapsed = now - t0;
    // Dauer richtet sich nach der Einstellung: schnell geladene Seiten enden
    // frühestens bei 60 % der Soll-Dauer, langsame spätestens bei 100 %.
    const closeReady = (pageReady && elapsed >= holdTime * 0.6) || elapsed >= holdTime;
    if (!closing && closeReady) {
      closing = true; closeAt = now;
    }
    let intensity;
    if (closing) {
      const k = Math.min(1, (now - closeAt) / RAMP_OUT);
      intensity = 1 - easeIO(k);
      if (k >= 1) { finish(); return; }
    } else {
      intensity = easeOut(Math.min(1, elapsed / RAMP_IN));
    }
    // Kurzer Beschleunigungs-„Punch" beim Absprung — treibt Kern & Aberration
    const boost = closing ? 0 : Math.exp(-elapsed / 240);
    // geglättete Distanz: Tempo beschleunigt beim Einblenden, bremst beim Ausblenden
    const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    dist += dt * (0.55 + intensity * 2.1 + boost * 2.6);

    positionTo(warpWrap); // folgt dem Pane (z. B. bei Split-Resize)
    resize();
    gl.useProgram(prog);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, elapsed / 1000);
    gl.uniform1f(uDist, dist);
    gl.uniform1f(uWarp, intensity);
    gl.uniform1f(uBoost, boost);
    gl.uniform3fv(uAcc, accColors[0]);
    gl.uniform3fv(uAcc2, accColors[1]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(frame);
  }
  function finish() {
    active = false; closing = false;
    canvas.classList.remove('on');
    app.classList.remove('warping');
    if (warpWrap) warpWrap.classList.remove('wv-warp-hide');
    warpWrap = null; warpTabId = null;
    cancelAnimationFrame(raf);
    setTimeout(() => { if (!active) canvas.classList.add('hidden'); }, 340);
  }

  // Beginn eines Sprungs im Bereich eines bestimmten Tabs (Pane).
  function begin(tab) {
    if (state.settings.warpEnabled === false) return;
    const t = tab || activeTab();
    if (!t || !t.wrap) return;
    const now = performance.now();
    if (active) return;                         // läuft schon — nicht neu starten
    if (now - lastBeginAt < COOLDOWN) return;   // höchstens ein Sprung alle 2 s
    if (!gl && !init()) return;
    readAccents();
    holdTime = Math.max(400, Math.min(3000, state.settings.warpDuration || 1500));
    lastBeginAt = now;
    pageReady = false;
    active = true; closing = false;
    t0 = now; lastT = now;
    dist = hash11Seed();
    warpWrap = t.wrap; warpTabId = t.id;
    warpWrap.classList.add('wv-warp-hide'); // nur diesen Pane verdecken
    app.classList.add('warping');
    positionTo(warpWrap);
    canvas.classList.remove('hidden');
    requestAnimationFrame(() => canvas.classList.add('on'));
    raf = requestAnimationFrame(frame);
  }
  function hash11Seed() { return ((performance.now() * 0.013) % 1) * 8; }
  // Seite fertig → Sprung sanft beenden (nur wenn es der laufende Pane ist)
  function end(tab) { if (!tab || !warpTabId || tab.id === warpTabId) pageReady = true; }
  // Sofort abbrechen (interne Seite/Fehler im laufenden Pane)
  function cancel(tab) {
    if (!active) return;
    if (tab && warpTabId && tab.id !== warpTabId) return;
    pageReady = true; closing = true; closeAt = performance.now() - RAMP_OUT; finish();
  }

  function play(tab) { begin(tab); setTimeout(() => end(tab), 200); }

  return { begin, end, cancel, play };
})();

/* ============================================================ music player */
// Kompakter, schön gestalteter Musik-Player für Spotify & Apple Music.
// Jeder Dienst läuft in einem eigenen Webview mit persistenter Login-Session.
const music = (() => {
  const MUSIC_PARTITION = 'persist:nova-music';
  const SERVICES = {
    spotify: { url: 'https://open.spotify.com', label: 'Spotify' },
    apple:   { url: 'https://music.apple.com',  label: 'Apple Music' },
    ytmusic: { url: 'https://music.youtube.com', label: 'YouTube Music' },
  };
  const panel = $('#music-panel');
  const body = $('#music-body');
  const views = {}; // svc -> { wrap, wv }
  let current = null;
  let open = false;
  let volume = 100;   // 0..100 — gilt NUR für den Musik-Player
  let muted = false;

  // Lautstärke-Enforcer in den Musik-Webview injizieren: setzt die Lautstärke
  // aller Audio-/Video-Elemente NUR in diesem Webview (unabhängig vom restlichen
  // Browser-Sound). Ein Intervall hält den Wert auch bei neuen Elementen.
  // Lautstärke 0..3 (0–300 %). Bis 100 % über element.volume (sicher); über 100 %
  // via Web-Audio-GainNode (Verstärkung). Streaming nutzt blob/MSE (same-origin),
  // daher funktioniert die Gain-Verschaltung ohne Stummschaltung.
  function volumeScript(vol) {
    return `(function(){
      try {
        window.__novaVol = ${vol};
        // DRM-Audio (Spotify/Apple Music/Tidal …, Widevine/FairPlay): createMediaElementSource
        // bricht/stummt den Stream → bei DRM NIEMALS Web-Audio. Nur element.volume (kein Boost).
        // Nicht-DRM (YouTube, YouTube Music, SoundCloud) → Boost >100% via Web-Audio möglich.
        var host = location.hostname;
        var isDRM = /spotify|music\.apple|tidal|deezer|amazon|pandora|qobuz/.test(host);
        var isSpotify = /spotify/.test(host);
        var engage = (window.__novaVol > 1.0001 || window.__novaWA) && !isDRM;
        var setSpotifyNative = function(){
          try {
            var t = Math.min(1, window.__novaVol);
            var inp = document.querySelector('[data-testid="volume-bar"] input[type="range"], input[aria-label*="olume" i][type="range"], input[aria-label*="autst" i][type="range"]');
            if (inp) {
              var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
              if (d && d.set) d.set.call(inp, String(t)); else inp.value = String(t);
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch(_){}
        };
        var apply = function(){
          try {
            var els = document.querySelectorAll('video,audio');
            if (engage) {
              if (!window.__novaAC) { try { window.__novaAC = new (window.AudioContext||window.webkitAudioContext)(); } catch(_){ return; } }
              var ac = window.__novaAC; window.__novaWA = true;
              if (!window.__novaNodes) window.__novaNodes = new WeakMap();
              els.forEach(function(e){
                var n = window.__novaNodes.get(e);
                if (!n) { try { var s = ac.createMediaElementSource(e); var g = ac.createGain(); s.connect(g); g.connect(ac.destination); n = { g: g }; window.__novaNodes.set(e, n); } catch(_){ return; } }
                try { n.g.gain.value = window.__novaVol; } catch(_){}
                try { e.volume = 1; } catch(_){}
                if (window.__novaVol === 0) e.muted = true; else if (e.muted && e.dataset.novaUnmute !== '0') e.muted = false;
              });
              if (ac.state === 'suspended') ac.resume().catch(function(){});
            } else {
              var t = Math.min(1, window.__novaVol);
              els.forEach(function(e){
                if (Math.abs((e.volume||0) - t) > 0.005) { try { e.volume = t; } catch(_){} }
                if (window.__novaVol === 0) e.muted = true; else if (e.muted && e.dataset.novaUnmute !== '0') e.muted = false;
              });
              if (isSpotify) setSpotifyNative();
            }
          } catch(_){}
        };
        apply();
        if (!window.__novaVolTimer) {
          window.__novaVolTimer = setInterval(apply, 500);
          try { new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true }); } catch(_){}
        }
      } catch(_){}
    })();`;
  }
  function pushVolume() {
    const v = muted ? 0 : Math.max(0, volume / 100); // 0..3
    for (const x of Object.values(views)) {
      try { x.wv.executeJavaScript(volumeScript(v), true).catch(() => {}); } catch {}
    }
    // UI — Füllung relativ zum Maximum (300 %), Boost-Zustand über 100 %
    const disp = muted ? 0 : volume;
    const slider = $('#music-vol');
    if (+slider.value !== volume) slider.value = volume;
    slider.style.setProperty('--vol', (disp / 300 * 100) + '%');
    $('#music-vol-val').textContent = disp + '%';
    $('#music-vol-btn').innerHTML = '';
    $('#music-vol-btn').appendChild(icon(muted || volume === 0 ? 'i-mute' : 'i-audio'));
    const foot = document.querySelector('.music-foot');
    foot?.classList.toggle('muted', muted || volume === 0);
    foot?.classList.toggle('boosting', !muted && volume > 100);
  }

  function ensureView(svc) {
    if (views[svc]) return views[svc];
    const wrap = el('div', 'music-view');
    wrap.style.cssText = 'position:absolute;inset:0;display:none;';
    const loading = el('div', 'music-loading');
    loading.appendChild(el('div', 'ms-spin'));
    loading.appendChild(el('span', null, `${SERVICES[svc].label} wird geladen …`));
    const wv = document.createElement('webview');
    wv.setAttribute('partition', MUSIC_PARTITION);
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=no,backgroundThrottling=no');
    // YouTube Music: Webview-Preload anhängen → der YouTube-Werbe-Entferner greift
    // (gleicher /youtubei/v1/player-Endpunkt) → werbefrei, alles gratis hörbar.
    // Spotify/Apple bleiben bewusst OHNE Preload (Player-Kompatibilität).
    if (svc === 'ytmusic' && state.webviewPreload) wv.setAttribute('preload', state.webviewPreload);
    wv.setAttribute('src', SERVICES[svc].url);
    let loaded = false, retries = 0;
    const reloadSvc = () => { try { wv.reload(); } catch { try { wv.loadURL(SERVICES[svc].url); } catch {} } };
    wv.addEventListener('did-stop-loading', () => {
      loaded = true; retries = 0;
      loading.style.display = 'none';
      applyZoom(svc, wv);
      repaintMusic(wv);
      setTimeout(() => { applyZoom(svc, wv); repaintMusic(wv); }, 400);
      pushVolume();
    });
    wv.addEventListener('dom-ready', () => { applyZoom(svc, wv); repaintMusic(wv); pushVolume(); });
    // Robust laden: bei Fehlschlag mit Backoff neu versuchen (sonst bleibt z. B. Spotify leer/schwarz)
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3 || e.isMainFrame === false) return;   // -3 = abgebrochen (normal bei Weiterleitungen)
      if (retries < 4) { retries++; loaded = false; loading.style.display = 'flex'; setTimeout(reloadSvc, 800 * retries); }
    });
    // Watchdog: wenn nach 14 s nichts geladen ist, einmal neu anstoßen
    setTimeout(() => { if (!loaded && retries < 4) { retries++; reloadSvc(); } }, 14000);
    wrap.append(loading, wv);
    body.appendChild(wrap);
    views[svc] = { wrap, wv, svc };
    return views[svc];
  }

  // „Render breit, skaliere klein" — NUR für Spotify (war rechts abgeschnitten).
  // Apple Music sah ohne Zoom besser aus → dort Zoom 1 lassen.
  const TARGET_W = { spotify: 660, ytmusic: 540 };
  function applyZoom(svc, wv) {
    const w = body.clientWidth;
    if (!w) return;
    const target = TARGET_W[svc];
    const z = target ? Math.max(0.5, Math.min(1, w / target)) : 1;
    try { wv.setZoomFactor(z); } catch {}
  }

  // Behebt das Electron-Compositing-Problem (schwarzer Bereich): die
  // Webview-Höhe wird explizit in Pixeln auf die Body-Höhe gesetzt, statt sich
  // auf height:100% zu verlassen (das die Guest-Oberfläche oft zu klein lässt).
  function sizeViews() {
    const h = body.clientHeight;
    const w = body.clientWidth;
    if (!h || !w) return;
    for (const v of Object.values(views)) {
      v.wv.style.height = h + 'px';
      v.wv.style.width = w + 'px';
      applyZoom(v.svc, v.wv);
    }
  }
  function repaintMusic(wv) {
    if (!wv) return;
    requestAnimationFrame(() => {
      sizeViews();
      const h = body.clientHeight;
      wv.style.height = (h - 1) + 'px';
      requestAnimationFrame(() => {
        wv.style.height = h + 'px';
        try { wv.executeJavaScript('window.dispatchEvent(new Event("resize"))', true).catch(() => {}); } catch {}
      });
    });
  }

  function pauseView(wv) {
    try { wv.executeJavaScript('(function(){try{document.querySelectorAll("video,audio").forEach(function(e){try{if(!e.paused)e.pause();}catch(_){}})}catch(_){}})()', true).catch(() => {}); } catch {}
  }
  function show(svc) {
    current = svc;
    ensureView(svc);
    for (const [key, v] of Object.entries(views)) {
      v.wrap.style.display = key === svc ? 'block' : 'none';
      if (key === svc) repaintMusic(v.wv);
      else pauseView(v.wv);   // HARD-SWITCH: andere Dienste sofort pausieren
    }
    let activeBtn = null;
    for (const b of panel.querySelectorAll('.music-svc')) {
      const on = b.dataset.svc === svc;
      b.classList.toggle('active', on);
      if (on) activeBtn = b;
    }
    updateTabScroll();
    // Aktiven Tab NUR im Strip selbst zentrieren (kein scrollIntoView → keine
    // Seiteneffekte/Springen übergeordneter Container) und nur bei echtem Overflow.
    const strip = $('#music-services');
    if (activeBtn && strip && strip.scrollWidth > strip.clientWidth + 4) {
      const target = activeBtn.offsetLeft - (strip.clientWidth - activeBtn.offsetWidth) / 2;
      strip.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
    }
    state.settings.musicService = svc;
    window.nova.settings.set({ musicService: svc });
    npView = views[svc] ? views[svc].wv : null;
    setTimeout(pollNowPlaying, 250);
    setTimeout(pollNowPlaying, 900);
  }
  // Service-Strip: Pfeile/Scroll-Status aktualisieren (zeigt nur was passt, Rest scrollt)
  function updateTabScroll() {
    const strip = $('#music-services'); const row = $('.music-tabs-row');
    if (!strip || !row) return;
    const over = strip.scrollWidth > strip.clientWidth + 4;
    row.classList.toggle('scrollable', over);
  }

  function toggle(force) {
    open = force != null ? force : !open;
    panel.classList.toggle('hidden', !open);
    $('#btn-music').classList.toggle('btn-music-active', open);
    if (open) {
      if (!current) show(state.settings.musicService || 'spotify');
      else if (views[current]) repaintMusic(views[current].wv);
      checkDrm();
      updateTabScroll();
      // Nach dem Einblenden (Animation) Größe & Compositing fixieren
      setTimeout(() => { sizeViews(); updateTabScroll(); if (current && views[current]) repaintMusic(views[current].wv); }, 380);
    }
  }

  $('#btn-music').addEventListener('click', () => toggle());
  $('#music-close').addEventListener('click', () => toggle(false));
  for (const b of panel.querySelectorAll('.music-svc')) {
    b.addEventListener('click', () => show(b.dataset.svc));
  }
  $('#music-reload').addEventListener('click', () => { if (current && views[current]) views[current].wv.reload(); });
  $('#music-popout').addEventListener('click', () => {
    if (current) { createTab(SERVICES[current].url); toggle(false); }
  });

  // Lautstärke (nur Musik)
  let volSaveTimer;
  $('#music-vol').addEventListener('input', (e) => {
    volume = +e.target.value;
    if (volume > 0) muted = false;
    pushVolume();
    clearTimeout(volSaveTimer);
    volSaveTimer = setTimeout(() => {
      state.settings.musicVolume = volume;
      state.settings.musicMuted = muted;
      window.nova.settings.set({ musicVolume: volume, musicMuted: muted });
    }, 300);
  });
  $('#music-vol-btn').addEventListener('click', () => {
    muted = !muted;
    pushVolume();
    state.settings.musicMuted = muted;
    window.nova.settings.set({ musicMuted: muted });
  });

  // Breite per Ziehen anpassen
  $('#music-resize').addEventListener('mousedown', (e) => {
    e.preventDefault();
    $('#drag-shield').classList.remove('hidden');
    panel.classList.add('ms-resizing');   // Musik-Webview schluckt die Maus nicht → auch Verkleinern bleibt smooth
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    const onMove = (ev) => {
      const w = Math.min(720, Math.max(320, startW + (startX - ev.clientX)));
      panel.style.width = w + 'px';
      sizeViews();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      $('#drag-shield').classList.add('hidden');
      panel.classList.remove('ms-resizing');
      window.nova.settings.set({ musicWidth: panel.offsetWidth });
      if (current && views[current]) repaintMusic(views[current].wv);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function applySettings() {
    if (state.settings.musicWidth) panel.style.width = state.settings.musicWidth + 'px';
    volume = typeof state.settings.musicVolume === 'number' ? state.settings.musicVolume : 100;
    muted = !!state.settings.musicMuted;
    $('#music-vol').value = volume;
    pushVolume();
  }

  // DRM-Status prüfen: ohne Widevine starten Spotify/Apple Music keine Titel.
  // Bei Problemen einen klaren Hinweis statt stiller Stille zeigen.
  let drmChecked = false;
  async function checkDrm() {
    if (drmChecked) return;
    let drm = null;
    try { drm = await window.nova.music.drm(); } catch {}
    if (!drm || drm.ready) { drmChecked = !!(drm && drm.ready); return; }
    if (panel.querySelector('.music-drm')) return;
    const bar = el('div', 'music-drm');
    bar.appendChild(icon('i-warn'));
    bar.appendChild(el('span', null, drm.available
      ? 'DRM wird geladen — falls ein Titel nicht startet, einmal „Neu laden".'
      : 'Widevine-DRM nicht verfügbar. Bitte NOVA neu starten, damit die Wiedergabe funktioniert.'));
    panel.querySelector('.music-head').after(bar);
  }

  // ---------------- Mini-Player in der Topbar ----------------
  const READ_NP = `(function(){try{
    var md=navigator.mediaSession&&navigator.mediaSession.metadata;
    var m=document.querySelector('video,audio');
    var art='';
    if(md&&md.artwork&&md.artwork.length){art=(md.artwork[md.artwork.length-1]||{}).src||(md.artwork[0]||{}).src||'';}
    var playing=!!m&&!m.paused&&!m.ended, pos=m?m.currentTime:0, dur=(m&&isFinite(m.duration))?m.duration:0;
    // Zuverlässigster Abspielstatus über die MediaSession (von Apple/Spotify/YT gesetzt) —
    // das <audio>-Element meldet bei DRM/MSE oft falsch „pausiert".
    try{var pbs=navigator.mediaSession&&navigator.mediaSession.playbackState;if(pbs==='playing')playing=true;else if(pbs==='paused')playing=false;}catch(e){}
    // Spotify: das <audio>-Element (MSE/DRM) liefert Zeit/Status unzuverlässig → aus der
    // Player-Leiste lesen (Play/Pause-Aria-Label + Positions-/Dauer-Text "m:ss").
    if(/spotify/.test(location.hostname)){
      try{
        var pp=document.querySelector('[data-testid="control-button-playpause"]');
        if(pp){var lbl=(pp.getAttribute('aria-label')||'').toLowerCase(); if(/pause|pausieren/.test(lbl))playing=true; else if(/play|wiedergabe|abspielen/.test(lbl))playing=false;}
        var toSec=function(t){t=(t||'').trim();if(!/^\\d+:\\d{2}/.test(t))return null;var p=t.split(':').map(Number);return p.length===3?p[0]*3600+p[1]*60+p[2]:p[0]*60+p[1];};
        var ppos=document.querySelector('[data-testid="playback-position"]'), pdur=document.querySelector('[data-testid="playback-duration"]');
        var sp=ppos?toSec(ppos.textContent):null, sd=pdur?toSec(pdur.textContent):null;
        if(sp!=null)pos=sp; if(sd!=null&&sd>0)dur=sd;
        if(!md){var t2=document.querySelector('[data-testid="context-item-info-title"], [data-testid="now-playing-widget"] a');var a2=document.querySelector('[data-testid="context-item-info-subtitles"] a, a[data-testid="context-item-info-artist"]');if(t2)return{ok:true,title:(t2.textContent||'').trim(),artist:a2?(a2.textContent||'').trim():'',art:art,playing:playing,pos:pos,dur:dur};}
      }catch(e){}
    }
    // Apple Music: Zeit aus dem Fortschritts-Slider lesen (das <audio>-Element ist bei DRM
    // unzuverlässig). Status kommt aus der MediaSession (oben). Lautstärke-Slider via valuemax>5 raus.
    if(/music\\.apple\\.com/.test(location.hostname)){
      try{
        var st=[document],g=0,best=null;
        while(st.length&&g++<30000){
          var r=st.shift(),els;try{els=r.querySelectorAll('[role="slider"],input[type="range"]');}catch(e){els=null;}
          if(els)for(var i=0;i<els.length;i++){var e=els[i];
            var vmax=parseFloat(e.getAttribute&&e.getAttribute('aria-valuemax')),vnow=parseFloat(e.getAttribute&&e.getAttribute('aria-valuenow'));
            if(!isNaN(vmax)&&vmax>5&&!isNaN(vnow)&&(!best||vmax>best.max))best={now:vnow,max:vmax};
          }
          var al;try{al=r.querySelectorAll('*');}catch(e){continue;}
          for(var j=0;j<al.length;j++){if(al[j].shadowRoot)st.push(al[j].shadowRoot);}
        }
        if(best){pos=best.now;dur=best.max;}
      }catch(e){}
    }
    return {ok:!!md,title:md?md.title:'',artist:md?md.artist:'',art:art,playing:playing,pos:pos,dur:dur};
  }catch(e){return {ok:false};}})()`;
  const cmdScript = (action) => `(function(){try{
    var host=location.hostname,m=document.querySelector('video,audio');
    // Tiefe Suche inkl. Shadow-DOM (Apple Music kapselt die Steuerung in Shadow-Roots)
    function deepQuery(sels){
      var stack=[document];var guard=0;
      while(stack.length&&guard++<30000){
        var root=stack.shift();
        for(var i=0;i<sels.length;i++){try{var el=root.querySelector(sels[i]);if(el)return el;}catch(e){}}
        var all;try{all=root.querySelectorAll('*');}catch(e){continue;}
        for(var j=0;j<all.length;j++){if(all[j].shadowRoot)stack.push(all[j].shadowRoot);}
      }
      return null;
    }
    function fire(el){ ['pointerover','pointerenter','pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){ try{ el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window})); }catch(e){} }); try{ el.click(); }catch(e){} }
    function clickDeep(sels){var el=deepQuery(sels);if(el){fire(el);return true;}return false;}
    // Positions-basiert (robust gegen Label-/Selektor-Änderungen): Play/Pause finden,
    // dann den Transport-Nachbarn klicken (Spul-Buttons werden ausgeschlossen).
    function transportNeighbor(dir){
      var pp=deepQuery(['[data-testid="control-button-playpause"]','[data-testid="playback-controls__play-pause"]','button.web-chrome-playback-controls__playback-btn','button[aria-label="Pause"]','button[aria-label="Play"]','button[aria-label="Wiedergabe"]','button[aria-label="Pausieren"]','button[aria-label="Abspielen"]','button[aria-label="Anhalten"]']);
      if(!pp)return false;
      var row=pp.parentElement,hop=0;
      // bis zu 3 Ebenen hoch, bis mehrere Transport-Buttons im Container liegen
      while(row&&hop++<3){ var c=row.querySelectorAll('button,[role="button"]'); if(c&&c.length>=2)break; row=row.parentElement; }
      if(!row)return false;
      var all=[];var list=row.querySelectorAll('button,[role="button"]');
      for(var i=0;i<list.length;i++){var b=list[i];var l=((b.getAttribute&&(b.getAttribute('aria-label')||b.getAttribute('title')))||'').trim();if(!SEEK.test(l))all.push(b);}
      var idx=all.indexOf(pp); if(idx<0)return false;
      var t=dir==='next'?all[idx+1]:all[idx-1];
      if(t){fire(t);return true;}
      return false;
    }
    // Den ECHTEN Play/Pause-Transport-Button finden: einen Play/Pause-Button, der im selben
    // Cluster wie Skip-Buttons sitzt (so wird NIE ein Song-/Playlist-"Play" getroffen → kein
    // Lied-Wechsel). Funktioniert über Shadow-DOM (Apple Music) und für alle Dienste.
    function transportPlayPause(){
      var ppRx=/^(play|pause|wiedergabe|pausieren|abspielen|anhalten|fortsetzen|wiedergeben|titel pausieren|titel abspielen)$/i;
      var skipRx=/(n(ä|ae)chst|next|weiter|vorherig|previous|zur(ü|ue)ck|skip)/i;
      var stack=[document],guard=0,cands=[];
      while(stack.length&&guard++<30000){
        var root=stack.shift();
        var btns;try{btns=root.querySelectorAll('button,[role="button"]');}catch(e){btns=null;}
        if(btns)for(var i=0;i<btns.length;i++){var l=((btns[i].getAttribute&&(btns[i].getAttribute('aria-label')||btns[i].getAttribute('title')))||'').trim();if(ppRx.test(l))cands.push(btns[i]);}
        var all;try{all=root.querySelectorAll('*');}catch(e){continue;}
        for(var j=0;j<all.length;j++){if(all[j].shadowRoot)stack.push(all[j].shadowRoot);}
      }
      // bevorzugt: Kandidat, dessen Vorfahre auch Skip-Buttons enthält (= Transport-Cluster)
      for(var k=0;k<cands.length;k++){
        var p=cands[k],hop=0;
        while(p&&hop++<5){
          var grp;try{grp=p.querySelectorAll&&p.querySelectorAll('button,[role="button"]');}catch(e){grp=null;}
          if(grp&&grp.length>=2){var skip=false;for(var s=0;s<grp.length;s++){var sl=((grp[s].getAttribute&&(grp[s].getAttribute('aria-label')||grp[s].getAttribute('title')))||'');if(skipRx.test(sl)){skip=true;break;}}if(skip){fire(cands[k]);return true;}}
          p=p.parentElement;
        }
      }
      return false;
    }
    // Tiefe Suche nach Button per Label (inc treffen, exc ausschließen — verhindert,
    // dass Vor-/Zurückspulen-Buttons („Skip Forward 15s") statt Titelwechsel klicken).
    function clickByLabel(inc, exc){
      var stack=[document],guard=0;
      while(stack.length&&guard++<4000){
        var root=stack.shift();
        var btns;try{btns=root.querySelectorAll('button,[role="button"],a[aria-label]');}catch(e){btns=[];}
        for(var i=0;i<btns.length;i++){var b=btns[i];var lbl=(b.getAttribute&&(b.getAttribute('aria-label')||b.getAttribute('title')))||'';lbl=lbl.trim();if(lbl&&inc.test(lbl)&&!(exc&&exc.test(lbl))){fire(b);return true;}}
        var all;try{all=root.querySelectorAll('*');}catch(e){continue;}
        for(var j=0;j<all.length;j++){if(all[j].shadowRoot)stack.push(all[j].shadowRoot);}
      }
      return false;
    }
    // Seek-/Spul-Buttons sicher ausschließen
    var SEEK=/forward|backward|vorspul|r(ü|ue)ckspul|rewind|skip\s*\d|\d+\s*(s|sek|sec|second)|fast/i;
    var A=${JSON.stringify(action)};
    if(A==='playpause'){
      // 1) eindeutige Transport-Buttons (Spotify/YT) — exakte Selektoren
      if(clickDeep(['[data-testid="control-button-playpause"]','ytmusic-player-bar #play-pause-button','#play-pause-button']))return true;
      // 2) Play/Pause im Transport-Cluster (mit Skip-Nachbarn) — Apple Music & generisch,
      //    trifft NIE einen Song-Play-Button → kein Lied-Wechsel.
      if(transportPlayPause())return true;
      // 3) Failsafe: Medienelement umschalten (pause klappt immer)
      if(m){try{m.paused?m.play():m.pause();}catch(e){}return true;}
      return false;
    }else if(A==='next'){
      if(clickDeep(['[data-testid="control-button-skip-forward"]','button.web-chrome-playback-controls__next','[data-testid="playback-controls__skip-next"]','ytmusic-player-bar .next-button','tp-yt-paper-icon-button.next-button','.skipControl__next','button[aria-label="Nächster Titel"]','button[aria-label="Next"]','button[aria-label="Weiter"]','button[aria-label="Play Next"]','button[aria-label="Next track"]','button[aria-label="Nächsten Titel abspielen"]','button[aria-label="Vorspulen zum nächsten Titel"]']))return true;
      // strikt: nur echte „nächster Titel"-Beschriftungen, KEINE Spul-Buttons
      if(clickByLabel(/^(n(ä|ae)chster titel|next( track| song)?|weiter|n(ä|ae)chstes|n(ä|ae)chsten titel( abspielen)?)$/i, SEEK))return true;
      // robuster Positions-Fallback (v.a. Apple Music)
      return transportNeighbor('next');
    }else if(A==='prev'){
      if(clickDeep(['[data-testid="control-button-skip-back"]','button.web-chrome-playback-controls__previous','[data-testid="playback-controls__skip-previous"]','ytmusic-player-bar .previous-button','tp-yt-paper-icon-button.previous-button','.skipControl__previous','.playControls__prev','button[aria-label="Vorheriger Titel"]','button[aria-label="Previous"]','button[aria-label="Zurück"]','button[aria-label="Play Previous"]','button[aria-label="Previous track"]','button[aria-label="Vorherigen Titel abspielen"]']))return true;
      if(clickByLabel(/^(vorheriger titel|previous( track| song)?|zur(ü|ue)ck|vorheriges|vorherigen titel( abspielen)?)$/i, SEEK))return true;
      return transportNeighbor('prev');
    }
    return false;}catch(e){return false;}})()`;

  const mini = $('#mini-music');
  let npView = null;     // Webview, der gerade spielt
  let lastNp = null;
  const posTrack = {};   // svc|title -> {pos, t}  → erkennt Wiedergabe an fortlaufender Zeit

  // HARD-SWITCH: nur den AKTIVEN Dienst auslesen (andere sind pausiert) → Steuerung folgt dem Tab
  async function pollNowPlaying() {
    const v = current && views[current];
    if (!v || !v.wv) { renderNow(null); return; }
    let np = null;
    try { np = await v.wv.executeJavaScript(READ_NP, true); } catch { np = null; }
    if (np && np.ok && (np.title || np.artist)) {
      // BULLETPROOF Abspielstatus: läuft die Position weiter → es SPIELT (egal was DOM/Element sagt).
      // Behebt Apple, wo <audio>/mediaSession fälschlich „pausiert" melden.
      try {
        const key = current + '|' + (np.title || '');
        const now = performance.now();
        const prev = posTrack[key];
        if (prev && (now - prev.t) < 4500) {
          if (np.pos > prev.pos + 0.25) np.playing = true;                 // Zeit läuft → spielt
          else if (np.pos <= prev.pos + 0.02 && !np.playing) np.playing = false; // steht still → pausiert
        }
        posTrack[key] = { pos: np.pos, t: now };
      } catch {}
      npView = v.wv; renderNow(np);
    } else renderNow(null);
  }

  const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); };

  // Aktualisiert BEIDE Anzeigen: Topbar-Mini-Player UND den In-Panel-Now-Playing-Balken.
  function renderNow(np) {
    lastNp = np;
    if (!np) { mini.classList.add('hidden'); }
    else {
      mini.classList.remove('hidden');
      $('#mm-title').textContent = np.title || 'Unbekannter Titel';
      $('#mm-artist').textContent = np.artist || '';
      const img = $('#mm-art-img');
      if (np.art && img.dataset.src !== np.art) { img.dataset.src = np.art; img.src = np.art; img.classList.add('show'); }
      if (!np.art) { img.classList.remove('show'); img.removeAttribute('src'); img.dataset.src = ''; }
      const use = $('#mm-playpause').querySelector('use'); if (use) use.setAttribute('href', np.playing ? '#i-pause' : '#i-play');
      $('#mm-progress').style.width = (np.dur > 0 ? Math.min(100, (np.pos / np.dur) * 100) : 0) + '%';
    }
    // In-Panel
    const pt = $('#mp-title'), pa = $('#mp-artist'), pbar = $('#mp-bar-fill'), ptm = $('#mp-time');
    const pimg = $('#mp-art-img'), pplay = $('#mp-play') && $('#mp-play').querySelector('use');
    if (!pt) return;
    if (!np) {
      pt.textContent = 'Nichts spielt gerade'; pa.textContent = '';
      if (pimg) { pimg.classList.remove('show'); pimg.removeAttribute('src'); pimg.dataset.src = ''; }
      if (pbar) pbar.style.width = '0%'; if (ptm) ptm.textContent = '';
      if (pplay) pplay.setAttribute('href', '#i-play');
    } else {
      pt.textContent = np.title || 'Unbekannter Titel'; pa.textContent = np.artist || '';
      if (pimg) { if (np.art && pimg.dataset.src !== np.art) { pimg.dataset.src = np.art; pimg.src = np.art; pimg.classList.add('show'); } if (!np.art) { pimg.classList.remove('show'); pimg.removeAttribute('src'); pimg.dataset.src = ''; } }
      if (pplay) pplay.setAttribute('href', np.playing ? '#i-pause' : '#i-play');
      if (pbar) pbar.style.width = (np.dur > 0 ? Math.min(100, (np.pos / np.dur) * 100) : 0) + '%';
      if (ptm) ptm.textContent = np.dur > 0 ? (fmtTime(np.pos) + ' / ' + fmtTime(np.dur)) : '';
    }
  }
  function hideMini() { mini.classList.add('hidden'); }

  // Spielt gerade ein NORMALER Browser-Tab Ton (z.B. YouTube-Video)? Dann darf die GLOBALE
  // System-Medientaste nicht benutzt werden — Chromium würde sie an diese MediaSession routen
  // und das Video pausieren statt die Musik. Stattdessen gezielt an die Musik-Webview senden.
  function anyOtherTabAudible() {
    try { return state.tabs.some((t) => { try { return t.wv && t.wv.isCurrentlyAudible && t.wv.isCurrentlyAudible(); } catch { return false; } }); }
    catch { return false; }
  }

  // Steuert IMMER den aktiven Dienst (Hard-Switch). Genutzt von Topbar-Mini UND In-Panel-Transport.
  // Mehrfach-Klicks während des Umschaltens entkoppeln (verhindert Doppel-Skip/Race).
  let cmdBusy = false;
  async function command(action) {
    const v = current && views[current] && views[current].wv;
    if (!v || cmdBusy) return;
    cmdBusy = true;
    try {
      let wcId = null; try { wcId = v.getWebContentsId(); } catch {}
      let host = ''; try { host = new URL(v.getURL()).hostname; } catch {}
      const isApple = /(^|\.)music\.apple\.com$/.test(host) || host.indexOf('apple') >= 0;
      const mkey = action === 'next' ? 'MediaNextTrack' : action === 'prev' ? 'MediaPreviousTrack' : 'MediaPlayPause';
      if (isApple) {
        // Apple Music reagiert am zuverlässigsten auf die System-Medientaste. ABER: läuft daneben ein
        // YouTube-Video o.ä., würde die GLOBALE Taste das Video treffen → dann gezielt an Apples Webview.
        if (!anyOtherTabAudible()) window.nova.music.hwMediaKey(action);
        else if (wcId) window.nova.music.mediaKey({ wcId, key: mkey });
        else window.nova.music.hwMediaKey(action);
      } else if (action === 'playpause') {
        // Spotify / YouTube Music: exakter Transport-Button (kein Lied-Wechsel) bzw. Element-Toggle — rein im Musik-Webview.
        let ok = false; try { ok = await v.executeJavaScript(cmdScript('playpause'), true); } catch {}
        if (!ok && wcId) window.nova.music.mediaKey({ wcId, key: mkey });   // gezielt, NIE global → trifft kein anderes Tab
      } else {
        // Spotify / YouTube Music Skip: exakter Skip-Button im DOM, sonst GEZIELTE Medientaste (nie global).
        let ok = false; try { ok = await v.executeJavaScript(cmdScript(action), true); } catch {}
        if (!ok && wcId) window.nova.music.mediaKey({ wcId, key: mkey });
        else if (!ok && !wcId && !anyOtherTabAudible()) window.nova.music.hwMediaKey(action);
      }
    } finally {
      setTimeout(() => { cmdBusy = false; }, 450);   // kurze Sperre gegen Doppelauslösung
    }
    setTimeout(pollNowPlaying, 380);
    setTimeout(pollNowPlaying, 1150);
  }
  // Topbar-Mini-Player
  $('#mm-playpause').addEventListener('click', (e) => { e.stopPropagation(); command('playpause'); });
  $('#mm-next').addEventListener('click', (e) => { e.stopPropagation(); command('next'); });
  $('#mm-prev').addEventListener('click', (e) => { e.stopPropagation(); command('prev'); });
  mini.addEventListener('click', () => toggle(true));
  // In-Panel-Transport
  $('#mp-play').addEventListener('click', () => command('playpause'));
  $('#mp-next').addEventListener('click', () => command('next'));
  $('#mp-prev').addEventListener('click', () => command('prev'));
  // Service-Strip scrollen
  $('#music-tabs-left').addEventListener('click', () => { $('#music-services').scrollBy({ left: -140, behavior: 'smooth' }); });
  $('#music-tabs-right').addEventListener('click', () => { $('#music-services').scrollBy({ left: 140, behavior: 'smooth' }); });
  $('#music-services').addEventListener('scroll', () => {});

  setInterval(pollNowPlaying, 1500);

  // Bei Fenstergrößenänderung die Player-Webviews mitskalieren
  window.addEventListener('resize', () => { if (open) { sizeViews(); updateTabScroll(); } });
  return { toggle, show, applySettings, checkDrm, pollNowPlaying };
})();

/* ============================================================ Claude (NOVA AI) */
// Schritt 1 — Fundament: claude.ai eingebettet, Login bleibt erhalten (eigene
// persistente Session, kein API-Key). Agent-Browsing/Coding bauen darauf auf.
const claude = (() => {
  const PART = 'persist:nova-claude';
  const panel = $('#claude-panel');
  const body = $('#claude-body');
  let wv = null, open = false, busy = false, abortFlag = false;   // wv = NUTZER-Chat; busy = Agent plant; abortFlag = sofort stoppen
  let agentWv = null;   // EIGENE Claude-Webview NUR für den Agenten (gleiches Login, eigener Chat) → Nutzer-Chat bleibt frei

  // ---- Andocken / Quick-Snap ----
  let dock = 'float';            // float | left | right | split-left | split-right
  let floatPos = null;          // {left, top, width, height}
  const DOCK_W = 400, GAP = 10;
  const preview = el('div', 'snap-preview hidden');
  document.body.appendChild(preview);
  const va = () => $('#view-area');
  const contentRect = () => va().getBoundingClientRect();
  const DOCK_CLASSES = ['cl-left', 'cl-right', 'cl-split-left', 'cl-split-right', 'cl-float'];

  // Zielrechteck einer Snap-Zone (für Panel-Position UND Vorschau)
  // Andock-Zonen: links / rechts / split-links / split-rechts (kein "unten" – ergibt keinen Sinn)
  function rectForZone(zone) {
    const r = contentRect();
    if (zone === 'left') return { left: r.left, top: r.top, width: DOCK_W, height: r.height };
    if (zone === 'right') return { left: r.right - DOCK_W, top: r.top, width: DOCK_W, height: r.height };
    if (zone === 'split-left') { const w = r.width / 2 - GAP / 2; return { left: r.left, top: r.top, width: w, height: r.height }; }
    if (zone === 'split-right') { const w = r.width / 2 - GAP / 2; return { left: r.right - w, top: r.top, width: w, height: r.height }; }
    return null;
  }
  // Snap-Zone für eine Cursor-Position bestimmen
  function zoneFor(x, y) {
    const r = contentRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return 'float';
    const rx = (x - r.left) / r.width;
    if (rx < 0.12) return 'left';
    if (rx > 0.88) return 'right';
    if (rx > 0.30 && rx < 0.70) return rx < 0.5 ? 'split-left' : 'split-right';
    return 'float';
  }
  function showPreview(zone) {
    const rc = rectForZone(zone);
    if (!rc) { preview.classList.add('hidden'); return; }
    preview.style.left = rc.left + 'px'; preview.style.top = rc.top + 'px';
    preview.style.width = rc.width + 'px'; preview.style.height = rc.height + 'px';
    preview.classList.remove('hidden');
  }

  // Panel + Web-Inhalt entsprechend des Andock-Modus platzieren
  function layoutDock() {
    DOCK_CLASSES.forEach((c) => document.body.classList.remove(c));
    const v = va();
    v.style.paddingLeft = v.style.paddingRight = v.style.paddingBottom = '';
    if (!open) return;
    const setPanel = (l, t, w, h) => {
      panel.style.left = l + 'px'; panel.style.top = t + 'px';
      panel.style.width = w + 'px'; panel.style.height = h + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    };
    if (dock === 'float') {
      document.body.classList.add('cl-float');
      const r = contentRect();
      const fp = floatPos || { left: r.left + 14, top: r.top + 14, width: 440, height: Math.min(700, r.height - 28) };
      setPanel(fp.left, fp.top, fp.width, fp.height);
    } else {
      const rc = rectForZone(dock);
      if (!rc) { dock = 'right'; layoutDock(); return; }   // unbekannter/alter Modus (z.B. "bottom") → rechts
      document.body.classList.add('cl-' + dock);
      setPanel(rc.left, rc.top, rc.width, rc.height);
      if (dock === 'left') v.style.paddingLeft = (DOCK_W + GAP) + 'px';
      else if (dock === 'right') v.style.paddingRight = (DOCK_W + GAP) + 'px';
      else if (dock === 'split-left') v.style.paddingLeft = (rc.width + GAP) + 'px';
      else if (dock === 'split-right') v.style.paddingRight = (rc.width + GAP) + 'px';
    }
    repaint();   // Zoom folgt zusätzlich automatisch dem ResizeObserver auf #claude-body
  }
  function setDock(mode) {
    if (mode === 'bottom') mode = 'right';   // "unten" wurde entfernt
    dock = mode; window.nova.settings.set({ claudeDock: mode }); layoutDock();
  }

  function ensureView() {
    if (wv) return wv;
    const loading = el('div', 'claude-loading');
    loading.appendChild(el('div', 'ms-spin'));
    loading.appendChild(el('span', null, 'Claude wird geladen … melde dich mit deinem Account an.'));
    wv = document.createElement('webview');
    wv.setAttribute('partition', PART);
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=no');
    wv.setAttribute('src', 'https://claude.ai/new');
    wv.addEventListener('did-stop-loading', () => { loading.style.display = 'none'; repaint(); });
    wv.addEventListener('dom-ready', repaint);
    body.append(loading, wv);
    // Zoom an die TATSÄCHLICHE Body-Breite koppeln — feuert während der gesamten
    // Dock-Animation und am Ende, also auch bei mehrfachem Umdocken immer korrekt.
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => applyClaudeZoom());
      ro.observe(body);
    }
    return wv;
  }
  // EIGENE, dauerhaft off-screen gerenderte Claude-Webview NUR für den Agenten (gleiche Session = geteiltes Login).
  // So plant der Agent unabhängig, während der Nutzer den normalen Chat (wv) ganz normal weiterbenutzen kann.
  function ensureAgentView() {
    if (agentWv) return agentWv;
    let host = document.getElementById('claude-agent-host');
    if (!host) { host = el('div'); host.id = 'claude-agent-host'; document.body.appendChild(host); }
    agentWv = document.createElement('webview');
    agentWv.setAttribute('partition', PART);
    agentWv.setAttribute('allowpopups', '');
    agentWv.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=no,backgroundThrottling=no');
    agentWv.setAttribute('src', 'https://claude.ai/new');
    host.appendChild(agentWv);
    return agentWv;
  }
  // claude.ai an die Panel-Breite anpassen: schmale Docks zoomen raus, damit das
  // Layout passt statt riesig/abgeschnitten zu wirken (wie der Spotify-Trick).
  // Liest IMMER die echte aktuelle Body-Breite — wird vom ResizeObserver getrieben,
  // daher keine Timing-/Stale-Breite-Probleme mehr beim mehrfachen Umdocken.
  function applyClaudeZoom() {
    if (!wv) return;
    const w = body.clientWidth;
    if (!w) return;
    let z = Math.max(0.55, Math.min(1, w / 640));
    // In den schmalen Vollhöhen-Docks (ganz links/rechts) Text ~30% größer → besser lesbar.
    // Split-View & frei schwebend bleiben passgenau.
    if (dock === 'left' || dock === 'right') z = Math.min(1.15, z * 1.3);
    try { if (Math.abs((wv.getZoomFactor ? wv.getZoomFactor() : 0) - z) > 0.001) wv.setZoomFactor(z); } catch { try { wv.setZoomFactor(z); } catch {} }
  }
  // Electron-Compositing-Fix (schwarzer Bereich) — Höhe kurz anstoßen, dann zurück auf CSS 100%.
  // KEINE feste Pixel-Breite mehr setzen: das Webview bleibt per CSS width:100% an der Panel-
  // Breite kleben → es kann sich nicht mehr eine alte (zu schmale) Breite „merken".
  function repaint() {
    if (!wv) return;
    requestAnimationFrame(() => {
      const h = body.clientHeight;
      if (!h) return;
      wv.style.width = ''; wv.style.height = (h - 1) + 'px';
      applyClaudeZoom();
      requestAnimationFrame(() => { wv.style.height = ''; applyClaudeZoom(); });
    });
  }
  let agentOn = false;
  let clCloseT = null;
  function toggle(force) {
    open = force != null ? force : !open;
    $('#btn-claude').classList.toggle('btn-claude-active', open);
    if (open) {
      clearTimeout(clCloseT);
      panel.classList.remove('hidden', 'cl-closing');
      ensureView(); layoutDock(); setTimeout(repaint, 380);
    } else {
      // sanftes Ausblenden statt abruptem Verschwinden
      if (!panel.classList.contains('hidden')) {
        panel.classList.add('cl-closing');
        clearTimeout(clCloseT);
        clCloseT = setTimeout(() => { panel.classList.add('hidden'); panel.classList.remove('cl-closing'); }, 240);
      }
      layoutDock(); if (agentOn) setAgent(false);
    }
  }
  function close() { toggle(false); }

  // ---- Agent-Modus: Werkzeugleiste ein, Standard-Andock rechts ----
  function setAgent(on) {
    agentOn = on;
    document.body.classList.toggle('agent-on', on);
    $('#claude-agentbar').classList.toggle('hidden', !on);
    $('#claude-agent').classList.toggle('active-tool', on);
    if (on) {
      if (!open) toggle(true);
      if (dock === 'float') setDock('right');   // beim Start sinnvoll rechts andocken
      const sp = currentSpace && currentSpace();
      if (sp && sp.splitTabId) { sp.splitTabId = null; updateWebviewLayout(); syncTabActiveClasses(); }
      caLog('Agent-Modus aktiv — öffne eine Seite und sende sie an Claude');
    }
    setTimeout(() => { layoutDock(); repaint(); }, 320);
  }

  function caLog(msg, warn) {
    const log = $('#ca-log');
    const row = el('div', 'ca-log-row' + (warn ? ' warn' : ''));
    row.appendChild(el('span', 'ca-dot'));
    row.appendChild(el('span', null, msg));
    log.appendChild(row);
    while (log.childElementCount > 6) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  const EXTRACT = `(function(){try{
    function c(t){return (t||'').replace(/\\s+/g,' ').trim();}
    var main = document.querySelector('main,article,[role="main"]') || document.body;
    return { title: document.title||'', url: location.href||'', text: c(main.innerText).slice(0,6000) };
  }catch(e){ return { title:'', url:(location&&location.href)||'', text:'' }; }})()`;

  function injectScript(message) {
    return `(function(){try{
      var ed = document.querySelector('div.ProseMirror[contenteditable="true"]') || document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
      if(!ed) return 'noeditor';
      ed.focus();
      var msg = ${JSON.stringify(message)};
      if (ed.tagName==='TEXTAREA'){ ed.value = msg; ed.dispatchEvent(new Event('input',{bubbles:true})); }
      else { try { document.execCommand('selectAll',false,null); document.execCommand('insertText',false,msg); } catch(e){} }
      setTimeout(function(){
        var b = document.querySelector('button[aria-label="Send message"]')||document.querySelector('button[aria-label="Nachricht senden"]')||document.querySelector('button[data-testid="send-button"]')||document.querySelector('fieldset button[type="submit"]');
        if(b) b.click();
      }, 180);
      return 'ok';
    }catch(e){ return 'err'; }})()`;
  }

  // Ist Claude bereit? (claude.ai geladen + eingeloggt → Eingabefeld vorhanden)
  const READY = `(function(){try{ return !!(document.querySelector('div.ProseMirror[contenteditable="true"]')||document.querySelector('[contenteditable="true"]')||document.querySelector('textarea')); }catch(e){ return false; }})()`;
  // Hat der Editor noch (ungesendeten) Text? → unterscheidet „Senden fehlgeschlagen" von „gesendet, Claude antwortet noch"
  const EDITOR_HAS_TEXT = `(function(){try{ var e=document.querySelector('div.ProseMirror[contenteditable="true"]')||document.querySelector('[contenteditable="true"]')||document.querySelector('textarea'); return e?((e.innerText||e.value||'').trim().length>3):false; }catch(e){ return false; }})()`;
  // Pollt, bis der Editor existiert — verhindert „zu früh gefragt" beim allerersten Start
  async function waitReady(maxMs, w) {
    w = w || wv; if (!w) return false;
    const tries = Math.ceil((maxMs || 22000) / 500);
    let hits = 0;
    for (let i = 0; i < tries; i++) {
      if (abortFlag) return false;             // Stop-Button → nicht weiter warten
      let ok = false; try { ok = await w.executeJavaScript(READY, true); } catch {}
      // Editor muss 2× hintereinander da sein → kein transienter Treffer des ALTEN Chats während der Navigation
      if (ok) { if (++hits >= 2) return true; } else hits = 0;
      await sleep(500);
    }
    return false;
  }

  const PROMPTS = {
    summary: 'Fasse den Inhalt dieser Webseite klar und strukturiert zusammen.',
    explain: 'Erkläre den Inhalt dieser Seite einfach und verständlich.',
    sources: 'Bewerte diese Seite kritisch: Wie glaubwürdig sind Inhalt und Quellen?',
    key: 'Liste die wichtigsten Kernpunkte dieser Seite als kompakte Stichpunkte.',
  };

  async function sendToClaude(promptText) {
    const tab = activeTab();
    if (!tab || !tab.wv || !isWebUrl(tab.url)) { caLog('Keine Webseite aktiv — öffne erst eine Seite', true); return; }
    if (!open) toggle(true);
    caLog('Lese aktuelle Seite …');
    let page = null;
    try { page = await tab.wv.executeJavaScript(EXTRACT, true); } catch {}
    if (!page || !page.text) { caLog('Seiteninhalt konnte nicht gelesen werden', true); return; }
    const message = `${promptText}\n\nSeite: ${page.title} (${page.url})\n\n"""\n${page.text}\n"""`;
    caLog(`Seite gelesen (${page.text.length} Zeichen)`);
    // Fallback: in die Zwischenablage, falls die Einschleusung scheitert
    try { await navigator.clipboard.writeText(message); } catch {}
    let res = 'err';
    try { res = await wv.executeJavaScript(injectScript(message), true); } catch {}
    if (res === 'ok') caLog('An Claude gesendet ✓');
    else if (res === 'noeditor') caLog('Bitte zuerst in Claude anmelden — Text liegt in der Zwischenablage', true);
    else caLog('Senden fehlgeschlagen — Text liegt in der Zwischenablage (einfügen)', true);
  }

  // Rohe Nachricht an Claude schleusen (z.B. vom NOVA Operator zur Planung genutzt)
  async function ask(message) {
    if (!open) toggle(true);
    ensureView();
    try { await navigator.clipboard.writeText(message); } catch {}
    setTimeout(async () => { try { await wv.executeJavaScript(injectScript(message), true); } catch {} }, 600);
  }

  // Nachricht senden UND auf die nächste, stabile Antwort warten → Text zurückgeben.
  // Genutzt vom NOVA Operator für die autonome Schritt-für-Schritt-Steuerung.
  // Claude unsichtbar, aber GERENDERT halten (off-screen) — claude.ai mountet den Editor nur,
  // wenn die Webview nicht display:none ist. So plant der Agent im Hintergrund, ohne das Chat-Panel aufzupoppen.
  // Der Zustand bleibt über den ganzen Agent-Lauf bestehen (prepare → mehrere runOnce → release),
  // damit der Editor zwischen den Schritten nicht ab- und neu aufgebaut wird.
  function bgShow() { if (open) return; panel.classList.remove('hidden'); panel.classList.add('cl-bg'); }
  function bgHide() { panel.classList.remove('cl-bg'); if (!open) panel.classList.add('hidden'); }
  // Agent-Claude (EIGENE Webview) vorbereiten: frischen /new-Chat + auf Editor warten. true=bereit, false=nicht eingeloggt.
  async function prepare() {
    busy = true; abortFlag = false;
    const fresh = !agentWv;
    ensureAgentView();
    if (fresh) {
      await sleep(900);                      // frische Webview lädt /new selbst
    } else {
      let cur = ''; try { cur = agentWv.getURL() || ''; } catch {}
      if (cur && !/about:blank/i.test(cur) && !/claude\.ai\/new(\/|$|\?)/.test(cur)) {
        try { agentWv.src = 'https://claude.ai/new'; } catch {}
        await sleep(1300);
      }
    }
    let ready = await waitReady(30000, agentWv);
    if (!ready && !abortFlag) {              // ein automatischer Wiederholversuch
      try { agentWv.src = 'https://claude.ai/new'; } catch {}
      await sleep(1600);
      ready = await waitReady(22000, agentWv);
    }
    return ready;                            // nicht eingeloggt → operate meldet es; Nutzer loggt sich im normalen Chat ein (geteilte Session)
  }
  function release() {
    busy = false;
    // Agent-Chat (eigene Webview) aufräumen + nächsten frischen Chat vorwärmen — beeinflusst den Nutzer-Chat NICHT.
    if (agentWv) {
      deleteCurrentChat().catch(() => {}).then(() => { if (agentWv) { try { agentWv.src = 'https://claude.ai/new'; } catch {} } });
    }
  }
  function abort() { abortFlag = true; }   // laufendes runOnce/waitReady sofort beenden (Stop-Button)
  // Frischen NUTZER-Chat öffnen (beim Klick aufs Claude-Icon). Unabhängig vom Agenten.
  function newChat() { if (!wv) return; try { wv.src = 'https://claude.ai/new'; } catch {} }

  // Agent-Chat NEU LADEN (Kontext bleibt serverseitig) → Absturz-Recovery.
  async function reloadChat() {
    if (!agentWv) return false;
    try { agentWv.reload(); } catch {}
    await sleep(600);
    return await waitReady(20000, agentWv);
  }
  // HARD-RESET: frischen Agent-Chat erzwingen → Selbstreparatur bei festgefahrenem/zu langem Chat.
  async function freshChat() {
    if (!agentWv) return false;
    try { agentWv.src = 'https://claude.ai/new'; } catch {}
    await sleep(1200);
    return await waitReady(22000, agentWv);
  }

  // Aktuelle (Agent-)Konversation aufräumen — best-effort, SEHR vorsichtig: nur das Sidebar-Element mit
  // GENAU dieser /chat/<id> wird angesteuert; Bestätigung nur über einen Button, dessen Text exakt „Löschen"/„Delete" ist.
  // Scheitert leise (z. B. wenn die Sidebar in der schmalen Hintergrund-Webview nicht gerendert ist).
  const OPEN_CHAT_MENU = `(function(){try{
    var id=(location.pathname.split('/chat/')[1]||'').split(/[\\/?#]/)[0];
    if(!id||id.length<8) return 'noid';
    var a=document.querySelector('a[href*="/chat/'+id+'"]');
    if(!a) return 'nolink';
    var row=a.closest('li')||a.parentElement; if(!row) return 'norow';
    try{ row.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); a.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); }catch(e){}
    var btn=row.querySelector('button[aria-haspopup="menu"],button[aria-label*="option" i],button[aria-label*="men" i],button[data-testid*="menu" i]');
    if(!btn) return 'nobtn';
    btn.click(); return 'ok';
  }catch(e){return 'err';}})()`;
  const CLICK_DELETE_ITEM = `(function(){try{
    var items=Array.prototype.slice.call(document.querySelectorAll('[role="menuitem"],[role="option"],[role="menuitemradio"]'));
    var d=items.find(function(x){return x.offsetParent&&/l(ö|oe)schen|delete|entfernen/i.test(x.textContent||'');});
    if(d){d.click();return true;} return false;
  }catch(e){return false;}})()`;
  const CONFIRM_DELETE = `(function(){try{
    var scope=document.querySelector('[role="dialog"],[role="alertdialog"]')||document;
    var btns=Array.prototype.slice.call(scope.querySelectorAll('button'));
    var d=btns.find(function(x){return x.offsetParent&&/^\\s*(l(ö|oe)schen|delete|entfernen)\\s*$/i.test((x.textContent||'').trim());});
    if(d){d.click();return true;} return false;
  }catch(e){return false;}})()`;
  async function deleteCurrentChat() {
    if (!agentWv) return false;
    try {
      let url = ''; try { url = agentWv.getURL() || ''; } catch {}
      if (!/claude\.ai\/chat\/[A-Za-z0-9-]{8,}/.test(url)) return false;   // nur echte, eindeutige Konversationen
      let o = 'no'; try { o = await agentWv.executeJavaScript(OPEN_CHAT_MENU, true); } catch {}
      if (o !== 'ok') return false;
      await sleep(450);
      let del = false; try { del = await agentWv.executeJavaScript(CLICK_DELETE_ITEM, true); } catch {}
      if (!del) { try { await agentWv.executeJavaScript('(function(){try{document.body.click();}catch(e){}})()', true); } catch {} return false; }
      await sleep(500);
      try { await agentWv.executeJavaScript(CONFIRM_DELETE, true); } catch {}
      await sleep(600);
      return true;
    } catch { return false; }
  }

  // ---- Modell-Auswahl auf claude.ai (best-effort über DOM; scheitert leise, Lauf geht weiter) ----
  const GET_MODEL = `(function(){try{
    var b=document.querySelector('button[data-testid="model-selector-dropdown"]')||Array.prototype.slice.call(document.querySelectorAll('button')).find(function(x){return /opus|sonnet|haiku|claude/i.test(x.textContent||'')&&x.offsetParent&&(x.textContent||'').trim().length<46;});
    return b?(b.textContent||'').trim():'';
  }catch(e){return '';}})()`;
  const OPEN_MODEL_MENU = `(function(){try{
    var b=document.querySelector('button[data-testid="model-selector-dropdown"]')||Array.prototype.slice.call(document.querySelectorAll('button')).find(function(x){return /opus|sonnet|haiku|claude/i.test(x.textContent||'')&&x.offsetParent&&(x.textContent||'').trim().length<46;});
    if(!b)return 'no'; b.click(); return 'opened';
  }catch(e){return 'err';}})()`;
  function PICK_MODEL(want) {
    return `(function(){try{
      var want=${JSON.stringify(want)};
      var items=Array.prototype.slice.call(document.querySelectorAll('[role="menuitem"],[role="option"],[role="menuitemradio"],a[role="menuitem"]'));
      var hit=items.find(function(x){return x.offsetParent&&new RegExp(want,'i').test(x.textContent||'');});
      if(hit){hit.click();return true;}
      try{document.body.click();}catch(e){} return false;
    }catch(e){return false;}})()`;
  }
  async function getModel() { try { return agentWv ? await agentWv.executeJavaScript(GET_MODEL, true) : ''; } catch { return ''; } }
  // tier: 'haiku' | 'sonnet' | 'opus'  → true wenn (vermutlich) gewechselt/bereits aktiv (auf der Agent-Webview)
  async function setModel(tier) {
    if (!agentWv || !tier) return false;
    try {
      const cur = await getModel();
      if (cur && new RegExp(tier, 'i').test(cur)) return true;       // schon das richtige Modell
      let opened = 'no'; try { opened = await agentWv.executeJavaScript(OPEN_MODEL_MENU, true); } catch {}
      if (opened !== 'opened') return false;
      await sleep(480);
      let picked = false; try { picked = await agentWv.executeJavaScript(PICK_MODEL(tier), true); } catch {}
      await sleep(320);
      return !!picked;
    } catch { return false; }
  }

  // Läuft auf der EIGENEN Agent-Webview (agentWv) — der Nutzer-Chat (wv) bleibt unberührt.
  async function runOnce(message) {
    busy = true; abortFlag = false;
    const w = ensureAgentView();
    const ready = await waitReady(24000, w);  // erster Start: claude.ai lädt noch → Editor abwarten
    if (!ready) return null;                   // nicht eingeloggt → operate meldet es
    let prev = 0; try { const r0 = await w.executeJavaScript(READ_REPLY, true); prev = (r0 && r0.n) || 0; } catch {}
    let inj = 'err';
    for (let a = 0; a < 3 && inj !== 'ok'; a++) {   // Editor evtl. erst beim 2./3. Versuch wirklich bereit
      try { inj = await w.executeJavaScript(injectScript(message), true); } catch {}
      if (inj !== 'ok') await sleep(1300);
    }
    if (inj !== 'ok') return null;
    // GEDULDIG: Solange Claude GENERIERT (working/streaming), NIE abbrechen — auch bei großen Prompts, die
    // länger zum Starten brauchen. Nur bei echtem STILLSTAND (kein Generieren + keine neue Antwort) aufgeben.
    let lastText = null, lastR = null, stable = 0, sawText = false, resent = false, idleMs = 0;
    for (let i = 0; i < 150; i++) {            // Obergrenze ~105s — greift praktisch nur bei totalem Stillstand
      if (abortFlag) { abortFlag = false; return null; }   // Stop-Button → sofort raus
      await sleep(700);
      let r = null; try { r = await w.executeJavaScript(READ_REPLY, true); } catch {}
      const working = !!(r && r.working);
      if (!r || !r.ok || r.n < prev + 1) {
        if (working) { idleMs = 0; continue; }             // Claude arbeitet (Stop-Button) → geduldig weiter warten
        idleMs += 700;
        // ~8s wirklich still + Text klebt noch im Editor → einmal erneut absenden (Senden kam nicht an)
        if (!resent && idleMs > 8000) { let h = false; try { h = await w.executeJavaScript(EDITOR_HAS_TEXT, true); } catch {} if (h) { resent = true; try { await w.executeJavaScript(injectScript(message), true); } catch {} idleMs = 0; } }
        if (idleMs > 28000) return null;                   // ~28s totaler Stillstand → aufgeben (planStep repariert)
        continue;
      }
      lastR = r; idleMs = 0;
      if (r.text) sawText = true;
      // Solange Claude noch tippt (streaming/working), NIE zurückgeben → keine abgeschnittene Antwort.
      if (working || r.streaming) { stable = 0; lastText = r.text; continue; }
      if (sawText && r.text && r.text === lastText) { if (++stable >= 2) return r; }
      else { stable = 0; lastText = r.text; }
    }
    return lastR;
  }

  // ---- Schritt 3: autonome Recherche (experimentell, über claude.ai-DOM) ----
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MAX_STEPS = 4;       // höchstens 4 Seiten öffnen, dann zwingend abschließen
  let agentRunning = false;
  let runId = 0;          // bricht alte Schleifen ab, falls neu gestartet wird
  let lastUrl = '';       // gegen Endlosschleife: gleiche Seite nicht zweimal öffnen
  // Liest Claudes letzte Nachricht aus mehreren Quellen, weil die gerenderte Prosa unzuverlässig
  // ist (Auto-Umbruch zerreißt URLs, Keywords kleben an). codes = Inline-Code (<code>, VERBATIM,
  // beste Quelle), hrefs = verlinkte URLs, raw = textContent (ohne Zero-Width), text = innerText (Stabilität).
  const READ_REPLY = `(function(){try{
    // Arbeitet Claude gerade? (Stop-Button / data-is-streaming) — UNABHÄNGIG davon, ob die Nachricht schon gerendert ist.
    var working=false; try{
      working = !!document.querySelector('[data-is-streaming="true"]')
        || !!document.querySelector('button[data-testid="stop-button"]')
        || !!document.querySelector('button[aria-label="Stop response"]')
        || !!document.querySelector('button[aria-label="Antwort stoppen"]')
        || !!document.querySelector('button[aria-label="Generierung stoppen"]')
        || !!document.querySelector('button[aria-label*="stop response" i]')
        || !!document.querySelector('button[aria-label*="antwort stopp" i]');
    }catch(e){}
    var nodes = document.querySelectorAll('div.font-claude-message');
    if(!nodes.length) nodes = document.querySelectorAll('[data-testid="assistant-message"], .prose, [data-is-streaming]');
    if(!nodes.length) return { ok:false, working:working, text:'', raw:'', hrefs:[], codes:[], n:0 };
    var last = nodes[nodes.length-1];
    var hrefs = [];
    last.querySelectorAll('a[href]').forEach(function(a){ var h=a.getAttribute('href')||''; if(/^https?:\\/\\//i.test(h)) hrefs.push(h); });
    var codes = [];
    last.querySelectorAll('code').forEach(function(c){ var t=(c.textContent||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD]/g,'').trim(); if(t) codes.push(t); });
    var streaming=working; try{ var sn=last.closest&&last.closest('[data-is-streaming]'); if(sn&&sn.getAttribute('data-is-streaming')==='true') streaming=true; }catch(e){}
    return { ok:true, working:working, streaming:streaming, text:(last.innerText||'').trim(), raw:(last.textContent||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD]/g,'').replace(/\\s+/g,' ').trim(), hrefs:hrefs, codes:codes, n: nodes.length };
  }catch(e){ return { ok:false, working:false, text:'', raw:'', hrefs:[], codes:[], n:0 }; }})()`;

  function setRunUI(on) {
    $('#ca-stop').classList.toggle('hidden', !on);
    $('#ca-research').classList.toggle('hidden', on);
  }
  function stopAgent() { agentRunning = false; setRunUI(false); }

  // wartet, bis die nächste Claude-Nachricht steht und ihr Text 2x stabil ist; gibt das ganze Objekt zurück
  async function waitForReply(minCount) {
    let lastText = null, lastR = null, stable = 0;
    for (let i = 0; i < 45 && agentRunning; i++) {
      await sleep(1200);
      let r = null; try { r = await wv.executeJavaScript(READ_REPLY, true); } catch {}
      if (!r || !r.ok || r.n < minCount) continue;
      lastR = r;
      if (r.text && r.text === lastText) { if (++stable >= 2) return r; }
      else { stable = 0; lastText = r.text; }
    }
    return lastR && lastR.text ? lastR : null;
  }

  // URL aus Claudes Antwort robust herauslesen. Jede Kandidaten-URL wird über den echten
  // URL()-Parser validiert (echter Domain-Host nötig) — so wird kein eingeklebtes Keyword wie
  // "...github.ÖFFNE:" oder eine abgeschnittene "https://github" jemals navigiert.
  function sanitizeUrl(u) {
    if (!u) return null;
    u = u.replace(/[​-‍﻿­]/g, '').trim();
    // nur erlaubte URL-Zeichen ab dem Protokoll → schneidet bei Nicht-ASCII (z.B. "Ö") sauber ab
    const mm = /^https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+/.exec(u);
    if (!mm) return null;
    const s = mm[0].replace(/[)\]}>.,;:"']+$/, '');
    try {
      const x = new URL(s);
      if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/i.test(x.hostname)) return null;   // echter Domain-Host (Punkt + ASCII-TLD)
      return x.href;
    } catch { return null; }
  }
  function pickUrl(r) {
    const notClaude = (s) => s && !/claude\.ai|anthropic\.com/i.test(s);
    // 1) Inline-Code (verbatim — kein Auto-Link, kein Umbruch, kein wbr): zuverlässigste Quelle
    for (const c of (r.codes || [])) { const s = sanitizeUrl(c); if (notClaude(s)) return s; }
    // 2) echter Link-href in der Nachricht
    for (const h of (r.hrefs || [])) { const s = sanitizeUrl(h); if (notClaude(s)) return s; }
    // 3) explizite ÖFFNE-Zeile im reinen Text
    const m = /(?:ÖFFNE|OEFFNE|OPEN)\s*:\s*(\S+)/i.exec(r.raw || '');
    if (m) { const s = sanitizeUrl(m[1]); if (notClaude(s)) return s; }
    // 4) irgendeine gültige URL im Text
    const m2 = /(https?:\/\/\S+)/i.exec(r.raw || '');
    if (m2) { const s = sanitizeUrl(m2[1]); if (notClaude(s)) return s; }
    return null;
  }

  async function startResearch(goal) {
    if (agentRunning) { caLog('Recherche läuft bereits — erst stoppen', true); return; }
    if (!goal) { caLog('Bitte oben ein Recherche-Ziel eingeben', true); return; }
    if (!open) toggle(true);
    if (!agentOn) setAgent(true);
    agentRunning = true; lastUrl = ''; const myRun = ++runId; setRunUI(true);
    caLog('🔎 Recherche: ' + goal.slice(0, 56));
    const instr = `Du bist der Recherche-Agent im NOVA-Browser. Forschungsziel: "${goal}".\n`
      + `Sei MAXIMAL entscheidungsfreudig: In den allermeisten Fällen GENÜGT EINE EINZIGE Seite. Sobald die gelesene Seite das Ziel beantwortet, antworte SOFORT mit FERTIG.\n`
      + `Öffne eine ZWEITE Seite nur, wenn die erste das Ziel klar NICHT beantwortet (absolutes Maximum ${MAX_STEPS} Seiten). Im Zweifel immer FERTIG statt noch eine Seite.\n`
      + `WICHTIG: Schreibe jede URL in Backticks (Inline-Code), damit sie unverändert ankommt.\n`
      + `Antworte mit GENAU EINER Zeile:\n`
      + 'ÖFFNE: `https://...`   — nur wenn du wirklich noch eine Seite brauchst\n'
      + `FERTIG: <kurzes Ergebnis>   — sobald du genug weißt (das ist der Normalfall)\n`
      + 'Starte jetzt mit EINER ÖFFNE-Zeile für die eine Seite, die das Ziel am direktesten beantwortet (URL in Backticks).';
    let prev = 0;
    try { const r0 = await wv.executeJavaScript(READ_REPLY, true); prev = (r0 && r0.n) || 0; } catch {}
    let inj = 'err';
    try { inj = await wv.executeJavaScript(injectScript(instr), true); } catch {}
    if (inj !== 'ok') { caLog('Konnte Claude nicht ansteuern — eingeloggt?', true); stopAgent(); return; }
    agentLoop(prev + 1, 0, myRun);
  }

  async function agentLoop(minCount, step, myRun) {
    if (!agentRunning || myRun !== runId) return;
    if (step >= MAX_STEPS) { caLog('Schritt-Limit erreicht — gestoppt', true); stopAgent(); return; }
    caLog(`Warte auf Claude … (Schritt ${step + 1}/${MAX_STEPS})`);
    const reply = await waitForReply(minCount);
    if (!agentRunning || myRun !== runId) return;
    if (!reply) { caLog('Keine neue Antwort von Claude — gestoppt', true); stopAgent(); return; }
    // FERTIG hat IMMER Vorrang → beendet die Recherche sofort (auch wenn noch eine URL im Text steht)
    if (/FERTIG\s*:/i.test(reply.raw || reply.text || '')) { caLog('Claude ist fertig ✓ — Ergebnis steht im Chat'); stopAgent(); return; }
    // URL robust + validiert lesen (Inline-Code → href → Text, alles über URL() geprüft)
    const url = pickUrl(reply);
    if (!url) {
      // keine saubere URL gefunden → Claude um vollständigen Link in Backticks bitten (statt Garbage zu navigieren)
      caLog('Keine saubere URL erkannt — bitte Claude um den vollständigen Link', true);
      let pc2 = minCount;
      try { const rr = await wv.executeJavaScript(READ_REPLY, true); pc2 = (rr && rr.n) || minCount; } catch {}
      try { await wv.executeJavaScript(injectScript('Die letzte Antwort enthielt keine gültige URL. Schicke die nächste Seite als EINE Zeile mit der URL in Backticks:\nÖFFNE: `https://example.com/pfad`\nOder antworte mit FERTIG: <Ergebnis>.'), true); } catch {}
      agentLoop(pc2 + 1, step + 1, myRun);
      return;
    }
    if (url === lastUrl) { caLog('Gleiche Seite erneut angefragt — gestoppt', true); stopAgent(); return; }
    lastUrl = url;
    caLog('Öffne: ' + url.slice(0, 48));
    const tab = activeTab();
    navigate(tab, url);
    await sleep(3800);
    if (!agentRunning || myRun !== runId) return;
    let page = null; try { page = await tab.wv.executeJavaScript(EXTRACT, true); } catch {}
    caLog(page && page.text ? `Gelesen (${page.text.length} Z.) → zurück an Claude` : 'Seite nicht lesbar → melde an Claude', !(page && page.text));
    const lastRound = step + 1 >= MAX_STEPS - 1;   // danach ist Schluss → Abschluss erzwingen
    const tail = lastRound
      ? '\n\nDas war die letzte Seite. Antworte JETZT mit "FERTIG: <Ergebnis>" — keine ÖFFNE-Zeile mehr.'
      : '\n\nBeantwortet das schon das Ziel? Dann antworte JETZT mit "FERTIG: <Ergebnis>". Nur falls die Seite das Ziel klar NICHT beantwortet: eine weitere ÖFFNE-Zeile (URL in Backticks).';
    const feed = page && page.text
      ? `SEITE ${url}:\n"""\n${page.text}\n"""${tail}`
      : `Die Seite ${url} ließ sich nicht lesen.${tail}`;
    let pc = minCount;
    try { const rr = await wv.executeJavaScript(READ_REPLY, true); pc = (rr && rr.n) || minCount; } catch {}
    try { await wv.executeJavaScript(injectScript(feed), true); } catch {}
    agentLoop(pc + 1, step + 1, myRun);
  }

  $('#btn-claude').addEventListener('click', () => {
    // Eigene Agent-Webview → der Nutzer-Chat ist jederzeit frei nutzbar, auch wenn der Agent läuft.
    const willOpen = !open; toggle(); if (willOpen) setTimeout(newChat, 60);   // beim Öffnen IMMER frischer Chat
  });
  $('#claude-close').addEventListener('click', () => toggle(false));
  $('#claude-reload').addEventListener('click', () => { if (wv) wv.reload(); });
  $('#claude-popout').addEventListener('click', () => { createTab('https://claude.ai/new'); toggle(false); });
  $('#claude-agent').addEventListener('click', () => setAgent(!agentOn));
  for (const chip of document.querySelectorAll('.ca-chip')) {
    chip.addEventListener('click', () => sendToClaude(PROMPTS[chip.dataset.prompt] || PROMPTS.summary));
  }
  const caSend = () => { const v = $('#ca-input').value.trim(); if (!v) return; $('#ca-input').value = ''; sendToClaude(v); };
  $('#ca-send').addEventListener('click', caSend);
  $('#ca-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') caSend(); });
  $('#ca-research').addEventListener('click', () => { const v = $('#ca-input').value.trim(); $('#ca-input').value = ''; startResearch(v); });
  $('#ca-stop').addEventListener('click', () => { stopAgent(); caLog('Recherche gestoppt'); });

  // Breite per Ziehen anpassen — nur im freien (schwebenden) Modus
  $('#claude-resize').addEventListener('mousedown', (e) => {
    if (dock !== 'float') return;
    e.preventDefault();
    $('#drag-shield').classList.remove('hidden');
    const startX = e.clientX, startW = panel.offsetWidth;
    const onMove = (ev) => { panel.style.width = Math.min(820, Math.max(340, startW + (ev.clientX - startX))) + 'px'; repaint(); };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
      $('#drag-shield').classList.add('hidden');
      floatPos = panel.getBoundingClientRect();
      window.nova.settings.set({ claudeFloat: { left: floatPos.left, top: floatPos.top, width: panel.offsetWidth, height: floatPos.height } });
      repaint();
    };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  });

  // ---- Header ziehen → frei verschieben + Quick-Snap (links/rechts/unten/Split) ----
  $('.claude-head').addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.button !== 0) return;
    e.preventDefault();
    const startRect = panel.getBoundingClientRect();
    const offX = e.clientX - startRect.left, offY = e.clientY - startRect.top;
    // beim Ziehen immer als schwebendes Fenster bewegen
    const fw = dock === 'float' ? startRect.width : 440;
    const fh = dock === 'float' ? startRect.height : Math.min(700, contentRect().height - 28);
    DOCK_CLASSES.forEach((c) => document.body.classList.remove(c));
    document.body.classList.add('cl-float', 'cl-dragging');
    const v = va(); v.style.paddingLeft = v.style.paddingRight = v.style.paddingBottom = '';
    panel.style.width = fw + 'px'; panel.style.height = fh + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto';
    $('#drag-shield').classList.remove('hidden');
    let zone = 'float';
    const onMove = (ev) => {
      panel.style.left = (ev.clientX - offX) + 'px';
      panel.style.top = Math.max(48, ev.clientY - offY) + 'px';
      zone = zoneFor(ev.clientX, ev.clientY);
      showPreview(zone);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('cl-dragging');
      preview.classList.add('hidden');
      $('#drag-shield').classList.add('hidden');
      if (zone === 'float') {
        const r = panel.getBoundingClientRect();
        floatPos = { left: r.left, top: r.top, width: panel.offsetWidth, height: r.height };
        dock = 'float';
        window.nova.settings.set({ claudeDock: 'float', claudeFloat: floatPos });
        layoutDock();
      } else {
        setDock(zone);
      }
    };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  });

  window.addEventListener('resize', () => { if (open) layoutDock(); });
  function relayout() { if (open) layoutDock(); }
  function applySettings() {
    if (state.settings.claudeFloat) floatPos = state.settings.claudeFloat;
    if (state.settings.claudeDock) dock = state.settings.claudeDock;
    if (dock === 'bottom') dock = 'right';   // alter Wert → "unten" gibt es nicht mehr
  }
  return { toggle, close, applySettings, relayout, setDock, isOpen: () => open, ask, runOnce, pickUrl, prepare, release, abort, reloadChat, freshChat, setModel, getModel };
})();

/* ============================================================ Dock-Manager — andockbare Panels koordinieren */
// Agent, Discord, Tresor, Share docken alle an #view-area an. Der Manager STAPELT mehrere Panels
// pro Seite nebeneinander (statt sie zu überlappen), summiert das Padding pro Seite und positioniert
// bei jeder Änderung (öffnen/schließen/Seite/einklappen/Resize) alle Panels neu. So gibt es nie eine
// Überlappung — egal ob 1 oder mehrere Panels links/rechts/eingeklappt sind.
const dockManager = (() => {
  const GAP = 3, COLLAPSED_GAP = 6, COLLAPSED_W = 66, EDGE = 8;   // EDGE = Rand zwischen Fensterkante und äußerstem Panel (nichts abgeschnitten)
  const MIN_SPLIT = 300;       // schmaler → lieber einklappen statt winzig anzeigen
  const panels = new Map();    // id → { el, side, collapsed, full, open, width:()=>number, collapse:(on)=>void }
  let roAttached = false, relayouting = false;
  function ensureRO() {
    if (roAttached) return; const va = $('#view-area'); if (!va) return;
    try { new ResizeObserver(() => layout()).observe(va, { box: 'border-box' }); roAttached = true; } catch {}
  }
  function set(id, info) { panels.set(id, Object.assign(panels.get(id) || {}, info)); ensureRO(); if (!relayouting) layout(); }
  function close(id) { const p = panels.get(id); if (p) p.open = false; if (!relayouting) layout(); }
  function railSpan(list) { return list.filter((p) => p.collapsed).length * (COLLAPSED_W + COLLAPSED_GAP); }
  function layout() {
    const va = $('#view-area'); if (!va) return;
    relayouting = true;
    try {
      const r = va.getBoundingClientRect();
      const baseL = r.left, baseR = window.innerWidth - r.right;
      const open = [...panels.values()].filter((p) => p.open && p.el);
      const fulls = open.filter((p) => p.full && !p.collapsed);
      const docked = open.filter((p) => !(p.full && !p.collapsed));   // eingeklappt + Split

      // Auto-Einklappen: passen mehrere Split-Panels nicht (jedes bekäme < MIN_SPLIT), klappe die jüngsten ein
      let splits = docked.filter((p) => !p.collapsed);
      while (splits.length > 1 && (r.width - 2 * EDGE - railSpan(docked)) / splits.length < MIN_SPLIT) {
        const victim = splits[splits.length - 1];
        victim.collapsed = true;
        try { victim.collapse && victim.collapse(true); } catch {}
        splits = splits.filter((p) => p !== victim);
      }
      const avail = r.width - 2 * EDGE - railSpan(docked);
      const share = splits.length ? Math.floor(avail / splits.length) : 0;

      // Eingeklappte Rails + Split-Panels von den Rändern stapeln
      let lx = baseL + EDGE, rx = baseR + EDGE, hasL = false, hasR = false;
      for (const p of docked) {
        if (!p.el) continue;
        p.el.style.top = Math.round(r.top) + 'px';
        const w = p.collapsed ? COLLAPSED_W : Math.max(220, Math.min(Math.round((p.width && p.width()) || 460), share));
        const g = p.collapsed ? COLLAPSED_GAP : GAP;
        p.el.style.width = w + 'px';
        if (p.side === 'left') { p.el.style.left = Math.round(lx) + 'px'; p.el.style.right = 'auto'; lx += w + g; hasL = true; }
        else { p.el.style.right = Math.round(rx) + 'px'; p.el.style.left = 'auto'; rx += w + g; hasR = true; }
      }
      const leftUsed = hasL ? Math.round(lx - baseL) : 0;
      const rightUsed = hasR ? Math.round(rx - baseR) : 0;

      // Vollbild füllt NUR den Platz zwischen den angedockten Panels → keine Überlappung mit den Rails
      for (const p of fulls) {
        p.el.style.top = Math.round(r.top) + 'px';
        p.el.style.left = Math.round(r.left + leftUsed) + 'px';
        p.el.style.right = 'auto';
        p.el.style.width = Math.round(r.width - leftUsed - rightUsed) + 'px';
      }

      va.style.paddingLeft = leftUsed ? leftUsed + 'px' : '';
      va.style.paddingRight = rightUsed ? rightUsed + 'px' : '';
    } finally { relayouting = false; }
  }
  let raf = 0;
  function layoutAnimated() { try { cancelAnimationFrame(raf); } catch {} const t0 = performance.now(); const tick = (t) => { layout(); if (t - t0 < 460) raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); }
  window.addEventListener('resize', layout);
  return { set, close, layout, layoutAnimated };
})();

/* ============================================================ NOVA Operator (AI-Operable Web — Phase 1) */
// DOM-Intelligence-Layer + sichtbare Bedienung: analysiert die aktive Seite strukturell,
// markiert interaktive Elemente sichtbar auf der Seite und führt Aktionen mit Fokus-Animation aus.
const operator = (() => {
  const panel = $('#operator-panel');
  let open = false, model = null, fillIdx = null;

  // ---- KI-Agenten-Bühne: eigenes, nicht anklickbares Fenster rechts (nur die KI bedient es) ----
  const stage = $('#agent-stage');
  let stageWv = null, stageMode = false, stageUrl = '', stageTitle = '';
  let stageSide = 'right', stageCollapsed = false;   // andockbar links/rechts + einklappbar
  let userContext = [], secrets = {};   // Nutzer-Antworten (an Claude) + sichere Daten (NICHT an Claude, nur lokal eingefügt)
  let checklist = [];                    // Live-Aufgabenliste [{text, done}], von Claude gepflegt
  let degraded = false;                  // nach Hard-Reset (frischer Chat ohne Historie) → Prompts wieder VOLL senden
  const MODEL_TIERS = ['haiku', 'sonnet', 'opus'];   // aufsteigende Stärke (Eskalation bei Problemen)
  function ensureStage() {
    if (stageWv) return stageWv;
    const wv = document.createElement('webview');
    wv.setAttribute('partition', PARTITION);     // gleiche Session wie der Nutzer → KI kann eingeloggte Seiten nutzen
    wv.setAttribute('allowpopups', '');
    if (state.webviewPreload) wv.setAttribute('preload', state.webviewPreload);
    wv.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=no,backgroundThrottling=no');
    wv.setAttribute('src', NEWTAB);
    const setUrl = (u) => { stageUrl = u || stageUrl; const e = $('#as-url'); if (e) e.textContent = prettyUrl(stageUrl); };
    wv.addEventListener('did-navigate', (e) => { setUrl(e.url); });
    wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) setUrl(e.url); });
    wv.addEventListener('page-title-updated', (e) => { stageTitle = e.title || stageTitle; });
    $('#as-viewport').insertBefore(wv, $('#as-scrim'));   // Webview hinter den Scrim (Scrim blockt Nutzer-Klicks)
    stageWv = wv;
    return wv;
  }
  function prettyUrl(u) {
    if (!u || /^nova:/i.test(u)) return 'neuer Tab';
    try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname !== '/' ? x.pathname : ''); } catch { return u; }
  }
  // Bühne andocken — exakt bündig mit dem Inhaltsbereich (#view-area) → gleiche Oberkante wie der Tab.
  // Seite (links/rechts) + eingeklappt berücksichtigen; Inhalt zur jeweiligen Seite zusammenschieben.
  function stageDock() {
    if (!stage) return;
    stage.classList.toggle('as-left', stageSide === 'left');
    stage.classList.toggle('as-collapsed', stageCollapsed);
    dockManager.set('agent', { el: stage, side: stageSide, collapsed: stageCollapsed, full: false, open: stageMode, width: () => Math.round(Math.min(880, Math.max(440, window.innerWidth * 0.47))), collapse: setStageCollapsed });
  }
  // Layout ändert sich animiert (Favoritenleiste ein-/ausklappen) → Bühne pro Frame MITwandern,
  // statt erst nach der Sidebar-Animation zu springen. Trackt #view-area über ~0,42 s.
  function relayoutAnimated() {
    if (!stageMode || stage.classList.contains('hidden')) return;
    dockManager.layout();   // Neu anordnen; der ResizeObserver des Managers verfolgt die Sidebar-Animation
  }
  function setStageSide(side) {
    if (side !== 'left' && side !== 'right') return;
    stageSide = side;
    try { state.settings.agentStageSide = side; window.nova.settings.set({ agentStageSide: side }); } catch {}
    stageDock();
  }
  function setStageCollapsed(on) {
    stageCollapsed = !!on;
    const cb = $('#as-collapse'); if (cb) cb.title = stageCollapsed ? 'Ausklappen' : 'Einklappen';
    stageDock();
  }
  function openStage() {
    ensureStage();
    stageMode = true;
    stageCollapsed = false;                                  // immer ausgeklappt starten
    if (state.settings && state.settings.agentStageSide === 'left') stageSide = 'left';   // zuletzt gewählte Seite
    stage.classList.remove('hidden', 'closing');
    document.body.classList.add('as-open');
    requestAnimationFrame(stageDock);
    setStageStep('Initialisiere …'); setStageSub('verbinde …'); setStageProgress(0);
  }
  function closeStage() {
    stageMode = false;
    dockManager.close('agent');   // übrige Panels + Inhalt-Padding neu berechnen (smooth via as-open-Transition)
    stage.classList.add('closing');
    setTimeout(() => {
      stage.classList.add('hidden'); stage.classList.remove('closing');
      document.body.classList.remove('as-open');
      stage.style.left = ''; stage.style.right = ''; stage.style.top = ''; stage.style.width = '';
    }, 320);
  }
  function stageReset() {                          // frischer „neuer Tab" für einen neuen Lauf
    ensureStage();
    try { stageWv.src = NEWTAB; } catch {}
    stageUrl = NEWTAB; stageTitle = '';
    const e = $('#as-url'); if (e) e.textContent = 'neuer Tab';
  }
  function setStageStep(t) { const e = $('#as-step-tx'); if (e) e.textContent = t || ''; }
  function setStageSub(t) { const e = $('#as-sub'); if (e) e.textContent = t || ''; }
  function setStageState(t) { const e = $('#as-state'); if (e) e.textContent = t || ''; }
  function setStageProgress(p) { const e = $('#as-bar'); if (e) e.style.width = Math.max(0, Math.min(100, p)) + '%'; }
  function stageRunningUI(on) { stage.classList.toggle('as-running', on); }

  // ---- Live-Checkliste (von Claude gepflegt, im Bühnen-HUD sichtbar) ----
  // Plan-/Checklisten-Zeilen aus Claudes Antwort lesen: „[ ] Schritt" / „[x] erledigt"
  function parseChecklist(r) {
    const txt = (r && typeof r === 'object') ? (r.text || r.raw || '') : (r || '');
    const items = [];
    txt.split('\n').forEach((ln) => {
      const m = /^\s*(?:[-*]\s*)?\[\s*([ xX✓✔•-]?)\s*\]\s*(.+?)\s*$/.exec(ln);
      if (m) { const t = m[2].replace(/\s+/g, ' ').trim().slice(0, 90); if (t) items.push({ done: /[xX✓✔]/.test(m[1]), text: t }); }
    });
    return items;
  }
  function sameTask(a, b) {
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9äöüß ]/g, '').replace(/\s+/g, ' ').trim();
    a = norm(a); b = norm(b);
    if (!a || !b) return false;
    return a === b || (a.length > 8 && b.length > 8 && (a.includes(b) || b.includes(a))) || a.slice(0, 16) === b.slice(0, 16);
  }
  function setChecklist(items) {
    if (!items || !items.length) return;
    if (!checklist.length) { checklist = items; renderChecklist(-1); return; }
    if (items.length >= checklist.length) {
      // umfassendere/gleich lange Liste → übernehmen, aber bereits erledigte Punkte bleiben erledigt
      items.forEach((ni) => { const old = checklist.find((c) => c.done && sameTask(c.text, ni.text)); if (old) ni.done = true; });
      checklist = items;
    } else {
      // kürzere Liste (oft nur partieller/gestreamter Read) → KEINE Punkte verlieren, nur done-Status übernehmen
      items.forEach((ni) => { const m = checklist.find((c) => sameTask(c.text, ni.text)); if (m && ni.done) m.done = true; });
    }
    renderChecklist(-1);
  }
  function renderChecklist(activeIdx) {
    const box = $('#as-check'); if (!box) return;
    const list = $('#as-check-list');
    box.classList.toggle('hidden', !checklist.length);
    if (!checklist.length) return;
    list.innerHTML = '';
    checklist.forEach((it, i) => {
      const row = el('div', 'as-ck-row' + (it.done ? ' done' : '') + (i === activeIdx ? ' active' : ''));
      const mark = el('span', 'as-ck-mark');
      if (it.done) mark.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
      row.append(mark, el('span', 'as-ck-tx', it.text));
      list.appendChild(row);
    });
    const done = checklist.filter((i) => i.done).length;
    const cnt = $('#as-check-count'); if (cnt) cnt.textContent = done + '/' + checklist.length;
  }
  // ersten offenen Punkt als „aktiv" markieren (visuelles Feedback während eines Schritts)
  function markActiveStep() { const idx = checklist.findIndex((i) => !i.done); renderChecklist(idx); }

  // Ziel-Webview/-URL/-Navigation: im Agent-Modus die Bühne, sonst der aktive Tab (manuelles Panel)
  function opWv() { return stageMode ? stageWv : (activeTab() && activeTab().wv); }
  function opUrl() { return stageMode ? stageUrl : (activeTab() && activeTab().url); }
  function opNavigate(url) {
    if (stageMode) { try { stageWv.src = url; } catch {} stageUrl = url; }
    else { const t = activeTab(); if (t) { try { navigate(t, url); } catch {} } }
  }

  // ---- Nutzer-Eingabe (fehlende Infos / Login-Daten / Auswahl) ----
  // Sensible Anfrage? → Wert wird NICHT an Claude gesendet, sondern lokal gehalten + per Platzhalter eingefügt.
  // Liefert einen Platzhalter-Schlüssel oder null (dann normale, an Claude weitergegebene Antwort).
  function secretKeyFor(q) {
    q = (q || '').toLowerCase();
    if (/passwor[dt]|kennwort/.test(q)) return 'passwort';
    if (/e-?mail/.test(q)) return 'email';
    if (/\bpin\b|\btan\b|2fa|verifiz|bestätigungscode|einmalcode|\bcode\b/.test(q)) return 'code';
    if (/benutzer|nutzername|user\s*name|\blogin\b|konto(name)?/.test(q)) return 'benutzer';
    if (/kreditkart|karten|\biban\b|kontonummer|bankverbindung/.test(q)) return 'zahlung';
    if (/telefon|handy|mobil|rufnummer/.test(q)) return 'telefon';
    if (/adresse|anschrift|stra(ß|ss)e|\bplz\b|wohnort|postleitzahl/.test(q)) return 'adresse';
    if (/geburts|\bsvnr\b|sozialvers|ausweis|personalausweis/.test(q)) return 'persoenlich';
    return null;
  }
  function maskFor(q) { return /passwor[dt]|kennwort|\bpin\b|\btan\b|geheim|secret|\bcode\b|2fa/i.test(q || ''); }
  // {{schlüssel}}-Platzhalter im FÜLLE-Wert lokal durch die echten, sicher gehaltenen Daten ersetzen.
  function applySecrets(val) {
    if (!val) return val;
    for (const k of Object.keys(secrets)) val = val.replace(new RegExp('\\{\\{\\s*' + k + '\\s*\\}\\}', 'ig'), secrets[k]);
    if (/\{\{\s*(?:geheim|secret)\s*\}\}/i.test(val)) { const any = secrets.passwort != null ? secrets.passwort : secrets[Object.keys(secrets)[0]]; if (any != null) val = val.replace(/\{\{\s*(?:geheim|secret)\s*\}\}/ig, any); }
    return val;
  }
  function askUser(question, mask) {
    return new Promise((resolve) => {
      const ov = $('#as-ask'), inp = $('#as-ask-input');
      $('#as-ask-q').textContent = question;
      inp.type = mask ? 'password' : 'text'; inp.value = '';
      ov.classList.remove('hidden');
      setTimeout(() => { try { inp.focus(); } catch {} }, 60);
      const finish = (val) => {
        ov.classList.add('hidden');
        $('#as-ask-ok').removeEventListener('click', ok);
        $('#as-ask-cancel').removeEventListener('click', cancel);
        inp.removeEventListener('keydown', key);
        resolve(val);
      };
      const ok = () => finish(inp.value.trim() || null);
      const cancel = () => finish(null);
      const key = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
      $('#as-ask-ok').addEventListener('click', ok);
      $('#as-ask-cancel').addEventListener('click', cancel);
      inp.addEventListener('keydown', key);
    });
  }

  // ---- Ergebnis-Karte: vom Agenten recherchierte Infos schön formatiert ausgeben ----
  function escHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function formatResult(text) {
    let t = escHtml((text || '').trim()).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const lines = t.split(/\n/); let html = '', inUl = false;
    for (const ln of lines) {
      const m = /^\s*(?:[-•*]|\d+\.)\s+(.*)$/.exec(ln);
      if (m) { if (!inUl) { html += '<ul>'; inUl = true; } html += '<li>' + m[1] + '</li>'; }
      else { if (inUl) { html += '</ul>'; inUl = false; } if (ln.trim()) html += '<p>' + ln + '</p>'; }
    }
    if (inUl) html += '</ul>';
    return html || '<p>(kein Ergebnis)</p>';
  }
  function showResult(goal, text) {
    const card = $('#agent-result');
    $('#ar-goal').textContent = goal || '';
    $('#ar-body').innerHTML = formatResult(text);
    card._text = text || '';
    card.classList.remove('hidden');
  }

  // ---- In die Seite injizierter Scanner: semantisches Modell + sichtbare Markierung ----
  const SCAN = `(function(){try{
    var prev=document.getElementById('__nova_op_layer'); if(prev)prev.remove();
    function vis(el){try{var r=el.getBoundingClientRect();if(r.width<6||r.height<6)return false;var s=getComputedStyle(el);return s.visibility!=='hidden'&&s.display!=='none'&&parseFloat(s.opacity||'1')>0.05;}catch(e){return false;}}
    function lbl(el){var t=(el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('title')))||el.value||(el.innerText||'')||el.name||(el.getAttribute&&el.getAttribute('alt'))||'';return (t||'').replace(/\\s+/g,' ').trim().slice(0,64);}
    var sel='a[href],button,[role="button"],input:not([type="hidden"]),textarea,select,[contenteditable="true"],[onclick],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"]';
    var raw=Array.prototype.slice.call(document.querySelectorAll(sel)).filter(vis);
    var els=raw.filter(function(e){return !raw.some(function(o){return o!==e&&o.contains(e);});}).slice(0,240);
    window.__novaOpTargets=els;
    function kindOf(e){var t=e.tagName.toLowerCase();var ty=(e.type||'').toLowerCase();if(t==='input'){if(ty==='password')return 'password';if(ty==='search'||/search|suche|query/i.test((e.name||'')+(e.placeholder||'')+(e.getAttribute('aria-label')||'')))return 'search';if(ty==='checkbox'||ty==='radio')return 'toggle';if(ty==='submit'||ty==='button')return 'button';return 'input';}if(t==='textarea'||e.isContentEditable)return 'input';if(t==='select')return 'select';if(t==='a'||e.getAttribute('role')==='link')return 'link';if(e.getAttribute('role')==='checkbox'||e.getAttribute('role')==='switch')return 'toggle';return 'button';}
    var targets=els.map(function(e,i){var r=e.getBoundingClientRect();return {i:i,kind:kindOf(e),label:lbl(e)||('<'+e.tagName.toLowerCase()+'>'),x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};});
    var txt=(document.body.innerText||'').toLowerCase().slice(0,20000);
    var hasPw=targets.some(function(t){return t.kind==='password';});
    var hasSearch=targets.some(function(t){return t.kind==='search';});
    var nInput=targets.filter(function(t){return t.kind==='input'||t.kind==='password';}).length;
    var tables=document.querySelectorAll('table').length;
    var pt='Allgemeine Seite';
    if(hasPw&&nInput<=5)pt='Login / Anmeldung';
    else if(/in den warenkorb|add to cart|checkout|warenkorb|jetzt kaufen/.test(txt))pt='Online-Shop';
    else if(tables>0)pt='Daten / Tabelle';
    else if(document.querySelector('article')||txt.length>3500)pt='Artikel / Lesen';
    else if(hasSearch)pt='Suche';
    else if(nInput>=3)pt='Formular';
    if(!window.__novaOpQuiet){
    var L=document.createElement('div');L.id='__nova_op_layer';L.style.cssText='position:fixed;inset:0;z-index:2147483646;pointer-events:none;font:700 11px system-ui,Segoe UI,sans-serif;';
    var COL={search:'#22d3ee',password:'#fb7185',input:'#a78bfa',select:'#a78bfa',link:'#7c4dff',button:'#f471b5',toggle:'#34d399'};
    var boxes=[];
    els.forEach(function(e,i){var c=COL[kindOf(e)]||'#f471b5';var b=document.createElement('div');b.style.cssText='position:fixed;border:1.5px solid '+c+';border-radius:5px;box-shadow:0 0 8px '+c+'66,inset 0 0 8px '+c+'22;box-sizing:border-box;will-change:transform,top,left;';var g=document.createElement('div');g.textContent=i;g.style.cssText='position:absolute;left:-1px;top:-14px;background:'+c+';color:#08080f;padding:0 4px;border-radius:4px;line-height:14px;';b.appendChild(g);L.appendChild(b);boxes.push({b:b,e:e});});
    document.documentElement.appendChild(L);
    window.__novaOpBoxes=boxes;
    // Markierungen beim Scrollen/Resize live aus den ECHTEN Positionen nachziehen; nicht
    // sichtbare ausblenden — so bleiben sie ausgerichtet und Elemente erscheinen beim Scrollen.
    function reposition(){var vh=innerHeight,vw=innerWidth;for(var k=0;k<boxes.length;k++){var o=boxes[k];var r;try{r=o.e.getBoundingClientRect();}catch(e){o.b.style.display='none';continue;}if(r.width<3||r.height<3||r.bottom<-2||r.top>vh+2||r.right<-2||r.left>vw+2){o.b.style.display='none';}else{o.b.style.display='block';o.b.style.left=r.left+'px';o.b.style.top=r.top+'px';o.b.style.width=r.width+'px';o.b.style.height=r.height+'px';}}}
    reposition();
    if(window.__novaOpScroll){try{removeEventListener('scroll',window.__novaOpScroll,true);removeEventListener('resize',window.__novaOpScroll);}catch(e){}}
    var raf=0;window.__novaOpScroll=function(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;reposition();});};
    addEventListener('scroll',window.__novaOpScroll,true);addEventListener('resize',window.__novaOpScroll);
    }
    var bodyTxt='';try{bodyTxt=((document.querySelector('main,article,[role="main"]')||document.body).innerText||'').replace(/\\s+/g,' ').trim().slice(0,1500);}catch(e){}
    return {ok:true,pageType:pt,title:document.title||'',url:location.href,tables:tables,targets:targets,text:bodyTxt};
  }catch(e){return {ok:false,error:String(e)};}})()`;

  const CLEAR = `(function(){try{var p=document.getElementById('__nova_op_layer');if(p)p.remove();if(window.__novaOpScroll){removeEventListener('scroll',window.__novaOpScroll,true);removeEventListener('resize',window.__novaOpScroll);window.__novaOpScroll=null;}}catch(e){}})()`;

  function execJs(action, idx, value) {
    return `(function(){try{
      var els=window.__novaOpTargets||[];var el=els[${idx}];if(!el)return {ok:false,error:'Element nicht mehr da'};
      try{el.scrollIntoView({block:'center',inline:'center'});}catch(e){}
      var r=el.getBoundingClientRect();
      var ring=document.createElement('div');ring.style.cssText='position:fixed;left:'+(r.left-3)+'px;top:'+(r.top-3)+'px;width:'+(r.width+6)+'px;height:'+(r.height+6)+'px;border:2.5px solid #f471b5;border-radius:8px;z-index:2147483647;pointer-events:none;box-shadow:0 0 0 4px rgba(244,113,181,.35),0 0 24px #f471b5;transition:opacity .35s;';document.documentElement.appendChild(ring);setTimeout(function(){ring.style.opacity='0';},700);setTimeout(function(){ring.remove();},1100);
      var A=${JSON.stringify(action)};
      if(A==='click'){['pointerover','pointerenter','pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){try{el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));}catch(e){}});try{el.click();}catch(e){}return {ok:true};}
      if(A==='fill'){var v=${JSON.stringify(value || '')};try{el.focus();}catch(e){}
        if(el.isContentEditable){try{document.execCommand('selectAll',false,null);document.execCommand('insertText',false,v);}catch(e){try{el.textContent=v;}catch(_){}}}
        else{
          var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
          var d=Object.getOwnPropertyDescriptor(proto,'value');
          var setV=function(val){try{if(d&&d.set)d.set.call(el,val);else el.value=val;}catch(e){try{el.value=val;}catch(_){}}};
          setV('');el.dispatchEvent(new Event('input',{bubbles:true}));   // erst leeren (React-Tracker zurücksetzen)
          setV(v);
          try{el.dispatchEvent(new InputEvent('input',{bubbles:true,data:v,inputType:'insertText'}));}catch(e){el.dispatchEvent(new Event('input',{bubbles:true}));}
          el.dispatchEvent(new Event('change',{bubbles:true}));
          try{el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'a'}));el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'a'}));}catch(e){}
          if((el.value||'')!==v){try{setV(v);el.dispatchEvent(new Event('input',{bubbles:true}));}catch(e){}}   // 1× Retry
        }
        var got=el.isContentEditable?((el.innerText||el.textContent||'').trim().length>0):((el.value||'').length>0);
        return {ok:true,filled:got};}
      if(A==='enter'){try{el.focus();['keydown','keypress','keyup'].forEach(function(t){el.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));});var f=el.form;if(f){f.requestSubmit?f.requestSubmit():f.submit();}}catch(e){}return {ok:true};}
      return {ok:false,error:'unbekannte Aktion'};
    }catch(e){return {ok:false,error:String(e)};}})()`;
  }

  function log(msg, warn) {
    const box = $('#op-log'); if (!box) return;
    const row = el('div', 'op-log-row' + (warn ? ' warn' : ''));
    row.appendChild(el('span', 'op-dot'));
    row.appendChild(el('span', null, msg));
    box.appendChild(row);
    while (box.childElementCount > 8) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
  }

  const KIND_LABEL = { search: 'Suche', password: 'Passwort', input: 'Eingabe', select: 'Auswahl', link: 'Link', button: 'Button', toggle: 'Schalter' };

  function renderModel(m) {
    const meta = $('#op-meta'); meta.innerHTML = '';
    const head = el('div', 'op-pagetype');
    head.appendChild(icon('i-operator'));
    head.appendChild(el('b', null, m.pageType));
    meta.appendChild(head);
    const counts = {};
    for (const t of m.targets) counts[t.kind] = (counts[t.kind] || 0) + 1;
    const chips = el('div', 'op-chips');
    for (const [k, n] of Object.entries(counts)) {
      const c = el('span', 'op-chip op-k-' + k, (KIND_LABEL[k] || k) + ' · ' + n);
      chips.appendChild(c);
    }
    if (m.tables) chips.appendChild(el('span', 'op-chip', 'Tabellen · ' + m.tables));
    meta.appendChild(chips);

    const body = $('#op-body'); body.innerHTML = '';
    // Elemente gruppiert auflisten (anklickbar → markieren + ausführen)
    const order = ['search', 'input', 'password', 'select', 'toggle', 'button', 'link'];
    const groups = {};
    for (const t of m.targets) (groups[t.kind] = groups[t.kind] || []).push(t);
    for (const k of order) {
      const arr = groups[k]; if (!arr || !arr.length) continue;
      body.appendChild(el('div', 'op-group-h', KIND_LABEL[k] || k));
      for (const t of arr) {
        const row = el('div', 'op-row op-k-' + k);
        row.appendChild(el('span', 'op-idx', String(t.i)));
        row.appendChild(el('span', 'op-rowlabel', t.label));
        if (k === 'input' || k === 'search' || k === 'password') {
          const fb = el('button', 'op-act', 'Ausfüllen'); fb.addEventListener('click', (e) => { e.stopPropagation(); startFill(t); });
          row.appendChild(fb);
        } else {
          const cb = el('button', 'op-act', 'Klicken'); cb.addEventListener('click', (e) => { e.stopPropagation(); doAction('click', t.i, null, t.label); });
          row.appendChild(cb);
        }
        row.addEventListener('mouseenter', () => focusTarget(t.i));
        body.appendChild(row);
      }
    }
  }

  async function focusTarget(idx) {
    const wv = opWv(); if (!wv) return;
    try { await wv.executeJavaScript(`(function(){try{var e=(window.__novaOpTargets||[])[${idx}];if(!e)return;var r=e.getBoundingClientRect();var x=document.getElementById('__nova_op_focus');if(!x){x=document.createElement('div');x.id='__nova_op_focus';x.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #fff;border-radius:7px;box-shadow:0 0 16px #f471b5,0 0 0 3px rgba(244,113,181,.5);transition:all .12s;';document.documentElement.appendChild(x);}x.style.left=(r.left-2)+'px';x.style.top=(r.top-2)+'px';x.style.width=(r.width+4)+'px';x.style.height=(r.height+4)+'px';x.style.opacity='1';clearTimeout(window.__novaOpFt);window.__novaOpFt=setTimeout(function(){x.style.opacity='0';},1200);}catch(e){}})()`, true); } catch {}
  }

  function startFill(t) {
    const v = prompt('Text für „' + (t.label || 'Feld') + '" eingeben:', '');
    if (v == null) return;
    doAction('fill', t.i, v, t.label);
  }

  // Aktion ausführen (ohne Re-Scan) → liefert ok zurück. Bei fill: merkt, ob der Wert wirklich im Feld steht.
  let lastFillFilled = true;
  async function execAction(action, idx, value, label) {
    const wv = opWv(); if (!wv) { log('Keine Seite aktiv', true); return false; }
    let r = null; try { r = await wv.executeJavaScript(execJs(action, idx, value), true); } catch (e) { r = { ok: false, error: String(e) }; }
    if (action === 'fill') lastFillFilled = !!(r && r.filled);
    if (r && r.ok) log((action === 'fill' ? (r.filled ? 'Ausgefüllt' : 'Ausgefüllt (Feld blieb leer?)') : action === 'enter' ? 'Bestätigt ↵' : 'Geklickt') + ': [' + idx + '] ' + (label || '').slice(0, 34));
    else log('Aktion fehlgeschlagen: ' + ((r && r.error) || '?'), true);
    return !!(r && r.ok);
  }
  // Manuelle Einzel-Aktion (Buttons im Panel): ausführen + Seite neu verstehen
  async function doAction(action, idx, value, label) {
    await execAction(action, idx, value, label);
    setTimeout(analyze, 900);
  }

  async function analyze() {
    const wv = opWv();
    if (!wv || !isWebUrl(opUrl())) { log('Bitte zuerst eine Webseite öffnen', true); return; }
    log('Analysiere Seite …');
    // In der KI-Bühne KEINE sichtbaren Markierungs-Boxen zeichnen (nur das Modell bauen) — saubere Ansicht
    if (stageMode) { try { await wv.executeJavaScript('window.__novaOpQuiet=true', true); } catch {} }
    let m = null; try { m = await wv.executeJavaScript(SCAN, true); } catch (e) { m = null; }
    if (!m || !m.ok) { log('Analyse fehlgeschlagen' + (m && m.error ? ': ' + m.error : ''), true); return; }
    model = m; renderModel(m);
    log('Verstanden: ' + m.pageType + ' — ' + m.targets.length + ' Elemente markiert');
  }

  function clearOverlay() { const wv = opWv(); if (wv) { try { wv.executeJavaScript(CLEAR, true).catch(() => {}); } catch {} } }

  function layout() {
    const va = $('#view-area');
    if (open) { panel.classList.remove('hidden'); va.style.paddingRight = '380px'; }
    else { panel.classList.add('hidden'); va.style.paddingRight = ''; clearOverlay(); }
  }
  function toggle(force) {
    open = force != null ? force : !open;
    if (open && stageMode) closeStage();   // manuelles Panel & KI-Bühne schließen sich gegenseitig aus
    $('#btn-operator').classList.toggle('active-tool', open);
    layout();
    if (open) setTimeout(analyze, 420);   // nach dem Andocken (Seite hat finale Breite) analysieren
  }

  // ---- Phase 2: Autonome Ausführung (Claude plant Schritt für Schritt, NOVA führt sichtbar aus) ----
  let opRunning = false;
  const MAX_OP_STEPS = 12;   // Standard
  // Max. Schritte aus Einstellungen: 0 / 'unlimited' → unbegrenzt (Infinity), sonst Zahl, Fallback 12
  function maxSteps() {
    const v = state.settings && state.settings.agentMaxSteps;
    if (v === 0 || v === 'unlimited' || v === '0') return Infinity;
    const n = parseInt(v, 10);
    return (n && n > 0) ? n : MAX_OP_STEPS;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setRunUI(on) {
    opRunning = on;
    const b = $('#op-analyze'); b.classList.toggle('op-running', on);
    const u = b.querySelector('use'); if (u) u.setAttribute('href', on ? '#i-x' : '#i-operator');
    b.title = on ? 'Stoppen' : 'Seite verstehen / Ausführen';
  }
  function stop() { setRunUI(false); try { claude.abort(); } catch {} }   // laufende Claude-Anfrage sofort abbrechen

  // Claudes Antwort in EINE Aktion übersetzen
  function parseAction(r) {
    // r ist das volle READ_REPLY-Objekt {text, raw, hrefs, codes}. Für die Aktions-Erkennung den
    // zeilenerhaltenden innerText nehmen und PLAN-/Checklisten-Zeilen ([ ]/[x]) ENTFERNEN —
    // sonst löst z. B. „[ ] Öffne die Seite" eine Navigate-Aktion aus. URLs kommen via pickUrl (hrefs).
    const base = (r && typeof r === 'object') ? (r.text || r.raw || '') : (r || '');
    const txt = base.split('\n').filter((ln) => !/^\s*(?:[-*]\s*)?\[\s*[ xX✓✔•-]?\s*\]/.test(ln)).join('\n');
    if (/FERTIG\s*:/i.test(txt)) return { done: true, msg: (txt.replace(/[\s\S]*FERTIG\s*:?/i, '') || '').trim() };
    // Seitenwechsel: explizites Schlüsselwort → URL robust aus href/code/raw ziehen (innerText zerreißt URLs)
    if (/(?:[ÖO]FFNE|OEFFNE|OPEN|GEHE(?:\s*ZU)?|NAVIGIERE(?:\s*ZU)?|BESUCHE)/i.test(txt)) {
      let url = null;
      if (r && typeof r === 'object' && claude.pickUrl) { try { url = claude.pickUrl(r); } catch {} }
      if (!url) {
        const nv = /(?:[ÖO]FFNE|OEFFNE|OPEN|GEHE(?:\s*ZU)?|NAVIGIERE(?:\s*ZU)?|BESUCHE)\s*:?\s*(https?:\/\/[^\s"'»]+|www\.[^\s"'»]+|[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'»]*)?)/i.exec(txt);
        if (nv) { let u = nv[1].replace(/[)\].,;"'»]+$/, ''); if (!/^https?:\/\//i.test(u)) u = 'https://' + u; if (/^https?:\/\/[^\s/]+\.[^\s/]{2,}/i.test(u)) url = u; }
      }
      if (url) return { action: 'navigate', url };
    }
    // Frage an den Nutzer (fehlende Info / Login-Daten / Auswahl).
    // innerText bevorzugen (behält Zeilenumbrüche), am LETZTEN "FRAGE:" splitten, erste Zeile / bis "?" nehmen.
    if (/(?:FRAGE|FRAG|ASK|EINGABE)\s*:/i.test(txt)) {
      const src = (r && typeof r === 'object' && r.text && /(?:FRAGE|FRAG|ASK|EINGABE)\s*:/i.test(r.text)) ? r.text : txt;
      const parts = src.split(/(?:FRAGE|FRAG|ASK|EINGABE)\s*:/i);
      let q = (parts[parts.length - 1] || '').split('\n')[0].trim();
      const qm = q.indexOf('?');
      if (qm > 0 && qm < 180) q = q.slice(0, qm + 1);          // saubere Frage bis zum Fragezeichen
      q = q.slice(0, 200).replace(/^["„»']|["""»']$/g, '').trim();
      if (q) return { action: 'ask', question: q };
    }
    let m = /(?:F[ÜU]LLE|FUELLE|FILL|TIPPE|TYPE)\s*\[?\s*(\d+)\s*\]?\s*[:=]?\s*["„»']([^"""»'\n]*)/i.exec(txt);
    if (m) return { action: 'fill', idx: +m[1], value: m[2] };
    m = /(?:F[ÜU]LLE|FUELLE|FILL|TIPPE|TYPE)\s*\[?\s*(\d+)\s*\]?\s+(.+)/i.exec(txt);
    if (m) return { action: 'fill', idx: +m[1], value: (m[2] || '').replace(/^["„»']|["""»']$/g, '').trim() };
    // Formular abschicken / Eingabe bestätigen (z. B. nach Login-Feldern, wenn kein Button erkennbar ist)
    let en = /(?:ENTER|ABSCHICKEN|ABSENDEN|BEST[ÄA]TIGEN?|SUBMIT|EINGABETASTE|RETURN)\s*\[?\s*(\d+)?\s*\]?/i.exec(txt);
    if (en) return { action: 'enter', idx: en[1] != null ? +en[1] : null };
    m = /(?:KLICK|CLICK|DR[ÜU]CKE|TIPPE AUF|W[ÄA]HLE)\s*\[?\s*(\d+)\s*\]?/i.exec(txt);
    if (m) return { action: 'click', idx: +m[1] };
    m = /\[(\d+)\]/.exec(txt);
    if (m) return { action: 'click', idx: +m[1] };
    return null;
  }
  // brief=true: kompakter Prompt (nur Seitenzustand) — spart Tokens & hält den Chat schlank.
  // brief=false (Schritt 1 / nach Selbstreparatur im frischen Chat): volle, eigenständige Anleitung.
  function planPrompt(goal, brief) {
    const noText = (l) => !l || /^<[a-z]+>$/.test(l);
    const useful = model.targets.filter((t) => t.kind === 'link' ? !noText(t.label) : true).slice(0, brief ? 55 : 75);
    const compact = useful.map((t) => `[${t.i}] ${t.kind}: ${noText(t.label) ? '(ohne Text — ' + t.kind + ')' : t.label.slice(0, 48)}`).join('\n');
    const empty = !model.targets.length;
    const hint = empty
      ? `\nKEINE Webseite geladen (Startseite). Beginne mit ÖFFNE: <url> (z. B. Google-Suche), um das Ziel zu erreichen.\n`
      : `\nElemente (Index, Typ, Beschriftung):\n${compact}\n`;
    const txtCap = brief ? 1100 : 1500;
    const pageText = (model.text && model.text.length > 40) ? `\nSeitentext (Auszug):\n"""\n${model.text.slice(0, txtCap)}\n"""\n` : '';
    const ctx = userContext.length ? `\nNutzer-Infos:\n${userContext.map((c) => '- ' + c.q + ' → ' + c.a).join('\n')}\n` : '';
    const skeys = Object.keys(secrets);
    const sec = skeys.length ? `\nSicher hinterlegt (echte Werte siehst du NIE — als Platzhalter einsetzen): ${skeys.map((k) => '{{' + k + '}}').join(', ')}.\n` : '';
    const clBlock = checklist.length ? `\nCheckliste:\n${checklist.map((c) => (c.done ? '[x] ' : '[ ] ') + c.text).join('\n')}\n` : '';
    const state = `Seite: ${model.pageType} — ${model.title}\nURL: ${model.url}\n` + hint + pageText + ctx + sec + clBlock;
    if (brief) {
      return `Nächster Schritt zum Ziel "${goal}".\n` + state
        + `\nGib ZUERST den aktualisierten PLAN-Block aus (alle Punkte, erledigte mit [x]), DANN GENAU EINE Aktion (KLICK/FÜLLE/ENTER/ÖFFNE/FRAGE/FERTIG).`;
    }
    return `Du steuerst einen echten Browser über NOVA — du siehst die Seite NICHT, nur dieses Modell.\nZiel des Nutzers: "${goal}"\n` + state
      + `\nGib ZUERST den aktualisierten PLAN-Block aus (Zeilen "[ ] offen" / "[x] erledigt", erledigte Schritte abhaken), DANN GENAU EINE nächste Aktion. Aktionen:\n`
      + `KLICK [index]\n`
      + `FÜLLE [index] "text"   (sensible Daten als Platzhalter {{email}} / {{passwort}})\n`
      + `ENTER [index]   (Formular abschicken / bestätigen, wenn kein Weiter-Button gelistet ist)\n`
      + `ÖFFNE: https://...   (Webseite ansteuern/wechseln, z. B. https://www.google.com/search?q=...)\n`
      + `FRAGE: <kurze Frage>   (NUR wenn dir eine Info fehlt: Login-Daten/Auswahl/Eingabe)\n`
      + `FERTIG: <Ergebnis>\n`
      + `Regeln: Schritt für Schritt Richtung Ziel. Fülle ein Feld IMMER ZUERST mit FÜLLE aus, BEVOR du Weiter/Anmelden klickst — nie „Weiter" bei leerem Feld. `
      + `Nach dem Ausfüllen schickt NOVA Login-Felder oft automatisch ab; sonst Button klicken oder ENTER [index]. Fehlt eine Info → FRAGE. `
      + `Bei Recherche-Zielen: lies den Textauszug, gib bei FERTIG eine AUSFÜHRLICHE, formatierte Zusammenfassung (Stichpunkte "- ", **fett**).`;
  }
  // Router (mit Opus): wählt das effizienteste Modell + erstellt die Checkliste
  function routerPrompt(goal) {
    return `Du bist der Planer eines autonomen Browser-Agenten (NOVA). Aufgabe des Nutzers: "${goal}".\n`
      + `1) Wähle das SCHNELLSTE Modell, das die EINZELSCHRITTE schafft — die meisten Schritte sind einfache Klicks/Eingaben:\n`
      + `   haiku = einfache Navigation/Suche; sonnet = normale mehrstufige Abläufe (Standard); opus NUR wenn wirklich anspruchsvolles Schlussfolgern nötig ist. Im Zweifel SONNET (schnell + zuverlässig). Bei schwierigen Stellen wechselt NOVA automatisch hoch.\n`
      + `2) Erstelle eine KURZE Checkliste der nötigen Schritte (3–7 Punkte).\n`
      + `Antworte GENAU in diesem Format, sonst nichts:\nMODELL: <haiku|sonnet|opus>\nPLAN:\n[ ] erster Schritt\n[ ] zweiter Schritt`;
  }

  // Plan-Anfrage mit SELBSTREPARATUR. build(brief) liefert den Prompt.
  // a0: normal senden · a1: Chat neu laden + erneut · a2/a3: HARD-RESET (frischer Chat) + VOLLER eigenständiger
  // Prompt → die Checkliste trägt den Fortschritt, also macht Claude im frischen Chat nahtlos weiter.
  async function planStep(build) {
    for (let a = 0; a < 4 && opRunning; a++) {
      if (a === 1) { setStageStep('Claude neu laden …'); setStageState('repariert'); try { await claude.reloadChat(); } catch {} }
      else if (a >= 2) { setStageStep('Selbstreparatur: frischer Chat …'); setStageState('repariert'); log('Selbstreparatur: starte frischen Chat (Fortschritt bleibt via Checkliste)', true); degraded = true; try { await claude.freshChat(); } catch {} }
      if (!opRunning) break;
      let r = null; try { r = await claude.runOnce(build(a < 2)); } catch {}   // ab a>=2: voller eigenständiger Prompt
      if (r && (r.raw || r.text)) return r;
      if (!opRunning) break;
      log('Claude antwortete nicht (Versuch ' + (a + 1) + ') …', true);
      await sleep(700);
    }
    return null;
  }

  async function operate(goal) {
    if (opRunning) { stop(); log('Gestoppt'); return; }
    if (!opWv()) { log('Kein Ziel-Fenster', true); return; }
    setRunUI(true);
    userContext = []; secrets = {}; checklist = []; degraded = false; renderChecklist(-1);   // frischer Lauf
    log('🤖 Autonome Steuerung: ' + goal.slice(0, 48));
    setStageSub('verbinde mit Claude …'); setStageState('denkt');
    log('Verbinde mit Claude (Hintergrund) …');
    let ready = false; try { ready = await claude.prepare(); } catch {}
    if (!opRunning) { claude.release(); return; }
    if (!ready) { log('Claude nicht bereit — bitte links im Panel in Claude anmelden', true); setStageStep('Claude nicht bereit — bitte in Claude anmelden'); setStageState('Login nötig'); claude.release(); stop(); return; }
    let finishedResult = null, lastFilledIdx = null, succeeded = false;
    const MAX = maxSteps();                    // aus Einstellungen (0/„unbegrenzt" → Infinity)
    const unlimited = !isFinite(MAX);

    // ---- Router: Opus klassifiziert die Aufgabe → wählt das schnellste passende Modell + Checkliste ----
    let tier = 'sonnet';
    setStageStep('Plane Aufgabe (Opus) …'); setStageState('plant');
    try {
      await claude.setModel('opus');
      const rr = await planStep(() => routerPrompt(goal));
      if (rr) {
        const rt = rr.text || rr.raw || '';
        const mm = /MODELL?\s*:\s*(haiku|sonnet|opus)/i.exec(rt);
        if (mm) tier = mm[1].toLowerCase();
        setChecklist(parseChecklist(rr));
      }
    } catch {}
    if (!opRunning) { claude.release(); secrets = {}; stop(); return; }
    log('Modell: ' + tier + (checklist.length ? ' · ' + checklist.length + ' Schritte geplant' : ''));
    setStageSub('Modell: ' + tier);
    try { await claude.setModel(tier); } catch {}

    // Eskalation: bei wiederholten Problemen auf ein stärkeres Modell wechseln (Kontext bleibt im selben Chat)
    let fails = 0;
    const escalate = () => {
      const i = MODEL_TIERS.indexOf(tier);
      if (i >= 0 && i < MODEL_TIERS.length - 1) {
        tier = MODEL_TIERS[i + 1]; fails = 0;
        log('Mehrere Probleme → wechsle zu stärkerem Modell: ' + tier, true);
        setStageSub('Modell: ' + tier); try { claude.setModel(tier); } catch {}
        return true;
      }
      return false;
    };

    try {
      for (let step = 0; step < MAX && opRunning; step++) {
        setStageProgress(unlimited ? Math.min(92, 12 + step * 7) : (step / MAX) * 100);
        markActiveStep();
        if (isWebUrl(opUrl())) {
          setStageStep('Verstehe die Seite …'); setStageState('liest');
          await analyze();                     // echte Webseite: verstehen + markieren
        } else {
          // Startseite / leerer Tab → kein Webinhalt: Claude soll selbst eine Seite öffnen
          model = { ok: true, pageType: 'NOVA-Startseite (keine Webseite geladen)', title: 'Startseite', url: opUrl() || 'nova://newtab', targets: [] };
          clearOverlay();
          log('Keine Webseite geladen — plane Seitenaufruf …');
        }
        if (!opRunning) break;
        if (!model) { log('Seite nicht lesbar — gestoppt', true); break; }
        log('Denke nach … (Schritt ' + (step + 1) + (unlimited ? '' : '/' + MAX) + ')');
        setStageStep('Plane Schritt ' + (step + 1) + ' …'); setStageState('denkt'); setStageSub('Modell: ' + tier);
        const reply = await planStep((canBrief) => planPrompt(goal, canBrief && step > 0 && !degraded));
        if (!opRunning) break;
        if (!reply) {                          // Claude mehrfach nicht erreichbar → eskalieren statt sofort aufgeben
          if (escalate()) { step--; continue; }
          log('Keine Antwort von Claude — gestoppt', true); setStageStep('Keine Antwort von Claude'); break;
        }
        const cl = parseChecklist(reply); if (cl.length) setChecklist(cl);   // Checkliste live von Claude pflegen
        const act = parseAction(reply);
        if (!act) {
          fails++;
          if (fails >= 2 && escalate()) { step--; continue; }
          if (fails >= 3) { log('Keine Aktion erkannt — gestoppt', true); setStageStep('Keine klare Aktion'); break; }
          log('Keine Aktion erkannt — versuche weiter …', true); continue;
        }
        if (act.done) { succeeded = true; finishedResult = (act.msg || '').trim(); log('Ziel erreicht ✓ ' + finishedResult.slice(0, 80)); setStageStep('Ziel erreicht ✓'); setStageState('fertig'); setStageProgress(100); checklist.forEach((c) => { c.done = true; }); renderChecklist(-1); break; }
        fails = 0;                             // gültige Aktion → Fehlerzähler zurücksetzen
        if (act.action === 'navigate') {
          log('Öffne andere Seite: ' + act.url.slice(0, 52));
          setStageStep('Öffne ' + prettyUrl(act.url)); setStageState('öffnet');
          opNavigate(act.url);
          await sleep(2400);                   // Laden abwarten, dann oben neu verstehen
          continue;
        }
        if (act.action === 'ask') {
          const sk = secretKeyFor(act.question);
          log('Frage an Nutzer: ' + act.question.slice(0, 60));
          setStageStep('Wartet auf deine Eingabe …'); setStageState('fragt');
          const ans = await askUser(act.question, maskFor(act.question));
          if (!opRunning) break;
          if (ans == null) { log('Eingabe abgebrochen — gestoppt', true); setStageStep('Eingabe abgebrochen'); break; }
          if (sk) { secrets[sk] = ans; userContext.push({ q: act.question, a: '«' + sk + ' sicher hinterlegt»' }); log('Sichere Daten hinterlegt (gehen NICHT an Claude)'); }
          else { userContext.push({ q: act.question, a: ans }); log('Antwort erhalten: ' + ans.slice(0, 40)); }
          step--;                              // Frage verbraucht keinen Schritt
          await sleep(200);
          continue;
        }
        // Eingabe bestätigen / Formular abschicken (ENTER) — Feld aus Index oder zuletzt ausgefülltem
        if (act.action === 'enter') {
          const ei = (act.idx != null) ? act.idx : lastFilledIdx;
          if (ei == null || ei < 0 || ei >= model.targets.length) { log('ENTER ohne gültiges Feld — gestoppt', true); break; }
          const et = model.targets[ei];
          setStageStep('Bestätige Eingabe ↵'); setStageState('handelt');
          await execAction('enter', ei, null, et && et.label);
          await sleep(1600);                   // Seite reagieren/navigieren lassen
          continue;
        }
        if (act.idx == null || act.idx < 0 || act.idx >= model.targets.length) { log('Ungültiger Index ' + act.idx + ' — gestoppt', true); break; }
        const t = model.targets[act.idx];
        setStageStep((act.action === 'fill' ? 'Tippe in „' : 'Klicke „') + (t && t.label || '').slice(0, 40) + '"'); setStageState('handelt');
        // Platzhalter {{email}}/{{passwort}}/… lokal durch die sicher gehaltenen Daten ersetzen (kommen nie zu Claude)
        const fillVal = applySecrets(act.value);
        const ok = await execAction(act.action, act.idx, fillVal, t && t.label);
        if (!ok) { log('Aktion scheiterte — gestoppt', true); break; }
        if (act.action === 'fill') {
          lastFilledIdx = act.idx;
          if (!lastFillFilled) { log('Feld blieb leer — kein Enter, plane neu', true); }
          // Auto-Enter NUR wenn das Feld wirklich befüllt wurde (sonst würde „Weiter" auf ein leeres Feld gehen).
          // Greift bei Suchfeld, Passwort sowie Login-Kennung (E-Mail/Telefon/Benutzer) wenn (noch) kein Passwortfeld da ist.
          const hasPwField = model.targets.some((x) => x.kind === 'password');
          const idLike = t && t.kind === 'input' && /e-?mail|mail|telefon|phone|handy|mobil|nutzername|benutzer|\buser\b|login/i.test((t.label || '') + ' ' + (model.pageType || ''));
          const autoEnter = lastFillFilled && t && (t.kind === 'search' || t.kind === 'password' || (idLike && !hasPwField));
          if (autoEnter) { await sleep(450); await execAction('enter', act.idx, null, t.label); }
        }
        await sleep(1200);                     // Seite reagieren/navigieren lassen
      }
    } catch (e) { log('Fehler: ' + (e && e.message), true); }
    claude.release();                          // Claude-Hintergrund-Webview wieder verstecken
    secrets = {};                              // sichere Daten sofort nach dem Lauf aus dem Speicher entfernen
    stop();
    if (stageMode) {
      stageRunningUI(false);
      const res = (finishedResult || '').trim();
      const cur = $('#as-step-tx') ? $('#as-step-tx').textContent : '';
      const stoppedByUser = /gestoppt|abgebrochen|eingabe abgebrochen/i.test(cur);
      if (succeeded && res && res.length > 12) {       // echtes Ergebnis → schön als Karte + Bühne schließen
        setStageState('fertig'); setStageStep('Ergebnis bereit ✓'); showResult(goal, res);
        setTimeout(() => { if (!opRunning && stageMode) closeStage(); }, 1800);
      } else if (succeeded) {                          // erledigt ohne langen Text → kurz anzeigen + schließen
        setStageState('fertig'); setStageStep(res ? ('Fertig: ' + res.slice(0, 70)) : 'Erledigt ✓');
        setTimeout(() => { if (!opRunning && stageMode) closeStage(); }, 3200);
      } else if (stoppedByUser) {                      // vom Nutzer gestoppt → offen lassen
        setStageState('gestoppt');
      } else {                                         // festgefahren → EHRLICH anzeigen, NICHT automatisch schließen
        setStageState('Problem'); setStageStep('Konnte nicht abschließen — Stopp drücken oder erneut starten');
        log('Lauf festgefahren — nicht abgeschlossen', true);
      }
    }
  }

  // Von außen gestartet (Agent-Button auf der Startseite): KI-Bühne öffnen + Ziel autonom erledigen.
  // Claude plant unsichtbar im Hintergrund — der Nutzer sieht NUR die animierte Agenten-Bühne.
  function run(goal) {
    goal = (goal || '').trim(); if (!goal) return;
    if (opRunning) stop();
    if (open) toggle(false);                   // manuelles Operator-Panel zu (Bühne ist die Agent-Ansicht)
    openStage();
    stageReset();
    stageRunningUI(true);
    $('#op-goal').value = goal;
    log('Agent-Modus gestartet: ' + goal.slice(0, 60));
    setStageStep('Agent gestartet: ' + goal.slice(0, 44));
    setTimeout(() => operate(goal), 500);      // kurz warten, bis die Bühnen-Webview „neuer Tab" geladen hat
  }

  $('#btn-operator').addEventListener('click', () => toggle());
  $('#op-close').addEventListener('click', () => toggle(false));
  $('#op-rescan').addEventListener('click', () => { if (opRunning) { stop(); log('Gestoppt'); } else analyze(); });
  $('#op-analyze').addEventListener('click', () => { if (opRunning) { stop(); log('Gestoppt'); return; } const g = $('#op-goal').value.trim(); if (g) operate(g); else analyze(); });
  $('#op-goal').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const g = $('#op-goal').value.trim(); if (g) operate(g); } });

  // Checkliste ein-/ausklappen
  $('#as-check-toggle').addEventListener('click', () => $('#as-check').classList.toggle('collapsed'));
  // KI-Bühne ein-/ausklappen (schmale Seitenleiste)
  $('#as-collapse').addEventListener('click', (e) => { e.stopPropagation(); setStageCollapsed(true); });
  $('#as-rail').addEventListener('click', () => setStageCollapsed(false));
  // KI-Bühne: Stop-Button → läuft gerade? stoppen. Sonst Bühne schließen.
  $('#as-stop').addEventListener('click', () => {
    if (opRunning) { stop(); stageRunningUI(false); setStageState('gestoppt'); setStageStep('Vom Nutzer gestoppt'); log('Gestoppt'); }
    else closeStage();
  });

  // Drag&Drop: Bühne am Kopf greifen → an linken/rechten Rand andocken (wie das Claude-Panel)
  const snapHint = el('div', 'as-snap hidden'); document.body.appendChild(snapHint);
  function showSnap(side) {
    const va = $('#view-area'); const r = va.getBoundingClientRect();
    const w = Math.min(stage.offsetWidth, r.width - 20);
    snapHint.style.top = r.top + 'px'; snapHint.style.height = (r.height - 10) + 'px'; snapHint.style.width = w + 'px';
    snapHint.style.left = (side === 'left' ? r.left : r.right - w) + 'px';
    snapHint.classList.remove('hidden');
  }
  const stageHead = stage.querySelector('.as-head');
  stageHead.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.button !== 0 || stageCollapsed) return;
    e.preventDefault();
    const shield = $('#drag-shield');
    // WICHTIG: Webviews schlucken Maus-Events → Vollbild-Shield einblenden, sonst feuern mousemove/up nicht.
    shield.classList.remove('hidden'); document.body.classList.add('as-dragging');
    let moved = false; const startX = e.clientX;
    const sideAt = (x) => (x < window.innerWidth / 2 ? 'left' : 'right');
    const onMove = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 6) return;
      moved = true; stage.classList.add('as-grab');
      showSnap(sideAt(ev.clientX));
    };
    const onUp = (ev) => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
      shield.classList.add('hidden'); document.body.classList.remove('as-dragging'); stage.classList.remove('as-grab'); snapHint.classList.add('hidden');
      if (moved) setStageSide(sideAt(ev.clientX));
    };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  });

  // Bühnenposition/-breite bei Fenstergröße nachführen
  window.addEventListener('resize', () => { if (stageMode && !stage.classList.contains('hidden')) stageDock(); });
  // Ergebnis-Karte
  $('#ar-close').addEventListener('click', () => $('#agent-result').classList.add('hidden'));
  $('#ar-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#agent-result')._text || ''); const b = $('#ar-copy'); b.classList.add('ok'); setTimeout(() => b.classList.remove('ok'), 1100); } catch {}
  });

  return { toggle, analyze, run, isOpen: () => open, relayout: () => { if (stageMode && !stage.classList.contains('hidden')) stageDock(); }, relayoutAnimated };
})();

/* ============================================================ topbar popovers */
const SPEED_OPTS = [
  [0, 'Unbegrenzt'], [131072, '128 KB/s'], [262144, '256 KB/s'], [524288, '512 KB/s'],
  [1048576, '1 MB/s'], [2097152, '2 MB/s'], [5242880, '5 MB/s'], [10485760, '10 MB/s'],
];
function fmtRate(n) { return n >= 1 ? fmtBytes(n) + '/s' : '0 KB/s'; }

// Eigenes, themen-konformes Dropdown (das native <select>-Popup ist nicht stylebar)
function makeSpeedSelect(value, onChange) {
  const sel = el('div', 'nsel');
  const head = el('div', 'nsel-head');
  const val = el('span', 'nsel-val');
  head.append(val, icon('i-down', 'ic chev'));
  sel.appendChild(head);
  let cur = value, pop = null;
  const labelFor = (v) => (SPEED_OPTS.find((o) => o[0] === v) || SPEED_OPTS[0])[1];
  val.textContent = labelFor(cur);

  function closePop() { if (pop) { pop.remove(); pop = null; } sel.classList.remove('open'); }
  function openPop() {
    closePop();
    pop = el('div', 'nsel-pop');
    for (const [v, label] of SPEED_OPTS) {
      const o = el('div', 'nsel-opt' + (v === cur ? ' sel' : ''), label);
      o.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        cur = v; val.textContent = label; closePop(); onChange(v);
      });
      pop.appendChild(o);
    }
    document.body.appendChild(pop);
    const r = head.getBoundingClientRect();
    const ph = pop.getBoundingClientRect().height;
    let top = r.bottom + 4;
    if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 4);
    pop.style.minWidth = r.width + 'px';
    pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 8) + 'px';
    pop.style.top = top + 'px';
    sel.classList.add('open');
  }
  head.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); pop ? closePop() : openPop(); });
  sel._close = closePop;
  sel._set = (v) => { cur = v; val.textContent = labelFor(v); };
  return sel;
}
// offene Dropdowns bei Klick außerhalb schließen
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.nsel')) {
    document.querySelectorAll('.nsel-pop').forEach((p) => p.remove());
    document.querySelectorAll('.nsel.open').forEach((s) => s.classList.remove('open'));
  }
});

function positionPop(pop, btn) {
  pop.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const w = pop.getBoundingClientRect().width;
  pop.style.top = r.bottom + 9 + 'px';
  pop.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
}

/* ---- Download-Dropdown ---- */
const dlPop = (() => {
  const pop = $('#dl-pop');
  const list = $('#dl-pop-list');
  let openFlag = false;

  // Gesamt-Limit-Dropdown einmalig bauen
  let globalSel = null;
  function ensureGlobalSel() {
    if (globalSel) { globalSel._set(state.settings.dlGlobalLimit || 0); return; }
    globalSel = makeSpeedSelect(state.settings.dlGlobalLimit || 0, (v) => {
      state.settings.dlGlobalLimit = v;
      window.nova.downloads.globalLimit(v);
    });
    $('#dl-global-limit').appendChild(globalSel);
  }

  function isOpen() { return openFlag; }
  function toggle(force) {
    openFlag = force != null ? force : !openFlag;
    if (openFlag) { ensureGlobalSel(); paint(); positionPop(pop, $('#btn-downloads-top')); }
    else { document.querySelectorAll('.nsel-pop').forEach((p) => p.remove()); pop.classList.add('hidden'); }
  }
  function close() { openFlag = false; document.querySelectorAll('.nsel-pop').forEach((p) => p.remove()); pop.classList.add('hidden'); }

  // In-place-Rendering: Zeilen werden wiederverwendet, damit das Einzel-Tempo-
  // Dropdown beim häufigen Status-Update (alle ~350 ms) nicht neu gebaut wird.
  const STATE_LABEL = { progressing: 'Lädt', completed: 'Fertig', cancelled: 'Abgebrochen', interrupted: 'Fehler' };
  const rows = new Map(); // id -> { row, sub, fill, bar, actions, limit, _state, _paused }

  function buildRow(it) {
    const row = el('div', 'dlp-item');
    const top = el('div', 'dlp-top');
    const ic = el('div', 'dlp-ic'); ic.appendChild(icon('i-file'));
    const info = el('div', 'dlp-info');
    const name = el('div', 'dlp-name', it.file);
    const sub = el('div', 'dlp-sub');
    info.append(name, sub);
    const actions = el('div', 'dlp-actions');
    top.append(ic, info, actions);
    const bar = el('div', 'dlp-bar'); const fill = el('i'); bar.appendChild(fill);
    const limit = el('div', 'dlp-limit');
    row.append(top, bar, limit);
    const r = { row, name, sub, fill, bar, actions, limit, _state: null, _paused: null, _mode: it.mode };
    rows.set(it.id, r);
    return r;
  }

  function rebuildActions(r, it) {
    r.actions.innerHTML = '';
    const act = (icn, title, action) => {
      const b = el('button', 'icon-btn'); b.appendChild(icon(icn)); b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); window.nova.downloads.action({ id: it.id, action }); });
      return b;
    };
    if (it.state === 'progressing') {
      r.actions.appendChild(it.paused ? act('i-play', 'Fortsetzen', 'resume') : act('i-pause', 'Pause', 'pause'));
      r.actions.appendChild(act('i-x', 'Abbrechen', 'cancel'));
    } else if (it.state === 'completed') {
      r.actions.appendChild(act('i-ext', 'Öffnen', 'open'));
      r.actions.appendChild(act('i-folder', 'Im Ordner zeigen', 'show'));
    }
  }

  function updateRow(r, it) {
    r.name.textContent = it.file;
    const pct = it.total > 0 ? Math.round((it.received / it.total) * 100) : 0;
    r.sub.textContent = it.state === 'progressing'
      ? `${fmtBytes(it.received)}${it.total ? ' / ' + fmtBytes(it.total) : ''} · ${it._speed > 1024 ? fmtRate(it._speed) : '…'}${it.paused ? ' · pausiert' : ''}`
      : `${STATE_LABEL[it.state] || it.state} · ${fmtBytes(it.received)}`;
    r.bar.style.display = it.state === 'progressing' ? '' : 'none';
    r.fill.style.width = pct + '%';
    // Aktionen nur bei Statuswechsel neu bauen
    if (r._state !== it.state || r._paused !== it.paused) { rebuildActions(r, it); r._state = it.state; r._paused = it.paused; }
    // Einzel-Tempolimit nur einmal aufbauen (eigene Downloads, während des Ladens)
    const wantLimit = it.state === 'progressing' && it.mode === 'custom';
    if (wantLimit && !r.limit.childElementCount) {
      r.limit.appendChild(icon('i-gauge'));
      r.limit.appendChild(el('span', 'dlp-limit-label', 'Tempo'));
      r.limit.appendChild(makeSpeedSelect(it.limit || 0, (v) => window.nova.downloads.limit({ id: it.id, limit: v })));
    } else if (!wantLimit && r.limit.childElementCount) {
      r.limit.innerHTML = '';
    }
  }

  function paint() {
    const items = [...dlState.values()].sort((a, b) => b.ts - a.ts);
    if (items.length === 0) {
      rows.clear(); list.innerHTML = '';
      const es = el('div', 'empty-state');
      es.appendChild(icon('i-download'));
      es.appendChild(el('span', null, 'Noch keine Downloads'));
      list.appendChild(es);
      return;
    }
    if (list.querySelector('.empty-state')) list.innerHTML = '';
    const present = new Set(items.map((i) => i.id));
    for (const [id, r] of [...rows]) if (!present.has(id)) { r.row.remove(); rows.delete(id); }
    for (const it of items) {
      const r = rows.get(it.id) || buildRow(it);
      updateRow(r, it);
      list.appendChild(r.row); // erzwingt Sortierreihenfolge (verschiebt vorhandenen Knoten)
    }
  }

  $('#dl-open-folder').addEventListener('click', () => window.nova.downloads.openFolder());
  $('#dl-clear').addEventListener('click', async () => { await window.nova.downloads.clear(); for (const [id, m] of [...dlState]) if (m.state !== 'progressing') dlState.delete(id); paint(); syncDlBadge(); });

  return { toggle, close, isOpen, paint };
})();

/* ---- Netzwerk-Monitor ---- */
const netPop = (() => {
  const pop = $('#net-pop');
  const list = $('#net-pop-list');
  let openFlag = false;
  // Glättung: Streaming lädt stoßweise (Burst, Pause, Burst). Ein gleitender
  // Mittelwert über mehrere Sekunden zeigt die echte, ruhige Dauer-Bandbreite.
  const SMOOTH = 5;     // Sekunden für die Durchschnittsrate
  const SPARK = 14;     // Balken im Sparkline-Verlauf
  const agg = new Map(); // wcId -> { buf:[], spark:[], req }
  const rowEls = new Map(); // wcId -> { row, title, sub, rate, sparkBox }
  let totalSmoothed = 0, totalReq = 0, activeTabs = 0;

  function isOpen() { return openFlag; }
  function toggle(force) {
    const next = force != null ? force : !openFlag;
    if (next === openFlag) return;
    openFlag = next;
    $('#btn-netmon').classList.toggle('active-tool', openFlag);
    window.nova.net.monitor(openFlag); // Debugger nur anhängen, solange offen
    if (openFlag) { agg.clear(); rowEls.clear(); list.innerHTML = ''; totalSmoothed = totalReq = activeTabs = 0; paint(); positionPop(pop, $('#btn-netmon')); }
    else { pop.classList.add('hidden'); }
  }
  function close() { if (openFlag) toggle(false); }

  const rateOf = (a) => a.buf.reduce((s, x) => s + x, 0) / Math.max(1, a.buf.length);

  function spark(arr) {
    const max = Math.max(1, ...arr);
    const bw = 54 / SPARK;
    let rects = '';
    for (let i = 0; i < arr.length; i++) {
      const h = Math.max(1, (arr[i] / max) * 20);
      rects += `<rect x="${(i * bw).toFixed(1)}" y="${(22 - h).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`;
    }
    return `<svg class="netp-spark" viewBox="0 0 54 22">${rects}</svg>`;
  }

  function ingest(stats) {
    const byId = new Map();
    for (const t of (stats.tabs || [])) byId.set(t.wcId, t);
    const ids = new Set([...agg.keys(), ...byId.keys()]);
    for (const id of ids) {
      let a = agg.get(id); if (!a) { a = { buf: [], spark: [], req: 0 }; agg.set(id, a); }
      const t = byId.get(id);
      const down = t ? t.down : 0;
      a.buf.push(down); if (a.buf.length > SMOOTH) a.buf.shift();
      a.spark.push(down); if (a.spark.length > SPARK) a.spark.shift();
      a.req = t ? t.req : 0;
      if (a.buf.every((x) => x === 0) && a.spark.every((x) => x === 0)) agg.delete(id);
    }
    totalSmoothed = 0; totalReq = 0; activeTabs = 0;
    for (const a of agg.values()) {
      const r = rateOf(a);
      if (r > 1024) { totalSmoothed += r; activeTabs++; }
      totalReq += a.req;
    }
  }

  function paint() {
    $('#net-down-rate').textContent = fmtRate(totalSmoothed);
    $('#net-up-rate').textContent = activeTabs;
    $('#net-req-rate').textContent = totalReq;
    $('#net-total-rate').textContent = fmtRate(totalSmoothed);

    const entries = [...agg.entries()]
      .map(([wcId, a]) => ({ wcId, rate: rateOf(a), spark: a.spark, req: a.req }))
      .filter((e) => e.rate > 1024)
      .sort((x, y) => y.rate - x.rate);

    // leere Zeilen entfernen
    const live = new Set(entries.map((e) => e.wcId));
    for (const [id, r] of [...rowEls]) if (!live.has(id)) { r.row.remove(); rowEls.delete(id); }

    if (entries.length === 0) {
      if (!list.querySelector('.empty-state')) {
        list.innerHTML = '';
        const es = el('div', 'empty-state'); es.appendChild(icon('i-activity'));
        es.appendChild(el('span', null, 'Kein aktiver Netzwerkverkehr')); list.appendChild(es);
      }
      return;
    }
    if (list.querySelector('.empty-state')) list.innerHTML = '';

    for (const e of entries) {
      const tab = tabByWcId(e.wcId);
      let r = rowEls.get(e.wcId);
      if (!r) {
        const row = el('div', 'netp-item');
        const fav = faviconEl(tab ? (tab.pendingUrl || tab.url) : 'x', 'netp-fav');
        const info = el('div', 'netp-info');
        const title = el('div', 'netp-title', tab ? displayTitle(tab) : 'Hintergrund / Player');
        const sub = el('div', 'netp-sub');
        info.append(title, sub);
        const sparkBox = el('div', 'netp-sparkbox');
        const rate = el('div', 'netp-rate'); const b = el('b'); rate.appendChild(b);
        row.append(fav, info, sparkBox, rate);
        if (tab) row.addEventListener('click', () => { activateTab(tab.id); close(); });
        r = { row, title, sub, rate: b, sparkBox };
        rowEls.set(e.wcId, r);
      }
      if (tab) r.title.textContent = displayTitle(tab);
      r.sub.textContent = `${e.req} Anfragen/s`;
      r.rate.textContent = fmtRate(e.rate);
      r.sparkBox.innerHTML = spark(e.spark);
      list.appendChild(r.row); // Sortierreihenfolge
    }
  }

  window.nova.net.onStats((stats) => {
    ingest(stats || { tabs: [] });
    if (openFlag) paint();
  });

  return { toggle, close, isOpen };
})();

/* ---- Topbar anpassen ---- */
const teEdit = (() => {
  const pop = $('#topbar-edit');
  const list = $('#te-list');
  const TOOLS = [
    ['claude', 'i-claude', 'Claude (NOVA AI)'], ['music', 'i-music', 'Musik'], ['downloads', 'i-download', 'Downloads'],
    ['netmon', 'i-activity', 'Netzwerk-Monitor'], ['screenshot', 'i-camera', 'Screenshot'], ['split', 'i-split', 'Split View'],
    ['shield', 'i-shield', 'NOVA Shield'], ['operator', 'i-operator', 'NOVA Operator'], ['plugins', 'i-plugin', 'Plugin-Store'], ['palette', 'i-bolt', 'Befehlspalette'],
  ];
  // NOVA-eigene Werkzeuge (eigene Buttons, kein data-tool) — standardmäßig sichtbar, per Set ausblendbar
  const EXTRA = [
    ['vault', '#btn-vault', 'NOVA Tresor'],
    ['share', '#btn-share', 'NOVA Share'],
    ['studio', '#btn-studio', 'NOVA Studio'],
    ['shifter', '#btn-shifter', 'Shifter'],
    ['discord', '#btn-discord', 'Discord'],
    ['whatsapp', '#btn-whatsapp', 'WhatsApp'],
  ];
  let openFlag = false;
  let extList = [];   // aktuell geladene Erweiterungs-Actions (von extActions gesetzt)

  function visible() {
    const t = state.settings.topbarTools;
    return Array.isArray(t) ? t : TOOLS.map((x) => x[0]);
  }
  function hiddenExt() { return new Set(state.settings.topbarExtHidden || []); }
  function extraHidden() { return new Set(state.settings.topbarExtraHidden || []); }
  function extraIcon(sel) {
    const b = document.querySelector(sel), svg = b && b.querySelector('svg');
    if (svg) { const c = svg.cloneNode(true); c.removeAttribute('width'); c.removeAttribute('height'); return c; }
    return icon('i-plugin');
  }
  function apply() {
    const vis = new Set(visible());
    const hidden = hiddenExt();
    for (const btn of document.querySelectorAll('.topbar-tool')) {
      const t = btn.dataset.tool || '';
      if (t.startsWith('ext:')) btn.classList.toggle('hidden', hidden.has(t.slice(4)));
      else btn.classList.toggle('hidden', !vis.has(t));
    }
    const exHid = extraHidden();
    for (const [key, sel] of EXTRA) { const b = document.querySelector(sel); if (b) b.classList.toggle('hidden', exHid.has(key)); }
  }
  function setExtList(list) { extList = list || []; }
  function toggle(force) {
    openFlag = force != null ? force : !openFlag;
    if (openFlag) { render(); positionPop(pop, $('#btn-edit-topbar')); }
    else pop.classList.add('hidden');
  }
  function close() { openFlag = false; pop.classList.add('hidden'); }

  function render() {
    const vis = new Set(visible());
    list.innerHTML = '';
    for (const [key, ic, label] of TOOLS) {
      const row = el('div', 'te-row');
      row.appendChild(icon(ic));
      row.appendChild(el('span', null, label));
      const sw = el('label', 'switch');
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = vis.has(key);
      inp.addEventListener('change', () => {
        const cur = new Set(visible());
        inp.checked ? cur.add(key) : cur.delete(key);
        const arr = TOOLS.map((x) => x[0]).filter((k) => cur.has(k));
        state.settings.topbarTools = arr;
        window.nova.settings.set({ topbarTools: arr });
        apply();
      });
      sw.appendChild(inp); sw.appendChild(el('i'));
      row.append(sw);
      list.appendChild(row);
    }
    // NOVA-eigene Werkzeuge (Studio, Shifter, Discord)
    list.appendChild(el('div', 'te-sep', 'NOVA-Werkzeuge'));
    const exHid = extraHidden();
    for (const [key, sel, label] of EXTRA) {
      const row = el('div', 'te-row');
      row.appendChild(extraIcon(sel));
      row.appendChild(el('span', null, label));
      const sw = el('label', 'switch');
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !exHid.has(key);
      inp.addEventListener('change', () => {
        const cur = extraHidden();
        inp.checked ? cur.delete(key) : cur.add(key);
        const arr = [...cur];
        state.settings.topbarExtraHidden = arr;
        window.nova.settings.set({ topbarExtraHidden: arr });
        apply();
      });
      sw.appendChild(inp); sw.appendChild(el('i'));
      row.append(sw);
      list.appendChild(row);
    }
    // Erweiterungs-Toolbar-Icons (falls vorhanden)
    if (extList.length) {
      list.appendChild(el('div', 'te-sep', 'Erweiterungen'));
      const hidden = hiddenExt();
      for (const a of extList) {
        const row = el('div', 'te-row');
        if (a.icon) { const img = el('img', 'te-ext-ico'); img.src = a.icon; row.appendChild(img); }
        else row.appendChild(icon('i-plugin'));
        row.appendChild(el('span', null, a.name));
        const sw = el('label', 'switch');
        const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !hidden.has(a.id);
        inp.addEventListener('change', () => {
          const cur = hiddenExt();
          inp.checked ? cur.delete(a.id) : cur.add(a.id);
          const arr = [...cur];
          state.settings.topbarExtHidden = arr;
          window.nova.settings.set({ topbarExtHidden: arr });
          apply();
        });
        sw.appendChild(inp); sw.appendChild(el('i'));
        row.append(sw);
        list.appendChild(row);
      }
    }
  }
  return { toggle, close, apply, setExtList };
})();

/* ---- Erweiterungs-Toolbar-Icons (browser actions) ---- */
const extActions = (() => {
  const wrap = $('#ext-actions');
  const pop = $('#ext-popup');
  const body = $('#ext-pop-body');
  let current = null, currentUrl = null;

  async function refresh() {
    let acts = [];
    try { acts = await window.nova.plugins.actions(); } catch {}
    wrap.innerHTML = '';
    for (const a of acts) {
      const btn = el('button', 'icon-btn topbar-tool ext-tool');
      btn.dataset.tool = 'ext:' + a.id;
      btn.title = a.title || a.name;
      if (a.icon) { const img = el('img', 'ext-ico'); img.src = a.icon; img.alt = ''; btn.appendChild(img); }
      else btn.appendChild(icon('i-plugin'));
      btn.addEventListener('click', (e) => { e.stopPropagation(); openPopup(a, btn); });
      wrap.appendChild(btn);
    }
    if (typeof teEdit !== 'undefined') { teEdit.setExtList(acts); teEdit.apply(); }
  }

  function openPopup(a, btn) {
    const wasOpen = current === a.id && !pop.classList.contains('hidden');
    closePopup();
    if (wasOpen) return;
    if (!a.popup) { toast((a.name || 'Erweiterung') + ' hat kein Popup-Fenster', 'i-info'); return; }
    current = a.id; currentUrl = a.popup;
    $('#ext-pop-title').textContent = a.name;
    const wv = document.createElement('webview');
    wv.setAttribute('partition', PARTITION);
    wv.setAttribute('src', a.popup);
    wv.setAttribute('allowpopups', '');
    wv.style.width = '360px'; wv.style.height = '480px';
    wv.addEventListener('dom-ready', () => {
      wv.executeJavaScript('({w:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth),h:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)})', true)
        .then((d) => { if (d && d.w) { wv.style.width = Math.min(780, Math.max(240, d.w)) + 'px'; wv.style.height = Math.min(620, Math.max(120, d.h + 4)) + 'px'; positionPop(pop, btn); } })
        .catch(() => {});
    });
    body.innerHTML = ''; body.appendChild(wv);
    pop.classList.remove('hidden');
    positionPop(pop, btn);
    // Lädt die Erweiterung wirklich GAR nicht (komplett leer)? → erst nach 16s eine ehrliche
    // Meldung (gibt langsamen/login-pflichtigen Erweiterungen genug Zeit, sich aufzubauen).
    const myId = a.id;
    setTimeout(async () => {
      if (current !== myId) return;
      let info = null;
      try { info = await wv.executeJavaScript('({t:(document.body?document.body.innerText.trim().length:0),n:document.querySelectorAll("div,button,input,form,main,section,a,canvas,img,iframe").length})', true); } catch {}
      if (info && info.t < 2 && info.n < 3) showStuck(a);
    }, 16000);
  }
  function showStuck(a) {
    body.innerHTML = '';
    const box = el('div', 'ext-stuck');
    box.appendChild(icon('i-info'));
    box.appendChild(el('p', null, `„${a.name}" lädt in NOVA nicht. Komplexe Erweiterungen (z. B. Passwort-Manager) brauchen Chrome-interne Funktionen, die NOVAs Erweiterungs-Engine (Electron) nicht voll bereitstellt.`));
    const open = el('button', 'btn'); open.appendChild(icon('i-ext')); open.appendChild(el('span', null, 'Trotzdem im Tab öffnen'));
    open.addEventListener('click', () => { if (currentUrl) { createTab(currentUrl); closePopup(); } });
    box.appendChild(open);
    body.appendChild(box);
  }
  function closePopup() { pop.classList.add('hidden'); body.innerHTML = ''; current = null; }

  $('#ext-pop-open').addEventListener('click', () => { if (currentUrl) { createTab(currentUrl); closePopup(); } });
  $('#ext-pop-close').addEventListener('click', closePopup);
  window.nova.plugins.onActionsChanged(() => refresh());
  // Rückmeldung, wenn von einer Store-Seite aus installiert wurde
  window.nova.plugins.onInstalled((r) => {
    if (r && r.ok) {
      toast(`„${r.ext.name}" in NOVA installiert ✓`);
      if (!$('#hub').classList.contains('hidden') && $('#panel-plugins').classList.contains('active')) renderPlugins();
    } else if (r) toast('Installation fehlgeschlagen: ' + (r.error || 'unbekannt'), 'i-x');
  });
  return { refresh, closePopup };
})();

/* ---- Favorit speichern (Ordner wählen / anlegen) ---- */
const bmSave = (() => {
  const pop = $('#bm-save');
  const foldersBox = $('#bm-save-folders');
  let openFlag = false, ctx = null, selectedFolder = null;

  function flattenFolders() {
    const acc = [];
    const walk = (nodes, depth) => {
      for (const n of nodes || []) {
        if (n.type === 'folder') { acc.push({ id: n.id, name: n.name, depth }); walk(n.children, depth + 1); }
      }
    };
    walk(state.bookmarks, 0);
    return acc;
  }
  function parentFolderOf(id) {
    let parent = null;
    const walk = (nodes, pid) => {
      for (const n of nodes || []) {
        if (n.id === id) { parent = pid; return true; }
        if (n.children && walk(n.children, n.id)) return true;
      }
      return false;
    };
    walk(state.bookmarks, null);
    return parent;
  }

  function renderFolders() {
    foldersBox.innerHTML = '';
    const folders = flattenFolders();
    if (folders.length === 0) selectedFolder = null;
    if (selectedFolder && !folders.some((f) => f.id === selectedFolder)) selectedFolder = folders[0] ? folders[0].id : null;
    for (const f of folders) {
      const row = el('div', 'bms-folder' + (f.id === selectedFolder ? ' sel' : ''));
      row.style.paddingLeft = 9 + f.depth * 14 + 'px';
      row.appendChild(icon('i-folder'));
      row.appendChild(el('span', 'bms-fname', f.name));
      row.appendChild(icon('i-check', 'ic bms-check'));
      row.addEventListener('click', () => { selectedFolder = f.id; renderFolders(); });
      foldersBox.appendChild(row);
    }
  }

  function open({ url, title, existing }) {
    closeAllTopMenus();
    ctx = { url, title, existing };
    $('#bm-save-title').textContent = existing ? 'Favorit bearbeiten' : 'Favorit hinzufügen';
    $('#bm-save-name').value = existing ? existing.name : (title || url);
    $('#bm-save-remove').classList.toggle('hidden', !existing);
    $('#bm-save-confirm').querySelector('span').textContent = existing ? 'Aktualisieren' : 'Speichern';
    selectedFolder = existing ? parentFolderOf(existing.id) : null;
    if (!selectedFolder) { const f = flattenFolders(); selectedFolder = f[0] ? f[0].id : null; }
    $('#bm-newfolder-row').classList.add('hidden');
    $('#bm-newfolder-name').value = '';
    renderFolders();
    openFlag = true;
    positionPop(pop, $('#btn-star'));
    setTimeout(() => $('#bm-save-name').focus(), 30);
  }
  function close() { openFlag = false; pop.classList.add('hidden'); }
  function isOpen() { return openFlag; }

  $('#bm-new-folder').addEventListener('click', () => {
    const row = $('#bm-newfolder-row');
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) $('#bm-newfolder-name').focus();
  });
  async function createFolder() {
    const name = $('#bm-newfolder-name').value.trim();
    if (!name) return;
    const folder = await window.nova.bookmarks.createFolder({ name, parentId: selectedFolder });
    $('#bm-newfolder-name').value = '';
    $('#bm-newfolder-row').classList.add('hidden');
    // state.bookmarks wird per bm:changed aktualisiert; kurz warten, dann auswählen
    setTimeout(() => { selectedFolder = folder.id; renderFolders(); }, 60);
  }
  $('#bm-newfolder-create').addEventListener('click', createFolder);
  $('#bm-newfolder-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') $('#bm-newfolder-row').classList.add('hidden'); });

  $('#bm-save-confirm').addEventListener('click', async () => {
    if (!ctx) return;
    const name = $('#bm-save-name').value.trim() || ctx.title || ctx.url;
    if (ctx.existing) {
      if (name !== ctx.existing.name) await window.nova.bookmarks.rename({ id: ctx.existing.id, name });
      if (selectedFolder && parentFolderOf(ctx.existing.id) !== selectedFolder) {
        await window.nova.bookmarks.move({ id: ctx.existing.id, targetParentId: selectedFolder });
      }
      toast('Favorit aktualisiert', 'i-star');
    } else {
      await window.nova.bookmarks.add({ url: ctx.url, title: name, folderId: selectedFolder });
      toast('Zu Favoriten hinzugefügt', 'i-star');
    }
    close();
    syncStar(activeTab());
  });
  $('#bm-save-remove').addEventListener('click', async () => {
    if (ctx && ctx.existing) { await window.nova.bookmarks.remove(ctx.existing.id); toast('Aus Favoriten entfernt', 'i-star'); }
    close();
    syncStar(activeTab());
  });
  $('#bm-save-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#bm-save-confirm').click(); if (e.key === 'Escape') close(); });

  return { open, close, isOpen, renderFolders };
})();

$('#btn-downloads-top').addEventListener('click', () => { netPop.close(); teEdit.close(); bmSave.close(); dlPop.toggle(); });
$('#btn-netmon').addEventListener('click', () => { dlPop.close(); teEdit.close(); bmSave.close(); netPop.toggle(); });
$('#btn-edit-topbar').addEventListener('click', () => { dlPop.close(); netPop.close(); bmSave.close(); teEdit.toggle(); });
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#dl-pop') && !e.target.closest('#btn-downloads-top') && !e.target.closest('.nsel-pop')) dlPop.close();
  if (!e.target.closest('#net-pop') && !e.target.closest('#btn-netmon')) netPop.close();
  if (!e.target.closest('#topbar-edit') && !e.target.closest('#btn-edit-topbar')) teEdit.close();
  if (!e.target.closest('#bm-save') && !e.target.closest('#btn-star') && !e.target.closest('.nsel-pop')) bmSave.close();
});

/* ============================================================ click ripple */
// Sanftes, akzentfarbenes Klick-Feedback auf allen interaktiven Elementen
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const host = e.target.closest(
    '.btn, .icon-btn, .ctx-item, .hub-nav-btn, .engine-card, .dial, .space-chip, .palette-item, .sugg-row, #btn-newtab, .accent-dot, .se-icon-btn'
  );
  if (!host || host.disabled) return;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const r = host.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 1.1;
  const rip = el('span', 'ripple');
  rip.style.width = rip.style.height = size + 'px';
  rip.style.left = (e.clientX - r.left - size / 2) + 'px';
  rip.style.top = (e.clientY - r.top - size / 2) + 'px';
  host.appendChild(rip);
  setTimeout(() => rip.remove(), 600);
});

/* ============================================================ auto-updater */
const updater = (() => {
  const pop = $('#update-pop');
  let info = null, busy = false;

  function show(i) {
    info = i;
    $('#up-sub').textContent = `Version ${i.version} ist verfügbar — du hast ${state.versions.app}.`;
    const notes = (i.notes || '').trim().replace(/\r/g, '');
    $('#up-notes').textContent = notes || 'Verbesserungen und Fehlerbehebungen.';
    $('#up-progress').classList.add('hidden');
    $('#up-progress').querySelector('i').style.width = '0%';
    $('#up-now').disabled = false;
    $('#up-now').querySelector('span').textContent = 'Jetzt aktualisieren';
    pop.classList.remove('hidden');
  }
  function close() { pop.classList.add('hidden'); }

  // Vollbild-Nebula-Overlay während NOVA für das Update beendet wird
  function showInstallSplash(version) {
    const s = $('#upd-splash');
    if (!s) return;
    const v = $('#upd-splash-ver');
    if (v) v.textContent = version ? ('Version ' + version + ' wird installiert') : 'Neue Version wird installiert';
    s.classList.remove('hidden');
    requestAnimationFrame(() => s.classList.add('show'));
  }
  function hideInstallSplash() {
    const s = $('#upd-splash');
    if (!s) return;
    s.classList.remove('show');
    setTimeout(() => s.classList.add('hidden'), 360);
  }

  $('#up-close').addEventListener('click', close);
  $('#up-later').addEventListener('click', close);
  $('#up-page').addEventListener('click', () => window.nova.update.openPage());
  $('#up-now').addEventListener('click', async () => {
    if (busy) return; busy = true;
    $('#up-now').disabled = true;
    $('#up-now').querySelector('span').textContent = 'Lädt …';
    $('#up-progress').classList.remove('hidden');
    const res = await window.nova.update.download();
    busy = false;
    if (res && res.ok && res.path) {
      $('#up-now').querySelector('span').textContent = 'Wird installiert …';
      showInstallSplash(info && info.version);   // animiertes Nebula-Overlay (NOVA schließt gleich)
      const ir = await window.nova.update.install(res.path);
      if (ir && ir.dev) {
        // Entwicklungsmodus (npm start) → kein Selbst-Update; nur die gepackte NOVA.exe kann das.
        hideInstallSplash();
        $('#up-now').disabled = false; $('#up-now').querySelector('span').textContent = 'Schließen';
        toast('Entwicklungsmodus erkannt — läuft als „' + (ir.exe || '?') + '". Auto-Update geht nur aus der gepackten NOVA.exe', 'i-warn');
      } else if (ir && ir.ok === false) {
        hideInstallSplash();
        $('#up-now').disabled = false; $('#up-now').querySelector('span').textContent = 'Erneut versuchen';
        toast('Update konnte nicht gestartet werden', 'i-warn');
      } else if (ir && ir.elevated) {
        // UAC: NOVA bleibt offen bis bestätigt → Splash ausblenden, Hinweis zeigen
        hideInstallSplash();
        toast('Bitte Adminrechte bestätigen — NOVA aktualisiert sich dann und startet neu', 'i-download');
      }
      // Normalfall: NOVA wird in ~0,5 s beendet, das Overlay bleibt bis dahin sichtbar.
    } else if (res && res.noAsset) {
      $('#up-now').disabled = false;
      $('#up-now').querySelector('span').textContent = 'Jetzt aktualisieren';
      toast('Kein Installationspaket im Release gefunden', 'i-warn');
    } else {
      $('#up-now').disabled = false;
      $('#up-now').querySelector('span').textContent = 'Erneut versuchen';
      toast('Download fehlgeschlagen', 'i-warn');
    }
  });
  window.nova.update.onProgress((p) => { $('#up-progress').querySelector('i').style.width = p + '%'; });
  window.nova.update.onAvailable((i) => show(i));

  return {
    show, close,
    async check(manual) {
      const r = await window.nova.update.check();
      if (r && r.available) show(r);
      else if (manual) toast('NOVA ist auf dem neuesten Stand', 'i-check');
    },
  };
})();

/* ============================================================ Website-Security-Analyse (Schloss-Symbol) */
const security = (() => {
  const panel = $('#sec-panel');
  let curHost = '', curReport = null;

  // In die Seite injizierter Sammler: Signale für die Risiko-Bewertung (kein echtes Hooking → robust)
  const SECSCAN = `(function(){try{
    var host=location.hostname.replace(/^www\\./,'');
    var https=location.protocol==='https:';
    var scripts=Array.prototype.slice.call(document.scripts);
    var ext=[], inlineLen=0, inlineTxt='';
    scripts.forEach(function(s){ if(s.src){ try{var h=new URL(s.src).hostname.replace(/^www\\./,''); if(h&&h!==host&&host.indexOf(h)<0&&h.indexOf(host)<0) ext.push(h);}catch(e){} } else { var t=s.textContent||''; inlineLen+=t.length; if(inlineTxt.length<24000) inlineTxt+=' '+t; } });
    var thirdScripts=Array.from(new Set(ext)).slice(0,40);
    var reqHosts=[]; try{ performance.getEntriesByType('resource').forEach(function(r){ try{var h=new URL(r.name).hostname.replace(/^www\\./,''); if(h&&h!==host) reqHosts.push(h);}catch(e){} }); }catch(e){}
    reqHosts=Array.from(new Set(reqHosts)).slice(0,60);
    var fpHits=[]; var fpPat={'Canvas-Fingerprint':/toDataURL|getImageData|measureText/, 'WebGL-Fingerprint':/WEBGL_debug_renderer|getExtension\\(|getParameter\\(/, 'Audio-Fingerprint':/AudioContext|createOscillator|createAnalyser/, 'Geraete-Enumeration':/navigator\\.(hardwareConcurrency|deviceMemory|userAgentData)|enumerateDevices|fonts\\.check/};
    for(var k in fpPat){ try{ if(fpPat[k].test(inlineTxt)) fpHits.push(k); }catch(e){} }
    var miner=/coinhive|cryptonight|coin-?hive|webminerpool|miner\\.start|cryptoloot|wasmMiner|hashrate/i.test(inlineTxt);
    var forms=[]; Array.prototype.slice.call(document.forms).forEach(function(f){ if(!f.querySelector('input[type=password]')) return; var action=f.getAttribute('action')||location.href; var ah=''; try{ah=new URL(action,location.href).hostname.replace(/^www\\./,'');}catch(e){} forms.push({actionHost:ah, sameHost:(!ah||ah===host), insecure:(String(action).indexOf('http://')===0 || !https)}); });
    return {ok:true, host:host, url:location.href, https:https, title:(document.title||'').slice(0,120), thirdPartyScripts:thirdScripts, thirdPartyRequestHosts:reqHosts, inlineScriptKB:Math.round(inlineLen/1024), fingerprint:fpHits, cryptoMiner:miner, passwordFields:document.querySelectorAll('input[type=password]').length, loginForms:forms.slice(0,6)};
  }catch(e){return {ok:false,error:String(e)};}})()`;

  function secPrompt(s) {
    return `Du bist ein Web-Security-Analyst. Bewerte SICHERHEIT & PRIVATSPHÄRE dieser Seite anhand der Signale (knapp, sachlich, keine Panikmache).\n`
      + `Host: ${s.host}\nHTTPS: ${s.https}\nTitel: ${s.title}\n`
      + `Drittanbieter-Skripte (${s.thirdPartyScripts.length}): ${s.thirdPartyScripts.join(', ') || '–'}\n`
      + `Drittanbieter-Request-Hosts (${s.thirdPartyRequestHosts.length}): ${s.thirdPartyRequestHosts.slice(0, 30).join(', ') || '–'}\n`
      + `Fingerprinting-Signale: ${s.fingerprint.join(', ') || 'keine'}\n`
      + `Crypto-Miner-Muster: ${s.cryptoMiner ? 'JA' : 'nein'}\n`
      + `Passwortfelder: ${s.passwordFields} · Login-Formulare: ${JSON.stringify(s.loginForms)}\n`
      + `Inline-JS: ${s.inlineScriptKB} KB\n\n`
      + `Antworte GENAU in diesem Format, sonst nichts:\n`
      + `RISIKO: <0-100>\nSTUFE: <sicher|niedrig|mittel|hoch|kritisch>\nZUSAMMENFASSUNG: <1-2 Sätze>\nBEFUNDE:\n`
      + `- [<kategorie: fingerprinting|tracking|crypto|login|drittanbieter|unsicher|allgemein>|<info|warn|gefahr>] <Titel> :: <kurze, verständliche Erklärung>\n`
      + `(2-6 Befunde; wenn die Seite sicher ist, gib trotzdem 1-2 positive Info-Befunde.)`;
  }

  const LEVELS = { sicher: { c: '#2dd4bf', t: 'Sicher' }, niedrig: { c: '#a3e635', t: 'Niedriges Risiko' }, mittel: { c: '#fbbf24', t: 'Mittleres Risiko' }, hoch: { c: '#fb923c', t: 'Hohes Risiko' }, kritisch: { c: '#ff4d6d', t: 'Kritisch' } };
  function parseReport(r, host) {
    const txt = (r && typeof r === 'object') ? (r.text || r.raw || '') : (r || '');
    if (!txt) return null;
    const score = Math.max(0, Math.min(100, parseInt((/RISIKO\s*:\s*(\d{1,3})/i.exec(txt) || [])[1], 10) || 0));
    let level = ((/STUFE\s*:\s*(sicher|niedrig|mittel|hoch|kritisch)/i.exec(txt) || [])[1] || '').toLowerCase();
    if (!level) level = score >= 75 ? 'kritisch' : score >= 55 ? 'hoch' : score >= 35 ? 'mittel' : score >= 15 ? 'niedrig' : 'sicher';
    const summary = ((/ZUSAMMENFASSUNG\s*:\s*(.+)/i.exec(txt) || [])[1] || '').split('\n')[0].trim();
    const findings = [];
    txt.split('\n').forEach((ln) => {
      const m = /^\s*[-*]\s*\[([a-zäöü]+)\s*\|\s*(info|warn|gefahr)\]\s*(.+?)\s*(?:::|–|-)\s*(.+)$/i.exec(ln);
      if (m) findings.push({ cat: m[1].toLowerCase(), sev: m[2].toLowerCase(), title: m[3].trim().slice(0, 80), detail: m[4].trim().slice(0, 240) });
    });
    return { host, score, level, summary: summary || 'Analyse abgeschlossen.', findings, ts: Date.now(), source: 'lokal' };
  }

  const CAT_ICON = { fingerprinting: '🫆', tracking: '🛰️', crypto: '⛏️', login: '🔑', drittanbieter: '🔗', unsicher: '⚠️', allgemein: '🛡️' };
  function render(rep) {
    showState('report');
    $('#sec-host').textContent = rep.host;
    const lv = LEVELS[rep.level] || LEVELS.mittel;
    $('#sec-score').textContent = rep.score;
    const circ = 2 * Math.PI * 52;
    const fg = $('#sec-ring-fg');
    fg.style.stroke = lv.c; fg.style.strokeDasharray = circ; fg.style.strokeDashoffset = circ * (1 - rep.score / 100);
    $('#sec-ring').style.setProperty('--lvc', lv.c);
    const tag = $('#sec-level-tag'); tag.textContent = lv.t; tag.style.background = lv.c + '22'; tag.style.color = lv.c; tag.style.borderColor = lv.c + '88';
    $('#sec-summary').textContent = rep.summary || '';
    const d = rep.ts ? new Date(rep.ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    $('#sec-meta').textContent = 'Geprüft am ' + d + (rep.source === 'community' ? ' · Community-Datenbank' : ' · lokal');
    const box = $('#sec-findings'); box.innerHTML = '';
    (rep.findings || []).forEach((f, i) => {
      const row = el('div', 'sec-find sev-' + (f.sev || 'info'));
      row.style.animationDelay = (i * 60) + 'ms';
      row.appendChild(el('span', 'sec-find-ic', CAT_ICON[f.cat] || '🛡️'));
      const tx = el('div', 'sec-find-tx');
      tx.appendChild(el('b', null, f.title || f.cat));
      tx.appendChild(el('span', null, f.detail || ''));
      row.appendChild(tx);
      box.appendChild(row);
    });
  }
  function showState(which) {
    $('#sec-empty').classList.toggle('hidden', which !== 'empty');
    $('#sec-loading').classList.toggle('hidden', which !== 'loading');
    $('#sec-gauge-wrap');
    panel.classList.toggle('sec-has-report', which === 'report');
  }

  async function open() {
    const tab = activeTab();
    const host = tab && isWebUrl(tab.url) ? hostOf(tab.url) : '';
    panel.classList.remove('hidden');
    $('#sec-host').textContent = host || 'Diese Seite';
    if (!host) { showState('empty'); $('#sec-scan').disabled = true; return; }
    $('#sec-scan').disabled = false;
    curHost = host;
    let rep = null; try { rep = await window.nova.security.get(host); } catch {}
    if (rep) { curReport = rep; render(rep); }
    else { curReport = null; showState('empty'); }
  }
  function close() { panel.classList.add('hidden'); }

  async function analyze() {
    const tab = activeTab();
    if (!tab || !tab.wv || !isWebUrl(tab.url)) { showState('empty'); return; }
    showState('loading'); $('#sec-loading-tx').textContent = 'Sammle Seiten-Signale …';
    let sig = null; try { sig = await tab.wv.executeJavaScript(SECSCAN, true); } catch {}
    if (!sig || !sig.ok) { showState('empty'); toast('Seite nicht lesbar', 'i-warn'); return; }
    $('#sec-loading-tx').textContent = 'Claude bewertet die Sicherheit …';
    let ready = false; try { ready = await claude.prepare(); } catch {}
    if (!ready) { showState('empty'); toast('Claude nicht bereit — bitte anmelden', 'i-warn'); claude.release(); return; }
    let reply = null; try { reply = await claude.runOnce(secPrompt(sig)); } catch {}
    claude.release();
    const rep = parseReport(reply, sig.host);
    if (!rep) { showState('empty'); toast('Analyse fehlgeschlagen', 'i-warn'); return; }
    curReport = rep; curHost = sig.host;
    try { await window.nova.security.save(rep); } catch {}
    render(rep);
    updateChip(activeTab());
  }

  // Schloss-Symbol: Risiko-Punkt setzen, wenn ein Report vorliegt (ohne die Liste preiszugeben)
  async function updateChip(tab) {
    const chip = $('#omni-sec'); if (!chip) return;
    chip.querySelectorAll('.sec-dot').forEach((n) => n.remove());
    chip.classList.remove('risk-mittel', 'risk-hoch', 'risk-kritisch', 'risk-sicher', 'risk-niedrig');
    const host = tab && isWebUrl(tab.url) ? hostOf(tab.url) : '';
    if (!host) return;
    let rep = null; try { rep = await window.nova.security.get(host); } catch {}
    if (!rep) return;
    chip.classList.add('risk-' + (rep.level || 'mittel'));
    const dot = el('span', 'sec-dot'); chip.appendChild(dot);
    chip.title = 'Security-Report: ' + (LEVELS[rep.level] || LEVELS.mittel).t + ' — klicken für Details';
    // Bei hohem/kritischem Risiko einmal kurz auf den Report aufmerksam machen (animiert, kein Pop-up-Spam)
    if ((rep.level === 'hoch' || rep.level === 'kritisch') && curHost !== host + '|warned') {
      curHost = host + '|warned';
      chip.classList.add('sec-pulse'); setTimeout(() => chip.classList.remove('sec-pulse'), 4000);
      toast('⚠ Sicherheitshinweis für ' + host + ' — Schloss-Symbol antippen', 'i-warn');
    }
  }

  $('#omni-sec').addEventListener('click', open);
  $('#sec-close').addEventListener('click', close);
  $('#sec-scan').addEventListener('click', analyze);
  $('#sec-rescan').addEventListener('click', analyze);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) close(); });

  return { open, close, analyze, updateChip };
})();

/* ============================================================ Chrome-GPU-Nebula (hinter der Oberfläche) */
const chromeNebula = (() => {
  function hexLin(hex) {
    hex = (hex || '').trim().replace('#', ''); if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const v = (i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return isNaN(c) ? 0 : Math.pow(c, 2.2); };
    return [v(0), v(2), v(4)];
  }
  function accent() {
    const cs = getComputedStyle(document.body);
    return [hexLin(cs.getPropertyValue('--acc') || '#00e5ff'), hexLin(cs.getPropertyValue('--acc2') || '#7c4dff')];
  }
  // Dunkler, fließender Nebel: höhere Strömung (uSpeed), domain-warping, hohe Schwelle → tiefes Schwarz mit Akzent-Filamenten
  const FRAG = `precision mediump float;
    uniform vec2 uRes; uniform float uTime; uniform vec3 uAcc; uniform vec3 uAcc2;
    uniform float uZoom; uniform float uSpeed; uniform float uInt;
    float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
    float noise(vec2 p){vec2 i=floor(p),f=fract(p);float a=hash(i),b=hash(i+vec2(1.,0.)),c=hash(i+vec2(0.,1.)),d=hash(i+vec2(1.,1.));vec2 u=f*f*(3.-2.*f);return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}
    float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<OCT;i++){v+=a*noise(p);p=m*p;a*=.5;}return v;}
    void main(){
      vec2 uv=(gl_FragCoord.xy-.5*uRes)/uRes.y; float t=uTime*uSpeed;
      vec2 q=uv*uZoom;
      float n1=fbm(q+vec2(t,t*0.5));
      float n2=fbm(q*2.1+vec2(-t*0.9,t*0.45)+n1*1.15);     // domain-warp → mehr Bewegung
      float d=n1*0.6+n2*0.65;
      float neb=pow(smoothstep(0.34,1.12,d),2.1);          // hohe Schwelle → dunkel, nur Filamente leuchten
      vec3 col=mix(uAcc,uAcc2,clamp(n2*1.25,0.,1.))*neb;
      col+=uAcc*0.014;                                      // ganz dezenter Akzent-Boden statt reinem Schwarz
      col*=uInt;                                            // Grunddämpfung (dunkel halten)
      col=clamp((col*(2.51*col+0.03))/(col*(2.43*col+0.59)+0.14),0.,1.);
      gl_FragColor=vec4(col,1.0);
    }`;
  const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;

  function makeRenderer(canvas, host, opts) {
    let gl = null, uRes, uTime, uZoom, uSpeed, uInt, uAcc, uAcc2;
    let raf = 0, paused = true, lastF = 0, started = 0, quality = 'mid', ok = false;
    function build() {
      gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' }) || canvas.getContext('experimental-webgl');
      if (!gl) return false;
      const OCT = quality === 'high' ? 5 : 4;
      const cs = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null; };
      const vs = cs(gl.VERTEX_SHADER, VERT), fs = cs(gl.FRAGMENT_SHADER, '#define OCT ' + OCT + '\n' + FRAG);
      if (!vs || !fs) return false;
      const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      uRes = gl.getUniformLocation(prog, 'uRes'); uTime = gl.getUniformLocation(prog, 'uTime');
      uZoom = gl.getUniformLocation(prog, 'uZoom'); uSpeed = gl.getUniformLocation(prog, 'uSpeed'); uInt = gl.getUniformLocation(prog, 'uInt');
      uAcc = gl.getUniformLocation(prog, 'uAcc'); uAcc2 = gl.getUniformLocation(prog, 'uAcc2');
      ok = true; return true;
    }
    function resize() {
      const scale = (quality === 'high' ? 0.8 : 0.55) * Math.min(devicePixelRatio || 1, 1.5);
      const cw = host.clientWidth, ch = host.clientHeight;
      const w = Math.max(2, Math.floor(cw * scale)), h = Math.max(2, Math.floor(ch * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; if (gl) gl.viewport(0, 0, w, h); }
    }
    function frame(now) {
      if (paused) { raf = 0; return; }
      raf = requestAnimationFrame(frame);
      if (now - lastF < 33) return;                       // ~30fps
      if (host.clientWidth < 2 || host.clientHeight < 2) return;   // eingeklappt / unsichtbar → nichts zeichnen
      lastF = now; resize();
      const [a, b] = accent();
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (now - started) / 1000);
      gl.uniform1f(uZoom, opts.zoom); gl.uniform1f(uSpeed, opts.speed); gl.uniform1f(uInt, opts.intensity);
      gl.uniform3fv(uAcc, a); gl.uniform3fv(uAcc2, b);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    try { new ResizeObserver(() => { if (!paused) resize(); }).observe(host); } catch {}
    return {
      setQuality(q) { quality = q; },
      start() { if (!ok && !build()) return false; paused = false; if (!started) started = performance.now(); if (!raf) { lastF = 0; raf = requestAnimationFrame(frame); } return true; },
      stop() { paused = true; if (raf) cancelAnimationFrame(raf); raf = 0; },
    };
  }

  let tabR = null, sideR = null, active = false;
  function ensure() {
    if (!tabR) { const c = $('#tabstrip-neb'); if (c) tabR = makeRenderer(c, $('#tabstrip'), { zoom: 1.25, speed: 0.20, intensity: 0.5 }); }
    if (!sideR) { const c = $('#sidebar-neb'); if (c) sideR = makeRenderer(c, $('#sidebar'), { zoom: 1.5, speed: 0.12, intensity: 0.5 }); }
  }
  function startAll() { [tabR, sideR].forEach((r) => r && r.start()); }
  function stopAll() { [tabR, sideR].forEach((r) => r && r.stop()); }
  // Effizienz: NUR pausieren, wenn das Fenster wirklich unsichtbar/minimiert ist (visibilitychange).
  // NICHT bei window.blur — das feuert auch, wenn ein Webview den Fokus bekommt (also ständig beim Surfen),
  // wodurch die Nebula einfror. Chromium drosselt RAF bei verdeckten Fenstern ohnehin selbst.
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAll(); else if (active) startAll(); });

  function apply(q) {
    q = q || 'mid';
    if (q === 'low') { active = false; document.body.classList.remove('neb-gpu'); stopAll(); return; }
    active = true;
    document.body.classList.add('neb-gpu');
    ensure();
    [tabR, sideR].forEach((r) => r && r.setQuality(q));
    if (!document.hidden) startAll();   // sofort loslaufen, nicht auf Fokus warten
  }
  return { apply };
})();

/* ============================================================ NOVA Studio (contained VM) */
const studio = (() => {
  const panel = $('#studio-panel');
  const body = $('#studio-body');
  let wv = null, openFlag = false, mode = 'full';

  function ensureWv() {
    if (wv) return wv;
    wv = document.createElement('webview');
    wv.id = 'studio-wv';
    wv.setAttribute('partition', PARTITION);
    if (state.webviewPreload) wv.setAttribute('preload', state.webviewPreload);
    wv.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=no,backgroundThrottling=no');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', 'nova://studio/');   // erst Attribute, dann src (wie mountWebview)
    body.appendChild(wv);
    // Panel-Befehle aus dem Studio-Webview (Split/Schließen liegen im Studio-Header)
    wv.addEventListener('ipc-message', (e) => {
      if (e.channel !== 'studio-cmd') return;
      const cmd = e.args && e.args[0];
      if (cmd === 'close') close();
      else if (cmd === 'split') setMode(mode === 'full' ? 'split' : 'full');
    });
    return wv;
  }
  function applyMode() {
    panel.classList.toggle('split', mode === 'split');
    $('#webviews').classList.toggle('studio-split', openFlag && mode === 'split');
  }
  function open() {
    if (openFlag) return;
    openFlag = true;
    ensureWv();
    panel.classList.remove('hidden');
    applyMode();
    requestAnimationFrame(() => panel.classList.add('show'));
    $('#btn-studio').classList.add('active');
  }
  function close() {
    if (!openFlag) return;
    openFlag = false;
    panel.classList.remove('show');
    $('#webviews').classList.remove('studio-split');
    $('#btn-studio').classList.remove('active');
    setTimeout(() => { if (!openFlag) panel.classList.add('hidden'); }, 320);
  }
  function toggle() { openFlag ? close() : open(); }
  function setMode(m) { mode = m; if (openFlag) applyMode(); }

  const btn = $('#btn-studio');
  if (btn) btn.addEventListener('click', toggle);

  return { open, close, toggle };
})();

/* ============================================================ Shifter (PC wach halten) */
const shifter = (() => {
  const btn = $('#btn-shifter'), pop = $('#shifter-pop'), orb = $('#sh-orb');
  let active = false, open = false;
  function render() {
    btn.classList.toggle('active', active);
    pop.classList.toggle('on', active);
    orb.classList.toggle('idle', !active);
    $('#sh-sub').textContent = active ? 'Aktiv — dein PC bleibt wach' : 'Hält deinen PC wach';
    $('#sh-toggle').querySelector('span').textContent = active ? 'Deaktivieren' : 'Aktivieren';
  }
  async function toggle() {
    try { const r = await window.nova.shifter.toggle(); active = !!(r && r.active); } catch {}
    render();
    toast(active ? 'Shifter aktiv — dein PC bleibt wach' : 'Shifter deaktiviert', active ? 'i-bolt' : 'i-check');
  }
  function openPop() { open = true; render(); pop.classList.remove('hidden'); positionPop(pop, btn); }
  function closePop() { open = false; pop.classList.add('hidden'); }
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); open ? closePop() : openPop(); });
  const t = $('#sh-toggle'); if (t) t.addEventListener('click', toggle);
  document.addEventListener('click', (e) => { if (open && !pop.contains(e.target) && !btn.contains(e.target)) closePop(); });
  (async () => { try { const r = await window.nova.shifter.status(); active = !!(r && r.active); render(); } catch {} })();
  return { toggle };
})();

/* ============================================================ NOVA Discord (andockbare Split-Bühne + Call-Status + Screen-Share) */
const discord = (() => {
  const stageEl = $('#discord-stage'), btn = $('#btn-discord');
  if (!stageEl) return { toggle() {} };
  let wv = null, mode = false, collapsed = false, side = 'right', layout = 'split', callInfo = {};
  const splitWidth = () => Math.round(Math.min(860, Math.max(420, window.innerWidth * 0.44)));

  function ensureWv() {
    if (wv) return wv;
    wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:nova-discord');
    wv.setAttribute('allowpopups', '');
    if (state.webviewPreload) wv.setAttribute('preload', state.webviewPreload);
    wv.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=no,backgroundThrottling=no');
    wv.setAttribute('src', 'https://discord.com/app');
    wv.addEventListener('ipc-message', (e) => { if (e.channel === 'discord-call') updateCall(e.args && e.args[0]); });
    $('#dc-viewport').appendChild(wv);
    return wv;
  }
  function dock() {
    const full = layout === 'full' && !collapsed;
    stageEl.classList.toggle('dc-left', side === 'left' && !full);
    stageEl.classList.toggle('dc-collapsed', collapsed);
    stageEl.classList.toggle('dc-fullscreen', full);
    dockManager.set('discord', { el: stageEl, side, collapsed, full, open: mode, width: splitWidth, collapse: setCollapsed });
  }
  function setLayout(l) {
    if (l !== 'split' && l !== 'full') return;
    layout = l; collapsed = false;
    const fb = $('#dc-full'); if (fb) fb.classList.toggle('active', l === 'full');
    try { state.settings.discordLayout = l; window.nova.settings.set({ discordLayout: l }); } catch {}
    dock();
  }
  function setSide(s) {
    if (s !== 'left' && s !== 'right') return;
    side = s;
    try { state.settings.discordSide = s; window.nova.settings.set({ discordSide: s }); } catch {}
    dock();
  }
  function setCollapsed(on) {
    collapsed = !!on;
    const cb = $('#dc-collapse'); if (cb) cb.title = collapsed ? 'Ausklappen' : 'Einklappen';
    dock();
  }
  function open() {
    ensureWv(); mode = true; collapsed = false;
    if (state.settings && state.settings.discordSide === 'left') side = 'left';
    if (state.settings && (state.settings.discordLayout === 'full' || state.settings.discordLayout === 'split')) layout = state.settings.discordLayout;
    const fb = $('#dc-full'); if (fb) fb.classList.toggle('active', layout === 'full');
    stageEl.classList.remove('hidden', 'closing');
    document.body.classList.add('dc-open');
    requestAnimationFrame(dock);
    if (btn) btn.classList.add('active');
  }
  function close() {
    if (!mode) return;
    mode = false;
    dockManager.close('discord');   // übrige Panels + Inhalt-Padding neu berechnen
    stageEl.classList.add('closing');
    setTimeout(() => {
      stageEl.classList.add('hidden'); stageEl.classList.remove('closing');
      document.body.classList.remove('dc-open');
      stageEl.style.left = ''; stageEl.style.right = ''; stageEl.style.top = ''; stageEl.style.width = '';
    }, 420);
    if (btn) btn.classList.remove('active');
  }
  function toggle() { mode ? close() : open(); }

  function updateCall(info) {
    callInfo = info || {};
    const inCall = !!callInfo.inCall;
    const chip = $('#dc-callchip');
    if (chip) { chip.classList.toggle('hidden', !inCall); const tx = $('#dc-callchip-tx'); if (tx) tx.textContent = inCall ? (callInfo.channel || 'im Call') : 'im Call'; }
    if (btn) btn.classList.toggle('in-call', inCall);
    const rc = $('#dc-rail-call'); if (rc) rc.classList.toggle('hidden', !inCall);
    const ch = $('#dc-rail-ch'); if (ch) ch.textContent = callInfo.channel || '';
    const sub = $('#dc-sub'); if (sub) sub.textContent = inCall ? 'im Sprachkanal' : 'in NOVA';
    const people = Array.isArray(callInfo.people) ? callInfo.people : [];
    const wrap = $('#dc-rail-people');
    if (wrap) {
      wrap.innerHTML = '';
      people.slice(0, 5).forEach((n) => { const a = document.createElement('span'); a.className = 'dc-rail-ava'; a.textContent = ((n || '?').trim().charAt(0) || '?'); a.title = n; wrap.appendChild(a); });
      if (people.length > 5) { const m = document.createElement('span'); m.className = 'dc-rail-more'; m.textContent = '+' + (people.length - 5); wrap.appendChild(m); }
    }
  }

  // ---- Ziehen zum Andocken (links/rechts) ----
  function showSnap(s) {
    const va = $('#view-area'); if (!va) return;
    const r = va.getBoundingClientRect();
    const w = splitWidth();
    const sn = $('#dc-snap'); if (!sn) return; sn.classList.remove('hidden');
    sn.style.top = Math.round(r.top) + 'px'; sn.style.height = Math.round(r.height - 10) + 'px'; sn.style.width = w + 'px';
    if (s === 'left') { sn.style.left = Math.round(r.left) + 'px'; sn.style.right = 'auto'; }
    else { sn.style.right = Math.round(window.innerWidth - r.right) + 'px'; sn.style.left = 'auto'; }
  }
  const head = $('#dc-head');
  if (head) head.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return;
    e.preventDefault();
    const mask = $('#dc-dragmask'); if (mask) mask.classList.remove('hidden');
    stageEl.classList.add('dc-grab');
    let curSide = side;
    const onMove = (ev) => { curSide = ev.clientX < window.innerWidth / 2 ? 'left' : 'right'; showSnap(curSide); };
    const onUp = () => {
      if (mask) mask.classList.add('hidden');
      stageEl.classList.remove('dc-grab');
      const sn = $('#dc-snap'); if (sn) sn.classList.add('hidden');
      setLayout('split'); setSide(curSide);   // an den Rand ziehen ⇒ Split-Ansicht
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    showSnap(curSide);
  });

  // ---- Bildschirmfreigabe-Auswahl ----
  let pickSources = [], pickKind = 'screen', pickSel = null;
  function showPicker() { const ov = $('#dc-screenpick'); if (!ov) return; ov.classList.remove('hidden'); renderTabs(); renderGrid(); const sh = $('#dc-sp-share'); if (sh) sh.disabled = true; }
  function hidePicker() { const ov = $('#dc-screenpick'); if (ov) ov.classList.add('hidden'); pickSel = null; }
  function renderTabs() { document.querySelectorAll('.dc-sp-tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === pickKind)); }
  function renderGrid() {
    const grid = $('#dc-sp-grid'); if (!grid) return; grid.innerHTML = '';
    const items = pickSources.filter((s) => pickKind === 'screen' ? String(s.id).startsWith('screen:') : String(s.id).startsWith('window:'));
    if (!items.length) { const em = document.createElement('div'); em.className = 'dc-sp-empty'; em.textContent = 'Keine Quellen gefunden.'; grid.appendChild(em); return; }
    items.forEach((s) => {
      const it = document.createElement('div'); it.className = 'dc-sp-item' + (pickSel === s.id ? ' selected' : '');
      const img = document.createElement('img'); img.className = 'dc-sp-thumb'; img.src = s.thumb || ''; it.appendChild(img);
      const nm = document.createElement('div'); nm.className = 'dc-sp-name';
      if (s.icon) { const ic = document.createElement('img'); ic.src = s.icon; nm.appendChild(ic); }
      const sp = document.createElement('span'); sp.textContent = s.name || 'Quelle'; nm.appendChild(sp); it.appendChild(nm);
      it.addEventListener('click', () => { pickSel = s.id; renderGrid(); const sh = $('#dc-sp-share'); if (sh) sh.disabled = false; });
      grid.appendChild(it);
    });
  }
  if (window.nova.screen && window.nova.screen.onSources) {
    window.nova.screen.onSources((list) => { pickSources = list || []; pickKind = 'screen'; pickSel = null; showPicker(); });
  }
  document.querySelectorAll('.dc-sp-tab').forEach((t) => t.addEventListener('click', () => { pickKind = t.dataset.kind; pickSel = null; const sh = $('#dc-sp-share'); if (sh) sh.disabled = true; renderTabs(); renderGrid(); }));
  const spCancel = $('#dc-sp-cancel'); if (spCancel) spCancel.addEventListener('click', () => { try { window.nova.screen.pick(null); } catch {} hidePicker(); });
  const spShare = $('#dc-sp-share'); if (spShare) spShare.addEventListener('click', () => { if (!pickSel) return; const audio = !!($('#dc-sp-audio') && $('#dc-sp-audio').checked); try { window.nova.screen.pick({ id: pickSel, audio }); } catch {} hidePicker(); });

  // ---- Buttons + Layout-Tracking ----
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  const bClose = $('#dc-close'); if (bClose) bClose.addEventListener('click', close);
  const bColl = $('#dc-collapse'); if (bColl) bColl.addEventListener('click', () => setCollapsed(true));
  const bSide = $('#dc-side'); if (bSide) bSide.addEventListener('click', () => setSide(side === 'left' ? 'right' : 'left'));
  const bFull = $('#dc-full'); if (bFull) bFull.addEventListener('click', () => setLayout(layout === 'full' ? 'split' : 'full'));
  const bReload = $('#dc-reload'); if (bReload) bReload.addEventListener('click', () => { try { wv && wv.reload(); } catch {} });
  const rail = $('#dc-rail'); if (rail) rail.addEventListener('click', () => setCollapsed(false));
  try { const ro = new ResizeObserver(() => { if (mode) dock(); }); const va = $('#view-area'); if (va) ro.observe(va, { box: 'border-box' }); } catch {}
  window.addEventListener('resize', () => { if (mode) dock(); });

  return { toggle, open, close };
})();

/* ============================================================ NOVA WhatsApp (andockbare Bühne wie Discord: Anrufe, Ungelesen-/Anruf-Status, Screen-Share) */
const whatsapp = (() => {
  const stageEl = $('#whatsapp-stage'), btn = $('#btn-whatsapp');
  if (!stageEl) return { toggle() {} };
  let wv = null, mode = false, collapsed = false, side = 'right', layout = 'split';
  const splitWidth = () => Math.round(Math.min(860, Math.max(420, window.innerWidth * 0.44)));

  function ensureWv() {
    if (wv) return wv;
    wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:nova-whatsapp');
    wv.setAttribute('allowpopups', '');
    if (state.webviewPreload) wv.setAttribute('preload', state.webviewPreload);
    wv.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=no,backgroundThrottling=no');
    wv.setAttribute('src', 'https://web.whatsapp.com');
    wv.addEventListener('ipc-message', (e) => { if (e.channel === 'whatsapp-status') updateStatus(e.args && e.args[0]); });
    $('#wa-viewport').appendChild(wv);
    return wv;
  }
  function dock() {
    const full = layout === 'full' && !collapsed;
    stageEl.classList.toggle('wa-left', side === 'left' && !full);
    stageEl.classList.toggle('wa-collapsed', collapsed);
    stageEl.classList.toggle('wa-fullscreen', full);
    dockManager.set('whatsapp', { el: stageEl, side, collapsed, full, open: mode, width: splitWidth, collapse: setCollapsed });
  }
  function setLayout(l) { if (l !== 'split' && l !== 'full') return; layout = l; collapsed = false; const fb = $('#wa-full'); if (fb) fb.classList.toggle('active', l === 'full'); try { state.settings.whatsappLayout = l; window.nova.settings.set({ whatsappLayout: l }); } catch {} dock(); }
  function setSide(s) { if (s !== 'left' && s !== 'right') return; side = s; try { state.settings.whatsappSide = s; window.nova.settings.set({ whatsappSide: s }); } catch {} dock(); }
  function setCollapsed(on) { collapsed = !!on; const cb = $('#wa-collapse'); if (cb) cb.title = collapsed ? 'Ausklappen' : 'Einklappen'; dock(); }
  function open() {
    ensureWv(); mode = true; collapsed = false;
    if (state.settings && state.settings.whatsappSide === 'left') side = 'left';
    if (state.settings && (state.settings.whatsappLayout === 'full' || state.settings.whatsappLayout === 'split')) layout = state.settings.whatsappLayout;
    const fb = $('#wa-full'); if (fb) fb.classList.toggle('active', layout === 'full');
    stageEl.classList.remove('hidden', 'closing');
    document.body.classList.add('wa-open');
    requestAnimationFrame(dock);
    if (btn) btn.classList.add('active');
  }
  function close() {
    if (!mode) return; mode = false;
    dockManager.close('whatsapp');
    stageEl.classList.add('closing');
    setTimeout(() => { stageEl.classList.add('hidden'); stageEl.classList.remove('closing'); document.body.classList.remove('wa-open'); stageEl.style.left = ''; stageEl.style.right = ''; stageEl.style.top = ''; stageEl.style.width = ''; }, 420);
    if (btn) btn.classList.remove('active');
  }
  function toggle() { mode ? close() : open(); }

  function updateStatus(info) {
    info = info || {};
    const unread = Math.max(0, parseInt(info.unread, 10) || 0);
    const inCall = !!info.inCall;
    const lbl = unread > 99 ? '99+' : String(unread);
    const ru = $('#wa-rail-unread'); if (ru) { ru.classList.toggle('hidden', unread <= 0); ru.textContent = lbl; }
    const rc = $('#wa-rail-call'); if (rc) rc.classList.toggle('hidden', !inCall);
    const chip = $('#wa-callchip'); if (chip) chip.classList.toggle('hidden', !inCall);
    const sub = $('#wa-sub'); if (sub) sub.textContent = inCall ? 'im Anruf' : (unread > 0 ? unread + ' ungelesen' : 'in NOVA');
    if (btn) btn.classList.toggle('in-call', inCall);
    const badge = $('#wa-badge'); if (badge) { badge.classList.toggle('hidden', unread <= 0); badge.textContent = lbl; }
  }

  // ---- Ziehen zum Andocken (links/rechts) ----
  function showSnap(s) {
    const va = $('#view-area'); if (!va) return; const r = va.getBoundingClientRect(); const w = splitWidth();
    const sn = $('#wa-snap'); if (!sn) return; sn.classList.remove('hidden');
    sn.style.top = Math.round(r.top) + 'px'; sn.style.height = Math.round(r.height - 10) + 'px'; sn.style.width = w + 'px';
    if (s === 'left') { sn.style.left = Math.round(r.left) + 'px'; sn.style.right = 'auto'; } else { sn.style.right = Math.round(window.innerWidth - r.right) + 'px'; sn.style.left = 'auto'; }
  }
  const head = $('#wa-head');
  if (head) head.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return;
    e.preventDefault();
    const mask = $('#wa-dragmask'); if (mask) mask.classList.remove('hidden');
    stageEl.classList.add('wa-grab');
    let curSide = side;
    const onMove = (ev) => { curSide = ev.clientX < window.innerWidth / 2 ? 'left' : 'right'; showSnap(curSide); };
    const onUp = () => { if (mask) mask.classList.add('hidden'); stageEl.classList.remove('wa-grab'); const sn = $('#wa-snap'); if (sn) sn.classList.add('hidden'); setLayout('split'); setSide(curSide); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    showSnap(curSide);
  });

  // ---- Buttons + Layout-Tracking ----
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  const bClose = $('#wa-close'); if (bClose) bClose.addEventListener('click', close);
  const bColl = $('#wa-collapse'); if (bColl) bColl.addEventListener('click', () => setCollapsed(true));
  const bSide = $('#wa-side'); if (bSide) bSide.addEventListener('click', () => setSide(side === 'left' ? 'right' : 'left'));
  const bFull = $('#wa-full'); if (bFull) bFull.addEventListener('click', () => setLayout(layout === 'full' ? 'split' : 'full'));
  const bReload = $('#wa-reload'); if (bReload) bReload.addEventListener('click', () => { try { wv && wv.reload(); } catch {} });
  const rail = $('#wa-rail'); if (rail) rail.addEventListener('click', () => setCollapsed(false));
  try { const ro = new ResizeObserver(() => { if (mode) dock(); }); const va = $('#view-area'); if (va) ro.observe(va, { box: 'border-box' }); } catch {}
  window.addEventListener('resize', () => { if (mode) dock(); });

  return { toggle, open, close };
})();

/* ============================================================ NOVA Tresor (Passwort-Manager: andockbar + Autofill) */
const vault = (() => {
  const stageEl = $('#vault-stage'), btn = $('#btn-vault');
  if (!stageEl) return { onWebviewMessage() {} };
  let mode = false, collapsed = false, side = 'right', layout = 'split';
  let entries = [], editingId = null, pendingSave = null, saveOfferData = null, lastGen = '';
  let lockAt = 0, timerIv = null, lastKeep = 0;
  const splitWidth = () => Math.round(Math.min(900, Math.max(440, window.innerWidth * 0.46)));
  const V = window.nova.vault;
  const host = (u) => { try { return hostOf(u) || ''; } catch { return ''; } };

  // ---------------- Andocken (Vollbild / Split / Rand-Leiste) ----------------
  function dock() {
    const full = layout === 'full' && !collapsed;
    stageEl.classList.toggle('vt-left', side === 'left' && !full);
    stageEl.classList.toggle('vt-collapsed', collapsed);
    stageEl.classList.toggle('vt-fullscreen', full);
    document.body.classList.toggle('vt-full-cover', full);   // Vollbild → Webviews dahinter ausblenden
    dockManager.set('vault', { el: stageEl, side, collapsed, full, open: mode, width: splitWidth, collapse: setCollapsed });
  }
  function setSide(s) { if (s !== 'left' && s !== 'right') return; side = s; try { state.settings.vaultSide = s; window.nova.settings.set({ vaultSide: s }); } catch {} dock(); }
  function setLayout(l) { if (l !== 'split' && l !== 'full') return; layout = l; collapsed = false; const fb = $('#vt-full'); if (fb) fb.classList.toggle('active', l === 'full'); try { state.settings.vaultLayout = l; window.nova.settings.set({ vaultLayout: l }); } catch {} dock(); }
  function setCollapsed(on) { collapsed = !!on; const cb = $('#vt-collapse'); if (cb) cb.title = collapsed ? 'Ausklappen' : 'Einklappen'; dock(); }
  async function open() {
    mode = true; collapsed = false;
    if (state.settings && state.settings.vaultSide === 'left') side = 'left';
    if (state.settings && (state.settings.vaultLayout === 'full' || state.settings.vaultLayout === 'split')) layout = state.settings.vaultLayout;
    const fb = $('#vt-full'); if (fb) fb.classList.toggle('active', layout === 'full');
    stageEl.classList.remove('hidden', 'closing');
    document.body.classList.add('vt-open');
    requestAnimationFrame(dock);
    if (btn) btn.classList.add('active');
    await syncStatus(); showScreen();
  }
  function close() {
    if (!mode) return;
    mode = false;
    document.body.classList.remove('vt-full-cover');   // Inhaltsbereich sofort wieder sichtbar (fährt mit auf)
    dockManager.close('vault');
    stageEl.classList.add('closing');
    setTimeout(() => { stageEl.classList.add('hidden'); stageEl.classList.remove('closing'); document.body.classList.remove('vt-open'); stageEl.style.left = ''; stageEl.style.right = ''; stageEl.style.top = ''; stageEl.style.width = ''; }, 420);
    if (btn) btn.classList.remove('active');
  }
  function toggle() { mode ? close() : open(); }
  function showSnap(s) {
    const va = $('#view-area'); if (!va) return; const r = va.getBoundingClientRect(); const w = splitWidth();
    const sn = $('#vt-snap'); if (!sn) return; sn.classList.remove('hidden');
    sn.style.top = Math.round(r.top) + 'px'; sn.style.height = Math.round(r.height - 10) + 'px'; sn.style.width = w + 'px';
    if (s === 'left') { sn.style.left = Math.round(r.left) + 'px'; sn.style.right = 'auto'; } else { sn.style.right = Math.round(window.innerWidth - r.right) + 'px'; sn.style.left = 'auto'; }
  }
  const head = $('#vt-head');
  if (head) head.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return;
    e.preventDefault();
    const mask = $('#vt-dragmask'); if (mask) mask.classList.remove('hidden');
    stageEl.classList.add('vt-grab');
    let curSide = side;
    const onMove = (ev) => { curSide = ev.clientX < window.innerWidth / 2 ? 'left' : 'right'; showSnap(curSide); };
    const onUp = () => { if (mask) mask.classList.add('hidden'); stageEl.classList.remove('vt-grab'); const sn = $('#vt-snap'); if (sn) sn.classList.add('hidden'); setLayout('split'); setSide(curSide); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    showSnap(curSide);
  });

  // ---------------- Status / Bildschirme ----------------
  let unlocked = false, hasVault = false, createMode = false;
  async function syncStatus() { try { const s = await V.status(); hasVault = !!s.exists; unlocked = !!s.unlocked; return s; } catch { return {}; } }
  function updateChrome() {
    const sub = $('#vt-sub'); if (sub) sub.textContent = unlocked ? 'entsperrt' : (hasVault ? 'gesperrt' : 'einrichten');
    const st = $('#vt-rail-state'); if (st) st.classList.toggle('unlocked', unlocked);
    const lb = $('#vt-lock'); if (lb) lb.classList.toggle('hidden', !unlocked);
    if (btn) btn.classList.toggle('unlocked', unlocked);
  }
  function showScreen() {
    const lock = $('#vt-lock-screen'), main = $('#vt-main'), ed = $('#vt-editor');
    ed.classList.add('hidden');
    if (!unlocked) { lock.classList.remove('hidden'); main.classList.add('hidden'); renderLock(); stopTimer(); }
    else { lock.classList.add('hidden'); main.classList.remove('hidden'); loadList(); V.keepalive().then((r) => { if (r && r.ok) lockAt = r.at || 0; startTimer(); }).catch(() => startTimer()); }
    updateChrome();
  }
  function renderLock() {
    createMode = !hasVault;
    $('#vt-lock-title').textContent = createMode ? 'Tresor einrichten' : 'Tresor entsperren';
    $('#vt-lock-sub').textContent = createMode ? 'Lege ein starkes Master-Passwort fest' : 'Master-Passwort eingeben';
    $('#vt-confirm-wrap').classList.toggle('hidden', !createMode);
    $('#vt-strength').classList.toggle('hidden', !createMode);
    $('#vt-lock-go').textContent = createMode ? 'Tresor erstellen' : 'Entsperren';
    $('#vt-master').value = ''; $('#vt-master2').value = ''; $('#vt-lock-msg').textContent = '';
    setTimeout(() => { try { $('#vt-master').focus(); } catch {} }, 90);
  }
  function strength(pw) { let s = 0; if (pw.length >= 8) s++; if (pw.length >= 12) s++; if (pw.length >= 16) s++; if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++; if (/\d/.test(pw)) s++; if (/[^A-Za-z0-9]/.test(pw)) s++; return Math.min(5, s); }
  const STR_TX = ['sehr schwach', 'schwach', 'okay', 'gut', 'stark', 'exzellent'];
  function paintStrength(barFill, txEl, pw) {
    const s = strength(pw); const pct = (s / 5) * 100;
    const col = s <= 1 ? '#ff5c6c' : s === 2 ? '#ffac4b' : s === 3 ? '#ffd24b' : s === 4 ? '#5fd0ff' : '#3ad07e';
    if (barFill) { barFill.style.width = pct + '%'; barFill.style.background = col; }
    if (txEl) { txEl.textContent = pw ? STR_TX[s] : '…'; txEl.style.color = col; }
  }

  // ---------------- Liste ----------------
  async function loadList() {
    const r = await V.list();
    if (!r.ok) { if (r.locked) { unlocked = false; showScreen(); } return; }
    entries = r.items || []; renderList();
  }
  function renderList() {
    const q = ($('#vt-search').value || '').toLowerCase().trim();
    const list = $('#vt-list'); list.innerHTML = '';
    const items = entries.filter((e) => !q || ((e.title || '') + ' ' + (e.url || '') + ' ' + (e.username || '')).toLowerCase().includes(q)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    $('#vt-empty').classList.toggle('hidden', entries.length > 0);
    for (const e of items) {
      const row = el('div', 'vt-item'); row.setAttribute('role', 'button'); row.tabIndex = 0;
      const av = e.url ? faviconEl(e.url, 'vt-item-av') : el('span', 'vt-item-av letter', (e.title || '?').trim().charAt(0).toUpperCase() || '?');
      const tx = el('div', 'vt-item-tx'); tx.appendChild(el('b', null, e.title || host(e.url) || 'Eintrag')); tx.appendChild(el('span', null, e.username || host(e.url) || ''));
      const cp = el('button', 'vt-item-cp'); cp.title = 'Passwort kopieren'; cp.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
      cp.addEventListener('click', (ev) => { ev.stopPropagation(); copyField(e.id, 'password'); });
      row.append(av, tx, cp);
      row.addEventListener('click', () => openEditor(e.id));
      list.appendChild(row);
    }
  }
  async function copyField(id, field) { const r = await V.copy(id, field); if (r && r.ok) toast('Kopiert — wird in 20 s automatisch geleert', 'i-check'); else if (r && r.locked) { unlocked = false; showScreen(); } }

  // ---------------- Editor ----------------
  async function openEditor(id) {
    editingId = id || null;
    $('#vt-main').classList.add('hidden'); $('#vt-editor').classList.remove('hidden');
    $('#vt-ed-title').textContent = id ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
    $('#vt-ed-del').classList.toggle('hidden', !id);
    const set = (s, v) => { const e = $(s); if (e) e.value = v || ''; };
    if (id) { const r = await V.get(id); if (r.ok) { const e = r.entry; set('#vt-f-title', e.title); set('#vt-f-url', e.url); set('#vt-f-user', e.username); set('#vt-f-pass', e.password); set('#vt-f-notes', e.notes); } }
    else { ['#vt-f-title', '#vt-f-url', '#vt-f-user', '#vt-f-pass', '#vt-f-notes'].forEach((s) => set(s, '')); try { const u = activeTab() && activeTab().url; if (u && !isInternal(u)) { set('#vt-f-url', host(u)); set('#vt-f-title', host(u)); } } catch {} }
    const p = $('#vt-f-pass'); if (p) p.type = 'password';
    paintStrength(null, null, ''); updateMeter();
    setTimeout(() => { try { (id ? $('#vt-f-pass') : $('#vt-f-title')).focus(); } catch {} }, 60);
  }
  function updateMeter() { const m = $('#vt-f-meter'); if (m) { const s = strength($('#vt-f-pass').value || ''); m.style.width = (s / 5 * 100) + '%'; m.style.background = s <= 1 ? '#ff5c6c' : s === 2 ? '#ffac4b' : s === 3 ? '#ffd24b' : s === 4 ? '#5fd0ff' : '#3ad07e'; } }
  function backToList() { $('#vt-editor').classList.add('hidden'); $('#vt-main').classList.remove('hidden'); loadList(); }
  async function saveEditor() {
    const patch = { title: $('#vt-f-title').value.trim(), url: $('#vt-f-url').value.trim(), username: $('#vt-f-user').value, password: $('#vt-f-pass').value, notes: $('#vt-f-notes').value };
    if (!patch.password && !patch.username) { toast('Benutzername oder Passwort fehlt', 'i-warn'); return; }
    const r = editingId ? await V.update(editingId, patch) : await V.add(patch);
    if (!r.ok) { toast(r.locked ? 'Tresor ist gesperrt' : 'Speichern fehlgeschlagen', 'i-warn'); if (r.locked) { unlocked = false; showScreen(); } return; }
    toast('Im Tresor gespeichert', 'i-check'); backToList();
  }
  async function deleteEntry() { if (!editingId) return; const r = await V.delete(editingId); if (r.ok) { toast('Eintrag gelöscht', 'i-check'); backToList(); } }

  // ---------------- Generator ----------------
  async function genNow() {
    const opts = { length: +$('#vt-gen-len').value, upper: $('#vt-gen-upper').checked, lower: $('#vt-gen-lower').checked, digits: $('#vt-gen-digits').checked, symbols: $('#vt-gen-symbols').checked };
    const r = await V.generate(opts); lastGen = (r && r.password) || ''; const out = $('#vt-gen-out'); if (out) out.textContent = lastGen;
  }
  function openGen() { $('#vt-gen-pop').classList.remove('hidden'); positionPop($('#vt-gen-pop'), $('#vt-gen-open') || btn); genNow(); }
  function closeGen() { $('#vt-gen-pop').classList.add('hidden'); }

  // ---------------- Autofill-Vermittlung (Webview ↔ Hauptprozess) ----------------
  async function onWebviewMessage(wv, channel, data) {
    try {
      if (channel === 'vault-detect') {
        if (!data || !data.hasLogin) { try { wv.send('vault-clear'); } catch {} return; }
        const r = await V.match(data.origin);
        if (r.ok && r.items && r.items.length) { try { wv.send('vault-offer', { matches: r.items }); } catch {} }
        else { try { wv.send('vault-clear'); } catch {} }
      } else if (channel === 'vault-fill-request') {
        if (!data) return; const r = await V.fill(data.id, data.origin);
        if (r.ok) { try { wv.send('vault-do-fill', { username: r.username, password: r.password }); } catch {} }
        else if (r.locked) { toast('Tresor entsperren, um auszufüllen', 'i-warn'); }
      } else if (channel === 'vault-save-offer') {
        offerSave(data);
      }
    } catch {}
  }
  function offerSave(data) {
    if (!data || !data.password) return;
    saveOfferData = data;
    $('#vs-host').textContent = data.title || host(data.url) || data.origin || 'Diese Seite';
    $('#vs-user').textContent = data.username || '—';
    $('#vs-pass').textContent = '•'.repeat(Math.min(12, (data.password || '').length || 8));
    $('#vault-save').classList.remove('hidden');
  }
  async function doSave(data) {
    try { const lr = await V.list(); if (lr.ok) entries = lr.items || []; } catch {}
    const h = host(data.url || data.origin);
    const existing = entries.find((e) => host(e.url) === h && (e.username || '') === (data.username || ''));
    let r;
    if (existing) r = await V.update(existing.id, { password: data.password, url: data.url || existing.url });
    else r = await V.add({ title: data.title || h, url: data.url || data.origin, username: data.username, password: data.password });
    if (r && r.ok) { toast('Im Tresor gespeichert', 'i-check'); if (mode && unlocked) loadList(); }
    else toast('Speichern fehlgeschlagen', 'i-warn');
  }

  // ---------------- Live-Countdown bis zur Auto-Sperre ----------------
  function fmtRemain(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function tickTimer() {
    const tx = $('#vt-timer-tx'), pill = $('#vt-timer'); if (!tx || !pill) return;
    if (!unlocked || !lockAt) { pill.classList.add('hidden'); return; }
    const rem = lockAt - Date.now();
    pill.classList.remove('hidden');
    tx.textContent = fmtRemain(rem);
    pill.classList.toggle('warn', rem <= 60000);
    if (rem <= 0) { tx.textContent = '0:00'; }   // der Hauptprozess sperrt jetzt → vault:locked folgt
  }
  function startTimer() { if (timerIv) clearInterval(timerIv); tickTimer(); timerIv = setInterval(tickTimer, 1000); }
  function stopTimer() { if (timerIv) { clearInterval(timerIv); timerIv = null; } const pill = $('#vt-timer'); if (pill) pill.classList.add('hidden'); }
  function keepalive() { const now = Date.now(); if (now - lastKeep < 18000) return; lastKeep = now; V.keepalive().then((r) => { if (r && r.ok) { lockAt = r.at || 0; } }).catch(() => {}); }

  // ---------------- Verkabelung ----------------
  $('#vt-lock-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pw = $('#vt-master').value, msg = $('#vt-lock-msg'), go = $('#vt-lock-go');
    if (createMode) {
      if (pw.length < 8) { msg.textContent = 'Mindestens 8 Zeichen.'; return; }
      if (pw !== $('#vt-master2').value) { msg.textContent = 'Passwörter stimmen nicht überein.'; return; }
      const r = await V.create(pw);
      if (!r.ok) { msg.textContent = r.error === 'exists' ? 'Tresor existiert bereits.' : r.error === 'weak' ? 'Zu schwach (min. 8 Zeichen).' : 'Fehler beim Erstellen.'; return; }
      hasVault = true; unlocked = true; toast('Tresor erstellt & entsperrt', 'i-check'); showScreen();
    } else {
      go.disabled = true; go.textContent = 'Entsperre …';
      const r = await V.unlock(pw);
      go.disabled = false; go.textContent = 'Entsperren';
      if (!r.ok) { msg.textContent = r.error === 'wrong' ? 'Falsches Master-Passwort.' : (r.error === 'none' ? 'Kein Tresor vorhanden.' : 'Entsperren fehlgeschlagen.'); stageEl.querySelector('.vt-lock-form').classList.add('vt-shake'); setTimeout(() => stageEl.querySelector('.vt-lock-form').classList.remove('vt-shake'), 500); return; }
      unlocked = true; toast('Tresor entsperrt', 'i-check'); showScreen();
      if (pendingSave) { const p = pendingSave; pendingSave = null; await doSave(p); }
    }
  });
  $('#vt-master').addEventListener('input', () => { if (createMode) paintStrength($('#vt-strength-fill'), $('#vt-strength-tx'), $('#vt-master').value); });
  document.querySelectorAll('.vt-eye').forEach((b) => b.addEventListener('click', () => { const e = $('#' + b.dataset.for); if (!e) return; e.type = e.type === 'password' ? 'text' : 'password'; b.classList.toggle('on', e.type === 'text'); }));
  $('#vt-search').addEventListener('input', renderList);
  $('#vt-new').addEventListener('click', () => openEditor(null));
  $('#vt-ed-back').addEventListener('click', backToList);
  $('#vt-ed-cancel').addEventListener('click', backToList);
  $('#vt-ed-save').addEventListener('click', saveEditor);
  $('#vt-ed-del').addEventListener('click', deleteEntry);
  $('#vt-f-pass').addEventListener('input', updateMeter);
  $('#vt-f-gen').addEventListener('click', openGen);
  $('#vt-gen-open').addEventListener('click', openGen);
  $('#vt-import').addEventListener('click', async () => {
    const r = await V.importFile();
    if (r.ok) { toast(r.added + ' importiert' + (r.skipped ? ' · ' + r.skipped + ' übersprungen' : ''), 'i-check'); loadList(); }
    else if (r.locked) { unlocked = false; showScreen(); }
    else if (!r.canceled) toast(r.error === 'format' ? 'CSV-Spalten nicht erkannt' : r.error === 'empty' ? 'Datei ist leer' : 'Import fehlgeschlagen', 'i-warn');
  });
  $('#vt-gen-x').addEventListener('click', closeGen);
  $('#vt-gen-regen').addEventListener('click', genNow);
  $('#vt-gen-len').addEventListener('input', () => { $('#vt-gen-lenv').textContent = $('#vt-gen-len').value; genNow(); });
  ['vt-gen-upper', 'vt-gen-lower', 'vt-gen-digits', 'vt-gen-symbols'].forEach((id) => $('#' + id).addEventListener('change', genNow));
  $('#vt-gen-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(lastGen); toast('Passwort kopiert', 'i-check'); } catch {} });
  $('#vt-gen-use').addEventListener('click', () => { if (!$('#vt-editor').classList.contains('hidden')) { $('#vt-f-pass').value = lastGen; updateMeter(); } else { navigator.clipboard.writeText(lastGen).catch(() => {}); toast('Passwort kopiert', 'i-check'); } closeGen(); });
  $('#vt-editor').querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const field = b.dataset.copy;
    if (editingId) await copyField(editingId, field);
    else { const v = field === 'password' ? $('#vt-f-pass').value : $('#vt-f-user').value; try { await navigator.clipboard.writeText(v); toast('Kopiert', 'i-check'); } catch {} }
  }));
  // Master-Passwort ändern
  $('#vt-settings').addEventListener('click', () => { $('#vt-md-old').value = ''; $('#vt-md-new').value = ''; $('#vt-md-new2').value = ''; $('#vt-md-msg').textContent = ''; $('#vt-master-dlg').classList.remove('hidden'); });
  $('#vt-md-x').addEventListener('click', () => $('#vt-master-dlg').classList.add('hidden'));
  $('#vt-md-cancel').addEventListener('click', () => $('#vt-master-dlg').classList.add('hidden'));
  $('#vt-md-save').addEventListener('click', async () => {
    const o = $('#vt-md-old').value, n = $('#vt-md-new').value, n2 = $('#vt-md-new2').value, msg = $('#vt-md-msg');
    if (n.length < 8) { msg.textContent = 'Neues Passwort: min. 8 Zeichen.'; return; }
    if (n !== n2) { msg.textContent = 'Neue Passwörter stimmen nicht überein.'; return; }
    const r = await V.changeMaster(o, n);
    if (!r.ok) { msg.textContent = r.error === 'wrong' ? 'Aktuelles Passwort falsch.' : 'Änderung fehlgeschlagen.'; return; }
    $('#vt-master-dlg').classList.add('hidden'); toast('Master-Passwort geändert', 'i-check');
  });
  // Speichern-Angebot
  $('#vs-no').addEventListener('click', () => { $('#vault-save').classList.add('hidden'); saveOfferData = null; });
  $('#vs-yes').addEventListener('click', async () => {
    $('#vault-save').classList.add('hidden'); const data = saveOfferData; saveOfferData = null; if (!data) return;
    const s = await syncStatus();
    if (s.unlocked) await doSave(data);
    else { pendingSave = data; toast('Tresor entsperren, um zu speichern', 'i-bolt'); open(); }
  });
  // Kopf-Buttons
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  $('#vt-close').addEventListener('click', close);
  $('#vt-collapse').addEventListener('click', () => setCollapsed(true));
  $('#vt-side').addEventListener('click', () => setSide(side === 'left' ? 'right' : 'left'));
  $('#vt-full').addEventListener('click', () => setLayout(layout === 'full' ? 'split' : 'full'));
  $('#vt-lock').addEventListener('click', async () => { await V.lock(); unlocked = false; showScreen(); toast('Tresor gesperrt', 'i-check'); });
  const rail = $('#vt-rail'); if (rail) rail.addEventListener('click', () => setCollapsed(false));
  try { const ro = new ResizeObserver(() => { if (mode) dock(); }); const va = $('#view-area'); if (va) ro.observe(va, { box: 'border-box' }); } catch {}
  window.addEventListener('resize', () => { if (mode) dock(); });
  if (V && V.onLocked) V.onLocked(() => { unlocked = false; lockAt = 0; stopTimer(); if (mode) showScreen(); else updateChrome(); });
  if (V && V.onLockAt) V.onLockAt((d) => { lockAt = (d && d.at) || 0; if (unlocked && mode) startTimer(); });
  // Aktivität im Tresor-Panel hält ihn wach (setzt die 5-Minuten-Sperre zurück)
  ['mousemove', 'keydown', 'pointerdown'].forEach((ev) => stageEl.addEventListener(ev, keepalive, { passive: true }));

  return { toggle, open, close, onWebviewMessage };
})();

/* ============================================================ NOVA Share (Datei-Server-Client: andockbar + Admin) */
const share = (() => {
  const stageEl = $('#share-stage'), btn = $('#btn-share');
  if (!stageEl) return {};
  const S = window.nova.share;
  let mode = false, collapsed = false, side = 'right', layout = 'split';
  let me = null, files = [], tab = 'files', editUserId = null;
  const splitWidth = () => Math.round(Math.min(940, Math.max(460, window.innerWidth * 0.48)));
  const fmtBytes = (n) => { n = Number(n) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i]; };

  // ---------------- Andocken (wie Tresor) ----------------
  function dock() {
    const full = layout === 'full' && !collapsed;
    stageEl.classList.toggle('sh-left', side === 'left' && !full);
    stageEl.classList.toggle('sh-collapsed', collapsed);
    stageEl.classList.toggle('sh-fullscreen', full);
    document.body.classList.toggle('sh-full-cover', full);
    dockManager.set('share', { el: stageEl, side, collapsed, full, open: mode, width: splitWidth, collapse: setCollapsed });
  }
  function setSide(s) { if (s !== 'left' && s !== 'right') return; side = s; try { state.settings.shareSide = s; window.nova.settings.set({ shareSide: s }); } catch {} dock(); }
  function setLayout(l) { if (l !== 'split' && l !== 'full') return; layout = l; collapsed = false; const fb = $('#sh-full'); if (fb) fb.classList.toggle('active', l === 'full'); try { state.settings.shareLayout = l; window.nova.settings.set({ shareLayout: l }); } catch {} dock(); }
  function setCollapsed(on) { collapsed = !!on; const cb = $('#sh-collapse'); if (cb) cb.title = collapsed ? 'Ausklappen' : 'Einklappen'; dock(); }
  async function open() {
    mode = true; collapsed = false;
    if (state.settings && state.settings.shareSide === 'left') side = 'left';
    if (state.settings && (state.settings.shareLayout === 'full' || state.settings.shareLayout === 'split')) layout = state.settings.shareLayout;
    const fb = $('#sh-full'); if (fb) fb.classList.toggle('active', layout === 'full');
    stageEl.classList.remove('hidden', 'closing');
    document.body.classList.add('sh-open');
    requestAnimationFrame(dock);
    if (btn) btn.classList.add('active');
    await refresh();
  }
  function close() {
    if (!mode) return; mode = false;
    document.body.classList.remove('sh-full-cover');
    dockManager.close('share');
    stageEl.classList.add('closing');
    setTimeout(() => { stageEl.classList.add('hidden'); stageEl.classList.remove('closing'); document.body.classList.remove('sh-open'); stageEl.style.left = ''; stageEl.style.right = ''; stageEl.style.top = ''; stageEl.style.width = ''; }, 420);
    if (btn) btn.classList.remove('active');
  }
  function toggle() { mode ? close() : open(); }
  function showSnap(s) {
    const va = $('#view-area'); if (!va) return; const r = va.getBoundingClientRect(); const w = splitWidth();
    const sn = $('#sh-snap'); if (!sn) return; sn.classList.remove('hidden');
    sn.style.top = Math.round(r.top) + 'px'; sn.style.height = Math.round(r.height - 10) + 'px'; sn.style.width = w + 'px';
    if (s === 'left') { sn.style.left = Math.round(r.left) + 'px'; sn.style.right = 'auto'; } else { sn.style.right = Math.round(window.innerWidth - r.right) + 'px'; sn.style.left = 'auto'; }
  }
  const head = $('#sh-head');
  if (head) head.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return;
    e.preventDefault();
    const mask = $('#sh-dragmask'); if (mask) mask.classList.remove('hidden');
    stageEl.classList.add('sh-grab');
    let curSide = side;
    const onMove = (ev) => { curSide = ev.clientX < window.innerWidth / 2 ? 'left' : 'right'; showSnap(curSide); };
    const onUp = () => { if (mask) mask.classList.add('hidden'); stageEl.classList.remove('sh-grab'); const sn = $('#sh-snap'); if (sn) sn.classList.add('hidden'); setLayout('split'); setSide(curSide); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    showSnap(curSide);
  });

  // ---------------- Screens ----------------
  function updateChrome() {
    const sub = $('#sh-status'); if (sub) sub.textContent = me ? (me.username + (me.role === 'admin' ? ' · Admin' : '')) : 'nicht verbunden';
    const st = $('#sh-rail-state'); if (st) st.classList.toggle('on', !!me);
    const lo = $('#sh-logout'); if (lo) lo.classList.toggle('hidden', !me);
    if (btn) btn.classList.toggle('connected', !!me);
  }
  function showScreen() {
    const login = $('#sh-login'), main = $('#sh-main');
    if (!me) { login.classList.remove('hidden'); main.classList.add('hidden'); setTimeout(() => { try { ($('#sh-server').value ? $('#sh-user') : $('#sh-server')).focus(); } catch {} }, 80); }
    else {
      login.classList.add('hidden'); main.classList.remove('hidden');
      $('#sh-tab-admin').classList.toggle('hidden', me.role !== 'admin');
      if (tab === 'admin' && me.role !== 'admin') tab = 'files';
      selectTab(tab);
    }
    updateChrome();
  }
  async function refresh() {
    const c = await S.config();
    if ($('#sh-server') && c.serverUrl) $('#sh-server').value = c.serverUrl;
    if (c.loggedIn) { const r = await S.me(); me = r.ok ? r.user : null; } else me = null;
    showScreen();
  }

  // ---------------- Dateien ----------------
  async function loadFiles() {
    const r = await S.files();
    if (!r.ok) { if (r.status === 401) { me = null; showScreen(); } return; }
    files = r.files || []; if (r.me) me = r.me;
    renderFiles(); updateQuota();
  }
  function updateQuota() {
    const q = $('#sh-quota-fill'), tx = $('#sh-quota-tx'); if (!me || !q) return;
    const used = me.usedBytes || 0, total = me.quotaBytes || 0, pct = total ? Math.min(100, used / total * 100) : 0;
    q.style.width = pct + '%'; q.style.background = pct > 90 ? '#ff5c6c' : pct > 70 ? '#ffac4b' : 'linear-gradient(90deg,var(--sh),var(--sh2))';
    tx.textContent = fmtBytes(used) + ' / ' + fmtBytes(total);
  }
  function renderFiles() {
    const q = ($('#sh-search').value || '').toLowerCase().trim();
    const list = $('#sh-files'); list.innerHTML = '';
    const items = files.filter((f) => !q || (f.name + ' ' + (f.ownerName || '')).toLowerCase().includes(q)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    $('#sh-empty').classList.toggle('hidden', files.length > 0);
    for (const f of items) {
      const row = el('div', 'sh-file');
      const ic = el('span', 'sh-file-ic'); ic.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 3v5h5"/><path d="M6 3h8l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>';
      const tx = el('div', 'sh-file-tx'); tx.appendChild(el('b', null, f.name)); tx.appendChild(el('span', null, fmtBytes(f.size) + ' · ' + (f.ownerName || '?') + (f.downloads ? ' · ' + f.downloads + '×' : '')));
      const dl = el('button', 'sh-file-btn'); dl.title = 'Herunterladen'; dl.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 4v12M7 12l5 5 5-5M5 20h14"/></svg>';
      dl.addEventListener('click', () => downloadFile(f));
      row.append(ic, tx, dl);
      if (f.mine || (me && me.role === 'admin')) { const del = el('button', 'sh-file-btn sh-del'); del.title = 'Löschen'; del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13h10l1-13"/></svg>'; del.addEventListener('click', () => deleteFile(f)); row.appendChild(del); }
      list.appendChild(row);
    }
  }
  async function downloadFile(f) { toast('Lade „' + f.name + '" …', 'i-download'); const r = await S.download(f.id, f.name); if (r.ok) toast('Heruntergeladen → ' + (r.path || 'Downloads'), 'i-check'); else toast('Download fehlgeschlagen', 'i-warn'); }
  async function deleteFile(f) { const r = await S.delete(f.id); if (r.ok) { toast('Gelöscht', 'i-check'); loadFiles(); } else toast('Löschen fehlgeschlagen', 'i-warn'); }

  // ---------------- Admin ----------------
  function toBytes(val, unit) { const n = Math.max(0, Number(val) || 0); return unit === 'GB' ? n * 1073741824 : n * 1048576; }
  function fromBytes(b) { b = Number(b) || 0; return b >= 1073741824 ? { val: +(b / 1073741824).toFixed(2), unit: 'GB' } : { val: Math.round(b / 1048576), unit: 'MB' }; }
  async function loadAdmin() {
    const [u, s] = await Promise.all([S.adminUsers(), S.adminStats()]);
    const stats = $('#sh-admin-stats');
    if (s.ok && stats) { stats.innerHTML = ''; const chip = (k, v) => { const c = el('div', 'sh-stat'); c.appendChild(el('b', null, v)); c.appendChild(el('span', null, k)); return c; }; stats.append(chip('Konten', String(s.stats.users)), chip('Dateien', String(s.stats.files)), chip('Gesamt', fmtBytes(s.stats.totalBytes))); }
    if (u.ok) renderUsers(u.users || []);
  }
  function renderUsers(users) {
    const list = $('#sh-users'); list.innerHTML = '';
    for (const u of users) {
      const row = el('div', 'sh-user' + (u.disabled ? ' off' : ''));
      const av = el('span', 'sh-user-av', (u.username[0] || '?').toUpperCase());
      const tx = el('div', 'sh-user-tx');
      const top = el('b', null, u.username); if (u.role === 'admin') { const bdg = el('span', 'sh-badge', 'Admin'); top.appendChild(bdg); }
      tx.appendChild(top);
      tx.appendChild(el('span', null, fmtBytes(u.usedBytes) + ' / ' + fmtBytes(u.quotaBytes) + ' · max ' + fmtBytes(u.maxFileBytes) + (u.disabled ? ' · gesperrt' : '')));
      const edit = el('button', 'sh-file-btn'); edit.title = 'Bearbeiten'; edit.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>'; edit.addEventListener('click', () => openUserDlg(u));
      const dis = el('button', 'sh-file-btn'); dis.title = u.disabled ? 'Entsperren' : 'Sperren'; dis.innerHTML = u.disabled ? '<svg viewBox="0 0 24 24"><path d="M7 11V8a5 5 0 0 1 9.9-1"/><rect x="5" y="11" width="14" height="9" rx="2"/></svg>' : '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
      dis.addEventListener('click', async () => { const r = await S.adminUpdate(u.id, { disabled: !u.disabled }); if (r.ok) loadAdmin(); else toast('Fehler', 'i-warn'); });
      const del = el('button', 'sh-file-btn sh-del'); del.title = 'Löschen'; del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13h10l1-13"/></svg>';
      del.addEventListener('click', async () => { const r = await S.adminDelete(u.id); if (r.ok) { toast('Konto gelöscht', 'i-check'); loadAdmin(); } else toast(r.error === 'self' ? 'Eigenes Konto nicht löschbar' : 'Fehler', 'i-warn'); });
      row.append(av, tx, edit, dis, del);
      list.appendChild(row);
    }
  }
  function openUserDlg(u) {
    editUserId = u ? u.id : null;
    $('#sh-ud-title').textContent = u ? ('Konto: ' + u.username) : 'Konto anlegen';
    $('#sh-ud-user').value = u ? u.username : ''; $('#sh-ud-user').disabled = !!u;
    $('#sh-ud-pass').value = ''; $('#sh-ud-pass').placeholder = u ? 'Neues Passwort (leer = unverändert)' : 'Passwort (min. 8 Zeichen)';
    const q = fromBytes(u ? u.quotaBytes : 2147483648), m = fromBytes(u ? u.maxFileBytes : 536870912);
    $('#sh-ud-quota').value = q.val; $('#sh-ud-quota-unit').value = q.unit;
    $('#sh-ud-max').value = m.val; $('#sh-ud-max-unit').value = m.unit;
    $('#sh-ud-admin').checked = u ? u.role === 'admin' : false;
    $('#sh-ud-msg').textContent = '';
    $('#sh-user-dlg').classList.remove('hidden');
  }
  async function saveUserDlg() {
    const msg = $('#sh-ud-msg');
    const quota = toBytes($('#sh-ud-quota').value, $('#sh-ud-quota-unit').value);
    const maxFile = toBytes($('#sh-ud-max').value, $('#sh-ud-max-unit').value);
    const isAdmin = $('#sh-ud-admin').checked;
    const pass = $('#sh-ud-pass').value;
    if (editUserId) {
      const patch = { role: isAdmin ? 'admin' : 'user', quotaBytes: quota, maxFileBytes: maxFile };
      if (pass) { if (pass.length < 8) { msg.textContent = 'Passwort min. 8 Zeichen.'; return; } patch.password = pass; }
      const r = await S.adminUpdate(editUserId, patch);
      if (!r.ok) { msg.textContent = 'Änderung fehlgeschlagen.'; return; }
    } else {
      const username = $('#sh-ud-user').value.trim();
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) { msg.textContent = 'Benutzername: 3–32 Zeichen (a–z, 0–9, . _ -).'; return; }
      if (pass.length < 8) { msg.textContent = 'Passwort min. 8 Zeichen.'; return; }
      const r = await S.adminCreate({ username, password: pass, role: isAdmin ? 'admin' : 'user', quotaBytes: quota, maxFileBytes: maxFile });
      if (!r.ok) { msg.textContent = r.error === 'exists' ? 'Benutzername existiert bereits.' : 'Anlegen fehlgeschlagen.'; return; }
    }
    $('#sh-user-dlg').classList.add('hidden'); toast('Gespeichert', 'i-check'); loadAdmin();
  }

  function selectTab(t) {
    tab = t;
    document.querySelectorAll('.sh-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $('#sh-pane-files').classList.toggle('hidden', t !== 'files');
    $('#sh-pane-admin').classList.toggle('hidden', t !== 'admin');
    if (t === 'files') loadFiles(); else loadAdmin();
  }

  // ---------------- Verkabelung ----------------
  $('#sh-login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const url = $('#sh-server').value.trim(), username = $('#sh-user').value.trim(), password = $('#sh-pass').value, msg = $('#sh-login-msg'), go = $('#sh-login-go');
    if (!url) { msg.textContent = 'Bitte Server-Adresse eingeben.'; return; }
    if (!/^https?:\/\//i.test(url)) { msg.textContent = 'Adresse muss mit http:// oder https:// beginnen.'; return; }
    go.disabled = true; go.textContent = 'Verbinde …';
    await S.setServer(url);
    const r = await S.login({ username, password });
    go.disabled = false; go.textContent = 'Anmelden';
    if (!r.ok) { msg.textContent = r.error === 'bad_credentials' ? 'Benutzername oder Passwort falsch.' : r.error === 'too_many' ? 'Zu viele Versuche — kurz warten.' : r.error === 'network' || r.error === 'no_server' ? 'Server nicht erreichbar.' : 'Anmeldung fehlgeschlagen.'; return; }
    me = r.user; $('#sh-pass').value = ''; toast('Mit Server verbunden', 'i-check'); showScreen();
  });
  document.querySelectorAll('#share-stage .sh-eye').forEach((b) => b.addEventListener('click', () => { const e = $('#' + b.dataset.for); if (!e) return; e.type = e.type === 'password' ? 'text' : 'password'; b.classList.toggle('on', e.type === 'text'); }));
  document.querySelectorAll('.sh-tab').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  $('#sh-search').addEventListener('input', renderFiles);
  $('#sh-refresh').addEventListener('click', loadFiles);
  $('#sh-upload').addEventListener('click', async () => { const r = await S.upload(); if (r && r.ok) loadFiles(); else if (r && !r.canceled) toast('Upload fehlgeschlagen', 'i-warn'); });
  $('#sh-user-new').addEventListener('click', () => openUserDlg(null));
  $('#sh-ud-x').addEventListener('click', () => $('#sh-user-dlg').classList.add('hidden'));
  $('#sh-ud-cancel').addEventListener('click', () => $('#sh-user-dlg').classList.add('hidden'));
  $('#sh-ud-save').addEventListener('click', saveUserDlg);
  if (S.onProgress) S.onProgress((p) => {
    const box = $('#sh-progress'), fill = $('#sh-prog-fill'), tx = $('#sh-prog-tx'); if (!box) return;
    if (p.done) { fill.style.width = '100%'; tx.textContent = (p.down ? 'Download' : 'Upload') + (p.ok ? ' fertig ✓' : ' fehlgeschlagen'); setTimeout(() => box.classList.add('hidden'), 1300); return; }
    box.classList.remove('hidden'); const pct = p.total ? Math.round(p.sent / p.total * 100) : 0; fill.style.width = pct + '%'; tx.textContent = (p.down ? '⬇ ' : '⬆ ') + (p.name || '') + ' · ' + pct + '%';
  });
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  $('#sh-close').addEventListener('click', close);
  $('#sh-collapse').addEventListener('click', () => setCollapsed(true));
  $('#sh-side').addEventListener('click', () => setSide(side === 'left' ? 'right' : 'left'));
  $('#sh-full').addEventListener('click', () => setLayout(layout === 'full' ? 'split' : 'full'));
  $('#sh-logout').addEventListener('click', async () => { await S.logout(); me = null; showScreen(); toast('Abgemeldet', 'i-check'); });
  const rail = $('#sh-rail'); if (rail) rail.addEventListener('click', () => setCollapsed(false));
  try { const ro = new ResizeObserver(() => { if (mode) dock(); }); const va = $('#view-area'); if (va) ro.observe(va, { box: 'border-box' }); } catch {}
  window.addEventListener('resize', () => { if (mode) dock(); });

  return { toggle, open, close };
})();

/* ============================================================ Google-Login (echtes Fenster → Sitzungs-Import) */
if (window.nova.google && window.nova.google.onStatus) {
  window.nova.google.onStatus((s) => {
    const st = s && s.state;
    if (st === 'opening') toast('Google-Login öffnet sich in einem sicheren Fenster …', 'i-bolt');
    else if (st === 'waiting') toast('Im geöffneten Fenster bei Google anmelden …', 'i-bolt');
    else if (st === 'done') {
      toast('Bei Google angemeldet ✓ — Seiten werden neu geladen', 'i-check');
      try { activeTab()?.wv.reload(); } catch {}
      try { document.querySelectorAll('#music-panel webview').forEach((w) => { try { w.reload(); } catch {} }); } catch {}
    }
    else if (st === 'timeout') toast('Google-Login abgebrochen (Zeitüberschreitung)', 'i-warn');
    else if (st === 'busy') toast('Login-Fenster ist bereits offen', 'i-warn');
    else if (st === 'error') toast('Google-Login: ' + ((s && s.msg) || 'Fehler'), 'i-warn');
  });
}

/* ============================================================ init */
(async function init() {
  const data = await window.nova.ready();
  state.settings = data.settings;
  state.bookmarks = data.bookmarks;
  state.webviewPreload = data.webviewPreload;
  state.versions = data.versions;
  state.totalBlocked = data.totalBlocked;

  if (state.settings.sidebarCollapsed) $('#app').classList.add('sb-collapsed');
  if (state.settings.bmCollapsed) $('#sidebar').classList.add('bm-collapsed');
  if (data.isMaximized) $('#win-max-ic').querySelector('use').setAttribute('href', '#i-restore');

  renderBookmarks();
  syncShieldBadge();
  teEdit.apply();
  extActions.refresh();
  if (state.settings.tabBarPosition === 'top') document.body.classList.add('tabs-top');
  try { chromeNebula.apply(state.settings.nebulaQuality || 'mid'); } catch {}   // GPU-Nebel hinter der Oberfläche
  music.applySettings();
  claude.applySettings();
  restoreSession(data.sessionTabs, data.startUrl);
  ensureIcon();
  // Warp-Animationen erst nach dem Startup zulassen (nicht beim Session-Restore)
  setTimeout(() => { warpReady = true; }, 1400);
})();
