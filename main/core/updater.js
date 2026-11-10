'use strict';
/**
 * 启动器在线更新（免安装包的增量更新）。
 *
 * 流程：查 GitHub Release → 下载 app-<version>.zip（体积校验 + SHA-256 +
 * zip 结构校验）→ 解压到临时目录 → 生成换装脚本（不直接覆盖当前运行的
 * 文件，等本进程退出后由脚本完成换装）→ 重启后弹出更新日志。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app, shell } = require('electron');
const AdmZip = require('adm-zip');

const net = require('./net');
const settingsLib = require('./settings');
const log = require('./log');

const REPO = 'Nainingsama/SWUSTMCL';
const API = `https://api.github.com/repos/${REPO}`;
const TIMEOUT = 15000;

function currentVersion() {
  return app.getVersion();
}

/** 语义化版本比较：>0 表示 a 更新 */
function compareVersion(a, b) {
  const pa = String(a || '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * 镜像版本清单：仓库根目录的 version.json（jsDelivr / gh-proxy 均可访问）
 * 结构：{ version, notes, assets: [{ name, size, sha256, url }] }
 */
const VERSION_JSON_SOURCES = [
  'https://cdn.jsdelivr.net/gh/Nainingsama/SWUSTMCL@main/version.json',
  'https://gh-proxy.com/https://raw.githubusercontent.com/Nainingsama/SWUSTMCL/main/version.json',
  'https://ghproxy.net/https://raw.githubusercontent.com/Nainingsama/SWUSTMCL/main/version.json',
];

async function latestFromMirror() {
  for (const url of VERSION_JSON_SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'User-Agent': 'SWUSTMCL-Updater' } });
      if (!res.ok) continue;
      const j = await res.json();
      if (!j || !j.version) continue;
      const assets = (j.assets || []).map((a) => ({
        name: a.name,
        size: Number(a.size) || 0,
        browser_download_url: a.url,
        digest: a.sha256 ? 'sha256:' + a.sha256 : '',
      }));
      log.info('更新检查走镜像清单：' + url);
      return { tag_name: 'v' + String(j.version).replace(/^v/, ''), body: j.notes || '', assets };
    } catch (e) {
      log.warn('镜像清单不可用：' + url + ' → ' + (e && e.message));
    }
  }
  return null;
}

async function latestRelease() {
  try {
    const res = await fetch(`${API}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SWUSTMCL-Updater' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (res.status === 404) return null; // 还没有任何 Release
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return res.json();
  } catch (e) {
    log.warn('GitHub API 不可用（' + (e && e.message) + '），尝试镜像清单');
    const mirror = await latestFromMirror();
    if (mirror) return mirror;
    throw new Error('无法连接更新服务器（GitHub 网络受限），可前往 Releases 手动下载');
  }
}

/** 从资产里解析期望的体积与 SHA-256。GitHub 2025+ 资产自带 digest 字段 */
function expectedOf(release, name) {
  const asset = (release.assets || []).find((a) => a.name === name);
  if (!asset) return null;
  const out = { size: Number(asset.size) || 0, sha256: '' };
  const digest = String(asset.digest || '');
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest);
  if (m) out.sha256 = m[1].toLowerCase();
  if (!out.sha256 && release.body) {
    const re = new RegExp(`sha256\\s*\\(\\s*${name}\\s*\\)\\s*[=:]\\s*([0-9a-f]{64})`, 'i');
    const hit = re.exec(release.body);
    if (hit) out.sha256 = hit[1].toLowerCase();
  }
  return out;
}

function isZip(file) {
  return net.isZipFile(file);
}

/** 校验 zip 结构：必须包含主程序 exe 与 resources，防止残缺包覆盖安装 */
function explain(zipPath) {
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch {
    throw new Error('zip 无法解析');
  }
  const names = zip.getEntries().map((e) => e.entryName.replace(/\\/g, '/'));
  const hasExe = names.some((n) => /(^|\/)SWUSTMCL\.exe$/i.test(n));
  const hasResources = names.some((n) => /(^|\/)resources\//i.test(n));
  if (!hasExe || !hasResources) {
    throw new Error('更新包结构不完整（缺少主程序或资源目录）');
  }
  // 若 zip 套了一层目录，返回那层前缀
  const first = names[0].split('/')[0];
  const nested = names.every((n) => n.startsWith(`${first}/`)) ? `${first}/` : '';
  return { names, nested, hasExe, hasResources };
}

/**
 * 检查更新
 * @returns {{available:boolean, version:string, notes:string, asset:object|null, url:string}}
 */
async function check(opts = {}) {
  const release = await latestRelease();
  if (!release) return { available: false, version: '', notes: '', asset: null };
  const version = String(release.tag_name || '').replace(/^v/, '');
  const newer = compareVersion(version, currentVersion()) > 0;
  const asset = newer
    ? ((release.assets || []).find((a) => /^app-.*\.zip$/i.test(a.name))
      || (release.assets || []).find((a) => /win.*\.zip$/i.test(a.name))
      || null)
    : null;
  if (newer && !asset && !opts.silent) {
    log.warn(`检测到新版本 ${version}，但 Release 里没有 Windows 压缩包`);
  }
  return {
    available: Boolean(newer && asset),
    version,
    current: currentVersion(),
    notes: release.body || '',
    name: release.name || '',
    publishedAt: release.published_at || '',
    asset: asset
      ? { name: asset.name, size: asset.size, url: asset.browser_download_url, ...((expectedOf(release, asset.name) || {})) }
      : null,
    htmlUrl: `https://github.com/${REPO}/releases`,
  };
}

/**
 * 下载并校验更新包，解压到临时目录，然后交由换装脚本完成替换。
 * @param {object} asset check() 返回的 asset
 * @param {(p:object)=>void} [onProgress]
 */
async function install(asset, onProgress) {
  const report = (p) => onProgress && onProgress(p);
  if (!app.isPackaged) throw new Error('开发模式下不支持自更新');

  const tmpDir = path.join(app.getPath('userData'), 'updates');
  await fsp.mkdir(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, asset.name || 'app-update.zip');

  // ---------- 下载 ----------
  report({ stage: 'download', message: '下载更新包', percent: 3 });
  let received = 0;
  // 国内直连 github.com 的 release 资产经常只有几十 KB/s 甚至 0，卡住 12 秒就换镜像
  const MIRRORS = [
    'https://gh-proxy.com/',
    'https://ghproxy.net/',
    'https://ghfast.top/',
  ];
  const tried = [];
  const onBytes = (n) => {
    received += n;
    if (asset.size) {
      const percent = Math.min(90, Math.round((received / asset.size) * 88) + 3);
      report({ stage: 'download', message: `下载中 ${(received / 1048576).toFixed(1)}/${(asset.size / 1048576).toFixed(1)} MB`, percent });
    }
  };

  async function fetchWithWatchdog(url, dest, { stallMs = 12000, totalMs = 600000 } = {}) {
    const ac = new AbortController();
    let lastTick = Date.now();
    const killer = setTimeout(() => ac.abort(), totalMs);
    const watch = setInterval(() => {
      if (Date.now() - lastTick > stallMs) ac.abort();
    }, 1500);
    const file = fs.createWriteStream(dest);
    try {
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastTick = Date.now();
        if (!file.write(Buffer.from(value))) await new Promise((r) => file.once('drain', r));
        onBytes(value.length);
      }
      await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())));
    } catch (e) {
      try { file.destroy(); } catch {}
      throw e;
    } finally {
      clearInterval(watch);
      clearTimeout(killer);
    }
  }

  let downloaded = false;
  for (const url of [asset.url, ...MIRRORS.map((m) => m + asset.url)]) {
    if (downloaded) break;
    if (tried.length) {
      received = 0;
      report({ stage: 'download', message: '直连较慢，切换加速镜像重试…', percent: 3 });
    }
    try {
      await fetchWithWatchdog(url, zipPath);
      downloaded = true;
    } catch (e) {
      tried.push(url);
      log.warn('更新包下载失败：' + url + ' → ' + (e && e.message));
      await fsp.unlink(zipPath).catch(() => {});
    }
  }
  if (!downloaded) throw new Error('更新包下载失败（直连与镜像均不可用），可稍后重试或前往 GitHub 手动下载');

  // ---------- 校验：体积 → SHA-256 → zip 结构 ----------
  report({ stage: 'verify', message: '校验更新包', percent: 92 });
  const size = fs.statSync(zipPath).size;
  if (asset.size && size !== asset.size) {
    await fsp.unlink(zipPath).catch(() => {});
    throw new Error(`体积与发布记录不一致（${size} ≠ ${asset.size}）`);
  }
  if (asset.sha256) {
    const sum = await net.sha256File(zipPath);
    if (sum !== asset.sha256) {
      await fsp.unlink(zipPath).catch(() => {});
      throw new Error('SHA-256 摘要与发布记录不一致，已放弃安装');
    }
  }
  const structure = explain(zipPath);
  if (structure.nested) throw new Error('更新包不应套目录，请在打包时平铺'); // 保守处理

  // ---------- 解压 ----------
  report({ stage: 'extract', message: '解压更新包', percent: 95 });
  const updateDir = path.join(tmpDir, 'staged');
  await fsp.rm(updateDir, { recursive: true, force: true });
  await fsp.mkdir(updateDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const rel = entry.entryName.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (rel.includes('..')) continue;
    const dest = path.join(updateDir, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, entry.getData());
  }

  // ---------- 换装脚本 ----------
  report({ stage: 'swap', message: '准备换装', percent: 98 });
  const appDir = path.dirname(app.getPath('exe'));
  const version = currentVersion();
  const newVer = String(asset.name || '').match(/app-(.+)\.zip/i);
  const batPath = path.join(tmpDir, 'swap.bat');
  const bat = [
    '@echo off',
    'setlocal enabledelayedexpansion',
    `set "APP=${appDir.replace(/\//g, '\\')}"`,
    `set "STAGED=${updateDir.replace(/\//g, '\\')}"`,
    `set "BACKUP=${path.join(tmpDir, 'previous').replace(/\//g, '\\')}"`,
    `set "LAUNCH=SWUSTMCL.exe"`,
    'rem 等主进程退出',
    ':wait',
    `tasklist /FI "IMAGENAME eq %LAUNCH%" 2>NUL | find /I "%LAUNCH%" >NUL && (timeout /t 1 /nobreak >NUL & goto wait)`,
    'if exist "%BACKUP%" rd /s /q "%BACKUP%"',
    'rem 备份当前版本（不覆盖式换装：先整体挪走，成功后清备份）',
    `for /f %%i in ('dir /b /ad "%APP%"') do if /i not "%%i"=="resources" if /i not "%%i"=="locales" move /y "%APP%\\%%i" "%BACKUP%\\%%i" >NUL 2>&1`,
    `for %%f in ("%APP%\\*.*") do if /i not "%%~nxf"=="resources" if /i not "%%~nxf"=="locales" move /y "%%f" "%BACKUP%\\" >NUL 2>&1`,
    'if exist "%APP%\\resources" move /y "%APP%\\resources" "%BACKUP%\\resources" >NUL 2>&1',
    'if exist "%APP%\\locales" move /y "%APP%\\locales" "%BACKUP%\\locales" >NUL 2>&1',
    'xcopy /e /i /y "%STAGED%\\*" "%APP%\\" >NUL',
    `start "" "%APP%\\%LAUNCH%"`,
    'endlocal',
  ].join('\r\n');
  await fsp.writeFile(batPath, bat, 'utf8');

  // 备份目录
  await fsp.mkdir(path.join(tmpDir, 'previous'), { recursive: true });

  const { spawn } = require('child_process');
  const child = spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  // 记录更新日志待弹出
  settingsLib.save({ lastSeenVersion: version });
  const notes = path.join(tmpDir, 'changelog.md');
  await fsp.writeFile(notes, asset.notes || '', 'utf8').catch(() => {});

  log.info(`更新包已就绪，即将重启完成换装`);
  return { ok: true, restarting: true };
}

/** 启动后调用：若上次完成了更新（版本变化），弹出更新日志 */
async function showChangelogIfUpdated(mainWindow, checkResult) {
  const s = settingsLib.all();
  if (!checkResult || !checkResult.updated) return;
  const file = path.join(app.getPath('userData'), 'updates', 'changelog.md');
  const notes = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (mainWindow && notes) {
    mainWindow.webContents.send('update:changelog', { version: s.lastSeenVersion, notes });
  }
}

module.exports = { check, install, compareVersion, expectedOf, sha256File: net.sha256File, isZip, explain, REPO };
