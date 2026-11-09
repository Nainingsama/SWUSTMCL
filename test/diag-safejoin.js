'use strict';
/** 诊断3：safeJoin 对中文路径的处理 */
const path = require('path');
const fs = require('fs');
const safe = require('../main/core/safe.js');

const base = 'D:\\我的世界（PCL2）\\.minecraft';
const dir = safe.safeJoin(base, 'SWUSTMC-特供包');
console.log('safeJoin 结果:', dir);
const modsDir = path.join(dir, 'mods');
console.log('mods 存在:', fs.existsSync(modsDir));
if (fs.existsSync(modsDir)) {
  console.log('mods 数量:', fs.readdirSync(modsDir).filter((f) => /\.jar$/i.test(f)).length);
}
console.log('withinDir:', safe.withinDir(base, modsDir));
console.log('realish(mods):', safe.realish(modsDir));
console.log('realish(base):', safe.realish(base));
