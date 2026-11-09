'use strict';
/**
 * 游戏目录发现与聚合。
 *
 * 启动器可能把 .minecraft 放在任意位置 —— 典型是 PCL 便携版：exe 与游戏目录
 * 都不在 %APPDATA%。发现链路：
 *   1. 解析桌面 / 开始菜单 / 公共桌面的 .lnk 快捷方式 → 定位启动器 exe →
 *      取 exe 同级的 .minecraft（便携版布局）；
 *   2. 各盘符根目录两层浅搜常见启动器 exe 兜底；
 *   3. %APPDATA%\.minecraft 官方默认目录；
 *   4. 设置里的主目录与手动添加目录。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

const LAUNCHER_EXES = [
  'Plain Craft Launcher 2.exe', 'Plain Craft Launcher.exe',
  'PCL2.exe', 'PCL.exe', 'HMCL.exe', 'BakaXL.exe',
];

function norm(p) {
  if (!p) return '';
  try {
    return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return String(p).toLowerCase();
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 从 .lnk 二进制里抠出目标路径（UTF-16LE 与 ANSI 两种编码都试） */
function readShortcutTargets(lnkPath) {
  const found = [];
  try {
    const buf = fs.readFileSync(lnkPath);
    for (const enc of ['utf16le', 'latin1']) {
      const text = buf.toString(enc);
      const matches = text.match(/[A-Za-z]:\\[^\u0000-\u001f"<>|*?\r\n]{3,120}/g) || [];
      for (const m of matches) {
        if (/\.exe$/i.test(m.trim())) found.push(m.trim());
      }
    }
  } catch {
    /* 快捷方式损坏就跳过 */
  }
  return found;
}

function shortcutPaths() {
  const dirs = [
    path.join(HOME, 'Desktop'),
    path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'),
  ];
  const out = [];
  for (const dir of dirs) {
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.lnk') && /craft|pcl|hmcl|bakaxl|minecraft/i.test(e.name)) {
        out.push(path.join(dir, e.name));
      }
    }
  }
  return out;
}

/** 在驱动器根目录浅层搜启动器 exe（最多两层，跳过系统目录） */
function scanRoots() {
  const roots = ['C:\\', 'D:\\', 'E:\\'];
  const skip = new Set([
    'windows', 'program files', 'program files (x86)', 'programdata',
    '$recycle.bin', 'system volume information', 'users', 'appdata',
    'perflogs', 'recovery', 'msys64',
  ]);
  const hits = [];
  for (const root of roots) {
    let level1 = [];
    try {
      level1 = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const a of level1) {
      if (!a.isDirectory() || skip.has(a.name.toLowerCase())) continue;
      const p1 = path.join(root, a.name);
      for (const exe of LAUNCHER_EXES) {
        if (fs.existsSync(path.join(p1, exe))) hits.push(path.join(p1, exe));
      }
      let level2 = [];
      try {
        level2 = fs.readdirSync(p1, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const b of level2) {
        if (!b.isDirectory()) continue;
        const p2 = path.join(p1, b.name);
        for (const exe of LAUNCHER_EXES) {
          if (fs.existsSync(path.join(p2, exe))) hits.push(path.join(p2, exe));
        }
      }
    }
  }
  return hits;
}

/** 找出所有可能的启动器根目录 */
function findLauncherRoots() {
  const exes = new Set();

  for (const lnk of shortcutPaths()) {
    for (const target of readShortcutTargets(lnk)) {
      if (fs.existsSync(target)) exes.add(target);
    }
  }
  for (const p of scanRoots()) exes.add(p);

  for (const guess of [path.join(HOME, 'PCL'), path.join(HOME, 'Desktop', 'PCL'), 'C:\\PCL', 'D:\\PCL']) {
    for (const exe of LAUNCHER_EXES) {
      const p = path.join(guess, exe);
      if (fs.existsSync(p)) exes.add(p);
    }
  }

  const roots = [];
  for (const exe of exes) {
    const dir = path.dirname(exe);
    const lower = path.basename(exe).toLowerCase();
    const kind = lower.includes('hmcl') ? 'HMCL' : lower.includes('bakaxl') ? 'BakaXL' : 'PCL';
    roots.push({ dir, kind });
  }
  return roots;
}

/** 综合当前设置，得出用于扫描的全部游戏目录 */
function all(settings) {
  const list = [];
  const push = (p, kind, name) => {
    if (!p) return;
    const key = norm(p);
    if (!key || list.some((x) => norm(x.path) === key)) return;
    if (!isDir(p)) return;
    list.push({ path: path.resolve(p), kind, name: name || path.basename(path.dirname(p)) || p });
  };

  push(settings.mcDir, 'primary', '主目录'); // 安装目标，排第一
  push(path.join(APPDATA, '.minecraft'), 'official', '官方启动器');

  for (const root of findLauncherRoots()) {
    let mc = path.join(root.dir, '.minecraft');
    if (!isDir(mc)) mc = path.join(root.dir, 'minecraft');
    push(mc, root.kind, root.kind);
  }

  for (const p of settings.extraDirs || []) push(p, 'custom', '自定义');

  return list;
}

/** 是否为 PCL/HMCL 的隔离实例目录（内含 mods/config/saves 等独立数据） */
function isIsolatedInstance(instanceDir) {
  const marks = ['mods', 'config', 'saves', 'options.txt', 'logs'];
  return marks.some((m) => fs.existsSync(path.join(instanceDir, m)));
}

module.exports = { all, findLauncherRoots, isIsolatedInstance, norm };
