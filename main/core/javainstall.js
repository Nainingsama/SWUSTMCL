'use strict';
/**
 * Java 运行时自动安装：启动时缺少对应版本 → 自动下载 JRE。
 * 主源：清华 Adoptium 镜像（国内快，文件名可枚举）；兜底：Adoptium 官方 API（GitHub 直链）。
 * 安装位置：<mcDir>/runtime/java-<major>/（与官方启动器/PCL 的 runtime 布局一致，
 * java.detect 的 fromMojangRuntime 天然会扫到它）。
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const net = require('./net');
const settingsLib = require('./settings');
const log = require('./log');

const TUNA_DIR = (major) => `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${major}/jre/x64/windows/`;
const ADOPTIUM_API = (major) => `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`;

/** 递归找 bin/javaw.exe（深度 3） */
function scanRuntime(root, depth = 0) {
  if (depth > 3) return null;
  let ents = [];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of ents) {
    const full = path.join(root, e.name);
    if (e.isFile() && /javaw\.exe$/i.test(e.name)) return full;
  }
  for (const e of ents) {
    if (e.isDirectory()) {
      const hit = scanRuntime(path.join(root, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** 清华：列目录取最新 zip 文件名 */
async function tunaLatestName(major) {
  const html = await net.fetchJson(TUNA_DIR(major), { raw: true, timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (SWUSTMCL)' } });
  const re = new RegExp(String.fromCharCode(79,112,101,110,74,68,75) + major + String.fromCharCode(85,45,106,114,101,95,120,54,52,95,119,105,110,100,111,119,115,95,104,111,116,115,112,111,116,95) + String.fromCharCode(91,92,119,46,45,93,43,92,46,122,105,112), String.fromCharCode(103));
  const names = String(html).match(re) || [];
  if (!names.length) throw new Error('清华镜像目录里没有可用文件');
  return names[names.length - 1]; // 页面按版本升序追加，最后一个即最新
}

/** Adoptium 官方 API：返回 GitHub 直链 */
async function adoptiumLink(major) {
  const list = await net.fetchJson(ADOPTIUM_API(major), { timeout: 15000 });
  const hit = (Array.isArray(list) ? list : []).find((a) => a.binary && a.binary.package);
  if (!hit) throw new Error('Adoptium API 无可用包');
  return hit.binary.package.link;
}

/**
 * 确保指定 major 的 Java 可用；没有则自动下载。
 * @returns {Promise<string|null>} javaw.exe 绝对路径；null 表示本地已有（无需下载）
 */
async function ensureJava(major, onProgress) {
  major = Number(major) || 21;
  const report = (stage, message, percent) => onProgress && onProgress({ stage, message, percent, major });
  const runtimeRoot = path.join(settingsLib.all().mcDir, 'runtime', `java-${major}`);
  const existing = scanRuntime(runtimeRoot);
  if (existing) return existing; // 之前装过

  log.info(`未找到 Java ${major}，开始自动下载运行时…`);
  report('download', `下载 Java ${major} 运行时`, 2);

  const tmpDir = path.join(settingsLib.all().mcDir, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const zipPath = path.join(tmpDir, `jre-${major}.zip`);

  // 主源：清华镜像
  let usedMirror = true;
  try {
    const name = await tunaLatestName(major);
    report('download', `下载 ${name}（清华镜像）`, 5);
    await net.download(TUNA_DIR(major) + name, zipPath, {
      retries: 2,
      timeout: 30000,
      onBytes: (n) => {
        void n;
        report('download', `下载 ${name}（清华镜像）`, Math.min(90, 5 + Math.round((fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0) / (30 * 1024 * 1024) * 85)));
      },
    });
  } catch (e) {
    // 兜底：Adoptium 官方（GitHub 直链，国内较慢）
    usedMirror = false;
    log.warn('清华镜像失败，切换 Adoptium 官方：' + e.message);
    report('download', '清华镜像失败，切换官方源', 5);
    const link = await adoptiumLink(major);
    await net.download(link, zipPath, { retries: 1, timeout: 60000, onBytes: () => report('download', '下载（官方源）', 40) });
  }

  // 解压
  report('extract', '解压运行时…', 92);
  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(runtimeRoot, true);
  } catch (e) {
    throw new Error('解压失败：' + e.message);
  } finally {
    try { fs.unlinkSync(zipPath); } catch {}
  }

  const exe = scanRuntime(runtimeRoot);
  if (!exe) throw new Error('解压后未找到 javaw.exe');
  log.info(`Java ${major} 安装完成：${exe}${usedMirror ? '（清华镜像）' : '（官方源）'}`);
  report('done', `Java ${major} 就绪`, 100);
  return exe;
}

module.exports = { ensureJava, scanRuntime };
