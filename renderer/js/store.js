'use strict';
/**
 * 轻量状态机 + 发布订阅。
 * 全局唯一实例 window.Store：渲染层所有页面共享的运行时状态。
 */
(function () {
  const listeners = new Map(); // key -> Set<fn>

  const state = {
    settings: null,       // 主进程配置（镜像）
    account: null,        // { mode, name, uuid, ... }
    dirs: [],             // 游戏目录
    installed: [],        // 已安装实例
    javaList: [],
    latestRelease: '',
    gameRunning: false,
    installProgress: {},  // id -> {percent, message, stage}
    view: 'home',
    newReleaseInfo: null, // { version } 待安装提示
    updateInfo: null,     // 启动器更新
    saveGroup: 'folder',
    taskMap: {},
  };

  function get(key) {
    return state[key];
  }

  function set(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      if (state[k] !== v) {
        state[k] = v;
        changed.push(k);
      }
    }
    for (const k of changed) {
      const subs = listeners.get(k);
      if (subs) for (const fn of subs) {
        try { fn(state[k], k); } catch (e) { console.error('[store]', e); }
      }
    }
    // 通配订阅
    const all = listeners.get('*');
    if (all && changed.length) for (const fn of all) fn(state, changed);
  }

  function on(key, fn) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key).delete(fn);
  }

  window.Store = { get, set, on, state };
})();
