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
        var engage = window.__novaVol > 1.0001 || window.__novaWA;
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
              els.forEach(function(e){
                var t = Math.min(1, window.__novaVol);
                if (Math.abs((e.volume||0) - t) > 0.005) { try { e.volume = t; } catch(_){} }
                if (window.__novaVol === 0) e.muted = true; else if (e.muted && e.dataset.novaUnmute !== '0') e.muted = false;
              });
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
    wv.setAttribute('src', SERVICES[svc].url);
    wv.addEventListener('did-stop-loading', () => {
      loading.style.display = 'none';
      applyZoom(svc, wv);
      repaintMusic(wv);
      setTimeout(() => { applyZoom(svc, wv); repaintMusic(wv); }, 400);
      pushVolume();
    });
    wv.addEventListener('dom-ready', () => { applyZoom(svc, wv); repaintMusic(wv); pushVolume(); });
    wrap.append(loading, wv);
    body.appendChild(wrap);
    views[svc] = { wrap, wv, svc };
    return views[svc];
  }

  // „Render breit, skaliere klein" — NUR für Spotify (war rechts abgeschnitten).
  // Apple Music sah ohne Zoom besser aus → dort Zoom 1 lassen.
  const TARGET_W = { spotify: 660 };
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

  function show(svc) {
    current = svc;
    ensureView(svc);
    for (const [key, v] of Object.entries(views)) {
      v.wrap.style.display = key === svc ? 'block' : 'none';
      if (key === svc) repaintMusic(v.wv);
    }
    for (const b of panel.querySelectorAll('.music-svc')) b.classList.toggle('active', b.dataset.svc === svc);
    state.settings.musicService = svc;
    window.nova.settings.set({ musicService: svc });
  }

  function toggle(force) {
    open = force != null ? force : !open;
    panel.classList.toggle('hidden', !open);
    $('#btn-music').classList.toggle('btn-music-active', open);
    if (open) {
      if (!current) show(state.settings.musicService || 'spotify');
      else if (views[current]) repaintMusic(views[current].wv);
      checkDrm();
      // Nach dem Einblenden (Animation) Größe & Compositing fixieren
      setTimeout(() => { sizeViews(); if (current && views[current]) repaintMusic(views[current].wv); }, 380);
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
    return {ok:!!md,title:md?md.title:'',artist:md?md.artist:'',art:art,
      playing:!!m&&!m.paused&&!m.ended,pos:m?m.currentTime:0,dur:(m&&isFinite(m.duration))?m.duration:0};
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
      if(host.indexOf('spotify')>=0&&clickDeep(['[data-testid="control-button-playpause"]']))return true;
      if(host.indexOf('apple')>=0){ if(clickByLabel(/^(play|pause|wiedergabe|pausieren|abspielen)$/i)) return true; }
      if(m){m.paused?m.play():m.pause();return true;}
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

  async function pollNowPlaying() {
    const entries = Object.values(views);
    if (entries.length === 0) { hideMini(); return; }
    let best = null, bestView = null;
    for (const v of entries) {
      if (!v.wv) continue;
      let np = null;
      try { np = await v.wv.executeJavaScript(READ_NP, true); } catch { np = null; }
      if (np && np.ok && (np.title || np.artist)) {
        if (np.playing) { best = np; bestView = v.wv; break; }
        if (!best) { best = np; bestView = v.wv; }
      }
    }
    if (best) { npView = bestView; renderMini(best); }
    else hideMini();
  }

  function renderMini(np) {
    lastNp = np;
    mini.classList.remove('hidden');
    $('#mm-title').textContent = np.title || 'Unbekannter Titel';
    $('#mm-artist').textContent = np.artist || '';
    const img = $('#mm-art-img');
    if (np.art && img.dataset.src !== np.art) { img.dataset.src = np.art; img.src = np.art; img.classList.add('show'); }
    if (!np.art) { img.classList.remove('show'); img.removeAttribute('src'); img.dataset.src = ''; }
    const use = $('#mm-playpause').querySelector('use');
    if (use) use.setAttribute('href', np.playing ? '#i-pause' : '#i-play');
    const pct = np.dur > 0 ? Math.min(100, (np.pos / np.dur) * 100) : 0;
    $('#mm-progress').style.width = pct + '%';
  }
  function hideMini() { mini.classList.add('hidden'); npView = null; }

  async function miniCmd(action) {
    const v = npView || (current && views[current] && views[current].wv);
    if (!v) return;
    let host = ''; try { host = new URL(v.getURL()).hostname; } catch {}
    const isApple = /(^|\.)music\.apple\.com$/.test(host) || host.indexOf('apple') >= 0;
    if (isApple && action !== 'playpause') {
      // Apple Music reagiert NICHT zuverlässig auf DOM-Klicks/synthetische Tasten, aber auf die
      // echten Multimedia-Tasten der Tastatur → exakt die auf Systemebene auslösen.
      window.nova.music.hwMediaKey(action);
      // zusätzlich den DOM-Versuch (schadet nicht, hilft falls hw nicht greift)
      try { await v.executeJavaScript(cmdScript(action), true); } catch {}
    } else {
      // Spotify & Co: echten DOM-Button klicken (zuverlässig), Medientaste nur Fallback
      let ok = false;
      try { ok = await v.executeJavaScript(cmdScript(action), true); } catch {}
      if (!ok && action !== 'playpause') {
        let wcId = null; try { wcId = v.getWebContentsId(); } catch {}
        if (wcId) window.nova.music.mediaKey({ wcId, key: action === 'next' ? 'MediaNextTrack' : 'MediaPreviousTrack' });
        else window.nova.music.hwMediaKey(action);
      }
    }
    setTimeout(pollNowPlaying, 350);
    setTimeout(pollNowPlaying, 1100);
  }
  $('#mm-playpause').addEventListener('click', (e) => { e.stopPropagation(); miniCmd('playpause'); });
  $('#mm-next').addEventListener('click', (e) => { e.stopPropagation(); miniCmd('next'); });
  $('#mm-prev').addEventListener('click', (e) => { e.stopPropagation(); miniCmd('prev'); });
  mini.addEventListener('click', () => toggle(true));

  setInterval(pollNowPlaying, 1500);

  // Bei Fenstergrößenänderung die Player-Webviews mitskalieren
  window.addEventListener('resize', () => { if (open) sizeViews(); });
  return { toggle, show, applySettings, checkDrm, pollNowPlaying };
})();

/* ============================================================ Claude (NOVA AI) */
// Schritt 1 — Fundament: claude.ai eingebettet, Login bleibt erhalten (eigene
// persistente Session, kein API-Key). Agent-Browsing/Coding bauen darauf auf.
const claude = (() => {
  const PART = 'persist:nova-claude';
  const panel = $('#claude-panel');
  const body = $('#claude-body');
  let wv = null, open = false;

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
  // claude.ai an die Panel-Breite anpassen: schmale Docks zoomen raus, damit das
  // Layout passt statt riesig/abgeschnitten zu wirken (wie der Spotify-Trick).
  // Liest IMMER die echte aktuelle Body-Breite — wird vom ResizeObserver getrieben,
  // daher keine Timing-/Stale-Breite-Probleme mehr beim mehrfachen Umdocken.
  function applyClaudeZoom() {
    if (!wv) return;
    const w = body.clientWidth;
    if (!w) return;
    const z = Math.max(0.55, Math.min(1, w / 640));
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
  function toggle(force) {
    open = force != null ? force : !open;
    panel.classList.toggle('hidden', !open);
    $('#btn-claude').classList.toggle('btn-claude-active', open);
    if (open) { ensureView(); layoutDock(); setTimeout(repaint, 380); }
    else { layoutDock(); if (agentOn) setAgent(false); }
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
    var nodes = document.querySelectorAll('div.font-claude-message');
    if(!nodes.length) nodes = document.querySelectorAll('[data-testid="assistant-message"], .prose, [data-is-streaming]');
    if(!nodes.length) return { ok:false, text:'', raw:'', hrefs:[], codes:[], n:0 };
    var last = nodes[nodes.length-1];
    var hrefs = [];
    last.querySelectorAll('a[href]').forEach(function(a){ var h=a.getAttribute('href')||''; if(/^https?:\\/\\//i.test(h)) hrefs.push(h); });
    var codes = [];
    last.querySelectorAll('code').forEach(function(c){ var t=(c.textContent||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD]/g,'').trim(); if(t) codes.push(t); });
    return { ok:true, text:(last.innerText||'').trim(), raw:(last.textContent||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD]/g,'').replace(/\\s+/g,' ').trim(), hrefs:hrefs, codes:codes, n: nodes.length };
  }catch(e){ return { ok:false, text:'', raw:'', hrefs:[], codes:[], n:0 }; }})()`;

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

  $('#btn-claude').addEventListener('click', () => toggle());
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
  return { toggle, close, applySettings, relayout, setDock, isOpen: () => open };
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
    ['shield', 'i-shield', 'NOVA Shield'], ['plugins', 'i-plugin', 'Plugin-Store'], ['palette', 'i-bolt', 'Befehlspalette'],
  ];
  let openFlag = false;
  let extList = [];   // aktuell geladene Erweiterungs-Actions (von extActions gesetzt)

  function visible() {
    const t = state.settings.topbarTools;
    return Array.isArray(t) ? t : TOOLS.map((x) => x[0]);
  }
  function hiddenExt() { return new Set(state.settings.topbarExtHidden || []); }
  function apply() {
    const vis = new Set(visible());
    const hidden = hiddenExt();
    for (const btn of document.querySelectorAll('.topbar-tool')) {
      const t = btn.dataset.tool || '';
      if (t.startsWith('ext:')) btn.classList.toggle('hidden', hidden.has(t.slice(4)));
      else btn.classList.toggle('hidden', !vis.has(t));
    }
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
  let current = null;

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
    current = a.id;
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
  }
  function closePopup() { pop.classList.add('hidden'); body.innerHTML = ''; current = null; }

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
      toast('Update wird installiert — NOVA startet neu', 'i-download');
      window.nova.update.install(res.path);
    } else if (res && res.opened) {
      close(); // kein direkter Download → Release-Seite wurde geöffnet
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
  music.applySettings();
  claude.applySettings();
  restoreSession(data.sessionTabs, data.startUrl);
  ensureIcon();
  // Warp-Animationen erst nach dem Startup zulassen (nicht beim Session-Restore)
  setTimeout(() => { warpReady = true; }, 1400);
})();
