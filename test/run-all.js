'use strict';
/** 测试汇总入口：npm test */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true }); // 各测试的临时根目录

const tests = ['nbt.test.js', 'safe.test.js', 'net.test.js', 'launch.test.js', 'compat.test.js'];
let failed = 0;

for (const t of tests) {
  console.log(`\n▶ ${t}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
}

console.log(`\n======== ${tests.length - failed}/${tests.length} 个测试文件通过 ========`);
process.exit(failed ? 1 : 0);
