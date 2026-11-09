'use strict';
/** 诊断4：真实 mods 目录的元数据与图标提取效果（stub electron） */
const Module = require('module');
const orig = Module._load;
Module._load = function (r, p, m) {
  if (r === 'electron') return { app: { getPath: () => 'D:\\SWUSTMCL\\userdata' }, shell: { trashItem: async () => {} } };
  return orig.call(this, r, p, m);
};

const instances = require('../main/core/instances.js');

const instDir = 'D:\\我的世界（PCL2）\\.minecraft\\versions\\SWUSTMC-特供包';

(async () => {
  const mods = await instances.listMods(instDir);
  console.log('总数:', mods.length);
  let withIcon = 0;
  let withName = 0;
  for (const m of mods.slice(0, 14)) {
    if (m.icon) withIcon++;
    if (m.modName) withName++;
    console.log(
      `- ${m.enabled ? '✓' : '✗'} ${m.modName || m.name} | v=${m.version || '-'} | by=${m.authors || '-'} | icon=${m.icon ? '有(' + m.icon.length + 'B)' : '无'}`
    );
  }
  console.log(`\n统计：${mods.length} 个 · 有名称 ${withName} · 有图标 ${withIcon}`);
})();
