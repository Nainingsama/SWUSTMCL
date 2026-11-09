'use strict';
/** 诊断5：直接调用 fetchSkinTexture（stub electron）验证默认皮肤兜底 */
const Module = require('module');
const orig = Module._load;
Module._load = function (r, p, m) {
  if (r === 'electron') {
    return {
      app: { getPath: () => 'D:\\SWUSTMCL\\userdata', isPackaged: true, getVersion: () => '1.0.0' },
      safeStorage: { isEncryptionAvailable: () => false, encryptString: (x) => Buffer.from(x), decryptString: (x) => x.toString() },
      shell: { trashItem: async () => {} },
      nativeImage: { createFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize: () => ({ getBitmap: () => Buffer.alloc(0) }) }) },
      net: { fetch: () => Promise.reject(new Error('no net via electron')) },
      clipboard: { writeText() {} },
      protocol: { registerSchemesAsPrivileged() {}, handle() {} },
      dialog: {}, Notification: class {}, BrowserWindow: class {}, ipcMain: { handle() {}, on() {} },
    };
  }
  return orig.call(this, r, p, m);
};

const account = require('../main/core/account.js');

(async () => {
  console.log('--- 离线 Steve（应有默认皮肤兜底）');
  const r1 = await account.fetchSkinTexture('offline-test-uuid', 'Steve');
  console.log('result:', JSON.stringify({ file: r1.file, cached: r1.cached, dataUrlLen: r1.dataUrl ? r1.dataUrl.length : 0 }));
  const fs = require('fs');
  if (r1.file && fs.existsSync(r1.file)) {
    const b = fs.readFileSync(r1.file);
    console.log('PNG 尺寸:', b.readUInt32BE(16) + 'x' + b.readUInt32BE(20), '| bytes:', b.length);
  }
  console.log('--- 正版同名查询（Notch，可能网络失败）');
  const r2 = await account.fetchSkinTexture('offline-notch', 'Notch');
  console.log('result:', JSON.stringify({ file: r2.file, dataUrlLen: r2.dataUrl ? r2.dataUrl.length : 0 }));
  process.exit(0);
})();
