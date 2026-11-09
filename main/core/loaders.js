'use strict';
/**
 * 加载器在线安装：Fabric / Quilt / NeoForge / Forge。
 *
 * - Fabric / Quilt：meta 服务直接给 profile JSON（继承原版），写进 versions/ 即可，
 *   缺失的原版底座自动补装。
 * - NeoForge / Forge：下载 installer.jar，调用本机 Java 以命令行静默安装
 *   （--installClient <游戏目录>）。安装器会自己生成版本 JSON 与库。
 *   Forge 的 ADQLS 需要较新 Java（1.17+ 用 Java 16+，1.13~1.16 用 Java 8~11）。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const net = require('./net');
const mirror = require('./mirror');
const safe = require('./safe');
const settingsLib = require('./settings');
const versionLib = require('./versions');
const javaLib = require('./java');
const log = require('./log');

const FABRIC_META = (mc, loader) => `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`;
const FABRIC_LOADERS = (mc) => `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`;
const QUILT_META = (mc, loader) => `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`;
const QUILT_LOADERS = (mc) => `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}`;
const FORGE_PROMO = 'https://bmclapi2.bangbang93.com/forge/minecraft/${mc}'; // eslint-disable-line no-template-curly-in-string
const FORGE_META = (mc) => `https://bmclapi2.bangbang93.com/forge/minecraft/${encodeURIComponent(mc)}`;
const NEOFORGE_META = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const NEOFORGE_META_MIRROR = 'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml';
const NEOFORGE_INSTALLER_MIRROR = (lv) => `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${lv}/neoforge-${lv}-installer.jar`;
const FORGE_INSTALLER = (mc, lv) => `https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/${mc}-${lv}/forge-${mc}-${lv}-installer.jar`;
const NEOFORGE_INSTALLER = (lv) => `https://maven.neoforged.net/releases/net/neoforged/neoforge/${lv}/neoforge-${lv}-installer.jar`;

const loaderListCache = new Map(); // key: loader|mc -> {time, data}（60 秒缓存）

function ensureMcDir() {
  return settingsLib.ensureGameDir();
}

// ---------------------------------------------------------------- Fabric / Quilt
async function listLoaderVersionsCached(loader, mc) {
  const cacheKey = loader + '|' + mc;
  const cached = loaderListCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 60000) return cached.data;
  if (loader === 'fabric') {
    // meta.fabricmc.net 国内经常不可达：官方失败自动切 BMCLAPI 的 fabric-meta 反代
    // 官方与 BMCLAPI 反代竞速：谁先返回用谁（国内官方常挂，镜像秒回）
    let data;
    try {
      data = await Promise.any([
      net.fetchJson(FABRIC_LOADERS(mc), { timeout: 8000 }),
      net.fetchJson(FABRIC_LOADERS(mc).replace('meta.fabricmc.net/v2', 'bmclapi2.bangbang93.com/fabric-meta/v2'), { timeout: 8000 }).catch(() => {
        throw new Error('Fabric 官方与镜像均不可达');
      }),
    ]);
    } catch (e1) {
      // 瞬态网络：1.5 秒后自动重试一轮
      await new Promise((r) => setTimeout(r, 1500));
      data = await Promise.any([
        net.fetchJson(FABRIC_LOADERS(mc), { timeout: 8000 }),
        net.fetchJson(FABRIC_LOADERS(mc).replace('meta.fabricmc.net/v2', 'bmclapi2.bangbang93.com/fabric-meta/v2'), { timeout: 8000 }),
      ]);
    }
    return (data || []).map((x) => ({
      version: (x.loader && x.loader.version) || x.version || '',
      stable: Boolean(x.loader && x.loader.stable),
    })).filter((x) => x.version);
  }
  if (loader === 'quilt') {
    const data = await net.fetchJson(QUILT_LOADERS(mc), { timeout: 15000 });
    return (data || []).map((x) => ({
      version: (x.loader && x.loader.version) || '',
      stable: Boolean(x.loader && x.loader.stable),
    })).filter((x) => x.version);
  }
  if (loader === 'forge') {
    const data = await net.fetchJson(FORGE_META(mc), { timeout: 10000 });
    const arr = Array.isArray(data) ? data : [];
    return arr.map((x) => ({
      version: String(x.version || ''),
      branch: x.branch || '',
      stable: x.type === 'recommended' || Boolean(x.recommended),
    })).filter((x) => x.version);
  }
  if (loader === 'neoforge') {
    let arr = [];
    // 镜像优先：BMCLAPI 的 maven-metadata 国内秒回；官方 API 仅兜底
    try {
      const xml = await net.fetchJson(NEOFORGE_META_MIRROR, { timeout: 12000, raw: true });
      const m = String(xml).match(/<version>([^<]+)<\/version>/g);
      arr = m ? m.map((x) => x.replace(/<\/?version>/g, '')) : [];
    } catch {
      const data = await net.fetchJson(NEOFORGE_META, { timeout: 15000 });
      arr = (data && data.versions) || [];
    }
    // 只保留与目标 MC 版本匹配的 NeoForge（20.x 对 1.20.x，21.x 对 1.21 …）
    const mm = String(mc || '').match(/^1\.(\d+)/);
    const minor = mm ? Number(mm[1]) : 0;
    return arr
      .filter((v) => {
        const m = String(v).match(/^(\d+)\./);
        return m && Number(m[1]) === minor;
      })
      .map((v) => ({ version: String(v), stable: !String(v).includes('-beta') }))
      .reverse();
  }
  loaderListCache.set(cacheKey, { time: Date.now(), data: [] });
  return [];
}

async function listLoaderVersions(loader, mc) {
  const cacheKey = loader + '|' + mc;
  const cached = loaderListCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 60000) return cached.data;
  const result = await listLoaderVersionsCached(loader, mc);
  loaderListCache.set(cacheKey, { time: Date.now(), data: result });
  return result;
}

function _deadTail(loader) {
    throw new Error(`不支持的加载器：${loader}`);
}

function uniqueInstanceId(mcDir, base) {
    let id = base;
    if (!fs.existsSync(path.join(mcDir, 'versions', id))) return id;
    for (let i = 2; i < 500; i++) {
      id = base + ' (' + i + ')';
      if (!fs.existsSync(path.join(mcDir, 'versions', id))) return id;
    }
    return base + '-' + Date.now();
  }

/** Maven 坐标 → libraries/ 下的相对路径 */
function mavenPathOf(name) {
  const [group, artifact, version, classifier] = String(name).split(':');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

/**
 * 下载 profile JSON 里的加载器库。
 * Fabric/Quilt 的库条目只有 maven 坐标 + 仓库 url（没有 downloads.artifact），
 * 之前只写 JSON 不下载库，装出来的实例一启动就 ClassNotFoundException。
 */
async function downloadProfileLibraries(profile, mcDir, report, from = 62, to = 96) {
  const libRoot = path.join(mcDir, 'libraries');
  const list = (profile.libraries || []).filter((l) => l && /^[\w.-]+:[\w.-]+:[^:]+/.test(String(l.name || '')));
  if (!list.length) return;
  let done = 0;
  await net.pool(list, 6, async (lib) => {
    const art = lib.downloads && lib.downloads.artifact;
    const rel = (art && art.path) || mavenPathOf(lib.name);
    const dest = safe.safeJoin(libRoot, rel);
    const url = (art && art.url) || `${String(lib.url || 'https://maven.fabricmc.net').replace(/\/+$/, '')}/${rel}`;
    const opts = {
      expectZip: true,
      retries: 1,
      timeout: 60000,
      expectedSize: (art && art.size) || 0,
      expectedSha1: (art && art.sha1) || lib.sha1 || '',
    };
    try {
      await net.download(url, dest, opts);
    } catch {
      // BMCLAPI maven 反代兜底
      const alt = url
        .replace('https://maven.fabricmc.net', 'https://bmclapi2.bangbang93.com/maven')
        .replace('https://maven.quiltmc.org/repository/release', 'https://bmclapi2.bangbang93.com/maven');
      await net.download(alt, dest, opts);
    }
    done += 1;
    if (report) report({ stage: 'libraries', message: `下载加载器库 ${done}/${list.length}`, percent: Math.round(from + (done / list.length) * (to - from)) });
  });
}

async function installFromProfileJson(profileJson, instanceId, source) {
  const mcDir = ensureMcDir();
  instanceId = uniqueInstanceId(mcDir, instanceId);
  safe.assertVersionId(instanceId);
  const dir = safe.safeJoin(path.join(mcDir, 'versions'), instanceId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${instanceId}.json`), JSON.stringify(profileJson, null, 2), 'utf8');
  return { id: instanceId, dir };
}

/**
 * 安装 Fabric / Quilt：拉 profile JSON（含继承原版），写入 versions/<实例名>/。
 * 原版底座缺失时返回 needsVanilla，让上层先装官方版本。
 */
async function installFabricQuilt(loader, mc, loaderVersion, instanceId, source, onProgress) {
  const report = (p) => onProgress && onProgress(p);
  report({ stage: 'meta', message: `获取 ${loader} 配置`, percent: 10 });

  const metaUrl = loader === 'fabric' ? FABRIC_META(mc, loaderVersion) : QUILT_META(mc, loaderVersion);
  let profile;
  try {
    profile = await net.fetchJson(metaUrl, { timeout: 12000 });
  } catch {
    // 官方 meta 不可达：fabric 走 BMCLAPI 反代重试
    profile = await net.fetchJson(metaUrl.replace('meta.fabricmc.net/v2', 'bmclapi2.bangbang93.com/fabric-meta/v2'), { timeout: 20000 });
  }
  if (!profile || !profile.mainClass || !Array.isArray(profile.libraries)) {
    throw new Error('加载器配置格式异常');
  }

  // 原版底座检查
  report({ stage: 'vanilla', message: '检查原版底座', percent: 25 });
  let needsVanilla = false;
  try {
    versionLib.loadVersionJson(ensureMcDir(), mc);
  } catch {
    needsVanilla = true;
  }

  report({ stage: 'write', message: '写入实例', percent: 60 });
  const r = await installFromProfileJson(profile, instanceId || `${loader}-${loaderVersion}-${mc}`, source);
  // 关键：把加载器自身的库（fabric-loader / asm / sponge-mixin…）下载到位
  await downloadProfileLibraries(profile, ensureMcDir(), report);
  report({ stage: 'done', message: '安装完成', percent: 100 });
  return { ok: true, id: r.id, needsVanilla };
}

/**
 * 安装 Forge / NeoForge：下载 installer.jar → 用本机 Java 静默安装。
 * @returns {Promise<{ok:boolean, id:string, needsVanilla:boolean, log:string[]}>}
 */
async function installForgeLike(loader, mc, loaderVersion, instanceId, source, onProgress) {
  const report = (p) => onProgress && onProgress(p);
  const mcDir = ensureMcDir();
  const tmp = path.join(appTmp(), `installer-${Date.now()}.jar`);
  const steps = [];

  // 原版底座检查
  report({ stage: 'vanilla', message: '检查原版底座', percent: 5 });
  let needsVanilla = false;
  try {
    versionLib.loadVersionJson(mcDir, mc);
  } catch {
    needsVanilla = true;
  }

  const url = loader === 'neoforge' ? NEOFORGE_INSTALLER(loaderVersion) : FORGE_INSTALLER(mc, loaderVersion);
  const urlAlt = loader === 'neoforge' ? NEOFORGE_INSTALLER_MIRROR(loaderVersion) : url;
  report({ stage: 'download', message: '下载安装器', percent: 15 });
  try {
    await net.download(mirror.rewrite(url, source), tmp, { expectZip: true, retries: 1, timeout: 120000 });
  } catch (e1) {
    steps.push('主源下载失败，切换镜像: ' + e1.message);
    await net.download(loader === 'neoforge' ? urlAlt : mirror.rewrite(url, alt0(source)), tmp, { expectZip: true, retries: 2, timeout: 180000 });
  }
  steps.push(`安装器已下载：${(net.fileSize(tmp) / 1048576).toFixed(1)} MB`);

  report({ stage: 'run', message: '运行安装器（可能需要几分钟）', percent: 40 });

  // Forge 安装器需要的 Java 版本：1.17+ 需要 16+，1.13~1.16 需要 8~11
  const javas = await javaLib.detect({ mcDirs: [mcDir] });
  const needMajor = pickInstallerJavaMajor(mc);
  const jvm = javaLib.pick(javas, needMajor) || javas[0];
  if (!jvm) throw new Error('未找到可用的 Java，请先在设置里确认 Java 检测结果');

  const result = await new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(jvm.java, ['-jar', tmp, '--installClient', mcDir], {
      cwd: mcDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const pipe = (s) => {
      if (!s) return;
      s.setEncoding('utf8');
      s.on('data', (c) => {
        out += c;
        if (out.length > 100000) out = out.slice(-50000);
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('error', (err) => resolve({ code: -1, out: `${out}\n${err.message}` }));
    child.on('close', (code) => resolve({ code, out }));
    // 安装器有时不退出，超时强杀并按产物判断成败
    setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: child.exitCode ?? 0, out, timeout: true });
    }, 10 * 60 * 1000);
  });

  steps.push(...result.out.split(/\r?\n/).filter(Boolean).slice(-12));

  // 按「产物是否存在」判断成败，不依赖退出码（部分版本安装器退出码不可靠）
  let installedId = '';
  try {
    const versionsRoot = path.join(mcDir, 'versions');
    const candidates = fs.readdirSync(versionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const want = loader === 'neoforge' ? loaderVersion : `${mc}-${loaderVersion}`;
    installedId = candidates.find((n) => n === want)
      || candidates.filter((n) => n.includes(loaderVersion)).slice(-1)[0]
      || '';
  } catch {}

  try { await fsp.unlink(tmp); } catch {}

  if (!installedId) {
    throw new Error(`安装器未能生成版本（退出码 ${result.code}）：\n${steps.slice(-4).join('\n')}`);
  }

  if (instanceId && instanceId !== installedId) {
    // 用户自定义实例名：重名自动加序号后复制版本目录
    instanceId = uniqueInstanceId(mcDir, instanceId);
    safe.assertVersionId(instanceId);
    const from = path.join(mcDir, 'versions', installedId);
    const to = path.join(mcDir, 'versions', instanceId);
    await copyDir(from, to);
    installedId = instanceId;
  }

  report({ stage: 'done', message: '安装完成', percent: 100 });
  log.info(`加载器安装完成：${loader} ${loaderVersion} → ${installedId}`);
  return { ok: true, id: installedId, needsVanilla, log: steps };
}

function alt0(source) { return source === 'bmcl' ? 'mojang' : 'bmcl'; }

function pickInstallerJavaMajor(mc) {
  const m = String(mc).match(/^1\.(\d+)/);
  const minor = m ? Number(m[1]) : 0;
  if (minor >= 17) return 21;
  if (minor >= 13) return 8; // 1.13~1.16 用 Java 8 装最稳
  return 8;
}

function appTmp() {
  const { app } = require('electron');
  const dir = path.join(app.getPath('userData'), 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}

/**
 * 加载器统一入口。原版底座缺失时自动先装原版再装加载器。
 */
async function install(loader, mc, loaderVersion, instanceId, source, onProgress) {
  const report = (p) => onProgress && onProgress(p);
  const mcDir = ensureMcDir();

  // 底座缺失自动补装
  let hasVanilla = true;
  try {
    versionLib.loadVersionJson(mcDir, mc);
  } catch {
    hasVanilla = false;
  }
  if (!hasVanilla && (loader === 'fabric' || loader === 'quilt' || loader === 'forge' || loader === 'neoforge')) {
    report({ stage: 'vanilla', message: `自动补装原版 ${mc}`, percent: 2 });
    const manifest = await versionLib.getManifest();
    const entry = (manifest.versions || []).find((v) => v.id === mc);
    if (!entry) throw new Error(`版本清单里找不到 ${mc}`);
    const { install: installVanilla } = require('./install');
    const r = await installVanilla(mc, entry, source || 'bmcl', (p) =>
      report({ ...p, message: `原版底座：${p.message}`, percent: Math.round((p.percent || 0) * 0.6) })
    );
    if (!r.ok) throw new Error(`原版底座安装失败：${r.error}`);
  }

  if (loader === 'fabric' || loader === 'quilt') {
    const r = await installFabricQuilt(loader, mc, loaderVersion, instanceId, source, onProgress);
  r.requestedId = instanceId;
  return r;
  }
  return installForgeLike(loader, mc, loaderVersion, instanceId, source, onProgress);
}

module.exports = { install, listLoaderVersions, FORGE_PROMO };
