'use strict';
/**
 * 设置：启动 / Java 与内存 / 网络 / 外观（壁纸 + 主题）/ 系统（GPU兜底、更新）。
 */
(function () {
  const { h, fmtSize } = window.Dom;
  let rootEl = null;
  let wallpaperThemeCache = null;

  const set = (patch) => window.smcl.save(patch).then((s) => window.Store.set({ settings: s })).catch((e) => window.Toast.error(e.message.replace(/^Error: /, '')));

  function render(root) {
    rootEl = root;
    window.Dom.clear(root);
    const s = window.Store.get('settings') || {};

    root.append(h('div.settings-grid', null,
      h('div.col', { style: { gap: '16px' } },
        launchCard(s),
        javaCard(s),
        networkCard(s),
      ),
      h('div.col', { style: { gap: '16px' } },
        appearanceCard(s),
        systemCard(s),
      ),
    ));
  }

  // ------------------------------------------------------------ 启动
  function launchCard(s) {
    const jvmInput = h('input.input.mono', { value: s.jvmArgs || '', placeholder: '例如：-XX:+UseG1GC -Dfml.ignoreInvalidMinecraftCertificates=true', onchange: (e) => set({ jvmArgs: e.target.value }) });
    const memAuto = h('span.switch' + (s.autoMemory ? '.on' : ''), {
      title: '按物理内存自动分配（35%，2048~8192 MB）',
      onclick: () => { memAuto.classList.toggle('on'); set({ autoMemory: memAuto.classList.contains('on') }); },
    });
    const memSlider = h('div.slider-wrap', null,
      slider(s.memory || 4096, 1024, 32768, 512, (v) => set({ memory: v })),
      memAuto,
    );
    const freeMemSwitch = h('button.switch' + (s.autoFreeMemory !== false ? '.on' : ''), {
      onclick: () => { freeMemSwitch.classList.toggle('on'); set({ autoFreeMemory: freeMemSwitch.classList.contains('on') }); },
    });
    const freeNow = h('button.btn.btn-ghost.btn-xs', {
      onclick: async () => {
        freeNow.disabled = true;
        freeNow.textContent = '优化中…';
        try {
          const r = await window.smcl.freeMemory();
          if (r.ok) window.Toast.success(`已整理 ${r.processes} / ${r.total || r.processes} 个进程（其余为系统进程，无权限）`);
          else window.Toast.warn('内存整理未完成');
        } catch (e) { window.Toast.error(e.message); }
        freeNow.disabled = false;
        freeNow.textContent = '立即优化';
      },
    }, '立即优化');
    const fsSwitch = h('button.switch' + (s.fullscreen ? '.on' : ''), { onclick: () => { fsSwitch.classList.toggle('on'); set({ fullscreen: fsSwitch.classList.contains('on') }); } });

    const gameDirInput = h('input.input.mono', { value: s.mcDir || '', readonly: true, style: { fontSize: '11.5px' } });
    const gameDirText = h('div.faint.mono', {
      style: { userSelect: 'text', wordBreak: 'break-all', marginTop: '6px', cursor: 'pointer' },
      title: '点击复制路径',
      onclick: async () => { try { await window.smcl.clipboardWrite(s.mcDir || ''); window.Toast.success('路径已复制'); } catch {} },
    }, s.mcDir || '（未设置）');
    const gameDirRow = h('div.gameDirRow', null,
      row('游戏存储位置', '版本 / 资源 / 存档的安装根目录，可放任意盘符；更改后原目录不会被移动。点击路径可复制',
        h('div.row', null,
          h('button.btn.btn-sm.pressable', { onclick: async () => {
            try {
              const nd = await window.smcl.pickDirNew();
              if (nd) { await set({ mcDir: nd }); renderAll(); window.Toast.success('游戏存储位置：' + nd); }
            } catch (e) { window.Toast.error(e.message.replace(/^Error: /, '')); }
          } }, '📁 更改位置'),
          h('button.btn.btn-ghost.btn-sm.pressable', { onclick: () => window.smcl.openPath(s.mcDir).catch(() => {}) }, '打开'),
        ), true),
      gameDirText,
    );

    return h('div.card', null,
      h('div.card-head', null, h('div.card-title', null, '启动')),
      h('div.card-body', null,
        gameDirRow,
        row('内存', '自动分配 = 物理内存 35%（2048~8192 MB）；也可手动指定', memSlider, true),
        row('启动前优化内存', '每次启动游戏前整理一次系统内存工作集', h('div.row', null, freeMemSwitch, freeNow), true),
        row('全屏启动', '游戏以全屏模式打开', fsSwitch),
        row('关闭启动器时', '最小化：保留在任务栏；直接退出：关闭启动器（正在运行的游戏窗口不受影响）',
          segGroup(['ask', 'minimize', 'close'], ['每次询问', '最小化', '直接退出'], s.closeAction || 'ask', (v) => set({ closeAction: v })), true),
        row('JVM 参数', '附加到 java 命令后，谨慎修改', jvmInput, true),
      ),
    );
  }

  // ------------------------------------------------------------ Java
  let javaList = window.Store.get('javaList') || [];
  function javaCard(s) {
    const listBox = h('div.col', { style: { gap: '6px' } });
    const detectBtn = h('button.btn.btn-sm.pressable', { onclick: () => detect() }, '🔍 重新检测');
    if (s.javaPath) {
      listBox.append(h('div.faint', { style: { wordBreak: 'break-all' } }, `手动指定：${s.javaPath}`));
    }
    const clearBtn = h('button.btn.btn-ghost.btn-xs', { onclick: () => set({ javaPath: '' }).then(() => renderAll()) }, '清除手动指定');
    if (s.javaPath) detectBtn.parentElement.append(clearBtn);

    const listBtn = h('button.btn.btn-sm.pressable', { onclick: () => window.JavaPicker.open(s.javaPath, (p) => { set({ javaPath: p }).then(renderAll); }) }, '📋 从列表选择');
    const pickBtn = h('button.btn.btn-sm.pressable', { onclick: async () => {
      try {
        const p = await window.smcl.pickJava();
        if (p) { await set({ javaPath: p }); renderAll(); }
      } catch (e) { window.Toast.error(e.message.replace(/^Error: /, '')); }
    } }, '手动指定 javaw.exe');

    async function detect() {
      detectBtn.disabled = true;
      detectBtn.textContent = '检测中…';
      try {
        javaList = await window.smcl.detectJava();
        window.Store.set({ javaList });
        drawJavaList();
      } finally {
        detectBtn.disabled = false;
        detectBtn.textContent = '🔍 重新检测';
      }
    }

    function drawJavaList() {
      [...listBox.querySelectorAll('.java-row')].forEach((x) => x.remove());
      if (!javaList.length) {
        listBox.append(h('div.faint', null, '未检测到 Java —— 请安装对应版本的 JDK，或手动指定。'));
        return;
      }
      for (const j of javaList) {
        listBox.append(h('div.java-row' + (s.javaPath === j.path ? '.active' : ''), {
          onclick: () => { set({ javaPath: j.path }).then(renderAll); },
        },
          h('div.jr-main', null,
            h('div', null, `Java ${j.major}（${j.version}）· ${j.vendor} · ${j.bits} 位`),
            h('div.jr-path.ellipsis', null, j.path),
          ),
          h('span.badge', null, j.source),
        ));
      }
    }
    drawJavaList();

    return h('div.card', null,
      h('div.card-head', null, h('div.card-title', null, 'Java 运行时'), h('span.spacer'), detectBtn, listBtn, pickBtn),
      h('div.card-body', null, listBox),
    );
  }

  // ------------------------------------------------------------ 网络
  function networkCard(s) {
    const dohSwitch = h('button.switch' + (s.doh ? '.on' : ''), { onclick: () => { dohSwitch.classList.toggle('on'); set({ doh: dohSwitch.classList.contains('on') }); } });
    const srcSeg = h('div.seg', null,
      seg('auto', '智能选择'),
      seg('bmcl', '尽量镜像'),
      seg('mojang', '尽量官方'),
    );
    function seg(v, label) {
      return h(`button.seg-item.${(s.downloadSource || 'bmcl') === v ? 'active' : ''}`, {
        onclick: (e) => {
          srcSeg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === e.currentTarget));
          set({ downloadSource: v });
        },
      }, label);
    }
    const threads = slider(s.downloadThreads || 8, 1, 32, 1, (v) => set({ downloadThreads: v }), (v) => `${v} 线程`);
    return h('div.card', null,
      h('div.card-head', null, h('div.card-title', null, '网络')),
      h('div.card-body', null,
        row('下载源', '智能选择 = 官方优先，加载缓慢或失败自动切换镜像源；清单获取始终双源竞速', srcSeg, true),
        row('DoH 加速解析', '域名被污染 / 解析异常时开启（DNS over HTTPS · 阿里公共 DNS）', dohSwitch),
      ),
    );
  }

  // ------------------------------------------------------------ 外观
  function appearanceCard(s) {
    const wp = s.wallpaper || {};
    const mode = wp.mode === 'slideshow' ? 'slideshow' : 'daynight';

    const enableSwitch = h('button.switch' + (wp.enabled ? '.on' : ''), {
      title: '启用 / 停用背景壁纸',
      onclick: () => { enableSwitch.classList.toggle('on'); saveWp({ enabled: enableSwitch.classList.contains('on') }); },
    });

    async function importTo(slot, label) {
      try {
        const r = await window.smcl.wallpaperPick(slot);
        if (r && r.theme) { wallpaperThemeCache = r.theme; window.Store.set({ wallpaperTheme: r.theme }); }
        window.Theme.applyAll(window.Store.get('settings'), r && r.theme);
        window.Toast.success(label + '已导入');
        renderAll();
      } catch (e) { window.Toast.error(String(e.message || e).replace(/^Error: /, '')); }
    }
    async function clearSlot(slot, label) {
      try {
        await window.smcl.wallpaperClear(slot);
        window.Theme.applyAll(window.Store.get('settings'), null);
        window.Toast.success(label + '已清除');
        renderAll();
      } catch (e) { window.Toast.error(String(e.message || e).replace(/^Error: /, '')); }
    }

    const slotRow = (slot, label, hasImg, hint) => h('div.field.mt-8', null,
      h('div.row', null,
        h('span.field-label.grow', null, label),
        h('span.faint', null, hasImg ? '已设置' : '默认图'),
        h('button.btn.btn-sm.pressable', { onclick: () => importTo(slot, label) }, '导入'),
        h('button.btn.btn-ghost.btn-sm.pressable', { onclick: () => clearSlot(slot, label) }, '清除'),
      ),
      h('div.field-hint', { style: { marginTop: '3px' } }, hint),
    );

    const images = wp.images || [];
    const listBox = h('div.col', { style: { gap: '6px', marginTop: '8px' } });
    for (const name of images) {
      listBox.append(h('div.row.dl-row', { style: { gap: '8px' } },
        h('span.mono.ellipsis.grow', { style: { fontSize: '12px' } }, name),
        h('button.iconbtn', {
          title: '从轮换中移除',
          style: { color: '#ff6369' },
          onclick: async () => {
            try {
              await window.smcl.wallpaperRemove(name);
              window.Theme.applyAll(window.Store.get('settings'), null);
              window.Toast.success('已移除');
              renderAll();
            } catch (e) { window.Toast.error(String(e.message || e).replace(/^Error: /, '')); }
          },
        }, window.Dom.icon('trash', 14)),
      ));
    }
    if (!images.length) listBox.append(h('div.faint', { style: { padding: '6px 0' } }, '还没有壁纸 —— 导入一张或多张，过一段时间自动平滑切换'));

    const interval = slider(wp.intervalMin ?? 10, 1, 120, 1, (v) => saveWp({ intervalMin: v }), (v) => v + ' 分钟');

    const modeSeg = segGroup(['daynight', 'slideshow'], ['昼夜切换', '不切换（多张轮换）'], mode, (v) => saveWp({ mode: v }).then(() => renderAll()));

    const fitSeg = segGroup(['cover', 'contain', 'stretch'], ['铺满', '完整', '拉伸'], wp.fit || 'cover', (v) => saveWp({ fit: v }));
    const maskSeg = segGroup(['none', 'soft', 'top', 'bottom', 'vignette'], ['无', '柔和', '顶部', '底部', '暗角'], wp.mask || 'soft', (v) => saveWp({ mask: v }));
    const opacity = slider(wp.opacity ?? 0.6, 0.05, 1, 0.05, (v) => saveWp({ opacity: v }), (v) => Math.round(v * 100) + '%');
    const blur = slider(wp.blur ?? 0, 0, 40, 1, (v) => saveWp({ blur: v }), (v) => v + 'px');
    const dim = slider(wp.dim ?? 0.35, 0, 0.85, 0.05, (v) => saveWp({ dim: v }), (v) => Math.round(v * 100) + '%');
    const ui = slider(wp.ui ?? 0.78, 0.35, 1, 0.05, (v) => saveWp({ ui: v }), (v) => Math.round(v * 100) + '%');

    // 主题色
    let sampled = wallpaperThemeCache || window.Store.get('wallpaperTheme');
    const accentSeg = segGroup(['brand', 'wallpaper'], ['固定校徽蓝', '跟随壁纸取色'], s.accent || 'brand', (v) => {
      set({ accent: v }).then(() => window.Theme.applyAll(window.Store.get('settings'), sampled));
    });
    const sampledHint = h('div.faint.mt-8', null,
      sampled ? (sampled.sampled ? `已从壁纸提取主色：色相 ${sampled.hue}°` : '壁纸接近纯灰，已自动回落到校徽蓝') : '导入壁纸后可跟随取色');

    const themeSeg = segGroup(['dark', 'light'], ['深色', '浅色'], s.theme || 'dark', (v) => {
      set({ theme: v }).then(() => window.Theme.applyAll(window.Store.get('settings'), sampled));
    });

    function saveWp(patch) {
      const cur = (window.Store.get('settings') || {}).wallpaper || {};
      const next = { ...cur, ...patch, enabled: patch.enabled ?? cur.enabled ?? true };
      return set({ wallpaper: next }).then(() => window.Theme.applyAll(window.Store.get('settings'), sampled));
    }

    const modeRows = mode === 'daynight'
      ? [
          slotRow('day', '白天壁纸（深色主题）', Boolean(wp.dayImage), '08:00 - 19:00 使用；未设置时用内置白天图'),
          slotRow('night', '夜间壁纸（深色主题）', Boolean(wp.nightImage || wp.image), '19:00 - 08:00 使用；未设置时用内置夜间图'),
          slotRow('light', '浅色主题壁纸', Boolean(wp.imageLight), '浅色主题始终使用这张；未设置时用内置浅色图'),
        ]
      : [
          h('div.field.mt-8', null,
            h('div.row', null,
              h('span.field-label.grow', null, '轮换壁纸（' + images.length + ' 张）'),
              h('button.btn.btn-primary.btn-sm.pressable', { onclick: () => importTo('list', '壁纸') }, '＋ 导入壁纸'),
            ),
            listBox,
          ),
          h('div.field.mt-8', null, h('span.field-label', null, '切换间隔'), interval),
        ];

    return h('div.card', null,
      h('div.card-head', null, h('div.card-title', null, '外观')),
      h('div.card-body', null,
        h('div.row', null, h('span.field-label.grow', null, '启用背景壁纸'), enableSwitch),
        h('div.field.mt-8', null,
          h('div.row', null, h('span.field-label.grow', null, '壁纸模式'), modeSeg),
          h('div.field-hint', { style: { marginTop: '4px' } },
            mode === 'daynight'
              ? '白天 / 夜间按时间自动切换，切换时平滑淡入淡出'
              : '多张壁纸按间隔自动轮换，切换时平滑淡入淡出'),
        ),
        ...modeRows,
        h('div.field.mt-8', null, h('span.field-label', null, '填充方式'), fitSeg),
        h('div.field.mt-8', null, h('span.field-label', null, '蒙版'), maskSeg),
        h('div.field.mt-8', null, h('span.field-label', null, '图片不透明度'), opacity),
        h('div.field.mt-8', null, h('span.field-label', null, '模糊度'), blur),
        h('div.field.mt-8', null, h('span.field-label', null, '压暗强度'), dim),
        h('div.field.mt-8', null, h('span.field-label', null, '界面玻璃不透明度'), ui),
        h('hr.divider'),
        row('主题模式', '', themeSeg, true),
        row('主题色', '从壁纸提取主色生成整套配色；纯灰图自动回落校徽蓝', accentSeg, true),
        sampledHint,
      ),
    );
  }

  // ------------------------------------------------------------ 系统
  function systemCard(s) {
    const isolateSwitch = h('button.switch' + (s.isolateByDefault ? '.on' : ''), { onclick: () => { isolateSwitch.classList.toggle('on'); set({ isolateByDefault: isolateSwitch.classList.contains('on') }); } });
    const autoCheck = h('button.switch' + (s.autoCheck ? '.on' : ''), { onclick: () => { autoCheck.classList.toggle('on'); set({ autoCheck: autoCheck.classList.contains('on') }); } });
    const autoFixInjectors = h('button.switch' + (s.autoFixInjectors !== false ? '.on' : ''), { onclick: () => { autoFixInjectors.classList.toggle('on'); set({ autoFixInjectors: autoFixInjectors.classList.contains('on') }); } });
    const autoUpdate = h('button.switch' + (s.autoUpdateCheck ? '.on' : ''), { onclick: () => { autoUpdate.classList.toggle('on'); set({ autoUpdateCheck: autoUpdate.classList.contains('on') }); } });

    const gpuStatus = h('span.badge.' + (s.gpuFallback ? 'badge-orange' : 'badge-green'), null, s.gpuFallback ? '兼容模式已启用' : '正常');
    const updateBtn = h('button.btn.btn-sm.pressable', { onclick: checkUpdateFlow }, '检查启动器更新');
    const gpuBtn = h('button.btn.btn-sm.pressable', {
      onclick: async () => {
        try {
          const r = await window.smcl.applyGpuAll('high');
          window.Toast.success(`已把 ${r.applied.length} 个 javaw 写入 Windows 高性能显卡偏好${r.failed.length ? `，${r.failed.length} 个失败` : ''}`);
        } catch (e) { window.Toast.error(e.message); }
      },
    }, '显卡偏好：高性能');

    return h('div.card', null,
      h('div.card-head', null, h('div.card-title', null, '系统')),
      h('div.card-body', null,
        row('版本隔离', '开启后每个版本使用独立的 mods / saves / config 目录（gameDir 指向实例目录）', isolateSwitch),
        row('GPU 兼容兜底', 'GPU 进程崩溃后自动写入标记，下次启动携带兼容参数（--no-sandbox / --disable-gpu-sandbox）', gpuStatus),
        row('第三方软件兼容', '搜狗输入法的云组件会让启动器闪退；开启后启动时自动临时结束这些组件（不影响打字，可在搜狗设置里根治）', autoFixInjectors),
        row('显卡偏好', '把 javaw.exe 写入 Windows「按应用设置图形性能」', gpuBtn, true),
        row('新版本提醒', '后台每 5 分钟检查 Minecraft 新正式版，弹系统通知', autoCheck),
        row('启动器更新', '检查 GitHub Release 增量更新包（体积 / SHA-256 / zip 结构三重校验）', h('div.row', null, updateBtn, autoUpdate)),
        row('关于', `星启 SWUSTMCL v${(window.smcl && window.smcl.version) || '1.0.0'} · MIT License`,
          h('button.btn.btn-ghost.btn-sm', { onclick: () => window.smcl.openUrl('https://github.com/swustmcl/SWUSTMCL').catch(() => {}) }, 'GitHub')),
      ),
    );
  }

  async function checkUpdateFlow() {
    try {
      const r = await window.smcl.checkUpdate({});
      if (!r.available) {
        window.Toast.success(`已是最新版本（${r.current}）`);
        return;
      }
      window.app.showUpdateModal(r);
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
    }
  }

  // ------------------------------------------------------------ 小部件
  function row(label, desc, ctl, wide) {
    return h('div.set-row', null,
      h('div.set-row-main', null,
        h('div.set-row-label', null, label),
        desc ? h('div.set-row-desc', null, desc) : null,
      ),
      h('div.set-row-ctl', { style: wide ? { maxWidth: '100%', marginTop: '8px', alignSelf: 'stretch' } : null }, ctl),
    );
  }

  function slider(value, min, max, step, onchange, fmt) {
    const val = h('span.slider-value', null, fmt ? fmt(value) : `${value} MB`);
    let timer = null;
    const fire = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => onchange(Number(el.value)), 110); };
    const el = h('input.slider', {
      type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
      oninput: () => {
        el.style.setProperty('--fill', `${((el.value - min) / (max - min)) * 100}%`);
        val.textContent = fmt ? fmt(Number(el.value)) : `${el.value} MB`;
        fire(); // 拖动过程中就实时生效（防抖），不用松手
      },
      onchange: () => { if (timer) { clearTimeout(timer); timer = null; } onchange(Number(el.value)); },
    });
    requestAnimationFrame(() => el.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`));
    return h('div.slider-wrap', null, el, val);
  }

  function segGroup(values, labels, current, onchange) {
    const seg = h('div.seg', { style: { flexWrap: 'wrap' } });
    values.forEach((v, i) => {
      seg.append(h(`button.seg-item.${current === v ? 'active' : ''}`, {
        onclick: (e) => {
          seg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === e.currentTarget));
          onchange(v);
        },
      }, labels[i]));
    });
    return seg;
  }

  function renderAll() {
    if (rootEl) render(rootEl);
  }

  window.Pages = window.Pages || {};
  window.Pages.settings = {
    render,
    onShow() { renderAll(); },
    onSettingsChanged() { if (rootEl && window.Store.get('view') === 'settings') renderAll(); },
  };
})();
