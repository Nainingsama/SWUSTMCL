'use strict';
/** 诊断10：导出 → 导入（inspect）全链路复现（stub electron） */
const Module = require('module');
const orig = Module._load;
Module._load = function (r, p, m) {
  if (r === 'electron') return { app: { getPath: () => 'D:\\SWUSTMCL\\userdata' }, shell: { trashItem: async () => {} } };
  return orig.call(this, r, p, m);
};
const fs = require('fs');
const path = require('path');
const mp = require('../main/core/modpack.js');

const dir = 'D:\\我的世界（PCL2）\\.minecraft';
const id = '111';
const dest = path.join('D:\\luncher\\SMCL\\test\\.tmp', 'roundtrip.zip');

(async () => {
  const plan = mp.exportPlan(dir, id, dir);
  console.log('plan files:', plan.files.length, '| 样例:', plan.files.slice(0, 3).map((f) => f.path).join(' | '));
  const r = await mp.exportPack(dir, id, dest, null, dir);
  console.log('export count:', r.count, '| zip size:', (fs.statSync(dest).size / 1048576).toFixed(1), 'MB');

  // inspect 自己导出的包
  try {
    const info = mp.inspect(dest);
    console.log('inspect OK:', JSON.stringify({ format: info.format, name: info.name, mc: info.mcVersion, loader: info.loader, mods: info.modCount }));
  } catch (e) {
    console.error('inspect FAIL:', e.message);
    // 列出 zip 根结构帮助定位
    const AdmZip = require('adm-zip');
    const z = new AdmZip(dest);
    console.log('zip 根条目:', z.getEntries().slice(0, 8).map((e) => e.entryName).join(' | '));
  }
  process.exit(0);
})().catch((e) => { console.error('OUTER FAIL:', e.stack || e.message); process.exit(1); });
