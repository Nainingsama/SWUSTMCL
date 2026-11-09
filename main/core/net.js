'use strict';
/**
 * 网络层：JSON 拉取 + 单文件下载（哈希校验 / zip 头校验）+ 并发池。
 * 只依赖 Node 内置 fetch，全部请求可被上层换源重试。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// HTTP 头只能是 ByteString：UA 不能带中文（星启 → XingQi）
const UA = 'SWUSTMCL/1.0 (XingQi; Electron)';

// ---- 下载源健康度（智能选择用）----
// 每个 source 记录：慢速次数（TTFB>2.5s）、失败次数、最近成功时间。
// auto 模式下按「失败少 + 不慢」挑主源；一次明显变慢/失败即降权。
const sourceHealth = {
  mojang: { slow: 0, fail: 0, ok: 0 },
  bmcl: { slow: 0, fail: 0, ok: 0 },
};
function recordSource(src, kind) {
  const h = sourceHealth[src];
  if (!h) return;
  h[kind] = (h[kind] || 0) + 1;
  if (kind === 'ok') { h.slow = Math.max(0, h.slow - 0.5); h.fail = Math.max(0, h.fail - 1); }
}
function betterSource() {
  const score = (s) => sourceHealth[s].fail * 3 + sourceHealth[s].slow * 1;
  return score('mojang') <= score('bmcl') ? 'mojang' : 'bmcl';
}

// ---- DoH（DNS over HTTPS，阿里公共 DNS）----
// 域名被污染/解析失败时：DoH 拿到真实 IP → https 模块用 IP 连接但 SNI/Host 仍用域名
let dohEnabled = false;
function setDoh(v) { dohEnabled = Boolean(v); }
const dohCache = new Map(); // host -> {ip, time}
async function dohResolve(host) {
  const hit = dohCache.get(host);
  if (hit && Date.now() - hit.time < 300000) return hit.ip;
  const r = await fetch(`https://dns.alidns.com/resolve?name=${encodeURIComponent(host)}&type=A`, {
    headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000),
  });
  const j = await r.json();
  const ans = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
  const ip = ans.length ? ans[ans.length - 1] : null;
  dohCache.set(host, { ip, time: Date.now() });
  return ip;
}

/** 用解析出的 IP 直连（TLS SNI/证书校验仍用原域名） */
function httpsViaIp(url, ip, timeout = 30000) {
  const https = require('https');
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ip, servername: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Host: u.hostname, 'User-Agent': UA, Accept: '*/*' },
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const loc = new URL(res.headers.location, url).href;
        httpsViaIp(loc, ip, timeout).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** 常规请求失败后的 DoH 兜底：返回 Buffer 或抛错 */
async function fetchViaDoh(url) {
  const host = new URL(url).hostname;
  const ip = await dohResolve(host);
  if (!ip) throw new Error('DoH 无解析结果');
  return httpsViaIp(url, ip);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 边读边算哈希，不把整个文件读进内存 */
function hashFile(file, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
const sha1File = (f) => hashFile(f, 'sha1');
const sha256File = (f) => hashFile(f, 'sha256');

async function fetchJson(url, { timeout = 25000, retries = 2, raw = false, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: raw ? '*/*' : 'application/json', ...headers },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return raw ? await res.text() : await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(400 * (i + 1));
    }
  }
  // DoH 兜底（JSON）
  if (dohEnabled) {
    try {
      const buf = await fetchViaDoh(url);
      const text = buf.toString('utf8');
      return raw ? text : JSON.parse(text);
    } catch (e2) {
      lastErr = e2;
    }
  }
  throw new Error(`请求失败 ${url} — ${lastErr && lastErr.message}`);
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

/**
 * 读文件头判断是不是 zip/jar。镜像偶尔用 200 回一个 HTML 错误页，
 * 字节数看着正常，存下来的「jar」一解就炸，表现为游戏启动十秒后崩溃。
 */
function isZipFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    const n = fs.readSync(fd, head, 0, 4, 0);
    if (n < 4) return false;
    return (
      (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) ||
      (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x05 && head[3] === 0x06) ||
      (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x07 && head[3] === 0x08)
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * 下载单个文件。已存在且大小一致则跳过（增量安装的关键）。
 * - expectedSha1 / expectedSha256：大小一致也要比哈希，不一致删掉重下
 * - expectZip：目标是 jar/zip 时必须真的是 zip 头，挡镜像错误页
 * - .part 临时文件先校验再改名，避免把损坏内容写进正式路径
 * - 内容层面的错误（错误页 / 坏 zip）标记 noRetry，直接抛给上层换源
 */
async function download(url, dest, opts = {}) {
  const {
    expectedSize = 0,
    expectedSha1 = '',
    expectedSha256 = '',
    retries = 3,
    onBytes = null,
    timeout = 30000,
    expectZip = false,
    minBytes = 0,
    headers = {},
  } = opts;
  const want1 = String(expectedSha1 || '').toLowerCase();
  const want256 = String(expectedSha256 || '').toLowerCase();

  const existing = fileSize(dest);
  if (existing > 0 && (!expectedSize || existing === expectedSize) && (!minBytes || existing >= minBytes)) {
    let trust = true;
    if (want1 && /^[0-9a-f]{40}$/.test(want1)) trust = (await sha1File(dest).catch(() => '')) === want1;
    if (trust && want256 && /^[0-9a-f]{64}$/.test(want256)) trust = (await sha256File(dest).catch(() => '')) === want256;
    if (trust && expectZip && !isZipFile(dest)) trust = false;
    if (trust) {
      if (onBytes) onBytes(existing);
      return { size: existing, skipped: true };
    }
    try { await fsp.unlink(dest); } catch {}
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 超时模型：timeout 只管「建立连接 + 等到响应头」；传输阶段改用「空闲超时」
    // （X 秒没有任何数据到达才中断），大文件慢速下载不再被整体超时反复掐断。
    const controller = new AbortController();
    let connectTimer = setTimeout(() => controller.abort(new Error('connect timeout')), timeout);
    let idleTimer = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('stall (no data)')), Math.max(timeout, 20000));
    };
    try {
      const t0 = Date.now();
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: controller.signal });
      if (opts.ttfbTo) opts.ttfbTo(Date.now() - t0);
      clearTimeout(connectTimer);
      connectTimer = null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      armIdle(); // 响应头已到，切到空闲超时

      const handle = await fsp.open(tmp, 'w');
      let received = 0;
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          armIdle(); // 每收到数据重置空闲计时
          if (done) break;
          await handle.write(value);
          received += value.length;
          if (onBytes) onBytes(value.length);
        }
      } finally {
        await handle.close();
      }

      if (want1 && /^[0-9a-f]{40}$/.test(want1) && (await sha1File(tmp)) !== want1) {
        throw new Error(`SHA1 校验失败`);
      }
      if (want256 && /^[0-9a-f]{64}$/.test(want256) && (await sha256File(tmp)) !== want256) {
        throw new Error(`SHA256 校验失败`);
      }
      if (minBytes && received < minBytes) {
        const e = new Error(`内容过小（${received} 字节），可能是错误页`);
        e.noRetry = true;
        throw e;
      }
      if (expectZip && !isZipFile(tmp)) {
        const e = new Error('下载到的不是有效的 jar/zip，多半是镜像返回了错误页');
        e.noRetry = true;
        throw e;
      }
      await fsp.rename(tmp, dest);
      if (opts.onOk) opts.onOk();
      return { size: received, skipped: false };
    } catch (e) {
      lastErr = e;
      try { await fsp.unlink(tmp); } catch {}
      if (e && e.noRetry) break; // 4xx / 内容级错误：重试同一地址无意义
      if (attempt < retries) await sleep(500 * (attempt + 1));
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
      if (idleTimer) clearTimeout(idleTimer);
    }
  }
  // 全部重试失败：DoH 开启时用 IP 直连再试一次（应对 DNS 污染）
  if (dohEnabled) {
    try {
      const buf = await fetchViaDoh(url);
      await fsp.writeFile(`${dest}.part`, buf);
      await fsp.rename(`${dest}.part`, dest);
      return { size: buf.length, skipped: false };
    } catch (e2) {
      lastErr = e2;
    }
  }
  throw new Error(`下载失败 ${path.basename(dest)} — ${lastErr && lastErr.message}`);
}

/**
 * 大文件分片下载：>8MB 时按 Range 并行拉取再合并，突破单连接限速。
 * 依赖 expectedSize（版本元数据里有）；任一分片失败整体抛错交给上层换源。
 */
async function downloadLarge(url, dest, opts = {}) {
  const total = Number(opts.expectedSize) || 0;
  if (total < 8 * 1024 * 1024) return download(url, dest, opts);

  await fsp.mkdir(path.dirname(dest), { recursive: true }); // 目录可能还不存在（新库目录）

  const parts = Math.min(6, Math.max(2, Math.ceil(total / (4 * 1024 * 1024))));
  const slice = Math.ceil(total / parts);
  const tmpParts = [];
  const errors = [];
  let rangeUnsupported = false;

  const cleanup = async () => {
    for (const p of tmpParts) { try { await fsp.unlink(p); } catch {} }
  };

  await pool(Array.from({ length: parts }, (_, i) => i), parts, async (i) => {
    if (rangeUnsupported) return;
    const start = i * slice;
    const end = Math.min(total, start + slice) - 1;
    const partPath = `${dest}.part${i}`;
    tmpParts[i] = partPath;
    let got = 0;
    for (let attempt = 0; attempt < 2 && got !== end - start + 1; attempt++) {
      try {
        const controller = new AbortController();
        let idle = setTimeout(() => controller.abort(new Error('stall')), 20000);
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Range: `bytes=${start}-${end}`, ...(opts.headers || {}) },
          signal: controller.signal,
        });
        // 服务器不支持 Range（返回 200 全量）：放弃分片，整体重下
        if (res.status === 200) { rangeUnsupported = true; throw new Error('服务器不支持 Range'); }
        if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const handle = await fsp.open(partPath, 'w');
        try {
          for (;;) {
            const { done, value } = await reader.read();
            idle = setTimeout(() => controller.abort(new Error('stall')), 20000);
            if (done) break;
            await handle.write(value, 0, value.length, got); // 分片内相对偏移，合并时按顺序拼接
            got += value.length;
            if (opts.onBytes) opts.onBytes(value.length);
          }
        } finally {
          clearTimeout(idle);
          await handle.close();
        }
      } catch (e) {
        if (rangeUnsupported) return;
        if (attempt === 1) errors.push(`分片${i}: ${e.message}`);
      }
    }
  });

  if (rangeUnsupported) {
    await cleanup();
    return download(url, dest, opts);
  }
  if (errors.length) {
    await cleanup();
    throw new Error(`分片下载失败 — ${errors.join('; ')}`);
  }

  // 合并
  const out = await fsp.open(`${dest}.part`, 'w');
  try {
    for (const p of tmpParts) {
      const buf = await fsp.readFile(p);
      await out.write(buf);
      await fsp.unlink(p);
    }
  } finally {
    await out.close();
  }
  const tmp = `${dest}.part`;

  // 哈希校验
  if (opts.expectedSha1 && /^[0-9a-f]{40}$/.test(opts.expectedSha1)) {
    const sum = await sha1File(tmp);
    if (sum !== opts.expectedSha1) {
      await fsp.unlink(tmp).catch(() => {});
      throw new Error('SHA1 校验失败');
    }
  }
  await fsp.rename(tmp, dest);
  return { size: total, skipped: false };
}

/** 受控并发执行，避免把带宽和句柄打满 */
async function pool(items, limit, worker) {
  const queue = items.slice();
  const runners = new Array(Math.min(limit, queue.length)).fill(0).map(async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

module.exports = { fetchJson, download, downloadLarge, pool, fileSize, sleep, sha1File, sha256File, isZipFile, UA, setDoh, dohResolve, fetchViaDoh, sourceHealth, betterSource, recordSource };
