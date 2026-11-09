'use strict';
/** compat.js 安全性测试：只读检测不杀进程 */
const { test, assert, summary } = require('./lib');
const compat = require('../main/core/compat');

async function run() {
  console.log('—— 第三方软件兼容');

  await test('INJECTORS 常量为已知搜狗附加组件', () => {
    assert.deepEqual(compat.INJECTORS, ['SGTool.exe', 'SogouCloud.exe', 'SOGOUSmartAssistant.exe']);
  });

  await test('findInjectors 只读检测不抛错、返回字符串数组', () => {
    const r = compat.findInjectors();
    assert.ok(Array.isArray(r));
    for (const n of r) assert.ok(compat.INJECTORS.includes(n), `未知进程名: ${n}`);
  });

  summary();
}

run();
