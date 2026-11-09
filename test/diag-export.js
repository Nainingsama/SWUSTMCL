'use strict';
/** 诊断：用真实数据跑 exportPlan，定位 0 文件问题（stub electron） */
const Module = require('module');
const fs = require('fs');
const path = require('path');

// electron stub
const electronStub = {
  app: { getPath: () => 'D:\\SWUSTMCL\\userdata', isPackaged: true, getVersion: () => '1.0.0' },
  shell: { trashItem: async () => {} },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const cfg = JSON.parse(fs.readFileSync('D:/SWUSTMCL/userdata/swustmcl-config.json', 'utf8'));
console.log('mcDir:', cfg.mcDir);
console.log('extraDirs:', JSON.stringify(cfg.extraDirs));

const roots = [cfg.mcDir, ...(cfg.extraDirs || [])];
let instDir = null;
let instId = 'SWUSTMC-特供包';
for (const r of roots) {
  const v = path.join(r, 'versions');
  try {
    for (const d of fs.readdirSync(v)) {
      if (d.includes('特供包') || d.includes('1.21.10')) {
        instDir = path.join(v, d);
        instId = d;
        let mods = 0;
        try {
          mods = fs.readdirSync(path.join(instDir, 'mods')).filter((f) => /\.jar$/i.test(f)).length;
        } catch {}
        console.log('FOUND:', instDir, '| mods:', mods);
      }
    }
  } catch {}
}

if (!instDir) {
  console.log('INSTANCE NOT FOUND — 列出所有 versions：');
  for (const r of roots) {
    try {
      console.log(' ', path.join(r, 'versions'), '→', fs.readdirSync(path.join(r, 'versions')).join(', '));
    } catch {}
  }
  process.exit(0);
}

const mp = require('../main/core/modpack.js');
const plan = mp.exportPlan(path.dirname(instDir), instId, path.dirname(instDir));
console.log('PLAN files:', plan.files.length, '| bytes:', plan.totalBytes, '| loader:', plan.loader, plan.loaderVersion, '| mc:', plan.mcVersion);
console.log('前5个文件:', plan.files.slice(0, 5).map((f) => f.path).join(' | '));
