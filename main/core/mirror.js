'use strict';
/**
 * 下载源重写。国内直连 Mojang 慢，BMCLAPI 提供同构镜像，改 host 即可。
 * 单文件下载走「主源失败换备用源」；版本清单走双源竞速（versions.js）。
 */

const RULES = [
  ['launchermeta.mojang.com', 'bmclapi2.bangbang93.com', ''],
  ['piston-meta.mojang.com', 'bmclapi2.bangbang93.com', ''],
  ['launcher.mojang.com', 'bmclapi2.bangbang93.com', ''],
  ['piston-data.mojang.com', 'bmclapi2.bangbang93.com', ''],
  ['resources.download.minecraft.net', 'bmclapi2.bangbang93.com', '/assets'],
  ['libraries.minecraft.net', 'bmclapi2.bangbang93.com', '/maven'],
];

const MANIFEST = {
  mojang: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  bmcl: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
};

const BMCL = 'https://bmclapi2.bangbang93.com';

/** 把官方 URL 改写到指定源 */
function rewrite(url, source) {
  if (!url || source === 'mojang') return url;
  try {
    const u = new URL(url);
    for (const [host, mirror, prefix] of RULES) {
      if (u.hostname === host) {
        return `https://${mirror}${prefix + u.pathname}${u.search || ''}`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

module.exports = { rewrite, MANIFEST, BMCL };
