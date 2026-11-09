'use strict';
/** 诊断6：stub electron 完整加载 main.js，检查主进程是否卡死/抛错 */
const Module = require('module');
const path = require('path');

const stubBrowserWindow = class BrowserWindow {
  constructor() {
    this.webContents = {
      on() {}, once() {}, openDevTools() {}, send() {}, executeJavaScript: async () => null, capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
    };
  }
  loadFile() { return Promise.resolve(); }
  on() {} once() {} show() {} close() {} destroy() {}
  isMinimized() { return false; } maximize() {} unmaximize() {} isDestroyed() { return false; }
  setWindowOpenHandler() {} setMenuBarVisibility() {}
};
const electronStub = {
  app: Object.assign({
    getPath: (k) => (k === 'exe' ? 'D:\\SWUSTMCL\\SWUSTMCL.exe' : 'D:\\SWUSTMCL\\userdata'),
    isPackaged: true,
    getVersion: () => '1.0.0',
    relaunch() {}, exit() {}, disableHardwareAcceleration() {},
    whenReady: () => Promise.resolve(),
    on() {}, requestSingleInstanceLock: () => true,
    setPath() {},
  }),
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
  BrowserWindow: stubBrowserWindow,
  ipcMain: { handle() {}, on() {} },
  dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 1 }) },
  shell: { openPath: async () => '', openExternal: async () => {}, trashItem: async () => {} },
  Notification: class { on() {} show() {} static isSupported() { return false; } },
  clipboard: { writeText() {}, readText: () => '' },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize: () => ({ getBitmap: () => Buffer.alloc(0) }) }) },
  net: { fetch: () => Promise.reject(new Error('electron net off')) },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

console.log('[diag] loading main.js …');
const t0 = Date.now();
try {
  require('../main/main.js');
  console.log(`[diag] main.js 顶层加载完成（${Date.now() - t0}ms）`);
} catch (e) {
  console.error('[diag] 主进程加载抛错:', e.stack || e.message);
  process.exit(1);
}

let alive = true;
setTimeout(() => { console.log('[diag] 3 秒后事件循环存活:', alive); }, 3000);
setTimeout(() => {
  console.log(alive ? '[diag] 主进程 6 秒无卡死 ✓' : '[diag] 主进程卡死 ✗');
  process.exit(alive ? 0 : 2);
}, 6000);
setInterval(() => { alive = alive && true; }, 100);
