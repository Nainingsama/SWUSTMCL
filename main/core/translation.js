'use strict';
/**
 * 离线译名库：中文模组名 → 英文原名。
 *
 * 三层数据：
 *   1. 内置基础表 main/core/mod-names.json（随启动器版本更新）
 *   2. 用户学习表 userdata/mod-names-user.json（每次在线查询成功自动积累）
 *   3. 在线 MC百科 桥接（content.chineseAlias）—— 成功后写入学习表
 * 查找顺序：用户表 → 内置表 → null（走在线）。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const BUILTIN_FILE = path.join(__dirname, 'mod-names.json');
const USER_FILE = () => path.join(app.getPath('userData'), 'mod-names-user.json');

let builtinCache = null;
let userCache = null;

function builtin() {
  if (builtinCache) return builtinCache;
  try {
    const j = JSON.parse(fs.readFileSync(BUILTIN_FILE, 'utf8'));
    builtinCache = { updated: j.updated || '', map: j.map || {} };
  } catch {
    builtinCache = { updated: '', map: {} };
  }
  return builtinCache;
}

function user() {
  if (userCache) return userCache;
  try {
    userCache = JSON.parse(fs.readFileSync(USER_FILE(), 'utf8'));
  } catch {
    userCache = { map: {} };
  }
  return userCache;
}

function saveUser() {
  try {
    const u = user();
    u.updated = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.dirname(USER_FILE()), { recursive: true });
    fs.writeFileSync(USER_FILE(), JSON.stringify(u, null, 2), 'utf8');
  } catch {}
}

/** 查询：精确 + 去空格/大小写宽松 */
function lookup(zh) {
  const key = String(zh || '').trim().replace(/\s+/g, '');
  if (!key) return null;
  const u = user().map;
  const b = builtin().map;
  const norm = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.replace(/\s+/g, '').toLowerCase() === key.toLowerCase()) return v;
    }
    return null;
  };
  return norm(u) || norm(b) || null;
}

/** 学习：在线桥接成功后调用 */
function learn(zh, en) {
  const k = String(zh || '').trim();
  const v = String(en || '').trim();
  if (!k || !v) return;
  const u = user();
  if (u.map[k] === v) return;
  u.map[k] = v;
  saveUser();
}

function stats() {
  return {
    builtin: Object.keys(builtin().map).length,
    learned: Object.keys(user().map).length,
    builtinUpdated: builtin().updated,
    userUpdated: user().updated || '',
  };
}

module.exports = { lookup, learn, stats, builtin };
