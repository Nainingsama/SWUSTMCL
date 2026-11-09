'use strict';
/** 诊断11：fabric/forge 版本列表竞速实测（含耗时） */
const Module = require('module');
const orig = Module._load;
Module._load = function (r, p, m) { if (r === 'electron') return { app: { getPath: () => 'D:\\SWUSTMCL\\userdata' } }; return orig.call(this, r, p, m); };
const loaders = require('../main/core/loaders.js');
(async () => {
  for (const [ld, mc] of [['fabric', '26.3'], ['forge', '26.3'], ['fabric', '1.21.10']]) {
    const t = Date.now();
    try {
      const list = await loaders.listLoaderVersions(ld, mc);
      console.log(`${ld} ${mc}: ${list.length} 个 | ${Date.now() - t}ms | 前3: ${list.slice(0, 3).map((x) => x.version).join(', ')}`);
    } catch (e) {
      console.log(`${ld} ${mc}: FAIL ${e.message} | ${Date.now() - t}ms`);
    }
  }
  process.exit(0);
})();
