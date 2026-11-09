'use strict';
/**
 * 启动参数构建与游戏进程管理。
 *
 * - 兼容新版 arguments 与旧版 minecraftArguments 两种格式；
 * - 版本隔离：实例内有独立 mods/config/saves 时，--gameDir 与工作目录都指向实例目录；
 * - natives 优先复用 <实例>/natives 里已解压内容；
 * - JVM 参数消毒：版本 JSON 是远端数据，剔除 -javaagent 一类可在启动瞬间
 *   执行任意代码的参数；
 * - classpath 去重（Windows 大小写不敏感）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const versionLib = require('./versions');
const rules = require('./rules');
const settingsLib = require('./settings');
const safe = require('./safe');
const dirsLib = require('./dirs');

const OS_NAME = rules.OS_NAME;

/** 版本 JSON 里的 JVM 参数会被原样传给 java，等同于命令行执行，剔除危险项 */
const FORBIDDEN_JVM_ARG = /^(-javaagent:|-agentlib:|-agentpath:|-Xbootclasspath:|-Xbootclasspath\/[ap]:|-XX:OnError=|-XX:OnOutOfMemoryError=|-XX:+?UnlockDiagnosticVMOptions$)/i;

function sanitizeJvmArgs(args) {
  const out = [];
  for (const arg of args || []) {
    if (typeof arg !== 'string') continue;
    if (FORBIDDEN_JVM_ARG.test(arg.trim())) continue;
    out.push(arg);
  }
  return out;
}

/** 离线 UUID：与主流启动器一致的 v3 规范写法 */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 客户端 jar 可能落在父版本目录（整合包实例 → 加载器 → 原版） */
function resolveClientJar(mcDir, id, meta) {
  const own = path.join(mcDir, 'versions', id, `${id}.jar`);
  if (fs.existsSync(own)) return own;
  let cur = meta && meta.inheritsFrom;
  for (let i = 0; cur && i < 5; i++) {
    const jar = path.join(mcDir, 'versions', cur, `${cur}.jar`);
    if (fs.existsSync(jar)) return jar;
    let next = null;
    try {
      next = JSON.parse(fs.readFileSync(path.join(mcDir, 'versions', cur, `${cur}.json`), 'utf8')).inheritsFrom || null;
    } catch {
      next = null;
    }
    cur = next;
  }
  try {
    const jar = fs.readdirSync(path.join(mcDir, 'versions', id)).find((f) => f.endsWith('.jar'));
    if (jar) return path.join(mcDir, 'versions', id, jar);
  } catch {}
  return own;
}

// 版本 JSON 的 natives 分类器常只写 os.name 不写 arch，按当前架构再筛一遍
function nativesAllowed(name) {
  const cls = String(name || '').split(':')[3];
  if (!cls || !cls.startsWith('natives-')) return true;
  const body = cls.slice('natives-'.length);
  if (OS_NAME === 'windows') {
    if (!body.startsWith('windows')) return false;
    const arch = body.slice('windows'.length).replace(/^-/, '');
    if (!arch) return process.arch === 'x64';
    if (arch === 'x86') return process.arch === 'ia32';
    if (arch === 'arm64') return process.arch === 'arm64';
    return false;
  }
  return true;
}

function dedupePaths(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const key = p.toLowerCase(); // Windows 路径大小写不敏感
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function libraryEntries(meta, mcDir) {
  const classpath = [];
  const nativeJars = [];
  for (const lib of meta.libraries || []) {
    if (!rules.allowed(lib.rules, {})) continue;
    const name = lib.name || '';
    if (!nativesAllowed(name)) continue;
    const classifier = String(name).split(':')[3] || '';
    const art = lib.downloads && lib.downloads.artifact;
    if (art && art.path) {
      const p = path.join(mcDir, 'libraries', art.path);
      if (classifier.startsWith('natives-')) nativeJars.push(p);
      else classpath.push(p);
    } else if (!lib.downloads && name) {
      const parts = name.split(':');
      const file = `${parts[1]}-${parts[2]}${parts[3] ? `-${parts[3]}` : ''}.jar`;
      classpath.push(path.join(mcDir, 'libraries', parts[0].replace(/\./g, '/'), parts[1], parts[2], file));
    }
    const nativeKey = lib.natives && lib.natives[OS_NAME];
    if (nativeKey) {
      const cls = nativeKey.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const d = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[cls];
      if (d && d.path) nativeJars.push(path.join(mcDir, 'libraries', d.path));
    }
  }
  return {
    classpath: dedupePaths(classpath.filter((p) => fs.existsSync(p))),
    nativeJars: dedupePaths(nativeJars.filter((p) => fs.existsSync(p))),
  };
}

/** natives 平铺解压到 <实例>/natives，已有同名且同大小的 dll 直接复用 */
function extractNatives(nativeJars, nativesDir) {
  if (!nativeJars.length) return;
  try {
    fs.mkdirSync(nativesDir, { recursive: true });
  } catch {
    return;
  }
  for (const jar of nativeJars) {
    let zip;
    try {
      zip = new AdmZip(jar);
    } catch {
      continue;
    }
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !/\.(dll|so|dylib)$/i.test(entry.entryName)) continue;
      const dest = path.join(nativesDir, path.basename(entry.entryName));
      try {
        if (fs.existsSync(dest) && fs.statSync(dest).size === entry.header.size) continue;
        fs.writeFileSync(dest, entry.getData());
      } catch {}
    }
  }
}

function findLoggingConfig(mcDir, meta) {
  const id = meta.logging && meta.logging.client && meta.logging.client.file && meta.logging.client.file.id;
  if (!id) return null;
  const p = path.join(mcDir, 'assets', 'log_configs', id);
  return fs.existsSync(p) ? p : null;
}

/**
 * java.library.path 不递归子目录，而 PCL 留下的 <实例>-natives 是分层的
 * （lwjgl/lwjgl.dll），直接指过去 JVM 找不到 dll，所以统一平铺到 <实例>/natives。
 */
function resolveNativesDir(instanceDir) {
  const dir = path.join(instanceDir, 'natives');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 构建完整启动命令
 * @returns {{java:string, args:string[], cwd:string, meta:object, playerName:string, gameDir:string, isolated:boolean}}
 */
function build(id, options = {}) {
  safe.assertVersionId(id);
  const settings = settingsLib.all();
  const mcDir = options.sourceDir || settings.mcDir;
  const meta = versionLib.loadVersionJson(mcDir, id);

  // 实例级设置（swustmcl-instance.json）覆盖全局：Java / 内存 / JVM 参数
  const instances = require('./instances');
  const merged = instances.mergedLaunchOptions(
    safe.safeJoin(path.join(mcDir, 'versions'), id),
    { javaPath: options.javaPath || settings.javaPath, memory: options.memory || settings.memory || 4096, jvmArgs: options.jvmArgs || settings.jvmArgs || '' }
  );

  const playerName = (options.playerName || settings.playerName || 'Steve').trim() || 'Steve';
  const acc = options.account && options.account.accessToken ? options.account : null;
  const memory = Math.max(1024, Number(merged.memory || 4096));
  const javaPath = merged.javaPath;
  const instanceDir = safe.safeJoin(path.join(mcDir, 'versions'), id);

  // 版本隔离：实例内有独立数据时强制隔离；否则跟随实例设置/全局设置
  let isolated = dirsLib.isIsolatedInstance(instanceDir);
  if (!isolated) {
    const instCfg = instances.mergedLaunchOptions(instanceDir, {});
    if (instCfg.isolate === true) isolated = true;
    else if (instCfg.isolate === false) isolated = false;
    else if (settings.isolateByDefault) isolated = true;
  }
  const gameDir = isolated ? instanceDir : mcDir;
  const nativesDir = resolveNativesDir(instanceDir);

  const clientJar = resolveClientJar(mcDir, id, meta);
  const { classpath: libs, nativeJars } = libraryEntries(meta, mcDir);
  const classpath = [clientJar, ...libs].join(path.delimiter);
  extractNatives(nativeJars, nativesDir);

  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(options.resolution && options.resolution.enabled),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };

  const assetsName = (meta.assetIndex && meta.assetIndex.id) || meta.assets || 'legacy';
  const legacyAssetsRoot = assetsName === 'pre-1.6'
    ? path.join(mcDir, 'resources')
    : path.join(mcDir, 'assets', 'virtual', assetsName);

  const authlibMode = acc && acc.mode === 'authlib' && options.authlibJar;
  const replacements = {
    '${auth_player_name}': acc ? acc.name : playerName,
    '${version_name}': id,
    '${game_directory}': gameDir,
    '${assets_root}': path.join(mcDir, 'assets'),
    '${game_assets}': legacyAssetsRoot,
    '${assets_index_name}': assetsName,
    '${auth_uuid}': acc ? acc.uuid : offlineUuid(playerName),
    '${auth_access_token}': acc ? acc.accessToken : '0',
    '${auth_session}': acc ? acc.accessToken : '0',
    '${clientid}': 'swustmcl',
    '${auth_xuid}': acc && acc.xuid ? acc.xuid : '0',
    '${user_type}': acc ? (authlibMode ? 'mojang' : 'msa') : 'mojang',
    '${version_type}': meta.type || 'release',
    '${natives_directory}': nativesDir,
    '${library_directory}': path.join(mcDir, 'libraries'),
    '${classpath_separator}': path.delimiter,
    '${classpath}': classpath,
    '${launcher_name}': 'SWUSTMCL',
    '${launcher_version}': require('../../package.json').version,
    '${user_properties}': '{}',
    '${resolution_width}': String((options.resolution && options.resolution.width) || 925),
    '${resolution_height}': String((options.resolution && options.resolution.height) || 530),
    '${quickPlayPath}': '',
    '${quickPlaySingleplayer}': '',
    '${quickPlayMultiplayer}': '',
    '${quickPlayRealms}': '',
  };

  const apply = (s) => {
    let out = s;
    for (const [k, v] of Object.entries(replacements)) {
      if (out.includes(k)) out = out.split(k).join(v);
    }
    return out;
  };

  // ---- JVM 参数 ----
  const jvm = [];
  const loggingConfig = findLoggingConfig(mcDir, meta);
  const minMem = Math.min(1024, Math.floor(memory / 2));

  if (meta.arguments && Array.isArray(meta.arguments.jvm)) {
    const raw = sanitizeJvmArgs(rules.flatten(meta.arguments.jvm, features));
    if (!raw.some((a) => a.startsWith('-Xmx'))) {
      jvm.push(`-Xmx${memory}M`, `-Xms${minMem}M`);
    }
    jvm.push(...raw.map(apply));
  } else {
    jvm.push(`-Xmx${memory}M`, `-Xms${minMem}M`);
    jvm.push(`-Djava.library.path=${nativesDir}`);
    jvm.push('-cp', classpath);
  }

  if (!jvm.includes('-Dfile.encoding=UTF-8')) {
    jvm.push('-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8');
  }
  if (loggingConfig) {
    jvm.push(`-Dlog4j.configurationFile=${loggingConfig}`);
    jvm.push('-Dlog4j2.formatMsgNoLookups=true');
  }
  // 皮肤站（authlib-injector）注入：javaagent 指向 api root
  if (authlibMode) {
    jvm.push(`-javaagent:${options.authlibJar}=${acc.root}`);
    jvm.push('-Dauthlibinjector.side=client');
  }

  const extra = (merged.jvmArgs || '').trim();
  if (extra) jvm.push(...extra.split(/\s+/).filter(Boolean));

  // 版本 JSON 里的 library.path 常指向不存在的分层目录，统一改指平铺目录
  const libPathIndex = jvm.findIndex((a) => a.startsWith('-Djava.library.path='));
  if (libPathIndex >= 0) jvm[libPathIndex] = `-Djava.library.path=${nativesDir}`;
  else jvm.push(`-Djava.library.path=${nativesDir}`);

  // ---- 游戏参数 ----
  let game = [];
  if (meta.arguments && Array.isArray(meta.arguments.game)) {
    game = rules.flatten(meta.arguments.game, features).map(apply);
  } else if (meta.minecraftArguments) {
    game = meta.minecraftArguments.split(/\s+/).filter(Boolean).map(apply);
  }

  if (options.fullscreen && !game.includes('--fullscreen')) game.push('--fullscreen');
  // 服务器一键加入：--server <host> --port <port>
  if (options.server && options.server.host) {
    game.push('--server', String(options.server.host));
    if (options.server.port) game.push('--port', String(options.server.port));
  }

  return {
    java: javaPath || 'javaw.exe',
    args: [...jvm, meta.mainClass, ...game],
    cwd: gameDir,
    meta,
    playerName,
    gameDir,
    isolated,
    command: `${javaPath || 'javaw.exe'} ${[...jvm, meta.mainClass, ...game].join(' ')}`,
  };
}

/** 启动前确认 java 路径确实是 javaw/java，而不是任意程序 */
function assertJavaPath(java) {
  if (!java || typeof java !== 'string') throw new Error('未指定 Java 运行时');
  if (!/^javaw?(\.exe)?$/.test(path.basename(java).toLowerCase())) {
    throw new Error('Java 路径必须是 javaw.exe 或 java.exe');
  }
  let st;
  try {
    st = fs.statSync(java);
  } catch {
    throw new Error('Java 路径不存在');
  }
  if (!st.isFile()) throw new Error('Java 路径不是文件');
  return java;
}

/**
 * 启动游戏进程
 * @param {string} id
 * @param {object} options
 * @param {{onLog:(s:string, isError?:boolean)=>void, onExit:(code:number|null)=>void, onError:(e:Error)=>void}} handlers
 */
function launch(id, options, handlers = {}) {
  const built = build(id, options);
  const { java, args, cwd } = built;
  assertJavaPath(java);

  const child = spawn(java, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  const pipe = (stream, isError) => {
    if (!stream) return;
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim() && handlers.onLog) handlers.onLog(line, isError);
      }
    });
  };

  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on('error', (err) => handlers.onError && handlers.onError(err));
  child.on('close', (code) => handlers.onExit && handlers.onExit(code));

  return { child, pid: child.pid, command: built.command, gameDir: built.gameDir, isolated: built.isolated };
}

module.exports = {
  launch, build, offlineUuid, extractNatives, sanitizeJvmArgs, assertJavaPath,
  libraryEntries, resolveClientJar, nativesAllowed,
};
