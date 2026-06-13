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
