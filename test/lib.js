'use strict';
/**
 * 测试工具：极小的断言库。
 */
const passed = [];
const failed = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed.push(name);
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed.push({ name, error: e });
      console.error(`  ✗ ${name}`);
      console.error(`    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
assert.ok = assert;
assert.deepEqual = (a, b, msg) => {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg || 'deepEqual'}: 期望 ${jb}，实际 ${ja}`);
};
assert.equal = (a, b, msg) => {
  const show = (v) => typeof v === 'bigint' ? `${v}n` : JSON.stringify(v);
  if (a !== b) throw new Error(`${msg || 'equal'}: 期望 ${show(b)}，实际 ${show(a)}`);
};
assert.throws = (fn, match) => {
  try {
    fn();
  } catch (e) {
    if (match && !match.test(e.message)) throw new Error(`错误信息不匹配: ${e.message}`);
    return;
  }
  throw new Error('期望抛出异常但没有');
};

module.exports = { test, assert, summary };

function summary() {
  console.log(`\n通过 ${passed.length} 项，失败 ${failed.length} 项`);
  if (failed.length) process.exit(1);
}
