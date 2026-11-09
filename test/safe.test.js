'use strict';
/** safe.js 安全边界测试：版本名 / 目录穿越 / URL 白名单 / zip 条目 */
const { test, assert, summary } = require('./lib');
const safe = require('../main/core/safe');

async function run() {
  console.log('—— 安全边界');

  await test('版本名校验：合法输入放行', () => {
    assert.equal(safe.assertVersionId('1.21.2'), '1.21.2');
    assert.equal(safe.assertVersionId('fabric-loader-0.20.1-1.21.1'), 'fabric-loader-0.20.1-1.21.1');
    assert.equal(safe.assertVersionId('整合包 实例 (2)'), '整合包 实例 (2)');
  });

  await test('版本名校验：穿越与非法字符拦截', () => {
    assert.throws(() => safe.assertVersionId('../../etc'), /非法字符/);
    assert.throws(() => safe.assertVersionId('a/b'), /非法字符/);
    assert.throws(() => safe.assertVersionId('a\\b'), /非法字符/);
    assert.throws(() => safe.assertVersionId('..'), /非法$/);
    assert.throws(() => safe.assertVersionId('con'), /保留/);
    assert.throws(() => safe.assertVersionId('COM1'), /保留/);
    assert.throws(() => safe.assertVersionId('.hidden'), /点或空格/);
    assert.throws(() => safe.assertVersionId('bad*name'), /非法字符/);
  });

  await test('safeJoin：拒绝目录穿越', () => {
    const base = 'C:\\fake\\root';
    assert.throws(() => safe.safeJoin(base, '..', '..'), /穿越|超出/);
    assert.throws(() => safe.safeJoin(base, 'a/../../b'), /穿越/);
    assert.throws(() => safe.safeJoin(base, 'C:\\Windows\\evil'), /绝对路径/);
    assert.throws(() => safe.safeJoin(base, 'a\\b\\..\\..\\..\\c'), /穿越|超出/);
    const ok = safe.safeJoin(base, 'a/b/c.txt');
    assert.ok(ok.includes('a') && ok.includes('c.txt'), '正常拼接放行');
  });

  await test('safeEntryName：zip 条目', () => {
    assert.equal(safe.safeEntryName('mods/test.jar'), 'mods/test.jar');
    assert.equal(safe.safeEntryName('a\\b.txt'), 'a/b.txt');
    assert.equal(safe.safeEntryName('../evil.jar'), null);
    assert.equal(safe.safeEntryName('/abs.jar'), null);
    assert.equal(safe.safeEntryName('C:/evil.jar'), null);
    assert.equal(safe.safeEntryName('ok/../../evil.jar'), null);
  });

  await test('URL 白名单', () => {
    assert.ok(safe.isHttpUrl('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', safe.GAME_HOSTS));
    assert.ok(safe.isHttpUrl('https://bmclapi2.bangbang93.com/maven/x.jar', safe.GAME_HOSTS));
    assert.ok(safe.isHttpUrl('https://meta.fabricmc.net/v2/versions/loader/1.21', safe.GAME_HOSTS), 'fabricmc.net 后缀匹配');
    assert.ok(!safe.isHttpUrl('http://evil.example.com/x', safe.GAME_HOSTS));
    assert.ok(!safe.isHttpUrl('file:///C:/Windows', safe.GAME_HOSTS));
    assert.ok(!safe.isHttpUrl('javascript:alert(1)', safe.GAME_HOSTS));
    assert.ok(!safe.isHttpUrl('https://evil.mojar.com/x', safe.GAME_HOSTS), '非后缀匹配不通过');
  });

  await test('withinDir 前缀不误判', () => {
    assert.ok(safe.withinDir('C:\\a\\b', 'C:\\a\\b\\c'));
    assert.ok(safe.withinDir('C:\\a\\b', 'C:\\a\\b'));
    assert.ok(!safe.withinDir('C:\\a\\b', 'C:\\a\\bc')); // 前缀相同但不是子目录
    assert.ok(!safe.withinDir('C:\\a\\b', 'D:\\a\\b'));
  });

  summary();
}

run();
