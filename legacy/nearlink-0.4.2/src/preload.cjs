const { contextBridge, ipcRenderer, webUtils } = require('electron');
const channels = new Set(['state:get', 'browser:preferences', 'local:browse', 'local:choose', 'transfer:between', 'devices:refresh', 'settings:theme', 'settings:name', 'shares:add', 'shares:write', 'shares:remove', 'trust:remove', 'pair:start', 'pair:approve', 'pair:reject', 'remote:browse', 'transfer:send', 'transfer:receive', 'transfer:cancel', 'settings:open', 'network:settings']);
contextBridge.exposeInMainWorld('nearlink', {
  invoke(channel, ...args) { if (!channels.has(channel)) throw new Error('Unknown operation.'); return ipcRenderer.invoke(channel, ...args); },
  dropFiles(files, target) {
    const paths = Array.from(files, file => webUtils.getPathForFile(file));
    if (!paths.length || paths.some(p => !p)) throw new Error('Drop files or folders from Finder or Windows Explorer.');
    return ipcRenderer.invoke('transfer:drop', paths, target);
  },
  onState(callback) { const listener = (_, state) => callback(state); ipcRenderer.on('state', listener); return () => ipcRenderer.removeListener('state', listener); }
});
