'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['overlay:state', 'profile:update', 'game:update', 'history:update', 'toast', 'roblox:present', 'settings:update', 'accounts:update']);
const CALLS = new Set([
  'app:init',
  'overlay:close',
  'overlay:passive',
  'store:set',
  'notes:save',
  'api',
  'roblox:launch',
  'clipboard:write',
  'open:external',
  'auth:signin',
  'auth:signout',
  'accounts:add',
  'accounts:remove',
  'accounts:refresh',
  'settings:multi-instance',
  'hotkey:set',
  'hotkey:suspend',
  'settings:login-item',
  'app:quit',
]);

contextBridge.exposeInMainWorld('visor', {
  on(channel, cb) {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event ${channel}`);
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  call(channel, ...args) {
    if (!CALLS.has(channel)) return Promise.reject(new Error(`Unknown call ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
});
