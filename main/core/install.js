'use strict';
/**
 * 版本安装：客户端 jar、依赖库、资源索引与素材、natives 解压。
 * 全部按「已存在即跳过」做增量，可安全重复调用（重复安装不重复下载）。
 * 单文件下载主源失败自动换备用源。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');

const net = require('./net');
const { downloadLarge } = require('./net');
const mirror = require('./mirror');
const versionLib = require('./versions');
const rules = require('./rules');
const safe = require('./safe');
const settingsLib = require('./settings');
const log = require('./log');

const OS_ARCH = process.arch === 'x64' ? '64' : process.arch === 'arm64' ? '64' : '32';

function mavenPath(name) {
  const parts = String(name).split(':');
  const [group, artifact, version, classifier] = parts;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

function nativeClassifier(lib, osName) {
  if (!lib.natives || !lib.natives[osName]) return null;
  return String(lib.natives[osName]).replace('${arch}', OS_ARCH);
}

/**
 * 汇总需要下载的文件。元数据里的 path 是远端可控字符串，
 * 一律 safeJoin 限定在 libraries/ 内，否则一个 ../../.. 就能写到任意位置。
 */
function collectTasks(meta, mcDir, versionDir, osName) {
  const tasks = [];
  const libRoot = path.join(mcDir, 'libraries');

  for (const lib of meta.libraries || []) {
    if (!rules.allowed(lib.rules, {})) continue;
    const art = lib.downloads && lib.downloads.artifact;
    const rel = art && art.path ? art.path : mavenPath(lib.name);
    const url = art && art.url ? art.url : `${lib.url || 'https://libraries.minecraft.net/'}${rel}`;

    if (art || !lib.downloads) {
      tasks.push({
        url,
        dest: safe.safeJoin(libRoot, rel),
        size: (art && art.size) || 0,
        sha1: (art && art.sha1) || '',
        kind: 'library',
        name: lib.name,
      });
    }

    // natives 分类器（旧版格式，如 1.12 的 LWJGL2）
    const classifier = nativeClassifier(lib, osName);
    if (classifier && lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[classifier]) {
      const c = lib.downloads.classifiers[classifier];
      tasks.push({
        url: c.url,
        dest: safe.safeJoin(libRoot, c.path || mavenPath(`${lib.name}:${classifier}`)),
        size: c.size || 0,
        sha1: c.sha1 || '',
        kind: 'native',
        name: lib.name,
        exclude: (lib.extract && lib.extract.exclude) || ['META-INF/'],
        nativeDir: path.join(versionDir, 'natives'),
      });
    }
  }
  return tasks;
}

function isExcluded(entryName, exclude) {
  return (exclude || []).some((prefix) => entryName.startsWith(prefix));
}

/** 主源失败自动换另一个源重试（单文件级容错） */
async function downloadWithFallback(rawUrl, dest, opts, source) {
  const alt = source === 'bmcl' ? 'mojang' : 'bmcl';
  // 大文件（client.jar 等 >8MB）走分片下载，突破单连接限速
  const big = (opts.expectedSize || 0) > 8 * 1024 * 1024;
  const doIt = (src) => {
    const url = mirror.rewrite(rawUrl, src);
    return big ? downloadLarge(url, dest, opts) : net.download(url, dest, opts);
  };
  try {
    return await doIt(source);
  } catch (e) {
    return await doIt(alt);
  }
}

/** natives 优先复用已解压内容：目标 dll 存在且大小一致就跳过 */
async function extractNatives(tasks, logFn) {
  const unzipped = new Set();
  for (const t of tasks) {
    if (t.kind !== 'native' || unzipped.has(t.dest)) continue;
    unzipped.add(t.dest);
    try {
      const zip = new AdmZip(t.dest);
      const outDir = t.nativeDir;
      await fsp.mkdir(outDir, { recursive: true });
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        if (isExcluded(entry.entryName, t.exclude)) continue;
        const baseName = path.basename(entry.entryName);
        if (!baseName || !/\.(dll|so|dylib)$/i.test(baseName)) continue;
        const dest = path.join(outDir, baseName);
        try {
          if (fs.existsSync(dest) && fs.statSync(dest).size === entry.header.size) continue;
          await fsp.writeFile(dest, entry.getData());
        } catch {}
      }
    } catch (e) {
      logFn(`natives 解压失败：${path.basename(t.dest)} — ${e.message}`);
    }
  }
}

/**
 * 安装一个版本
 * @param {string} id 版本号
 * @param {object} entry manifest 条目（含 url）
 * @param {string} source 'bmcl' | 'mojang'
 * @param {(p:object)=>void} [onProgress]
 */
async function install(id, entry, source, onProgress) {
  safe.assertVersionId(id);
  const osName = require('./rules').OS_NAME;
  const started = Date.now();
  const mcDir = settingsLib.ensureGameDir();
  const versionDir = safe.safeJoin(path.join(mcDir, 'versions'), id);
  await fsp.mkdir(versionDir, { recursive: true });

  const report = (patch) => onProgress && onProgress({ id, ...patch });
  const warnings = [];
  const logFn = (msg) => {
    warnings.push(msg);
    log.warn(`[install:${id}] ${msg}`);
    report({ stage: 'warn', message: msg });
  };

  report({ stage: 'meta', message: '读取版本信息', percent: 2 });

  const meta = await versionLib.getVersionMeta(entry, source);
  meta.id = id;
  await fsp.writeFile(path.join(versionDir, `${id}.json`), JSON.stringify(meta, null, 2), 'utf8');

  // ---------- 收集任务 ----------
  const tasks = [];

  if (meta.downloads && meta.downloads.client && meta.downloads.client.url) {
    const c = meta.downloads.client;
    tasks.push({
      url: c.url,
      dest: path.join(versionDir, `${id}.jar`),
      size: c.size || 0,
      sha1: c.sha1 || '',
      kind: 'client',
      name: 'client.jar',
    });
  } else {
    logFn('该版本未提供 client.jar 下载地址，可能依赖加载器额外安装');
  }

  tasks.push(...collectTasks(meta, mcDir, versionDir, osName));

  // 资源索引
  const assetIndex = meta.assetIndex;
  let assetsName = (assetIndex && assetIndex.id) || meta.assets || 'legacy';
  try {
    safe.assertVersionId(String(assetsName), '资源索引名');
  } catch {
    logFn('资源索引名非法，已回退到 legacy');
    assetsName = 'legacy';
  }
  const indexPath = safe.safeJoin(path.join(mcDir, 'assets', 'indexes'), `${assetsName}.json`);
  let indexJson = null;

  if (assetIndex && assetIndex.url) {
    await downloadWithFallback(
      assetIndex.url,
      indexPath,
      { expectedSize: assetIndex.size || 0, expectedSha1: assetIndex.sha1 || '' },
      source
    );
    indexJson = versionLib.readJson(indexPath);
  } else if (fs.existsSync(indexPath)) {
    indexJson = versionLib.readJson(indexPath);
  }

  if (indexJson && indexJson.objects) {
    const seen = new Set();
    const objectsRoot = path.join(mcDir, 'assets', 'objects');
    for (const [name, obj] of Object.entries(indexJson.objects)) {
      if (!obj || !obj.hash || seen.has(obj.hash)) continue;
      // 资源哈希是文件名，必须严格是 40 位十六进制，否则可借它做路径穿越
      if (!/^[0-9a-f]{40}$/i.test(String(obj.hash))) continue;
      seen.add(obj.hash);
      const hash = String(obj.hash).toLowerCase();
      tasks.push({
        url: `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
        dest: safe.safeJoin(objectsRoot, hash.slice(0, 2), hash),
        size: obj.size || 0,
        sha1: hash,
        kind: 'asset',
        name,
      });
    }
  } else {
    logFn('未获取到资源索引，游戏可能缺少音效与语言文件');
  }

  // log4j 配置
  const loggingFile = meta.logging && meta.logging.client && meta.logging.client.file;
  if (loggingFile && loggingFile.url) {
    let logName = 'client.xml';
    const candidate = String(loggingFile.id || 'client.xml');
    try {
      if (safe.safeEntryName(candidate) === candidate && !candidate.includes('/')) logName = candidate;
    } catch {}
    tasks.push({
      url: loggingFile.url,
      dest: safe.safeJoin(path.join(mcDir, 'assets', 'log_configs'), logName),
      size: loggingFile.size || 0,
      sha1: loggingFile.sha1 || '',
      kind: 'logconfig',
      name: 'log4j config',
    });
  }

  // ---------- 执行下载 ----------
  const total = tasks.length;
  const totalBytes = tasks.reduce((s, t) => s + (t.size || 0), 0);
  let done = 0;
  let bytes = 0;
  let skipped = 0;
  let lastEmit = 0;
  let lastBytesAt = 0;
  let lastBytesVal = 0;
  let speedText = '';
  const baseThreads = Math.max(1, Math.min(16, settingsLib.all().downloadThreads || 16));
  // 资源（assets）都是小文件，吃并发不吃带宽：单独放大
  const assetCount = tasks.filter((t) => t.kind === 'asset').length;
  const threads = assetCount > tasks.length / 2 ? Math.min(32, baseThreads * 2) : baseThreads;

  const emit = (force = false) => {
    const now = Date.now();
    if (now - lastBytesAt > 500) {
      const dt = (now - lastBytesAt) / 1000;
      if (lastBytesAt > 0 && dt > 0) speedText = Math.round((bytes - lastBytesVal) / 1024 / dt) + ' KB/s';
      lastBytesAt = now;
      lastBytesVal = bytes;
    }
    if (!force && now - lastEmit < 180) return;
    lastEmit = now;
    const percent = totalBytes > 0
      ? Math.min(99, Math.round((bytes / totalBytes) * 96) + 2)
      : Math.round((done / Math.max(1, total)) * 96) + 2;
    report({ stage: 'download', message: `下载中 ${done}/${total} · ${speedText}`, done, total, bytes, totalBytes, percent });
  };

  emit(true);
  await net.pool(tasks, threads, async (t) => {
    try {
      const r = await downloadWithFallback(
        t.url,
        t.dest,
        {
          expectedSize: t.size,
          expectedSha1: t.sha1 || '',
          expectZip: /\.(jar|zip)$/i.test(t.dest),
          retries: 1,
          onBytes: (n) => { bytes += n; emit(); },
        },
        source
      );
      if (r && r.skipped) skipped += 1;
    } catch (e) {
      logFn(`${t.kind === 'asset' ? '资源' : '文件'}下载失败：${t.name || path.basename(t.dest)} — ${e.message}`);
    }
    done += 1;
    emit();
  });

  // ---------- natives 解压（优先复用已解压内容） ----------
  report({ stage: 'natives', message: '解压本地库', percent: 97 });
  await extractNatives(tasks, logFn);

  // ---------- 虚拟资源（pre-1.6 / legacy） ----------
  const isPre16 = assetsName === 'pre-1.6';
  if (indexJson && (indexJson.virtual || indexJson.map_to_resources || isPre16) && indexJson.objects) {
    report({ stage: 'assets', message: '整理旧版资源目录', percent: 98 });
    const targetRoot = indexJson.map_to_resources || isPre16
      ? path.join(mcDir, 'resources')
      : path.join(mcDir, 'assets', 'virtual', assetsName);
    for (const [name, obj] of Object.entries(indexJson.objects)) {
      const src = path.join(mcDir, 'assets', 'objects', obj.hash.slice(0, 2), obj.hash);
      let dst;
      try {
        dst = safe.safeJoin(targetRoot, name);
      } catch {
        continue;
      }
      try {
        if (!fs.existsSync(dst)) {
          await fsp.mkdir(path.dirname(dst), { recursive: true });
          await fsp.copyFile(src, dst);
        }
      } catch {}
    }
  }

  // ---------- 安装后完整性校验：缺的当场补，补不齐明确失败 ----------
  try {
    const repair = require('./repair');
    report({ stage: 'verify', message: '校验文件完整性', percent: 99 });
    const before = repair.check(mcDir, id);
    if (before.missing.length) {
      logFn(`有 ${before.missing.length} 个文件没下完整，正在补全…`);
      const r = await repair.fix(mcDir, id, (p) =>
        report({ stage: 'verify', message: `补全文件 ${p.done}/${p.total}`, percent: 99 })
      );
      if (r.remaining.length) {
        const sample = r.remaining.slice(0, 3).map((x) => x.name).join('、');
        return {
          ok: false,
          id,
          files: total,
          skipped,
          bytes,
          seconds: Math.round((Date.now() - started) / 1000),
          warnings,
          error: `还有 ${r.remaining.length} 个文件没补齐（例如 ${sample}），安装不完整。请把「下载源」换成另一个后重试。`,
        };
      }
    }
  } catch (e) {
    logFn(`完整性校验没跑通：${e.message}`);
  }

  report({ stage: 'done', message: '安装完成', percent: 100, done: total, total });
  log.info(`安装完成：${id}（${total} 个文件，跳过 ${skipped}，新增 ${(bytes / 1048576).toFixed(1)} MB）`);

  return {
    ok: true,
    id,
    files: total,
    skipped,
    bytes,
    seconds: Math.round((Date.now() - started) / 1000),
    warnings,
  };
}

module.exports = { install, mavenPath, collectTasks, extractNatives };
