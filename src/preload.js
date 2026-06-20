'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (payload) => ipcRenderer.invoke(ch, payload);
const send = (ch) => (payload) => ipcRenderer.send(ch, payload);
const on = (ch) => (cb) => { ipcRenderer.on(ch, (_e, data) => cb(data)); };

contextBridge.exposeInMainWorld('nova', {
  ready: invoke('ui:ready'),

  win: {
    min: send('win:min'),
    max: send('win:max'),
    close: send('win:close'),
    fullscreen: send('win:fullscreen'),
    onMaximized: on('win:maximized'),
    onFullscreen: on('win:fullscreen'),
  },

  settings: {
    set: invoke('settings:set'),
    onChanged: on('settings:changed'),
  },

  adblock: {
    site: invoke('ab:site'),
    resetTab: send('ab:resetTab'),
    tabDetail: invoke('ab:tabDetail'),
    refresh: invoke('ab:refresh'),
    catalog: invoke('ab:catalog'),
    onStats: on('ab:stats'),
  },

  tabs: {
    thumb: invoke('tab:thumb'),
    screenshot: invoke('tab:screenshot'),
  },

  music: {
    drm: invoke('music:drm'),
    mediaKey: send('music:mediaKey'),
    hwMediaKey: send('music:hwMediaKey'),
  },

  omni: {
    suggest: invoke('omni:suggest'),
    searchUrl: invoke('omni:searchUrl'),
  },

  history: {
    add: send('history:add'),
    query: invoke('history:query'),
    delete: invoke('history:delete'),
    clear: invoke('history:clear'),
    top: invoke('history:top'),
  },

  bookmarks: {
    get: invoke('bm:get'),
    add: invoke('bm:add'),
    remove: invoke('bm:remove'),
    rename: invoke('bm:rename'),
    setOpen: invoke('bm:setOpen'),
    find: invoke('bm:find'),
    createFolder: invoke('bm:createFolder'),
    move: invoke('bm:move'),
    importEdge: invoke('bm:importEdge'),
    export: invoke('bm:export'),
    importJson: invoke('bm:importJson'),
    onChanged: on('bm:changed'),
  },

  downloads: {
    list: invoke('dl:list'),
    action: invoke('dl:action'),
    limit: invoke('dl:limit'),
    globalLimit: invoke('dl:globalLimit'),
    clear: invoke('dl:clear'),
    openFolder: send('dl:openFolder'),
    onUpdate: on('dl:update'),
  },

  net: {
    monitor: send('net:monitor'),
    onStats: on('net:stats'),
  },

  security: {
    get: invoke('sec:get'),         // (host) → gespeicherter Report oder null
    save: invoke('sec:save'),       // (report) → lokal speichern (+ Beitrag, falls Token)
    pull: invoke('sec:pull'),       // geteilte DB von GitHub holen + mergen
    contribute: invoke('sec:contribute'),
  },

  update: {
    check: invoke('update:check'),
    download: invoke('update:download'),
    install: invoke('update:install'),
    openPage: invoke('update:openPage'),
    onAvailable: on('update:available'),
    onProgress: on('update:progress'),
  },

  session: {
    save: send('session:save'),
  },

  shifter: {
    toggle: invoke('shifter:toggle'),
    status: invoke('shifter:status'),
  },

  google: {
    login: invoke('google:login'),
    onStatus: on('google:login-status'),
  },

  discord: {
    onScreenSources: on('discord:screen-sources'),
    pickScreen: send('discord:screen-pick'),
  },

  vault: {
    status: invoke('vault:status'),
    create: invoke('vault:create'),
    unlock: invoke('vault:unlock'),
    lock: invoke('vault:lock'),
    keepalive: invoke('vault:keepalive'),
    list: invoke('vault:list'),
    get: invoke('vault:get'),
    add: invoke('vault:add'),
    update: (id, patch) => ipcRenderer.invoke('vault:update', id, patch),
    delete: invoke('vault:delete'),
    match: invoke('vault:match'),
    fill: (id, origin) => ipcRenderer.invoke('vault:fill', id, origin),
    generate: invoke('vault:generate'),
    changeMaster: (oldPw, newPw) => ipcRenderer.invoke('vault:changeMaster', oldPw, newPw),
    copy: (id, field) => ipcRenderer.invoke('vault:copy', id, field),
    onLocked: on('vault:locked'),
    onLockAt: on('vault:lock-at'),
  },

  share: {
    config: invoke('share:config'),
    setServer: invoke('share:setServer'),
    ping: invoke('share:ping'),
    login: invoke('share:login'),
    logout: invoke('share:logout'),
    me: invoke('share:me'),
    files: invoke('share:files'),
    upload: invoke('share:upload'),
    download: (id, name) => ipcRenderer.invoke('share:download', id, name),
    delete: invoke('share:delete'),
    changePassword: invoke('share:changePassword'),
    openDownloads: invoke('share:openDownloads'),
    adminUsers: invoke('share:adminUsers'),
    adminStats: invoke('share:adminStats'),
    adminCreate: invoke('share:adminCreate'),
    adminUpdate: (id, patch) => ipcRenderer.invoke('share:adminUpdate', id, patch),
    adminDelete: invoke('share:adminDelete'),
    onProgress: on('share:progress'),
  },

  plugins: {
    state: invoke('plugins:state'),
    setNative: invoke('plugins:setNative'),
    saveUserscript: invoke('plugins:saveUserscript'),
    removeUserscript: invoke('plugins:removeUserscript'),
    toggleUserscript: invoke('plugins:toggleUserscript'),
    loadExtension: invoke('plugins:loadExtension'),
    installFromStore: invoke('plugins:installFromStore'),
    removeExtension: invoke('plugins:removeExtension'),
    toggleExtension: invoke('plugins:toggleExtension'),
    actions: invoke('plugins:actions'),
    onActionsChanged: on('plugins:actionsChanged'),
    onInstalled: on('plugins:installed'),
  },

  sys: {
    setIcon: invoke('sys:icon'),
    iconExists: invoke('sys:iconExists'),
    createShortcut: invoke('sys:shortcut'),
    registerDefault: invoke('sys:registerDefault'),
    clearData: invoke('sys:clearData'),
  },

  onOpenTab: on('tabs:open'),
  onShortcut: on('shortcut'),
  onTabAudio: on('tab:audio'),
});
