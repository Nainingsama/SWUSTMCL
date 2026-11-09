'use strict';
/** 诊断7：fabric 双通道实测 */
const Module = require('module');
const orig = Module._load;
Module._load = function (r, p, m) {
  if (r === 'electron') return { app: { getPath: () => 'D:\\SWUSTMCL\\userdata' } };
  return orig.call(this, r, p, m);
};
const loaders = require('../main/core/loaders.js');
(async () => {
  const list = await loaders.listLoaderVersions('fabric', '1.21.10');
  console.log('fabric 1.21.10 版本数:', list.length, '| 前3:', list.slice(0, 3).map((x) => x.version + (x.stable ? '' : '(测试)')).join(', '));
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
