'use strict';
/** 诊断2：模拟 dirs.all() 的发现链路，找到 PCL 实例真实路径并跑 exportPlan */
const Module = require('module');
const path = require('path');
const fs = require('fs');

const electronStub = {
  app: { getPath: () => 'D:\\SWUSTMCL\\userdata', isPackaged: true, getVersion: () => '1.0.0' },
  shell: { trashItem: async () => {} },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const dirsLib = require('../main/core/dirs.js');
const settings = { mcDir: 'C:\\Users\\blj\\AppData\\Roaming\\.minecraft', extraDirs: [] };
const all = dirsLib.all(settings);
console.log('dirs.all() 结果:');
for (const d of all) console.log(' ', d.kind.padEnd(8), d.path);

const target = all.find((d) => d.kind === 'PCL' || d.kind === 'HMCL');
if (!target) {
  console.log('没有发现 PCL/HMCL 目录');
  process.exit(0);
}
const versionsRoot = path.join(target.path, 'versions');
console.log('\nPCL versions:', fs.readdirSync(versionsRoot).join(', '));

const mp = require('../main/core/modpack.js');
for (const id of fs.readdirSync(versionsRoot)) {
  try {
    const plan = mp.exportPlan(settings.mcDir, id, target.path);
    console.log(`PLAN [${id}]: files=${plan.files.length} bytes=${plan.totalBytes} loader=${plan.loader} ${plan.loaderVersion} mc=${plan.mcVersion}`);
    if (id === 'SWUSTMC-特供包') {
      console.log('  样例:', plan.files.slice(0, 4).map((f) => f.path).join(' | '));
    }
  } catch (e) {
    console.log(`PLAN [${id}]: ERROR ${e.message}`);
  }
}
