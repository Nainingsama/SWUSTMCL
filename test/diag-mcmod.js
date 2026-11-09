'use strict';
/** 诊断8：MC百科 译名桥接实测（真实网络，无 electron 依赖） */
const c = require('../main/core/content.js');
(async () => {
  console.log('查询：鼠标手势');
  const r = await c.chineseAlias('鼠标手势');
  console.log('候选数:', r.length);
  r.forEach((x) => console.log(` - [${x.mcmodId}] ${x.zh} → ${x.en}`));
  if (!r.length) console.log('（无候选 —— 检查网络/解析）');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
