'use strict';
/**
 * 账号管理。
 *
 * - 微软正版：设备码流程 + 按通道自动续期；令牌经 safeStorage 加密落盘。
 * - 离线账户：本地皮肤（64x64 / 64x32 / 128 高清），纸娃娃预览数据。
 * - 头像：从皮肤纹理裁 8x8 头部（含帽子层），缓存 6 小时。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');

const auth = require('./auth');
const settingsLib = require('./settings');
const net = require('./net');
const log = require('./log');
const accountstore = require('./accountstore');

// 玩家名 → 正版 UUID 缓存（离线用户尝试展示同名正版皮肤）
const mojangUuidCache = new Map();
async function fetchMojangUuidByName(name) {
  const key = String(name || '').toLowerCase();
  if (!key) return null;
  if (mojangUuidCache.has(key)) return mojangUuidCache.get(key);
  let out = null;
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const j = await res.json();
      if (j && j.id) out = String(j.id).toLowerCase();
    }
  } catch {}
  mojangUuidCache.set(key, out);
  return out;
}

// 内置默认 Steve 皮肤（64x64 PNG，base64）：离线账户 / 皮肤拉取失败时的最终兜底
const DEFAULT_ALEX_B64 = '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';
const DEFAULT_SKIN_B64 = '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';

let loginAbort = null; // 取消轮询用
let activeStage = null; // 进行中的设备码信息（幂等恢复用）

function accountState() {
  // 以账户库中的“当前账户”为准：旧 secret / loginMode 可能与实际激活账户不同步，
  // 若只看 loginMode + 令牌有效期，正版账户在令牌过期时会错误显示成“离线账户”。
  const act = accountstore.active();
  if (act) {
    const p = act.payload || {};
    if (act.type === 'msa') {
      return {
        mode: 'msa',
        name: act.name || p.name || 'Steve',
        uuid: act.uuid || p.uuid || '',
        skinUrl: (p.skins && p.skins[0] && p.skins[0].url) || '',
        expiresAt: p.expiresAt || 0,
      };
    }
    if (act.type === 'authlib') {
      const sel = p.selected || {};
      return {
        mode: 'authlib',
        name: sel.name || act.name || 'Player',
        uuid: sel.id || act.uuid || '',
        root: p.root || '',
        serverName: p.serverName || '',
        skinUrl: p.skinUrl || '',
        expiresAt: 0,
      };
    }
    if (act.type === 'offline') {
      const nm = act.name || 'Steve';
      return { mode: 'offline', name: nm, uuid: act.uuid || require('./launch').offlineUuid(nm), skinUrl: '', expiresAt: 0 };
    }
  }
  const s = settingsLib.all();
  const al = settingsLib.getSecret('authlib');
  if (s.loginMode === 'authlib' && al && al.selected) {
    return {
      mode: 'authlib',
      name: al.selected.name,
      uuid: al.selected.id,
      root: al.root,
      serverName: al.serverName || '',
      skinUrl: '',
      expiresAt: 0,
    };
  }
  const token = settingsLib.getSecret('msa');
  if (s.loginMode === 'msa' && token && token.expiresAt > Date.now()) {
    return {
      mode: 'msa',
      name: token.name,
      uuid: token.uuid,
      skinUrl: (token.skins && token.skins[0] && token.skins[0].url) || '',
      expiresAt: token.expiresAt,
    };
  }
  return {
    mode: 'offline',
    name: s.playerName || 'Steve',
    uuid: require('./launch').offlineUuid(s.playerName || 'Steve'),
    skinUrl: '',
    expiresAt: 0,
  };
}

/** 启动游戏用：确保令牌新鲜（过期前 60 秒即续期） */
async function ensureFreshToken() {
  const token = settingsLib.getSecret('msa');
  if (!token) return null;
  if (token.expiresAt > Date.now() + 60000) return token;

  log.info('正版令牌已过期，自动续期…');
  try {
    const refreshed = await auth.refreshToken(token.clientId || '', token.refreshToken, token.mode || 'live');
    const profile = await auth.xboxToMinecraft(refreshed.access_token, token.mode || 'live');
    const next = {
      ...profile,
      mode: token.mode || 'live',
      clientId: token.clientId || '',
      refreshToken: refreshed.refresh_token || token.refreshToken,
    };
    settingsLib.setSecret('msa', next);
    accountstore.upsert({ uid: 'msa-' + next.uuid, type: 'msa', name: next.name, uuid: next.uuid, payload: next });
    log.info(`令牌续期成功：${next.name}`);
    return next;
  } catch (e) {
    if (e.invalidGrant) {
      settingsLib.setSecret('msa', null);
      settingsLib.save({ loginMode: 'offline' });
      throw new Error('登录已失效，请重新登录微软账户');
    }
    // 网络问题时旧 token 可能还没到期，能沿用就沿用
    if (token.expiresAt > Date.now()) return token;
    throw e;
  }
}

/**
 * 发起设备码登录（不阻塞，阶段通过回调推给渲染层）。
 * 幂等：已有流程进行中时不再报错，而是把当前设备码重新推给渲染层
 * （用户切去浏览器输码后回到启动器，重开弹窗/重复点击都能看到码）。
 * @param {(stage:object)=>void} onStage
 * @returns {Promise<{name?:string, uuid?:string, already?:boolean}>}
 */
async function loginDeviceCode(onStage = () => {}) {
  if (loginAbort) {
    // 已有流程：恢复展示当前设备码
    if (activeStage && activeStage.userCode) {
      onStage({ ...activeStage, resumed: true });
      return { already: true };
    }
    throw new Error('已有登录流程在进行，请稍候或取消后重试');
  }
  const settings = settingsLib.all();
  const clientId = (settings.msClientId || '').trim();
  const mode = clientId ? 'azure' : 'live';

  const abort = { aborted: false };
  loginAbort = abort;

  try {
    onStage({ stage: 'device', message: '正在获取设备码…' });
    const dc = await auth.startDeviceCode(clientId);
    activeStage = {
      stage: 'code',
      userCode: dc.userCode,
      url: dc.url,
      message: dc.message || `请在 ${dc.url} 输入代码`,
    };
    // 设备码自动进剪贴板，省去手抄
    try {
      const { clipboard } = require('electron');
      clipboard.writeText(dc.userCode);
      activeStage.copied = true;
    } catch {}
    onStage({ ...activeStage });

    const interval = Math.max(3, dc.interval) * 1000;
    const deadline = Date.now() + Math.min(dc.expiresIn || 900, 1200) * 1000;
    let tokens = null;
    while (Date.now() < deadline) {
      if (abort.aborted) throw new Error('已取消登录');
      await auth.sleep(interval);
      const r = await auth.pollToken(clientId, dc.deviceCode, mode);
      if (r.done) {
        tokens = r.tokens;
        break;
      }
      if (r.reason === 'expired') throw new Error('设备码已过期，请重试');
      if (r.reason === 'declined') throw new Error('你在网页上拒绝了授权');
      if (r.reason === 'slow') continue;
    }
    if (!tokens) throw new Error('登录超时，请重试');

    onStage({ stage: 'exchange', message: '正在换取游戏档案…' });
    const profile = await auth.xboxToMinecraft(tokens.access_token, mode);

    const account = {
      ...profile,
      mode,
      clientId,
      refreshToken: tokens.refresh_token || '',
    };
    settingsLib.setSecret('msa', account);
    const uid = accountstore.upsert({ uid: 'msa-' + profile.uuid, type: 'msa', name: profile.name, uuid: profile.uuid, payload: account });
    accountstore.setActive(uid);
    settingsLib.save({ loginMode: 'msa', playerName: profile.name });
    log.info(`微软正版登录成功：${profile.name}`);
    onStage({ stage: 'done', name: profile.name });
    return { name: profile.name, uuid: profile.uuid };
  } finally {
    loginAbort = null;
    activeStage = null;
  }
}

function cancelLogin() {
  if (loginAbort) loginAbort.aborted = true;
}

function logout() {
  settingsLib.setSecret('msa', null);
  settingsLib.save({ loginMode: 'offline' });
  log.info('已退出微软正版登录');
}

// ---------------------------------------------------------------- 头像缓存
const AVATAR_TTL = 6 * 60 * 60 * 1000;

function avatarDir() {
  const dir = path.join(app.getPath('userData'), 'avatars');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 获取玩家皮肤纹理（PNG bytes）。
 * - 正版：account.skins[0].url 或 sessionserver 按 uuid 查
 * - 离线：userData/skins/<小写玩家名>.png（设置页导入）
 * 结果缓存 6 小时（按文件的 mtime 判断），避免每次打开界面都拉网络。
 */
async function fetchSkinTexture(uuid, name, force, hintSkinUrl) {
  const dir = avatarDir();
  const key = String(uuid || name || 'steve').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 40) || 'steve';
  const file = path.join(dir, `${key}.png`);

  if (!force) {
    try {
      const st = await fsp.stat(file);
      if (st.isFile() && Date.now() - st.mtimeMs < AVATAR_TTL && st.size > 0) {
        const bytes = await fsp.readFile(file);
        return { file, cached: true, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
      }
    } catch {}
  }

  let bytes = null;

  // 1) 离线账户本地皮肤
  const skinDir = path.join(app.getPath('userData'), 'skins');
  const localSkin = path.join(skinDir, `${String(name || '').toLowerCase()}.png`);
  try {
    bytes = await fsp.readFile(localSkin);
  } catch {
    bytes = null;
  }

  // 1.2) 皮肤直链（登录/换角色时解析的 textures URL，最可靠）
  if (!bytes && hintSkinUrl) {
    try {
      const res = await fetch(hintSkinUrl, { signal: AbortSignal.timeout(15000) });
      if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
    } catch {}
  }

  // 1.5) 皮肤站（authlib-injector）：资料里记录的皮肤 URL → {root}/skins/{uuid} 兜底
  if (!bytes) {
    const s = settingsLib.all();
    const al = s.loginMode === 'authlib' ? settingsLib.getSecret('authlib') : null;
    if (al && al.root && uuid) {
      const pf = (al.profiles || []).find((p) => p && p.id === uuid);
      if (pf && pf.skinUrl) {
        try {
          const r1 = await fetch(pf.skinUrl, { signal: AbortSignal.timeout(15000) });
          if (r1.ok) bytes = Buffer.from(await r1.arrayBuffer());
        } catch {}
      }
    }
    const al2 = s.loginMode === 'authlib' ? settingsLib.getSecret('authlib') : null;
    if (!bytes && al2 && al2.root && uuid) {
      try {
        const rootBase = al2.root.replace(/\/+$/, '');
        const res = await fetch(rootBase + '/skins/' + uuid, { signal: AbortSignal.timeout(15000) });
        const type = res.headers.get('content-type') || '';
        if (res.ok && type.includes('image')) bytes = Buffer.from(await res.arrayBuffer());
      } catch {}
    }
  }

  // 1.6) 皮肤站 sessionserver 兼容端点（返回 base64 textures）
  if (!bytes) {
    const s = settingsLib.all();
    const al = s.loginMode === 'authlib' ? settingsLib.getSecret('authlib') : null;
    if (al && al.root && uuid) {
      try {
        const res = await fetch(al.root.replace(/\/+$/, '') + '/sessionserver/session/minecraft/profile/' + uuid, { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          const p = await res.json();
          const prop = (p.properties || []).find((x) => x.name === 'textures');
          if (prop) {
            const tex = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
            const tu = tex.textures && tex.textures.SKIN && tex.textures.SKIN.url;
            if (tu && /^https:\/\//.test(tu)) {
              const r2 = await fetch(tu, { signal: AbortSignal.timeout(15000) });
              if (r2.ok) bytes = Buffer.from(await r2.arrayBuffer());
            }
          }
        }
      } catch {}
    }
  }

  // 2) 正版皮肤 URL
  if (!bytes) {
    const s = settingsLib.getSecret('msa');
    const url = s && s.uuid === uuid && s.skins && s.skins[0] ? s.skins[0].url : '';
    if (url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
      } catch {}
    }
  }

  // 3.5) 离线账户：按玩家名查同名正版玩家，有则借其皮肤
  let skinUuid = String(uuid || '');
  if (!bytes) {
    const s = settingsLib.all();
    if (s.loginMode === 'offline') {
      const realId = await fetchMojangUuidByName(name);
      if (realId) skinUuid = realId;
    }
  }

  // 4) sessionserver 兜底（正版 uuid 可查）
  if (!bytes && /^[0-9a-f]{32}$/i.test(skinUuid.replace(/-/g, ''))) {
    try {
      const res = await fetch(
        `https://sessionserver.mojang.com/session/minecraft/profile/${skinUuid.replace(/-/g, '')}`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (res.ok) {
        const p = await res.json();
        const prop = (p.properties || []).find((x) => x.name === 'textures');
        if (prop) {
          const tex = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
          const tu = tex.textures && tex.textures.SKIN && tex.textures.SKIN.url;
          if (tu && /^https:\/\/(textures\.minecraft\.net|textures\.mojang\.com)\//.test(tu)) {
            const r2 = await fetch(tu, { signal: AbortSignal.timeout(15000) });
            if (r2.ok) bytes = Buffer.from(await r2.arrayBuffer());
          }
        }
      }
    } catch {}
  }

  if (!bytes) {
    // 内置默认皮肤：按 UUID 最低 16 位 hex 的奇偶分配 Steve / Alex（与 Mojang 规则一致）
    const hex = String(uuid || '').replace(/-/g, '') || '0';
    let lsb = 0n;
    try { lsb = BigInt('0x' + hex.slice(-16)); } catch {}
    const pick = (lsb & 1n) === 1n ? DEFAULT_ALEX_B64 : DEFAULT_SKIN_B64;
    bytes = Buffer.from(pick, 'base64');
    log.info(`使用默认皮肤（${(lsb & 1n) === 1n ? 'Alex' : 'Steve'}）`);
  }
  try { await fsp.writeFile(file, bytes); } catch {} // 缓存写失败不影响返回
  return { file, cached: false, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
}

/** 离线皮肤导入：校验 PNG 尺寸（64x64 / 64x32 / 宽64 高128+ 的高清） */
async function importLocalSkin(playerName, srcFile) {
  const name = String(playerName || '').trim();
  if (!name || name.length > 32) throw new Error('玩家名无效');
  const file = path.resolve(String(srcFile || ''));
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new Error('皮肤文件不存在');
  if (st.size > 1024 * 1024) throw new Error('皮肤文件过大（上限 1 MB）');

  // PNG 魔数 + IHDR 宽高
  const buf = await fsp.readFile(file);
  if (!(buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
    throw new Error('不是有效的 PNG 文件');
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const valid = (w === 64 && (h === 64 || h === 32)) || (w === 64 && h >= 128) || (w === 128 && h === 128);
  if (!valid) throw new Error(`皮肤尺寸不支持（${w}x${h}），请使用 64x64 / 64x32 / 64x128+ 高清皮肤`);

  const dir = path.join(app.getPath('userData'), 'skins');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${name.toLowerCase()}.png`);
  await fsp.writeFile(dest, buf);
  // 让头像缓存立刻失效
  const state = accountState();
  await fetchSkinTexture(state.uuid, state.name, true).catch(() => {});
  log.info(`已导入离线皮肤：${name}（${w}x${h}）`);
  return { name, w, h, file: dest };
}

function localSkinFile(playerName) {
  const p = path.join(app.getPath('userData'), 'skins', `${String(playerName || '').toLowerCase()}.png`);
  return fs.existsSync(p) ? p : null;
}

/** 清除头像缓存（删除本地皮肤/换皮肤后调用，避免 6 小时缓存展示旧图） */
function clearAvatarCache(uuid, name) {
  const key = String(uuid || name || 'steve').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 40) || 'steve';
  const file = path.join(avatarDir(), key + '.png');
  try { fs.unlinkSync(file); } catch {}
  try {
    for (const f of fs.readdirSync(avatarDir())) {
      // 皮肤文件名同名缓存一并清（离线名与 uuid 双 key 场景）
      if (f.startsWith(key + '.')) fs.unlinkSync(path.join(avatarDir(), f));
    }
  } catch {}
}

module.exports = {
  accountState, clearAvatarCache, ensureFreshToken, loginDeviceCode, cancelLogin, logout,
  fetchSkinTexture, importLocalSkin, localSkinFile,
};
