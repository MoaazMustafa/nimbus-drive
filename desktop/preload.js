'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('nimbus', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => on('state', cb),
  onLog: (cb) => on('log', cb),
  onInstall: (cb) => on('install', cb),

  start: () => ipcRenderer.invoke('services:start'),
  stop: () => ipcRenderer.invoke('services:stop'),
  restart: () => ipcRenderer.invoke('services:restart'),
  restartOne: (name) => ipcRenderer.invoke('services:restartOne', name),
  takeover: () => ipcRenderer.invoke('external:takeover'),

  installFromGitHub: (repo) => ipcRenderer.invoke('setup:install', repo),
  locateProject: () => ipcRenderer.invoke('setup:locate'),
  cancelInstall: () => ipcRenderer.invoke('install:cancel'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  runUpdate: () => ipcRenderer.invoke('update:run'),
  rollback: () => ipcRenderer.invoke('update:rollback'),
  rebuild: () => ipcRenderer.invoke('rebuild:run'),
  shellUpdateInstall: () => ipcRenderer.invoke('shell-update:install'),
  openReleases: () => ipcRenderer.invoke('open:releases'),
  verifyDomain: () => ipcRenderer.invoke('verify:run'),

  tunnelStatus: () => ipcRenderer.invoke('tunnel:status'),
  tunnelInstall: () => ipcRenderer.invoke('tunnel:install'),
  tunnelSetup: (opts) => ipcRenderer.invoke('tunnel:setup', opts),
  tunnelCancel: () => ipcRenderer.invoke('tunnel:cancel'),
  tunnelDelete: (name) => ipcRenderer.invoke('tunnel:delete', name),
  onTunnelStep: (cb) => on('tunnel-step', cb),

  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (payload) => ipcRenderer.invoke('config:save', payload),
  pickFolder: (current) => ipcRenderer.invoke('dialog:pickFolder', current),

  getLogs: (proc, afterId, filter) => ipcRenderer.invoke('logs:get', { proc, afterId, filter }),
  exportLogs: (proc) => ipcRenderer.invoke('logs:export', proc),

  openLink: (which) => ipcRenderer.invoke('open:link', which),
});
