const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  flushSpooler: () => ipcRenderer.invoke('flush-spooler'),
  getSpoolerAudit: () => ipcRenderer.invoke('get-spooler-audit'),
  printJob: (jobData) => ipcRenderer.invoke('print-job', jobData),
  previewJob: (data) => ipcRenderer.invoke('preview-job', data),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  onJobEvent: (callback) => {
    ipcRenderer.on('job-event', (event, data) => callback(data));
  }
});
