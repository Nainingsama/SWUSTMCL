'use strict';
/** 诊断9：直接跑 exportPack 检查 zip 产物（stub electron） */
const Module = require('module');
const orig = Module._load;
Module._load = function (r, p, m) {
  if (r === 'electron') return { app: { getPath: () => 'D:\\SWUSTMCL\\userdata' }, shell: { trashItem: async () => {} } };
  return orig.call(this, r, p, m);
};
const fs = require('fs');
const path = require('path');
const mp = require('../main/core/modpack.js');

const mcDir = 'C:\\Users\\blj\\AppData\\Roaming\\.minecraft';
const dir = 'D:\\我的世界（PCL2）\\.minecraft';
const id = 'SWUSTMC-特供包';
const dest = path.join('D:\\luncher\\SMCL\\test\\.tmp', 'export-test.zip');

(async () => {
  const plan = mp.exportPlan(mcDir, id, dir);
  console.log('plan files:', plan.files.length, '| plan.dir:', plan.dir);
  const r = await mp.exportPack(mcDir, id, dest, null, dir);
  console.log('exportPack result count:', r.count);
  const z = new (require('adm-zip'))(dest);
  console.log('zip 条目数:', z.getEntries().length);
  console.log('zip 大小:', (fs.statSync(dest).size / 1048576).toFixed(1), 'MB');
  console.log('前5条:', z.getEntries().slice(0, 5).map((e) => e.entryName).join(' | '));
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
