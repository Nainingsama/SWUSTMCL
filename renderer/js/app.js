'use strict';
/**
 * 应用入口：路由（淡出→淡入+上浮）、初始化、事件接线、日志抽屉。
 */
(function () {
  const { h } = window.Dom;
  const Pages = window.Pages;

  const VIEW_TITLES = {
    home: '首页', domains: '域', versions: '版本管理', download: '下载游戏',
    account: '账户', downloads: '记录', servers: '服务器',
    packs: '整合包', content: '资源', saves: '存档', settings: '设置',
  };

  const app = {
    current: 'home',

    async goto(view) {
      if (!VIEW_TITLES[view] || view === this.current) return;
      const prev = document.querySelector(`.view[data-view="${this.current}"]`);
      const next = document.querySelector(`.view[data-view="${view}"]`);
      if (!next) return;

      document.querySelectorAll('.nav-item').forEach((n) =>
        n.classList.toggle('active', n.dataset.view === view));
      document.getElementById('topbarViewName').textContent = VIEW_TITLES[view];

      const switchNow = () => {
        if (prev) prev.classList.remove('active');
        next.classList.add('active');
        window.Store.set({ view });
        this.current = view;
        const page = Pages[view];
        // 首次进入渲染，之后只刷新
        if (page && page.render && !next.dataset.rendered) {
          try {
            page.render(next);
            next.dataset.rendered = '1';
          } catch (e) {
            console.error('[init] 页面渲染失败:', e);
            next.innerHTML = '<div class="empty"><div class="empty-icon">⚠</div><div>页面渲染失败：</div><pre style="white-space:pre-wrap;color:#ff8d92">' + String((e && e.stack) || e).replace(/[<>&]/g, '') + '</pre></div>';
          }
        }
        if (page && page.onShow) page.onShow();
        // 切换页面回到顶部：避免沿用上一页的滚动位置（首页看起来像布局变了）
        const mainEl = document.getElementById('main');
        if (mainEl) mainEl.scrollTop = 0;
      };

      if (prev && !document.body.classList.contains('reduce-motion')) {
        prev.classList.add('leaving');
        setTimeout(() => {
          prev.classList.remove('leaving');
          switchNow();
        }, 140);
      } else {
        switchNow();
      }
    },

    async refreshInstalled() {
      // 防重入：download.onShow 会再调 refreshInstalled，无条件递归会把主循环饿死
      if (window.__refreshingInstalled) return;
      window.__refreshingInstalled = true;
      if (window.Pages && window.Pages.versions && window.Pages.versions.invalidateDetailCache) window.Pages.versions.invalidateDetailCache();
      try {
        const list = await window.smcl.installed();
        window.Store.set({ installed: list });
        // 体积后台补齐（30 秒节流，避免频繁全盘扫描）
        if (!window.__sizesAt || Date.now() - window.__sizesAt > 30000) {
          window.__sizesAt = Date.now();
          window.smcl.sizes().catch(() => {});
        }
        const page = Pages[this.current];
        if (page && page.onShow) page.onShow();
      } catch {} finally {
        window.__refreshingInstalled = false;
      }
    },

    updateAccountCard() {
      const acc = window.Store.get('account');
      if (!acc) return;
      document.getElementById('accountName').textContent = acc.name;
      document.getElementById('accountMode').textContent = acc.mode === 'msa' ? '正版' : acc.mode === 'authlib' ? ((window.Store.get('settings') || {}).authlibNames || {})[acc.root] || acc.serverName || '皮肤站' : '离线';
      window.smcl.getAvatar(acc.uuid, acc.name).then((r) => {
        if (r && r.dataUrl) {
          window.SkinView.drawHead(document.getElementById('sidebarAvatar'), r.dataUrl).catch(() => {});
        } else {
          // 皮肤尚未下载完成：稍后自动重试一次
          setTimeout(() => window.app.updateAccountCard(), 4000);
        }
      }).catch(() => {});
    },

    installLauncherUpdate(info) {
      this.showUpdateModal(info);
    },

    showUpdateModal(r) {
      let modalRef = null;
      modalRef = window.Modal.open({
        title: `启动器更新 ${r.version}`,
        body: (el) => {
          el.append(
            h('div.row', null,
              h('span.badge.badge-green', null, `v${r.current} → v${r.version}`),
              r.asset ? h('span.faint', null, `${(r.asset.size / 1048576).toFixed(1)} MB · SHA-256 校验`) : null,
            ),
            h('div.changelog.mt-12', null, r.notes || '（无更新日志）'),
            r.asset ? null : h('div.muted.mt-12', null, 'Release 里没有找到 Windows 更新包，请前往 GitHub 手动下载。'),
          );
        },
        footer: [
          h('button.btn.pressable', { onclick: () => modalRef.close(false) }, '稍后'),
          r.asset
            ? h('button.btn.btn-primary.pressable', {
                onclick: async () => {
                  const body = modalRef.bodyEl;
                  window.Dom.clear(body).append(
                    h('div.col', { style: { gap: '10px', padding: '20px 0' } },
                      h('div.progress', null, h('div.progress-bar#updBar', { style: { width: '0%' } })),
                      h('div.progress-meta', null, h('span#updMsg', null, '准备下载…'), h('span#updPct', null, '')),
                    ),
                  );
                  try {
                    await window.smcl.installUpdate(r.asset);
                    window.Toast.success('更新包校验完成，即将重启换装…');
                  } catch (e) {
                    window.Toast.error(e.message.replace(/^Error: /, ''));
                    modalRef.close(false);
                  }
                },
              }, '下载并安装')
            : h('button.btn.btn-primary.pressable', { onclick: () => window.smcl.openUrl(r.htmlUrl || 'https://github.com/swustmcl/SWUSTMCL/releases').catch(() => {}) }, '前往下载'),
        ],
      });
    },
  };

  // ------------------------------------------------------------ 初始化
  async function init() {
    // 状态
    const state = await window.smcl.state();
    window.Store.set({
      settings: state.settings,
      account: state.account,
      dirs: state.dirs,
      gameRunning: state.gameRunning,
      latestRelease: state.latestRelease,
      sysMemory: state.sysMemory || 0,
      taskMap: state.taskMap || {},
      cfReady: state.cfReady || false,
    });

    // 主题先行，避免闪白
    window.Theme.applyAll(state.settings, null);
    // 壁纸取色缓存
    if (state.settings && state.settings.wallpaper && (state.settings.wallpaper.image || state.settings.wallpaper.imageLight)) {
      try {
        const slotImg = state.settings.theme === 'light' ? state.settings.wallpaper.imageLight : state.settings.wallpaper.image;
        const t = await window.smcl.wallpaperPalette(slotImg || state.settings.wallpaper.image || state.settings.wallpaper.imageLight);
        window.Store.set({ wallpaperTheme: t });
        window.Theme.applyAll(state.settings, t);
      } catch {}
    }

    // 渲染首页
    Pages.home.render(document.querySelector('.view[data-view="home"]'));

    // 并行加载数据
    window.app.refreshInstalled();
    window.smcl.detectJava().then((l) => window.Store.set({ javaList: l })).catch(() => {});
    window.smcl.sizes().catch(() => {});

    // 物理内存（用于内存滑块上限）
    try {
      const mem = await new Promise((resolve) => {
        // os.totalmem 没暴露给渲染层，从 state 里补——主进程 app:state 返回
        resolve(window.Store.state.sysMemory);
      });
      if (mem) document.documentElement.style.setProperty('--sys-mem', fmtMem(mem));
    } catch {}

    window.app.updateAccountCard();

    // ---------- 窗口控制 ----------
    document.getElementById('btnMin').onclick = () => window.smcl.win.minimize();
    document.getElementById('btnMax').onclick = () => window.smcl.win.maximize();
    document.getElementById('btnClose').onclick = () => window.smcl.win.close();

    // ---------- 导航 ----------
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => window.app.goto(btn.dataset.view));
    });
    document.getElementById('accountCard').addEventListener('click', () => window.app.goto('account'));

    // ---------- 日志抽屉 ----------
    initLogDrawer();

    // ---------- 事件：设置变更 ----------
    window.smcl.onSettingsChanged((s) => {
      window.Store.set({ settings: s });
      window.Theme.applyAll(s, window.Store.get('wallpaperTheme'));
    });

    // ---------- 全局下载任务卡（类似 PCL 的悬浮进度） ----------
    const TaskCard = {
      show(name) {
        const c = document.getElementById('taskCard');
        if (!c) return;
        c.hidden = false;
        c.classList.remove('hide', 'done', 'fail');
        document.getElementById('taskName').textContent = name;
      },
      update(p) {
        const c = document.getElementById('taskCard');
        if (!c || c.hidden) return;
        const bar = document.getElementById('taskBar');
        const msg = document.getElementById('taskMsg');
        const pct = document.getElementById('taskPct');
        if (bar) bar.style.width = (p.percent || 0) + '%';
        if (msg) msg.textContent = p.message || '';
        if (pct) pct.textContent = p.percent != null ? p.percent + '%' : '';
      },
      finish(ok, text) {
        const c = document.getElementById('taskCard');
        if (!c || c.hidden) return;
        c.classList.add(ok ? 'done' : 'fail');
        document.getElementById('taskName').textContent = text || (ok ? '任务完成' : '任务失败');
        document.getElementById('taskBar').style.width = '100%';
        setTimeout(() => { c.hidden = true; }, ok ? 2600 : 4200);
      },
    };
    window.TaskCard = TaskCard;

    // ---------- 任务系统（下载页数据源）+ 右下角任务卡 ----------
    const Tasks = {
      update(name, source, p) {
        const map = window.Store.get('taskMap') || {};
        const t = map[name] || { name, source: source || '本地', status: 'running', start: Date.now() };
        t.percent = p.percent != null ? p.percent : t.percent;
        t.message = p.message || t.message;
        if (p.stage === 'done' || (p.percent != null && p.percent >= 100)) { t.status = 'done'; t.end = Date.now(); }
        map[name] = t;
        window.Store.set({ taskMap: { ...map } });
      },
      fail(name, msg) {
        const map = window.Store.get('taskMap') || {};
        const t = map[name];
        if (!t) return;
        t.status = 'failed';
        t.message = msg || t.message;
        t.end = Date.now();
        window.Store.set({ taskMap: { ...map } });
      },
    };
    window.Tasks = Tasks;
    const taskFrom = (nameFn, srcFn) => (p) => {
      const name = typeof nameFn === 'function' ? nameFn(p) : nameFn;
      const source = typeof srcFn === 'function' ? srcFn(p) : (srcFn || '本地');
      Tasks.update(name, source, p);
      TaskCard.show(name);
      TaskCard.update(p);
      if (p.stage === 'done' || (p.percent != null && p.percent >= 100)) TaskCard.finish(true, name + ' 完成');
    };

    // ---------- 事件：安装进度 ----------
    window.smcl.onInstall(taskFrom((p) => '安装 ' + (p.id || ''), () => 'Minecraft'));
    window.smcl.onInstall((p) => {
      const prog = window.Store.get('installProgress') || {};
      prog[p.id] = p;
      window.Store.set({ installProgress: { ...prog } });
      Pages.download.onProgress && Pages.download.onProgress(p);
      Pages.versions.onProgress && Pages.versions.onProgress(p);
    });
    window.smcl.onLoader((p) => { Pages.download.onProgress && Pages.download.onProgress(p); });
    window.smcl.onLoader(taskFrom((p) => '安装加载器 ' + (p.loader || ''), () => 'Minecraft'));
    window.smcl.onJavaProgress(taskFrom((p) => '下载 Java ' + (p.major || '')));
    window.smcl.onLoader(taskFrom((p) => '安装加载器 ' + (p.loader || '')));
    window.smcl.onPack((p) => { Pages.packs.onProgress && Pages.packs.onProgress(p); });
    window.smcl.onPack(taskFrom((p) => '导入整合包 ' + (p.name || ''), () => '本地'));
    window.smcl.onPack(taskFrom((p) => '导入整合包 ' + (p.name || '')));
    window.smcl.onContentProgress(taskFrom((p) => '下载资源', (p) => (p && p.source === 'curseforge' ? 'CurseForge' : 'Modrinth')));
    window.smcl.onSavesProgress((p) => Pages.saves.onProgress && Pages.saves.onProgress(p));

    // ---------- 事件：版本体积 ----------
    // 体积是开机后台扫描逐条推送的：页面没渲染时到达的事件先落缓存，
    // 之后渲染实例卡直接从缓存取值（否则后渲染的行徽章永远停在「…」）
    if (window.smcl.onVersionSize) {
      window.smcl.onVersionSize((p) => {
        window.__sizeCache = window.__sizeCache || {};
        window.__sizeCache[`${p.dir}|${p.id}`] = p.size;
        Pages.versions.onSize && Pages.versions.onSize(p);
      });
    }

    // ---------- 事件：游戏 ----------
    // 顶栏运行状态指示（支持多开：记录每个运行中的游戏进程）
    const runningGames = []; // { id, pid }
    const syncTopbarStatus = () => {
      const n = runningGames.length;
      const wrap = document.getElementById('topbarStatus');
      if (!wrap) return;
      wrap.hidden = false;
      document.getElementById('topbarDot').style.background = n ? '#3dd68c' : 'rgba(150,160,180,0.6)';
      document.getElementById('topbarStatusText').textContent = n
        ? (n > 1 ? '共 ' + n + ' 个游戏窗口运行中 · 日志见底部抽屉' : '游戏正在运行 · 日志见底部抽屉')
        : '没有运行中的实例';
      document.getElementById('topbarStopBtn').hidden = !n;
      window.Store.set({ gameRunning: n > 0, runningGames: runningGames.slice() });
    };
    const dropRunning = (pid) => {
      const i = pid ? runningGames.findIndex((g) => g.pid === pid) : 0;
      if (i >= 0 && i < runningGames.length) runningGames.splice(i, 1);
    };
    syncTopbarStatus();
    window.Store.on('gameRunning', syncTopbarStatus);
    window.smcl.onGameStarted((p) => {
      runningGames.push({ id: (p && p.id) || '?', pid: (p && p.pid) || 0 });
      syncTopbarStatus();
    });
    window.smcl.onGameExit(({ pid, code }) => {
      dropRunning(pid);
      syncTopbarStatus();
      window.Toast.info(`游戏已退出（代码 ${code ?? '-'}）`);
    });
    // 关闭启动器询问（主题化弹窗）
    let closePromptOpen = false;
    window.smcl.onClosePrompt(() => {
      if (closePromptOpen) return;
      closePromptOpen = true;
      const remember = h('input', { type: 'checkbox', style: { width: '15px', height: '15px', accentColor: 'var(--accent)' } });
      const m = window.Modal.open({
        title: '关闭启动器',
        dismissible: false, // 必须明确选择，避免误触把状态卡死
        body: (el) => el.append(
          h('div', { style: { fontSize: '13.5px', lineHeight: '1.65' } }, '要最小化启动器，还是直接退出？'),
          h('div.faint', { style: { marginTop: '6px' } }, '已启动的游戏窗口不会被关闭。'),
          h('label.row', { style: { marginTop: '14px', gap: '8px', cursor: 'pointer', fontSize: '12.5px' } },
            remember,
            h('span', null, '记住本次选择（以后不再提示，可在设置里修改）'),
          ),
        ),
        footer: [
          h('button.btn', { onclick: () => choose('cancel') }, '取消'),
          h('button.btn', { onclick: () => choose('minimize') }, '最小化'),
          h('button.btn.btn-primary', { onclick: () => choose('close') }, '直接退出'),
        ],
      });
      // 无论通过按钮、Esc 还是窗口关闭而消失，都要复位，否则后续点 X 既不出弹窗也关不掉
      m.then(() => { closePromptOpen = false; });
      function choose(action) {
        const r = remember.checked;
        closePromptOpen = false;
        m.close(null);
        window.smcl.closeChoice({ action, remember: r }).catch(() => {});
      }
    });
    window.smcl.onGameError(({ message, pid }) => {
      dropRunning(pid);
      syncTopbarStatus();
      window.Toast.error(`游戏进程错误：${message}`);
    });
    document.getElementById('topbarStopBtn').addEventListener('click', async (e) => {
      if (runningGames.length <= 1) {
        try { await window.smcl.kill(runningGames[0] && runningGames[0].pid); } catch (err) { window.Toast.error(err.message); }
        return;
      }
      // 多开：列出每个窗口，选择结束哪一个
      const panel = h('div.float-panel.menu-panel');
      const close = () => { panel.remove(); document.removeEventListener('mousedown', onDoc, true); };
      const onDoc = (ev) => { if (!panel.contains(ev.target)) close(); };
      panel.append(h('div', { style: { padding: '6px 10px', fontSize: '12px', color: 'var(--text-dim)' } }, '结束哪一个游戏？'));
      for (const [i, g] of runningGames.entries()) {
        panel.append(h('button.menu-item', {
          onclick: async () => { close(); try { await window.smcl.kill(g.pid); } catch (err) { window.Toast.error(err.message); } },
        }, `结束 ${g.id} #${i + 1}`));
      }
      panel.append(h('button.menu-item.danger', {
        onclick: async () => { close(); try { await window.smcl.kill(); } catch (err) { window.Toast.error(err.message); } },
      }, '全部结束'));
      document.body.append(panel);
      const r = e.currentTarget.getBoundingClientRect();
      const pw = panel.offsetWidth || 190;
      panel.style.left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 12)) + 'px';
      panel.style.top = (r.bottom + 6) + 'px';
      setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    });

    // ---------- 事件：新版本 ----------
    window.smcl.onNewRelease(({ version, gotoInstall }) => {
      window.Store.set({ newReleaseInfo: { version } });
      Pages.home.onShow && Pages.home.onShow();
      if (gotoInstall) window.app.goto('download');
    });
    window.smcl.onUpdateAvailable((r) => {
      window.Store.set({ updateInfo: r });
      Pages.home.onShow && Pages.home.onShow();
    });
    window.smcl.onUpdateProgress((p) => {
      const bar = document.getElementById('updBar');
      const msg = document.getElementById('updMsg');
      const pct = document.getElementById('updPct');
      if (bar) bar.style.width = `${p.percent || 0}%`;
      if (msg) msg.textContent = p.message || '';
      if (pct) pct.textContent = p.percent != null ? `${p.percent}%` : '';
    });
    window.smcl.onUpdateChangelog(({ version, notes }) => {
      let modalRef = null;
      modalRef = window.Modal.open({
        title: `已更新到 v${version} 🎉`,
        body: (el) => el.append(h('div.changelog', null, notes || '本次更新完成了。')),
        footer: [h('button.btn.btn-primary.pressable', { onclick: () => modalRef.close(true) }, '好的')],
      });
    });

    // ---------- 拖拽：capture 阶段处理（跨窗口拖入的链接/文本 → 皮肤站识别）----------
    // PCL 同款体验：拖入的 URL 自动填入并识别；拖悬时显示确认浮层
    let dropHover = false;
    /** 从剪贴板读 URL → 填入皮肤站输入框并识别（PCL 式剪贴板导入） */
    async function importFromClipboard(silent) {
      try {
        const text = await window.smcl.clipboardRead();
        const mm = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
        const urlInput = document.querySelector('#alUrl');
        if (!mm) { if (!silent) window.Toast.warn('剪贴板里没有网址 —— 先点皮肤站卡片上的复制按钮'); return false; }
        if (!urlInput) { if (!silent) window.Toast.warn('请先打开「账户」页的皮肤站面板'); return false; }
        urlInput.value = mm[0].replace(/\/+$/, '');
        urlInput.dispatchEvent(new Event('change'));
        window.Toast && window.Toast.success('已识别皮肤站地址：' + mm[0].slice(0, 50));
        hideDropTip();
        return true;
      } catch (e) { if (!silent) window.Toast.error(e.message); return false; }
    }
    window.__importFromClipboard = importFromClipboard;

    function hideDropTip() {
      dropHover = false;
      const t = document.getElementById('__dropTip');
      if (t) t.style.display = 'none';
    }

    const dropTip = () => {
      let t = document.getElementById('__dropTip');
      if (!t) {
        t = document.createElement('div');
        t.id = '__dropTip';
        t.style.cssText = 'position:fixed;inset:0;z-index:99;display:grid;place-items:center;cursor:pointer;background:rgba(10,14,22,0.45);backdrop-filter:blur(3px);';
        t.innerHTML = '<div style="padding:26px 46px;border-radius:16px;border:2px dashed var(--accent,#4b8df0);background:rgba(16,21,32,0.92);color:#fff;font-size:16px;font-weight:650;letter-spacing:0.04em;text-align:center;line-height:1.9;">🫳 松手导入皮肤站<br><span style="font-size:12.5px;font-weight:400;color:#9fb2d0;">或在网页上点「复制」后点击此处 —— 自动读取剪贴板</span></div>';
        t.addEventListener('click', () => importFromClipboard(false));
        document.body.appendChild(t);
      }
      return t;
    };
    window.addEventListener('dragenter', (e) => {
      // text/html 也要认：很多站的 API 卡片拖出时只带 html，不带 uri-list
      const hasUrl = [...(e.dataTransfer && e.dataTransfer.types || [])].some((t) => t === 'text/uri-list' || t === 'text/plain' || t === 'text/html');
      if (hasUrl) {
        dropHover = true;
        dropTip().style.display = 'grid';
        // 剪贴板轮询：网站卡片若带「复制」按钮，点一下即自动导入（无需真拖到窗口）
        if (!window.__clipPoll) {
          let tries = 0;
          window.__clipPoll = setInterval(async () => {
            tries += 1;
            if (tries > 30 || !dropHover) { clearInterval(window.__clipPoll); window.__clipPoll = null; return; }
            const done = await importFromClipboard(true); // silent
            if (done) { clearInterval(window.__clipPoll); window.__clipPoll = null; }
          }, 600);
        }
      }
    }, true);
    window.addEventListener('dragover', (e) => { e.preventDefault(); }, true);
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null && dropHover) hideDropTip();
    }, true);
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      hideDropTip();
      // 拖入本地文件：整合包 zip 直接识别并询问是否安装
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      const zip = files.find((f) => /\.zip$/i.test(f.name || ''));
      if (zip) {
        const p = window.smcl.pathForFile ? window.smcl.pathForFile(zip) : zip.path;
        if (!p) {
          window.Toast.warn('无法读取该文件的路径，请改用「整合包 → 选择文件」');
          return;
        }
        const ok = await window.Modal.confirm({
          title: '导入整合包',
          message: '检测到整合包文件：' + zip.name,
          detail: '将自动识别格式并创建实例（可先预览再确认安装）',
          okText: '去导入',
        });
        if (!ok) return;
        if (window.app.current !== 'packs') window.app.goto('packs');
        setTimeout(() => {
          if (window.Pages.packs && window.Pages.packs.importPath) window.Pages.packs.importPath(p);
        }, 360);
        return;
      }
      const dt = e.dataTransfer || {};
      const text = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
      let mm = String(text).match(/https?:\/\/[^\s"'<>]+/i);
      if (!mm) {
        // 兜底：从拖入的网页片段（text/html）里提取链接（取捕获组，别把 href=" 一起带进去）
        const href = String(dt.getData('text/html') || '').match(/href\s*=\s*["']?(https?:\/\/[^"'>\s]+)/i);
        if (href) mm = [href[1]];
      }
      if (!mm) {
        window.Toast && window.Toast.warn('拖入的内容里没有找到网址');
        return;
      }
      const url = mm[0].replace(/\/+$/, '');
      const urlInput = document.querySelector('#alUrl');
      if (urlInput) {
        urlInput.value = url;
        urlInput.dispatchEvent(new Event('change'));
        window.Toast.success('已识别皮肤站地址');
        return;
      }
      // 没打开面板：先验证是不是 authlib 皮肤站，是就自动打开「添加角色 → 第三方认证」并预填
      try {
        const meta = await window.smcl.authlibMeta(url);
        window.Toast.success('识别到皮肤站：' + (meta.serverName || meta.root));
        if (window.app.current !== 'account') window.app.goto('account');
        setTimeout(() => {
          if (window.Pages && window.Pages.account && window.Pages.account.openAuthlibUrl) {
            window.Pages.account.openAuthlibUrl(url);
          }
        }, 320);
      } catch {
        window.Toast.warn('拖入的地址不是有效的皮肤站（需 authlib-injector 兼容的 API 地址）');
      }
    }, true);

    // 恢复日志
    try {
      const recent = await window.smcl.logRecent();
      for (const line of recent) appendLog(line);
    } catch {}
  }

  function fmtMem(n) {
    return `${(n / 1073741824).toFixed(1)} GB`;
  }

  // ------------------------------------------------------------ 日志抽屉
  let logErrorSeen = false;
  function initLogDrawer() {
    const drawer = document.getElementById('logDrawer');
    const tab = document.getElementById('logTab');
    const lines = document.getElementById('logLines');
    const dot = document.getElementById('logDot');

    tab.addEventListener('click', () => {
      drawer.classList.toggle('expanded');
      if (drawer.classList.contains('expanded')) {
        dot.classList.remove('has-err');
        requestAnimationFrame(() => { lines.scrollTop = lines.scrollHeight; });
      }
    });
    document.getElementById('logClear').addEventListener('click', () => window.smcl.logClear());
    document.getElementById('logToggleWrap').addEventListener('click', (e) => {
      lines.querySelectorAll('.log-line').forEach((l) => l.classList.toggle('nowrap'));
      e.currentTarget.textContent = e.currentTarget.textContent === '自动换行' ? '单行模式' : '自动换行';
    });

    window.smcl.onLog((line) => {
      appendLog(line);
      if (line.level === 'error' || line.level === 'game-err') {
        logErrorSeen = true;
        dot.classList.add('has-err'); // 只亮红点提醒，不自动弹出抽屉
      }
      if (drawer.classList.contains('expanded')) lines.scrollTop = lines.scrollHeight;
    });
    window.smcl.onLogCleared(() => window.Dom.clear(lines));
  }

  function appendLog(line) {
    const lines = document.getElementById('logLines');
    if (!lines) return;
    const t = new Date(line.t);
    const pad = (x) => String(x).padStart(2, '0');
    const el = h(`div.log-line.lvl-${line.level}`,
      null,
      h('span.log-time', null, `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`),
      line.text,
    );
    lines.append(el);
    while (lines.children.length > 1200) lines.removeChild(lines.firstChild);
    if (lines.parentElement && document.getElementById('logDrawer').classList.contains('expanded')) {
      lines.scrollTop = lines.scrollHeight;
    }
  }

  // ---------- Java 选择弹窗 ----------
    window.JavaPicker = {
      async open(current, onPick) {
        let api = null;
        let list = window.Store.get('javaList') || [];
        if (!list.length) {
          try { list = await window.smcl.detectJava(); window.Store.set({ javaList: list }); } catch {}
        }
        window.Modal.open({
          title: '选择 Java 版本',
          size: 'lg',
          body: (el) => {
            if (!list.length) {
              el.append(h('div.empty', null, '未检测到 Java —— 请先安装 JDK，或在下方手动浏览'));
              return;
            }
            el.append(h('div.row.row-wrap.mb-12', null,
              h('span.badge.badge-blue', null, `${list.length} 个已检测`),
              h('span.faint', null, '点击「选择」填入，或切换到全局 Java'),
            ));
            const cur = (current || '').toLowerCase();
            for (const j of list) {
              const isCur = cur && j.path.toLowerCase() === cur;
              el.append(h('div.dl-row', null,
                h('span.badge.' + (j.major >= 21 ? 'badge-green' : j.major >= 17 ? 'badge-blue' : 'badge'), null, 'Java ' + j.major),
                h('div.grow', { style: { minWidth: 0 } },
                  h('div', { style: { fontWeight: '600', fontSize: '13px' } }, `${j.version} · ${j.vendor} · ${j.bits} 位`),
                  h('div.faint.mono.ellipsis', { title: j.path }, j.path),
                ),
                h('span.badge', null, j.source),
                isCur
                  ? h('span.badge.badge-green', null, '✓ 当前')
                  : h('button.btn.btn-sm.pressable', {
                      onclick: () => { onPick(j.path); api.close(j.path); },
                    }, '选择'),
              ));
            }
          },
        });
      },
    };


    window.app = app;
  window.app.init = init; // 测试钩子
  document.addEventListener('DOMContentLoaded', () => {
    Promise.resolve(init()).catch((e) => {
      console.error('[init] 初始化失败:', e);
      document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:#ff8d92;font-family:sans-serif;">' +
        '<div style="text-align:center"><h2>启动器初始化失败</h2><pre style="max-width:80vw;white-space:pre-wrap;color:#e9edf5;">' +
        String((e && e.stack) || e).replace(/[<>&]/g, '') + '</pre></div></div>';
    });
  });
})();
