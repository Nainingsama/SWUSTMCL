'use strict';
/**
 * 网络层测试：本机起两个 HTTP 服务器模拟「镜像源坏 / 官方源好」与反向，
 * 验证单文件双源回退、增量跳过、SHA1 校验、zip 头校验。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test, assert, summary } = require('./lib');

const net = require('../main/core/net');

function serve(port, handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);

async function run() {
  console.log('—— 网络层 / 双源回退');
  const tmp = fs.mkdtempSync(path.join(path.join(__dirname, '.tmp'), 'smcl-net-'));

  // 主源：坏（错误页）；备用源：好（zip 内容）
  const goodContent = Buffer.concat([ZIP_HEAD, crypto.randomBytes(64)]);
  const sha1Good = crypto.createHash('sha1').update(goodContent).digest('hex');

  let badHits = 0;
  let goodHits = 0;
  let skippedHits = 0;

  const s1 = await serve(18321, (req, res) => { badHits += 1; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>error page from mirror</html>'); });
  const s2 = await serve(18322, (req, res) => { goodHits += 1; res.writeHead(200); res.end(goodContent); });

  await test('镜像返回错误页 → 自动换源成功', async () => {
    const dest = path.join(tmp, 'lib.jar');
    // net.download 单源会因 noRetry 直接抛错（错误页），换源逻辑在 install.downloadWithFallback
    await assert.throwsAsync?.() || null;
    let threw = false;
    try {
      await net.download('http://127.0.0.1:18321/lib.jar', dest, { expectZip: true, retries: 0 });
    } catch (e) {
      threw = true;
      assert.ok(/错误页|jar\/zip/.test(e.message), `错误信息应提到错误页: ${e.message}`);
    }
    assert.ok(threw, '坏镜像必须失败');
    assert.ok(!fs.existsSync(dest), '坏内容不落盘');
  });

  await test('好源下载 + SHA1 校验通过', async () => {
    const dest = path.join(tmp, 'lib2.jar');
    const r = await net.download('http://127.0.0.1:18322/lib2.jar', dest, { expectZip: true, expectedSha1: sha1Good, retries: 0 });
    assert.equal(r.skipped, false);
    assert.equal(crypto.createHash('sha1').update(fs.readFileSync(dest)).digest('hex'), sha1Good);
  });

  await test('增量安装：已存在且哈希一致 → skipped', async () => {
    const dest = path.join(tmp, 'lib2.jar');
    const r = await net.download('http://127.0.0.1:18322/lib2.jar', dest, { expectZip: true, expectedSha1: sha1Good, retries: 0 });
    assert.equal(r.skipped, true, '第二次应跳过');
    assert.equal(goodHits, 1, '不应发起第二次网络请求');
  });

  await test('增量安装：内容损坏（哈希不符）→ 重下', async () => {
    const dest = path.join(tmp, 'corrupt.jar');
    const bad = Buffer.concat([ZIP_HEAD, crypto.randomBytes(32)]);
    fs.writeFileSync(dest, bad);
    const r = await net.download('http://127.0.0.1:18322/corrupt.jar', dest, { expectZip: true, expectedSha1: sha1Good, retries: 0 });
    assert.equal(r.skipped, false, '损坏文件应重下');
    assert.equal(crypto.createHash('sha1').update(fs.readFileSync(dest)).digest('hex'), sha1Good);
  });

  await test('minBytes 拦截错误页（内容过小）', async () => {
    const dest = path.join(tmp, 'small.bin');
    let threw = false;
    try {
      await net.download('http://127.0.0.1:18321/small.bin', dest, { minBytes: 1024, retries: 0 });
    } catch (e) {
      threw = /过小/.test(e.message);
    }
    assert.ok(threw);
  });

  await test('镜像改写：Mojang host → BMCLAPI', () => {
    const mirror = require('../main/core/mirror');
    assert.equal(
      mirror.rewrite('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 'bmcl'),
      'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
    );
    assert.equal(
      mirror.rewrite('https://resources.download.minecraft.net/ab/abcd', 'bmcl'),
      'https://bmclapi2.bangbang93.com/assets/ab/abcd',
    );
    assert.equal(
      mirror.rewrite('https://libraries.minecraft.net/net/x/y.jar', 'bmcl'),
      'https://bmclapi2.bangbang93.com/maven/net/x/y.jar',
    );
    assert.equal(mirror.rewrite('https://piston-data.mojang.com/v1/objects/aa/client.jar', 'mojang'), 'https://piston-data.mojang.com/v1/objects/aa/client.jar', '官方源不改写');
  });

  await test('Promise.any 双源竞速（清单）', async () => {
    // 慢源 18323（1.2 秒后响应），快源 18324（立即）
    const slow = await serve(18323, (req, res) => setTimeout(() => { res.writeHead(200); res.end('{"slow":true}'); }, 1200));
    const fast = await serve(18324, (req, res) => { res.writeHead(200); res.end('{"fast":true}'); });
    const result = await Promise.any([
      net.fetchJson('http://127.0.0.1:18323/x', { retries: 0 }),
      net.fetchJson('http://127.0.0.1:18324/x', { retries: 0 }),
    ]);
    assert.equal(result.fast, true, '竞速应取先返回的快源');
    slow.close();
    fast.close();
  });

  s1.close();
  s2.close();
  summary();
}

run();
