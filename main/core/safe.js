'use strict';
/**
 * 安全边界。
 *
 * 渲染进程传来的所有路径 / 版本名 / URL 都按不可信输入处理（页面可能被导航
 * 劫持或被注入脚本），这里统一做四件事：
 *   1. 版本名 / 实例名只允许单段，且不能是保留设备名 / 通配符 / 控制字符；
 *   2. 拼接出来的路径必须落在给定根目录内（防目录穿越）；
 *   3. 下载地址只允许 http/https，可选主机白名单；
 *   4. 压缩包条目必须是安全的相对路径。
 */
const fs = require('fs');
const path = require('path');

/** Windows 保留设备名，作为文件/目录名会被解析到设备 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const BAD_ID_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * 版本名 / 实例名只允许单段。允许中文与空格（整合包实例名常见），
 * 但不允许任何能改变路径含义的字符。
 */
function assertVersionId(id, label = '版本名') {
  if (typeof id !== 'string') throw new Error(`${label}无效`);
  if (!id || id.length > 64) throw new Error(`${label}长度非法`);
  if (id === '.' || id === '..') throw new Error(`${label}非法`);
  if (BAD_ID_CHARS.test(id)) throw new Error(`${label}含有非法字符`);
  if (/^[.\s]|[.\s]$/.test(id)) throw new Error(`${label}不能以点或空格开头/结尾`);
  if (RESERVED.has(id.split('.')[0].toLowerCase())) throw new Error(`${label}使用了系统保留名称`);
  return id;
}

/**
 * 解析符号链接后的绝对路径。目标不存在时退化为「最近已存在祖先的真实路径
 * + 剩余片段」，否则 Windows 8.3 短名会与真实长名判成两个目录。
 */
function realish(p) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** child 是否位于 parent 子树内（含 parent 自身） */
function withinDir(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(realish(parent), realish(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertWithin(parent, child, label = '路径') {
  if (!withinDir(parent, child)) throw new Error(`${label}超出允许范围`);
  return path.resolve(child);
}

/**
 * 安全拼接：逐段校验后再拼，最后验证整体没逃出 base。
 * 用于「版本元数据里给的相对路径」这类远端可控输入。
 */
function safeJoin(base, ...parts) {
  if (!base) throw new Error('缺少根目录');
  for (const part of parts) {
    if (typeof part !== 'string' || !part) throw new Error('路径片段无效');
    const normalized = part.replace(/\\/g, '/');
    for (const seg of normalized.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') throw new Error('路径片段包含目录穿越');
    }
    if (path.isAbsolute(part) || /^[a-zA-Z]:/.test(part)) throw new Error('路径片段不能是绝对路径');
  }
  return assertWithin(base, path.resolve(base, ...parts));
}

/** 规范化压缩包条目名；不安全返回 null */
function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 260) return null;
  const normalized = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  if (/[\u0000-\u001f]/.test(normalized)) return null;
  if (normalized.split('/').some((seg) => seg === '..')) return null;
  return normalized;
}

function isHttpUrl(value, hosts) {
  if (typeof value !== 'string' || !value) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (!u.hostname) return false;
  if (hosts && hosts.length) {
    const host = u.hostname.toLowerCase();
    if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  }
  return true;
}

function assertHttpUrl(value, hosts, label = '链接') {
  if (!isHttpUrl(value, hosts)) throw new Error(`${label}不在允许范围内`);
  return value;
}

/** 允许下载游戏元数据 / 资源的主机（官方 + BMCLAPI + 加载器官方源） */
const GAME_HOSTS = [
  'mojang.com', 'minecraft.net', 'minecraftservices.com',
  'bmclapi2.bangbang93.com', 'bmclapi.bangbang93.com',
  'fabricmc.net', 'quiltmc.org', 'minecraftforge.net', 'neoforged.net', 'maven.org',
];

/** 整合包 / 资源 CDN */
const PACK_HOSTS = ['modrinth.com', 'forgecdn.net', 'curseforge.com', 'cdn.modrinth.com', 'github.com', 'objects.githubusercontent.com'];

/** 允许展示的外链（浏览器打开） */
const PAGE_HOSTS = ['minecraft.net', 'modrinth.com', 'curseforge.com', 'github.com', 'microsoft.com', 'live.com', 'xbox.com', 'bangbang93.com', 'swust.edu.cn', 'ynet.com'];

module.exports = {
  RESERVED, GAME_HOSTS, PACK_HOSTS, PAGE_HOSTS,
  assertVersionId, assertWithin, withinDir, safeJoin, safeEntryName,
  isHttpUrl, assertHttpUrl, realish,
};
