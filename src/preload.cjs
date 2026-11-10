const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The renderer can only reach these named operations.
const channels = new Set([
  'state:get',
  'local:browse',
  'local:choose',
  'browser:preferences',
  'devices:refresh',
  'pair:start',
  'pair:approve',
  'pair:reject',
  'trust:remove',
  'shares:add',
  'shares:write',
  'shares:remove',
  'shares:reveal',
  'remote:browse',
  'transfer:between',
  'transfer:send',
  'transfer:cancel',
  'transfer:clear',
  'settings:name',
  'settings:open',
  'network:settings',
]);

contextBridge.exposeInMainWorld('nearlink', {
  platform: process.platform,
  invoke(channel, ...args) {
    if (!channels.has(channel)) throw new Error('Unknown operation.');
    return ipcRenderer.invoke(channel, ...args);
  },
  dropFiles(files, target) {
    const paths = Array.from(files, file => webUtils.getPathForFile(file));
    if (!paths.length || paths.some(p => !p)) throw new Error('Drop files or folders from Finder or Windows Explorer.');
    return ipcRenderer.invoke('transfer:drop', paths, target);
  },
  onState(callback) {
    const listener = (_, state) => callback(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
});
