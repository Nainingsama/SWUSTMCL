'use strict';
/**
 * build:win —— 产出 Windows 免安装便携包。
 *
 * 方案：不引入 electron-builder（重依赖），
 *   1. 把 electron 运行时（node_modules/electron/dist）整体铺进 dist/SWUSTMCL/；
 *   2. electron.exe 重命名为 SWUSTMCL.exe（Electron 按 resources/app 顺序找应用）；
 *   3. 应用源码放进 resources/app/（package.json + main/ + renderer/ + 生产依赖）；
 *   4. 整体打成 dist/SWUSTMCL-<版本>-win-x64.zip，打印体积与 SHA-256（发布用）。
 *
 * 用法：npm run build:win
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'SWUSTMCL');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function log(msg) {
  console.log(`[build] ${msg}`);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copy(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      if (ent.name === '.tmp' || ent.name === 'shots') continue;
      copy(path.join(src, ent.name), path.join(dest, ent.name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try { total += fs.statSync(full).size; } catch {}
      }
    }
  };
  walk(p);
  return total;
}

async function main() {
  log(`打包 星启 SWUSTMCL v${pkg.version}`);

  // 0. 前置检查：Electron 必须已安装（二进制已下载）
  const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
  const electronExe = path.join(electronDist, 'electron.exe');
  if (!fs.existsSync(electronExe)) {
    console.error('[build] 未找到 electron 运行时，请先运行：npm install');
    process.exit(1);
  }

  // 1. 清理并搭舞台
  rmrf(dist);
  fs.mkdirSync(stage, { recursive: true });

  // 2. 运行时
  log('复制 Electron 运行时…');
  copy(electronDist, stage);

  // 3. 主程序改名（Electron 会从 resources/app 加载应用源码）
  fs.renameSync(path.join(stage, 'electron.exe'), path.join(stage, 'SWUSTMCL.exe'));

  // 4. 应用源码 + 生产依赖
  log('写入应用源码…');
  const appRoot = path.join(stage, 'resources', 'app');
  fs.mkdirSync(appRoot, { recursive: true });
  copy(path.join(root, 'main'), path.join(appRoot, 'main'));
  copy(path.join(root, 'renderer'), path.join(appRoot, 'renderer'));
  copy(path.join(root, 'LICENSE'), path.join(appRoot, 'LICENSE'));
  copy(path.join(root, 'README.md'), path.join(appRoot, 'README.md'));
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    main: 'main/main.js',
    author: pkg.author,
    license: pkg.license,
  }, null, 2));

  // 生产依赖（当前仅 adm-zip；electron 不进包）
  log('写入生产依赖…');
  for (const dep of Object.keys(pkg.dependencies || {})) {
    const from = path.join(root, 'node_modules', dep);
    if (fs.existsSync(from)) copy(from, path.join(appRoot, 'node_modules', dep));
    else {
      console.error(`[build] 生产依赖缺失：${dep}，请先 npm install`);
      process.exit(1);
    }
  }

  // 5. 打 zip
  log('压缩为 zip…');
  const zipName = `SWUSTMCL-${pkg.version}-win-x64.zip`;
  const zipPath = path.join(dist, zipName);
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  // 平铺：解压即得 SWUSTMCL/ 目录
  for (const ent of fs.readdirSync(stage, { withFileTypes: true })) {
    const full = path.join(stage, ent.name);
    if (ent.isDirectory()) zip.addLocalFolder(full, `SWUSTMCL/${ent.name}`);
    else zip.addLocalFile(full, 'SWUSTMCL', ent.name);
  }
  zip.writeZip(zipPath);

  const zipSize = fs.statSync(zipPath).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');

  log('—— 完成 ——');
  log(`目录：${stage}（${(dirSize(stage) / 1048576).toFixed(1)} MB）`);
  log(`压缩包：${zipPath}（${(zipSize / 1048576).toFixed(1)} MB）`);
  log(`SHA-256：`);
  console.log(`  ${sha256}`);
  console.log(`\n发布说明可粘贴：`);
  console.log(`  sha256(${zipName})=${sha256}`);
}

main().catch((e) => {
  console.error('[build] 失败：', e);
  process.exit(1);
});
