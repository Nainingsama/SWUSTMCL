'use strict';
/**
 * 第三方皮肤站登录（authlib-injector 标准）。
 *
 * 流程：
 *   1. 用户拖入/粘贴皮肤站的 Yggdrasil API Root（如 https://littleskin.cn/api/yggdrasil）；
 *   2. GET root 拿到站点元信息（serverName 等），用于展示确认；
 *   3. POST {root}/authserver/authenticate 登录，返回 accessToken + 角色列表；
 *   4. 多角色时 POST {root}/authserver/refresh 选定角色；
 *   5. 启动游戏时下载 authlib-injector.jar 并注入：
 *      -javaagent:<jar>=<apiRoot>
 *      游戏参数中的 uuid/name/token 全部使用皮肤站返回值。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const net = require('./net');
const safe = require('./safe');
const log = require('./log');

const INJECTOR_VERSION = '1.2.8';
const INJECTOR_BUILD = 56;
// 下载顺序：官方分发（yushi.moe，国内可通）→ ghproxy 反代 → GitHub 直连
const INJECTOR_URLS = [
  `https://authlib-injector.yushi.moe/artifact/${INJECTOR_BUILD}/authlib-injector-${INJECTOR_VERSION}.jar`,
  `https://ghproxy.net/https://github.com/yushijinhun/authlib-injector/releases/download/v${INJECTOR_VERSION}/authlib-injector-${INJECTOR_VERSION}.jar`,
  `https://github.com/yushijinhun/authlib-injector/releases/download/v${INJECTOR_VERSION}/authlib-injector-${INJECTOR_VERSION}.jar`,
];
const INJECTOR_SHA256 = '9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10';

/** 校验并规范化 API Root：https、去掉尾斜杠 */
function normalizeRoot(url) {
  const raw = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(raw)) throw new Error('皮肤站地址必须是 https:// 开头');
  try {
    const u = new URL(raw);
    if (!u.hostname) throw new Error('地址无效');
  } catch {
    throw new Error('皮肤站地址无效');
  }
  return raw;
}

/** 拉取站点元信息（GET root 本身就是元信息） */
async function fetchMeta(rootUrl) {
  const root = normalizeRoot(rootUrl);
  const meta = await net.fetchJson(root, { timeout: 15000, retries: 1 });
  if (!meta || typeof meta !== 'object' || !meta.meta) {
    throw new Error('该地址不是有效的 authlib-injector API Root（缺少 meta）');
  }
  return {
    root,
    serverName: (meta.meta && meta.meta.serverName) || new URL(root).hostname,
    skinDomains: meta.skinDomains || [],
  };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/** 从 profile.properties 的 textures 属性里解出皮肤直链（authlib-injector 标准） */
function skinUrlOf(p) {
  try {
    const prop = ((p && p.properties) || []).find((x) => x && x.name === 'textures');
    if (!prop || !prop.value) return '';
    const tex = JSON.parse(Buffer.from(String(prop.value), 'base64').toString('utf8'));
    const u = tex && tex.textures && tex.textures.SKIN && tex.textures.SKIN.url;
    return u && /^https?:\/\//.test(u) ? u : '';
  } catch {
    return '';
  }
}

/** 登录：返回 {accessToken, clientToken, profiles, selected} */
async function login(rootUrl, username, password) {
  const root = normalizeRoot(rootUrl);
  const r = await postJson(`${root}/authserver/authenticate`, { username, password });
  const j = r.json;
  if (!r.ok || !j || !j.accessToken) {
    const msg = (j && j.errorMessage) || `HTTP ${r.status}`;
    throw new Error(`皮肤站登录失败：${msg}`);
  }
  const profiles = Array.isArray(j.availableProfiles) ? j.availableProfiles : [];
  if (!profiles.length) throw new Error('该账号没有任何角色（先去皮肤站创建角色）');
  return {
    root,
    accessToken: j.accessToken,
    clientToken: j.clientToken || '',
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, skinUrl: skinUrlOf(p) })),
    selected: j.selectedProfile ? { id: j.selectedProfile.id, name: j.selectedProfile.name, skinUrl: skinUrlOf(j.selectedProfile) } : null,
  };
}

/** 多角色时切换/选定角色（refresh 带上 selectedProfile） */
async function selectProfile(rootUrl, accessToken, profileId) {
  const root = normalizeRoot(rootUrl);
  const r = await postJson(`${root}/authserver/refresh`, {
    accessToken,
    selectedProfile: { id: profileId },
  });
  const j = r.json;
  if (!r.ok || !j || !j.accessToken) {
    throw new Error(`选择角色失败：${(j && j.errorMessage) || `HTTP ${r.status}`}`);
  }
  return {
    accessToken: j.accessToken,
    clientToken: j.clientToken || '',
    selected: j.selectedProfile ? { id: j.selectedProfile.id, name: j.selectedProfile.name, skinUrl: skinUrlOf(j.selectedProfile) } : null,
  };
}

/**
 * 确保 authlib-injector.jar 存在（缺则下载）。
 * 放在启动器自己的 userData/injector/ 下 —— 不写用户的 .minecraft：
 * 那里可能只读/被占用/被安全软件拦（实测 EPERM），而且不该污染游戏目录。
 */
async function ensureInjector() {
  const dir = path.join(app.getPath('userData'), 'injector');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const dest = path.join(dir, `authlib-injector-${INJECTOR_VERSION}.jar`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100 * 1024) return dest;
  try { fs.rmSync(dest + '.part', { force: true }); } catch {} // 清理上次残留（可能被锁/只读）
  log.info('下载 authlib-injector 注入器…');
  let lastErr;
  for (const url of INJECTOR_URLS) {
    try {
      await net.download(url, dest, {
        expectZip: true,
        retries: 1,
        timeout: 45000,
        expectedSha256: INJECTOR_SHA256,
      });
      log.info('authlib-injector 就绪：' + url.split('/')[2]);
      return dest;
    } catch (e) {
      lastErr = e;
      try { fs.rmSync(dest, { force: true }); } catch {}
      try { fs.rmSync(dest + '.part', { force: true }); } catch {}
    }
  }
  throw new Error(`注入器下载失败——所有镜像均不可达（${lastErr ? lastErr.message : '网络错误'}）。请检查网络或开启 DoH 后重试`);
}

module.exports = { normalizeRoot, fetchMeta, login, selectProfile, ensureInjector, INJECTOR_VERSION };
