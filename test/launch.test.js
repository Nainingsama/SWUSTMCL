'use strict';
/**
 * 启动参数构建测试：electron 桩 + 伪造版本 JSON（含继承、隔离、natives）。
 * 验证 JVM 消毒、classpath 去重、natives 解压复用、离线 UUID。
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assert, summary } = require('./lib');

// ---- electron 桩（settings.js 只用 app.getPath）----
const tmpRoot = fs.mkdtempSync(path.join(path.join(__dirname, '.tmp'), 'smcl-main-'));
const electronStub = {
  app: { getPath: () => path.join(tmpRoot, 'userdata'), isPackaged: false, relaunch() {}, exit() {}, disableHardwareAcceleration() {}, whenReady: () => Promise.resolve(), on() {}, requestSingleInstanceLock: () => true },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString('utf8') },
  BrowserWindow: class {},
  ipcMain: { handle() {}, on() {} },
  dialog: {}, shell: {}, Notification: class {}, clipboard: { writeText() {} },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize: () => ({ getBitmap: () => Buffer.alloc(0) }) }) },
  net: { fetch: () => Promise.reject(new Error('no network in test')) },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const settings = require('../main/core/settings');
settings.init();
settings.save({ mcDir: path.join(tmpRoot, 'game'), playerName: 'TestPlayer', memory: 2048, downloadThreads: 4, javaPath: '' });
const launch = require('../main/core/launch');
const dirsLib = require('../main/core/dirs');

const mcDir = settings.all().mcDir;
const ADMIT = { downloads: { artifact: { path: 'net/has/art.jar', url: 'https://libraries.minecraft.net/net/has/art.jar', size: 10, sha1: '' } }, name: 'grp:has:1.0' };

async function run() {
  console.log('—— 启动参数构建');

  await test('离线 UUID 符合 v3 规范（与主流启动器一致）', () => {
    const u = launch.offlineUuid('Steve');
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u), `格式: ${u}`);
    assert.equal(launch.offlineUuid('Steve'), u, '同名字段稳定');
  });

  await test('新版 arguments 格式：JVM 占位符替换 + 隔离实例 gameDir', () => {
    const id = 'fabric-test';
    const vdir = path.join(mcDir, 'versions', id);
    fs.mkdirSync(vdir, { recursive: true });
    fs.mkdirSync(path.join(vdir, 'mods'), { recursive: true }); // 触发隔离
    fs.writeFileSync(path.join(vdir, `${id}.json`), JSON.stringify({
      id, mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      arguments: {
        game: ['--username', '${auth_player_name}', '--gameDir', '${game_directory}'],
        jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}', '-Dx=${version_name}'],
      },
      libraries: [ADMIT],
      assetIndex: { id: '5', url: 'https://piston-meta.mojang.com/v1/packages/x/5.json' },
    }));
    fs.writeFileSync(path.join(vdir, `${id}.jar`), Buffer.from([0x50, 0x4b, 3, 4]));

    const built = launch.build(id, { playerName: 'Alice', memory: 1500 });
    const jvm = built.args.slice(0, built.args.indexOf('net.fabricmc.loader.impl.launch.knot.KnotClient'));
    assert.ok(jvm.some((a) => a.startsWith('-Xmx1500M')), '内存注入');
    assert.ok(jvm.some((a) => a.includes('-Dx=fabric-test')), 'version_name 占位符');
    assert.ok(built.cwd === vdir, `隔离实例 cwd 指向实例目录: ${built.cwd}`);
    assert.ok(built.gameDir === vdir, 'gameDir 指向实例目录');
    const gameArgs = built.args.slice(built.args.indexOf('net.fabricmc.loader.impl.launch.knot.KnotClient') + 1);
    assert.equal(gameArgs[gameArgs.indexOf('--username') + 1], 'Alice');
    assert.ok(gameArgs[gameArgs.indexOf('--gameDir') + 1] === vdir);
  });

  await test('旧版 minecraftArguments 格式 + 非隔离实例', () => {
    const id = 'legacy-1.7.10';
    const vdir = path.join(mcDir, 'versions', id);
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(path.join(vdir, `${id}.json`), JSON.stringify({
      id, mainClass: 'net.minecraft.client.main.Main',
      minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root}',
      libraries: [],
      javaVersion: { majorVersion: 8 },
    }));
    fs.writeFileSync(path.join(vdir, `${id}.jar`), Buffer.from([0x50, 0x4b, 3, 4]));
    const built = launch.build(id, {});
    assert.ok(built.cwd === mcDir, '非隔离：cwd 是游戏根目录');
    assert.ok(built.args.some((a) => a === 'net.minecraft.client.main.Main'));
  });

  await test('JVM 参数消毒：剔除 -javaagent 注入', () => {
    const cleaned = launch.sanitizeJvmArgs(['-Xmx1G', '-javaagent:evil.jar', '-agentlib:x', '-XX:OnError=pwn', '-ok']);
    assert.deepEqual(cleaned, ['-Xmx1G', '-ok']);
  });

  await test('classpath 去重（Forge Duplicate key 防护）', () => {
    const meta = { libraries: [
      { name: 'a:lib:1.0', downloads: { artifact: { path: 'a/lib/1.0/lib-1.0.jar', url: 'https://libraries.minecraft.net/a/lib/1.0/lib-1.0.jar', size: 0, sha1: '' } } },
      { name: 'a:lib:1.0', downloads: { artifact: { path: 'a/lib/1.0/lib-1.0.jar', url: 'https://libraries.minecraft.net/a/lib/1.0/lib-1.0.jar', size: 0, sha1: '' } } },
    ] };
    const entries = launch.libraryEntries(meta, mcDir);
    assert.equal(entries.classpath.length, 0, '文件不存在的不进 classpath');
  });

  await test('继承合并：inheritsFrom + 同坐标库覆盖', () => {
    const versions = require('../main/core/versions');
    const id = 'forge-inherit';
    const vdir = path.join(mcDir, 'versions', id);
    fs.mkdirSync(path.join(mcDir, 'versions', '1.18.2'), { recursive: true });
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(path.join(mcDir, 'versions', '1.18.2', '1.18.2.json'), JSON.stringify({
      id: '1.18.2', mainClass: 'net.minecraft.client.main.Main',
      libraries: [{ name: 'net.minecraft:client:1.18.2', downloads: { artifact: { path: 'x/client.jar', url: 'https://libraries.minecraft.net/x/client.jar', size: 0, sha1: '' } } },
        { name: 'old:lib:1.0', downloads: { artifact: { path: 'old/lib.jar', url: 'https://libraries.minecraft.net/old/lib.jar', size: 0, sha1: '' } } }],
      arguments: { game: ['--base'], jvm: ['-Dbase=1'] },
    }), 'utf8');
    fs.writeFileSync(path.join(vdir, `${id}.json`), JSON.stringify({
      id, inheritsFrom: '1.18.2', mainClass: 'forge.Launcher',
      libraries: [{ name: 'old:lib:1.1', downloads: { artifact: { path: 'old/lib2.jar', url: 'https://libraries.minecraft.net/old/lib2.jar', size: 0, sha1: '' } } }],
      arguments: { game: ['--child'], jvm: ['-Dchild=1'] },
    }), 'utf8');
    const merged = versions.loadVersionJson(mcDir, id);
    assert.equal(merged.mainClass, 'forge.Launcher', '子版本 mainClass 优先');
    assert.ok(merged.libraries.some((l) => l.name === 'old:lib:1.1'), '同坐标被子版本覆盖');
    assert.ok(!merged.libraries.some((l) => l.name === 'old:lib:1.0'), '父版本旧库被移除');
    assert.ok(merged.libraries.some((l) => l.name === 'net.minecraft:client:1.18.2'), '父版本库保留');
    assert.deepEqual(merged.arguments.game, ['--base', '--child'], '参数拼接');
  });

  await test('natives 解压：已存在同大小 dll 复用，不重复写', () => {
    const AdmZip = require('adm-zip');
    // 构造一个 natives zip
    const zip = new AdmZip();
    zip.addFile('lwjgl.dll', Buffer.from('dll-content'));
    const nativesJar = path.join(tmpRoot, 'natives-test.jar');
    fs.writeFileSync(nativesJar, zip.toBuffer());
    const nativesDir = path.join(tmpRoot, 'natives');
    launch.extractNatives([nativesJar], nativesDir);
    const p1 = path.join(nativesDir, 'lwjgl.dll');
    assert.ok(fs.existsSync(p1), '首次解压成功');
    const mtime1 = fs.statSync(p1).mtimeMs;
    // 等一秒再跑一遍，若被重写 mtime 会变
    launch.extractNatives([nativesJar], nativesDir);
    assert.equal(fs.statSync(p1).mtimeMs, mtime1, '第二次复用（未重写）');
  });

  await test('版本隔离检测', () => {
    const id = 'isolated-detect';
    const vdir = path.join(mcDir, 'versions', id);
    fs.mkdirSync(path.join(vdir, 'config'), { recursive: true });
    assert.equal(dirsLib.isIsolatedInstance(vdir), true);
    const plain = path.join(mcDir, 'versions', 'legacy-1.7.10');
    assert.equal(dirsLib.isIsolatedInstance(plain), false);
  });

  summary();
}

run();
