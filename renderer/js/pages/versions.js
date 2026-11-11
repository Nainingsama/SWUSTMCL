'use strict';
/**
 * 版本管理：跨目录汇总所有实例卡片。
 * 启动 / 打开目录 / 复制启动命令 / 修复依赖 / 删除 / 导入整合包入口。
 */
(function () {
  const { h, fmtSize } = window.Dom;
  let rootEl = null;
  let searchEl = null;
  let filterLoader = 'all';

  /** 单色线性 SVG 图标（替代彩色 emoji） */
  function svgIcon(name, size = 16) {
    const P = {
      cubes: '<path d="M10 2.5l6 3.2v5.2l-6 3.2-6-3.2V5.7z"/><path d="M4 5.7l6 3.2 6-3.2M10 8.9v6.2"/>',
      plus: '<path d="M10 4.5v11M4.5 10h11"/>',
      box: '<path d="M3.5 6.3l6.5-3 6.5 3v6.2l-6.5 3-6.5-3z"/><path d="M3.5 6.3L10 9.3l6.5-3M10 9.3v6.2"/>',
      gear: '<circle cx="10" cy="10" r="3"/><path d="M10 2.8v1.8M10 15.4v1.8M2.8 10h1.8M15.4 10h1.8M4.9 4.9l1.3 1.3M13.8 13.8l1.3 1.3M4.9 15.1l1.3-1.3M13.8 6.2l1.3-1.3"/>',
      folder: '<path d="M3 5.8h5.2l1.4 1.9H17v7.5H3z"/>',
      list: '<path d="M7.5 6h9M7.5 10h9M7.5 14h9M4 6h.1M4 10h.1M4 14h.1"/>',
      grid: '<path d="M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z"/>',
      trash: '<path d="M5 6h10M8.2 6V4.6h3.6V6M6.6 6l.7 9.2h5.4L13.4 6M8.6 8.6v4.8M11.4 8.6v4.8"/>',
      export: '<path d="M10 12V3.2M6.6 6.6L10 3.2l3.4 3.4M4 12.5V16h12v-3.5"/>',
      clock: '<circle cx="10" cy="10" r="6.4"/><path d="M10 6.2V10l2.4 1.9"/>',
      world: '<circle cx="10" cy="10" r="6.4"/><path d="M3.6 10h12.8M10 3.6c1.9 1.8 2.9 4 2.9 6.4s-1 4.6-2.9 6.4c-1.9-1.8-2.9-4-2.9-6.4s1-4.6 2.9-6.4z"/>',
      sun: '<circle cx="10" cy="10" r="2.9"/><path d="M10 2.8v1.8M10 15.4v1.8M2.8 10h1.8M15.4 10h1.8M4.9 4.9l1.3 1.3M13.8 13.8l1.3 1.3M4.9 15.1l1.3-1.3M13.8 6.2l1.3-1.3"/>',
      play: '<path d="M7 4.8l7.6 5.2L7 15.2z"/>',
      refresh: '<path d="M15.6 8.2A5.6 5.6 0 1 0 16 12.4"/><path d="M15.6 3.6v4.6h-4.6"/>',
      shot: '<path d="M3.6 5.6h12.8v9H3.6z"/><circle cx="7.2" cy="8.7" r="1.3"/><path d="M3.6 12.6l4-2.9 5 3.9 3-2.4"/>',
      card: '<path d="M3.5 4.5h13v11h-13zM3.5 8h13"/>',
    };
    const el = h('span.icon-svg', { style: { display: 'inline-flex', width: size + 'px', height: size + 'px', flex: 'none', alignItems: 'center' } });
    el.innerHTML = '<svg viewBox="0 0 20 20" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || '') + '</svg>';
    return el;
  }

  const LOADER_BADGE = {
    Fabric: 'badge-orange', Quilt: 'badge-purple', Forge: 'badge-red',
    NeoForge: 'badge-orange', OptiFine: 'badge-green', 原版: 'badge-blue',
  };

  let viewMode = localStorage.getItem('swustmcl.versionsView') || 'grid';
  let sortMode = localStorage.getItem('swustmcl.versionsSort') || 'name';
  let selectedId = window.Store.get('selectedInstance') || '';
  let query = '';

  function render(root) {
    rootEl = root;
    window.Dom.clear(root);
    root.append(
      h('div.ver-page', null,
        h('div.ver-side#verSide'),
        h('div.ver-main#verMain'),
      ),
    );
    drawAll();
  }

  function installedSorted() {
    const all = (window.Store.get('installed') || []).slice();
    const cmp = {
      name: (a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id, 'zh-CN'),
      version: (a, b) => String(b.mcVersion || '').localeCompare(String(a.mcVersion || ''), 'zh-CN', { numeric: true }),
      size: (a, b) => (((window.__sizeCache || {})[a.dir + '|' + a.id]) || 0) - (((window.__sizeCache || {})[b.dir + '|' + b.id]) || 0) * -1,
    }[sortMode] || ((a, b) => a.id.localeCompare(b.id));
    return all.sort(cmp);
  }

  function sizeBadgeOf(v) {
    const cached = (window.__sizeCache || {})[v.dir + '|' + v.id];
    return h('span.badge', { title: '实例占用空间', dataset: { sizeFor: v.dir + '|' + v.id } }, cached != null ? '占用 ' + fmtSize(cached) : '占用 …');
  }

  function openFolderOf(v) {
    return window.smcl.openPath([v.dir, 'versions', v.id].join('\\')).catch((e) => window.Toast.error(e.message));
  }

  function drawAll() {
    const side = rootEl && rootEl.querySelector('#verSide');
    const mainEl = rootEl && rootEl.querySelector('#verMain');
    if (!side || !mainEl) return;
    const all = installedSorted();
    if (selectedId && !all.some((v) => v.id === selectedId)) selectedId = '';

    // ---------- 左：实例列表 ----------
    window.Dom.clear(side);
    side.append(
      h('div.ver-side-row.ver-side-all' + (!selectedId ? '.chosen' : ''), {
        dataset: { vid: '' },
        onclick: () => selectInstanceById(''),
      }, svgIcon('cubes', 17), h('span.ellipsis.grow', null, '全部实例'), h('span.badge', null, String(all.length))),
    );
    // 按启动器（游戏目录来源）分大目录，可折叠 / 改名 / 打开目录
    const GROUPS = [
      ['primary', '当前文件夹'],
      ['official', '官方启动器'],
      ['PCL', 'PCL'],
      ['HMCL', 'HMCL'],
      ['BakaXL', 'BakaXL'],
      ['custom', '自定义文件夹'],
    ];
    const kindLabel = (k) => (GROUPS.find((g) => g[0] === k) || [k, k || '其他'])[1];
    const customNames = (window.Store.get('settings') || {}).dirNames || {};
    let collapsedDirs = [];
    try { collapsedDirs = JSON.parse(localStorage.getItem('swustmcl.collapsedDirs') || '[]') || []; } catch {}
    const isCollapsed = (dir) => collapsedDirs.some((d) => d.toLowerCase() === String(dir).toLowerCase());

    const byKind = new Map();
    for (const v of all) {
      const k = v.kind || 'custom';
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(v);
    }
    const order = GROUPS.map((g) => g[0]);
    const kinds = [...byKind.keys()].sort((a, b) => {
      const ia = order.indexOf(a); const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    function openDirMenu(dir, name, anchor) {
      const panel = h('div.menu-panel.float-panel');
      const close = () => { panel.remove(); document.removeEventListener('mousedown', onDoc, true); };
      const onDoc = (ev) => { if (!panel.contains(ev.target)) close(); };
      panel.append(
        h('button.menu-item', {
          onclick: () => { close(); renameDir(dir, name); },
        }, svgIcon('gear', 15), '改名'),
        h('button.menu-item', {
          onclick: () => { close(); window.smcl.openPath(dir).catch((e) => window.Toast.error(e.message)); },
        }, svgIcon('folder', 15), '打开文件夹'),
      );
      document.body.append(panel);
      const r = anchor.getBoundingClientRect();
      const pw = panel.offsetWidth || 172;
      const ph = panel.offsetHeight || 96;
      let left = Math.min(r.left, window.innerWidth - pw - 12);
      let top = r.bottom + 6;
      if (top + ph > window.innerHeight - 12) top = Math.max(12, r.top - ph - 6);
      panel.style.left = Math.max(8, left) + 'px';
      panel.style.top = top + 'px';
      setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    }

    function renameDir(dir, oldName) {
      let input;
      const m = window.Modal.open({
        title: '自定义启动器名称',
        body: (el) => {
          input = h('input.input', { value: oldName || '', placeholder: '例如：PCL、官方启动器、我的整合包目录' });
          el.append(
            h('div.field', null, h('span.field-label', null, '显示名称'), input),
            h('div.faint.mt-8', { style: { wordBreak: 'break-all', userSelect: 'text' } }, dir),
          );
        },
        footer: [
          h('button.btn.pressable', { onclick: () => m.close(null) }, '取消'),
          h('button.btn.btn-primary.pressable', {
            onclick: async () => {
              const val = String(input.value || '').trim();
              if (!val) { window.Toast.warn('名称不能为空'); return; }
              try {
                const cur = (window.Store.get('settings') || {}).dirNames || {};
                const next = { ...cur, [dir]: val };
                const r = await window.smcl.save({ dirNames: next });
                const settings = (r && r.settings) ? Object.assign({}, window.Store.get('settings') || {}, { dirNames: next }) : { ...(window.Store.get('settings') || {}), dirNames: next };
                window.Store.set({ settings });
                m.close(true);
                window.Toast.success('已重命名为：' + val);
                drawAll();
              } catch (e) { window.Toast.error(e.message.replace(/^Error: /, '')); }
            },
          }, '保存'),
        ],
      });
      setTimeout(() => input && input.focus(), 40);
    }

    for (const k of kinds) {
      const items = byKind.get(k);
      const dirOf = items[0].dir || '';
      const label = customNames[dirOf] || kindLabel(k);
      const collapsed = isCollapsed(dirOf);
      const head = h('div.ver-side-group-head' + (collapsed ? '.collapsed' : ''), {
        title: (collapsed ? '展开' : '收起') + '：' + dirOf,
        onclick: (ev) => {
          if (ev.target.closest('.grp-more')) return;
          collapsedDirs = collapsed
            ? collapsedDirs.filter((d) => d.toLowerCase() !== dirOf.toLowerCase())
            : [...collapsedDirs, dirOf];
          try { localStorage.setItem('swustmcl.collapsedDirs', JSON.stringify(collapsedDirs)); } catch {}
          drawAll();
        },
      },
        h('span.grp-caret', null, collapsed ? '›' : '⌄'),
        h('span.grp-name', null, label),
        h('span.grp-path.ellipsis', null, dirOf),
        h('span.badge', null, String(items.length)),
        h('button.iconbtn.grp-more', {
          title: '更多',
          onclick: (ev) => { ev.stopPropagation(); openDirMenu(dirOf, label, ev.currentTarget); },
        }, '…'),
      );
      side.append(head);
      if (collapsed) continue;
      for (const v of items) {
        side.append(h('div.ver-side-row.ver-side-child' + (v.id === selectedId ? '.chosen' : ''), {
          title: v.dir + '\\versions\\' + v.id,
          dataset: { vid: v.id },
          onclick: () => selectInstanceById(v.id),
        },
          h('span.loader-mini', { innerHTML: window.LoaderIcon.svg(v.loader, 16) }),
          h('span.ellipsis.grow', null, v.displayName || v.id),
          h('span.faint', { style: { fontSize: '11px', flex: 'none' } }, v.mcVersion || ''),
        ));
      }
    }
    side.append(
      h('span.spacer'),
      h('button.ver-side-btn', { onclick: () => addDirFlow() }, svgIcon('plus', 14), '添加与导入'),
      h('button.ver-side-btn', { onclick: () => importPackFlow() }, svgIcon('box', 14), '导入整合包'),
      h('button.ver-side-btn', { onclick: () => window.app.goto('settings') }, svgIcon('gear', 14), '全局游戏设置'),
    );

    renderRight(all, mainEl);
  }

  /** 只重绘右侧（选中实例 / 切换视图时用，左侧栏保持不变） */
  const detailNodeCache = new Map();
  function renderRight(all, mainEl) {
    mainEl = mainEl || (rootEl && rootEl.querySelector('#verMain'));
    if (!mainEl) return;
    window.Dom.clear(mainEl);
    if (selectedId) {
      const dv = all.find((x) => x.id === selectedId);
      if (dv) {
        // 8 秒内复用同一个详情节点：来回切换实例不再重建概览（体感明显更跟手）
        const key = dv.dir + '|' + dv.id;
        const hit = detailNodeCache.get(key);
        if (hit && Date.now() - hit.t < 8000) { mainEl.append(hit.node); return; }
        const node = detailView(dv);
        detailNodeCache.set(key, { node, t: Date.now() });
        mainEl.append(node);
        return;
      }
    }
    const launchTargetId = window.Store.get('homeVersionId') || (all[0] && all[0].id);
    const sel = all.find((v) => v.id === launchTargetId);
    const viewSeg = h('div.seg', null,
      h('button.seg-item' + (viewMode === 'grid' ? '.active' : ''), { title: '网格视图', onclick: () => { viewMode = 'grid'; localStorage.setItem('swustmcl.versionsView', viewMode); drawAll(); } }, svgIcon('grid', 15)),
      h('button.seg-item' + (viewMode === 'list' ? '.active' : ''), { title: '列表视图', onclick: () => { viewMode = 'list'; localStorage.setItem('swustmcl.versionsView', viewMode); drawAll(); } }, svgIcon('list', 15)),
    );
    const sortSel = h('select.select', { style: { maxWidth: '150px' }, title: '排序方式', onchange: (e) => { sortMode = e.target.value; localStorage.setItem('swustmcl.versionsSort', sortMode); drawAll(); } },
      h('option', { value: 'name', selected: sortMode === 'name' }, '实例名称'),
      h('option', { value: 'version', selected: sortMode === 'version' }, '游戏版本'),
      h('option', { value: 'size', selected: sortMode === 'size' }, '占用空间'),
    );
    const searchInp = h('input.input#verSearch', {
      value: query,
      placeholder: '搜索实例…',
      style: { maxWidth: '190px' },
      oninput: window.Dom.debounce((e) => {
        query = e.target.value.trim().toLowerCase();
        const caret = e.target.selectionStart;
        drawAll();
        // 重绘后把焦点和光标还给搜索框，否则输一个字符就会失焦
        const next = rootEl && rootEl.querySelector('#verSearch');
        if (next) { next.focus(); try { next.setSelectionRange(caret, caret); } catch {} }
      }, 180),
    });
    const launchSel = h('button.btn.btn-primary.btn-sm.pressable', {
      title: sel ? '启动 ' + sel.id : '没有可启动的实例',
      disabled: !sel,
      onclick: () => sel && launchOne(sel),
    }, svgIcon('play', 14), '启动游戏');

    mainEl.append(
      h('div.ver-topbar', null,
        h('div.ver-title-lg', null, '全部实例'),
        h('span.spacer'),
        searchInp,
        h('button.iconbtn', { title: '刷新', onclick: async () => { try { await window.app.refreshInstalled(); window.Toast.success('已刷新'); } catch {} } }, svgIcon('refresh', 16)),
        sortSel,
        viewSeg,
        h('button.btn.btn-sm.pressable', { onclick: () => addDirFlow() }, svgIcon('plus', 14), '添加与导入'),
        launchSel,
      ),
    );

    const filtered = all.filter((v) => !query || v.id.toLowerCase().includes(query) || (v.displayName || '').toLowerCase().includes(query));
    const content = h('div.ver-content');
    mainEl.append(content);

    if (!filtered.length) {
      content.append(h('div.empty', null, h('div.empty-icon', null, svgIcon('cubes', 34)),
        all.length ? '没有匹配的实例' : '未发现任何实例 —— 试试「下载游戏」或通过快捷方式自动发现 PCL/HMCL 目录'));
      return;
    }
    if (viewMode === 'grid') {
      const grid = h('div.ver-tiles');
      for (const v of filtered) grid.append(tileOf(v));
      content.append(grid);
    } else {
      const rows = h('div.ver-rows');
      for (const v of filtered) rows.append(rowOf(v));
      content.append(rows);
    }
  }

  /** 选中实例：只切换左侧高亮 + 重绘右侧，避免整个列表重建造成的卡顿 */
  let selRenderTimer = null;
  function selectInstanceById(id) {
    selectedId = id || '';
    window.Store.set({ selectedInstance: selectedId });
    const sideEl = rootEl && rootEl.querySelector('#verSide');
    if (sideEl) {
      sideEl.querySelectorAll('.ver-side-row').forEach((row) => {
        row.classList.toggle('chosen', row.dataset.vid === selectedId);
      });
    }
    if (selRenderTimer) clearTimeout(selRenderTimer);
    const targetId = selectedId;
    selRenderTimer = setTimeout(() => {
      selRenderTimer = null;
      if (selectedId !== targetId) return; // 已被更新的点击覆盖
      renderRight(installedSorted(), rootEl && rootEl.querySelector('#verMain'));
    }, 40);
  }

  function selectInstance(v) {
    selectedId = v.id;
    window.Store.set({ selectedInstance: v.id });
    drawAll();
  }

  function tileOf(v) {
    const isSel = v.id === (window.Store.get('homeVersionId') || '');
    return h('div.card.hoverable.ver-tile' + (isSel ? '.selected' : ''), {
      onclick: () => { window.Store.set({ homeVersionId: v.id }); drawAll(); },
      ondblclick: () => launchOne(v),
    },
      h('span.inst-radio' + (isSel ? '.on' : ''), { style: { position: 'absolute', left: '12px', top: '12px' } }),
      h('button.iconbtn', { title: '更多操作', style: { position: 'absolute', right: '8px', top: '8px' }, onclick: (e) => { e.stopPropagation(); openInstanceMenu(v, e.currentTarget); } }, '…'),
      h('div.ver-tile-icon', { innerHTML: window.LoaderIcon.svg(v.loader, 42) }),
      h('div.ver-tile-name.ellipsis', { title: v.id }, v.displayName || v.id),
      h('div.ver-tile-sub', null, (v.mcVersion || v.type) + (v.loader && v.loader !== '原版' ? ', ' + v.loader : '')),
      h('div.ver-tile-badges', null,
        v.isolated ? h('span.badge.badge-accent', null, '隔离') : null,
        v.mods > 0 ? h('span.badge', null, v.mods + ' 模组') : null,
        !v.hasJar ? h('span.badge.badge-red', { title: '缺少 client.jar，可在详情里体检修复' }, '缺 jar') : null,
        sizeBadgeOf(v),
      ),
    );
  }

  function rowOf(v) {
    const isSel = v.id === (window.Store.get('homeVersionId') || '');
    return h('div.ver-row' + (isSel ? '.selected' : ''), {
      onclick: () => { window.Store.set({ homeVersionId: v.id }); drawAll(); },
      ondblclick: () => launchOne(v),
    },
      h('span.inst-radio' + (isSel ? '.on' : '')),
      h('span.loader-mini', { style: { width: '24px', flex: 'none' }, innerHTML: window.LoaderIcon.svg(v.loader, 22) }),
      h('div.grow', { style: { minWidth: 0 } },
        h('div.ver-row-name.ellipsis', { title: v.id }, v.displayName || v.id),
        h('div.faint', null, (v.mcVersion || v.type) + (v.loader && v.loader !== '原版' ? ', ' + v.loader : '') + (v.dirName ? ' · ' + v.dirName : '')),
      ),
      h('span', { style: { display: 'flex', gap: '6px', flex: 'none', alignItems: 'center' } },
        v.isolated ? h('span.badge.badge-accent', null, '隔离') : null,
        v.mods > 0 ? h('span.badge', null, v.mods + ' 模组') : null,
        sizeBadgeOf(v),
      ),
      h('span.ver-row-actions', null,
        h('button.iconbtn', { title: '打开文件夹', onclick: (e) => { e.stopPropagation(); openFolderOf(v); } }, svgIcon('folder', 15)),
        h('button.iconbtn', { title: '模组管理', onclick: (e) => { e.stopPropagation(); openDetail(v, '模组'); } }, svgIcon('list', 15)),
        h('button.iconbtn', { title: '实例详情', onclick: (e) => { e.stopPropagation(); openDetail(v); } }, svgIcon('gear', 15)),
        (() => {
          const d = window.DomainContext && window.DomainContext.active ? window.DomainContext.active() : null;
          if (!d || d.personal || !v.isolated || !window.PublishPack) return null;
          return h('button.iconbtn', { title: '发布到社团域', onclick: (e) => { e.stopPropagation(); window.PublishPack.open(v); } }, svgIcon('export', 15));
        })(),
        h('button.iconbtn', { title: '删除实例', style: { color: '#ff6369' }, onclick: (e) => { e.stopPropagation(); deleteOne(v); } }, svgIcon('trash', 15)),
      ),
    );
  }

  /** 网格卡「…」菜单：打开文件夹 / 模组 / 详情 / 体检 / 导出 / 删除 */
  function openInstanceMenu(v, anchor) {
    const panel = h('div.menu-panel.float-panel');
    const close = () => { panel.remove(); document.removeEventListener('mousedown', onDoc, true); };
    const onDoc = (ev) => { if (!panel.contains(ev.target)) close(); };
    const items = [
      ['打开文件夹', () => openFolderOf(v), false, 'folder'],
      ['模组管理', () => openDetail(v, '模组'), false, 'list'],
      ['实例详情', () => openDetail(v), false, 'gear'],
      ['体检补全', () => repairOne(v), false, 'refresh'],
      ['导出整合包', () => window.app.goto('packs'), false, 'export'],
    ];
    const domain = window.DomainContext && window.DomainContext.active ? window.DomainContext.active() : null;
    if (domain && !domain.personal && v.isolated && window.PublishPack) {
      items.push(['发布到社团域', () => window.PublishPack.open(v), false, 'export']);
    }
    items.push(['删除实例', () => deleteOne(v), true, 'trash']);
    for (const [label, fn, danger, ic] of items) {
      panel.append(h('button.menu-item' + (danger ? '.danger' : ''), { onclick: () => { close(); fn(); } }, svgIcon(ic, 15), label));
    }
    document.body.append(panel);
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth || 180;
    const ph = panel.offsetHeight || 240;
    let left = Math.min(r.right - pw, window.innerWidth - pw - 12);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 12) top = Math.max(12, r.top - ph - 6);
    panel.style.left = Math.max(8, left) + 'px';
    panel.style.top = top + 'px';
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
  }

  // ---------------------------------------------------------- 实例详情（共享构建器）
  const ovHistoryCache = { time: 0, data: [] };

  async function loadHistoryCached() {
    if (Date.now() - ovHistoryCache.time < 30000 && ovHistoryCache.data.length) return ovHistoryCache.data;
    try { ovHistoryCache.data = await window.smcl.historyList(); } catch { ovHistoryCache.data = []; }
    ovHistoryCache.time = Date.now();
    return ovHistoryCache.data;
  }

  function buildOverviewPane(v) {
    const pane = h('div.ov-cards');
    const infoCard = h('div.ov-card', null,
      h('div.ov-card-title', null, '基本信息'),
      h('div.ov-row', null, svgIcon('cubes', 18), h('div', null,
        h('div.faint', null, '游戏版本'), h('div.ov-val', null, v.mcVersion || v.type))),
      h('div.ov-row', null, svgIcon('clock', 18), h('div', null,
        h('div.faint', null, '游戏时长'), h('div.ov-val#ovPlaytime', null, '统计中…'))),
    );
    const lastCard = h('div.ov-card', null,
      h('div.ov-card-title', null, '上次游玩'),
      h('div.ov-empty#ovLast', null, '统计中…'),
    );
    const modCard = h('div.ov-card', null,
      h('div.ov-card-title', null, '模组'),
      h('div.ov-empty', null, v.mods > 0 ? v.mods + ' 个模组' : '无数据'),
      h('button.btn.btn-ghost.btn-xs', { style: { marginTop: '8px' }, onclick: () => openDetail(v, '模组') }, '→ 前往管理'),
    );
    const shotCard = h('div.ov-card', null,
      h('div.ov-card-title', null, '截图'),
      h('div.ov-empty#ovShots', null, '统计中…'),
    );
    const moreCard = h('div.ov-card', null,
      h('div.ov-card-title', null, '更多'),
      h('div.ov-more', null,
        h('button.ov-more-item', { onclick: () => window.Pages.versions.openDetail(v, '世界') }, svgIcon('world', 18), '世界'),
        h('button.ov-more-item', { onclick: () => window.Pages.versions.openDetail(v, '资源包') }, svgIcon('box', 18), '资源包'),
        h('button.ov-more-item', { onclick: () => window.Pages.versions.openDetail(v, '光影') }, svgIcon('sun', 18), '光影'),
        h('button.ov-more-item', { onclick: () => window.Pages.versions.openDetail(v, '设置') }, svgIcon('gear', 18), '设置'),
      ),
    );
    pane.append(infoCard, lastCard, modCard, shotCard, moreCard);

    (async () => {
      const hist = (await loadHistoryCached()).filter((x) => x.id === v.id);
      const total = hist.reduce((s, x) => s + Math.max(0, (x.end || x.start) - (x.start || 0)), 0);
      const mins = Math.round(total / 60000);
      const pt = pane.querySelector('#ovPlaytime');
      if (pt) pt.textContent = Math.floor(mins / 60) + ' 小时 ' + (mins % 60) + ' 分';
      const lastEl = pane.querySelector('#ovLast');
      if (lastEl) {
        const last = hist[hist.length - 1];
        if (last) {
          const d = new Date(last.end || last.start);
          const dur = Math.max(0, (last.end || last.start) - (last.start || 0));
          lastEl.textContent = d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0')
            + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
            + ' · ' + Math.max(1, Math.round(dur / 60000)) + ' 分钟';
        } else lastEl.textContent = '无数据';
      }
      try {
        const r = await window.smcl.instanceAssets(v.dir, v.id, 'screenshots');
        const sh = pane.querySelector('#ovShots');
        if (sh) sh.textContent = r.items.length ? r.items.length + ' 张截图' : '无数据';
      } catch {}
    })();
    return pane;
  }

  function buildWorldsPane(v) {
    const pane = h('div');
    pane.append(h('div.skeleton', { style: { height: '120px' } }));
    const fmtTime = (ms) => {
      if (!ms) return '未知';
      const d = new Date(ms);
      return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0')
        + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };
    const savesDir = [v.dir, 'versions', v.id, 'saves'].join('\\');
    window.smcl.saves().then((all) => {
      const list = (Array.isArray(all) ? all : [])
        .filter((x) => x.dir === v.dir && x.instanceId === v.id)
        .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
      window.Dom.clear(pane);
      pane.append(h('div.row.mb-8', null,
        h('div.faint.grow', null, '这个实例的存档（' + list.length + ' 个）'),
        h('button.btn.btn-ghost.btn-xs', { onclick: () => window.smcl.openPath(savesDir).catch((e) => window.Toast.error(e.message)) }, svgIcon('folder', 14), '打开存档目录'),
      ));
      if (!list.length) {
        pane.append(h('div.empty', null, h('div.empty-icon', null, svgIcon('world', 34)), '这个实例还没有存档'));
        return;
      }
      const rows = h('div.col', { style: { gap: '8px' } });
      for (const s of list) {
        rows.append(h('div.dl-row', null,
          h('div.save-thumb', { style: { width: '44px', height: '44px', borderRadius: '8px', backgroundImage: s.icon ? 'url("' + s.icon + '")' : 'none', backgroundSize: 'cover', flex: 'none' } }),
          h('div.grow', { style: { minWidth: 0 } },
            h('div', { style: { fontWeight: '600', fontSize: '13px' } }, s.name + (s.hardcore ? ' 💀' : '')),
            h('div.faint', null, (s.version || '?') + ' · ' + (s.gameType || '生存') + ' · 上次游玩 ' + fmtTime(s.lastPlayed)),
          ),
          h('button.btn.btn-ghost.btn-xs', { onclick: () => window.smcl.openPath(s.path).catch((e) => window.Toast.error(e.message)) }, svgIcon('folder', 15)),
          h('button.btn.btn-ghost.btn-xs.btn-danger', { title: '移入回收站', onclick: async () => {
            const ok = await window.Modal.confirm({ title: '删除存档「' + s.name + '」？', message: '将移入回收站，可从回收站恢复。', danger: true, okText: '删除' });
            if (!ok) return;
            try { await window.smcl.trashSave(s.path); window.Toast.success('已移入回收站'); window.Pages.versions.openDetail(v, '世界'); } catch (e) { window.Toast.error(e.message); }
          } }, svgIcon('trash', 15)),
        ));
      }
      pane.append(rows);
    }).catch((e) => { window.Dom.clear(pane).append(h('div.empty', null, e.message)); });
    return pane;
  }

  function buildAssetsPane(v, kind) {
    const stKey = 'swustmcl.assetView.' + kind;
    let view = localStorage.getItem(stKey) || (kind === 'screenshots' ? 'grid' : 'list');
    let sort = 'mtime-desc';
    let data = { items: [], folder: '' };
    const fmtTime = (ms) => {
      const d = new Date(ms);
      return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
    };
    const bodyBox = h('div', { style: { marginTop: '8px' } });
    const pane = h('div');
    const viewSeg = h('div.seg', null,
      h('button.seg-item' + (view === 'grid' ? '.active' : ''), { onclick: () => { view = 'grid'; localStorage.setItem(stKey, view); syncSeg(); draw(); } }, '网格'),
      h('button.seg-item' + (view === 'list' ? '.active' : ''), { onclick: () => { view = 'list'; localStorage.setItem(stKey, view); syncSeg(); draw(); } }, '列表'),
    );
    function syncSeg() {
      viewSeg.querySelectorAll('.seg-item').forEach((x, i) => x.classList.toggle('active', (i === 0) === (view === 'grid')));
    }
    const sortSel = h('select.select', { style: { maxWidth: '175px' }, onchange: (e) => { sort = e.target.value; draw(); } },
      h('option', { value: 'mtime-desc' }, '修改时间（新→旧）'),
      h('option', { value: 'name-asc' }, '名称 A→Z'),
      h('option', { value: 'name-desc' }, '名称 Z→A'),
      h('option', { value: 'size-desc' }, '大小（大→小）'),
    );
    pane.append(
      h('div.row', { style: { gap: '8px', flexWrap: 'wrap' } },
        viewSeg, sortSel,
        h('span.spacer'),
        h('button.btn.btn-ghost.btn-xs', { onclick: () => load() }, '↻ 刷新'),
        h('button.btn.btn-ghost.btn-xs', { onclick: () => window.smcl.openPath(data.folder).catch((e) => window.Toast.error(e.message)) }, svgIcon('folder', 14), '打开文件夹'),
      ),
      bodyBox,
    );
    function sorted() {
      const arr = data.items.slice();
      if (sort === 'name-asc') arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      else if (sort === 'name-desc') arr.sort((a, b) => b.name.localeCompare(a.name, 'zh-CN'));
      else if (sort === 'size-desc') arr.sort((a, b) => b.size - a.size);
      else arr.sort((a, b) => b.mtime - a.mtime);
      return arr;
    }
    async function trash(it) {
      const ok = await window.Modal.confirm({ title: '移到回收站', message: it.name, danger: true, okText: '删除' });
      if (!ok) return;
      try { await window.smcl.instanceAssetTrash(it.path); window.Toast.success('已移到回收站'); load(); } catch (e) { window.Toast.error(String(e.message || e).replace(/^Error: /, '')); }
    }
    function assetCard(it) {
      const thumb = kind === 'screenshots' && it.thumb
        ? h('img', { src: it.thumb, style: { width: '100%', borderRadius: '8px', display: 'block' } })
        : h('div', { style: { height: '76px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', display: 'grid', placeItems: 'center' } }, svgIcon(kind === 'screenshots' ? 'shot' : kind === 'shaderpacks' ? 'sun' : 'box', 26));
      return h('div.card.hoverable', {
        style: { padding: '8px', position: 'relative', cursor: 'pointer' },
        title: it.name,
        onclick: () => window.smcl.openPath(it.path).catch((e) => window.Toast.error(e.message)),
      },
        thumb,
        h('div', { style: { fontSize: '12px', fontWeight: '600', marginTop: '6px', wordBreak: 'break-all' } }, it.name),
        h('div.faint', { style: { fontSize: '11px' } }, (it.dir ? '文件夹' : fmtSize(it.size)) + ' · ' + fmtTime(it.mtime)),
        h('button.iconbtn', { title: '移到回收站', style: { position: 'absolute', right: '4px', top: '4px' }, onclick: (e) => { e.stopPropagation(); trash(it); } }, svgIcon('trash', 15)),
      );
    }
    function assetRow(it) {
      return h('div.dl-row', {
        style: { cursor: 'pointer' },
        onclick: () => window.smcl.openPath(it.path).catch((e) => window.Toast.error(e.message)),
      },
        h('span', { style: { display: 'inline-flex', flex: 'none' } }, svgIcon(kind === 'screenshots' ? 'shot' : kind === 'shaderpacks' ? 'sun' : 'box', 18)),
        h('div.grow', { style: { minWidth: 0 } },
          h('div', { style: { fontWeight: '600', fontSize: '13px', wordBreak: 'break-all' } }, it.name),
          h('div.faint', null, (it.dir ? '文件夹' : fmtSize(it.size)) + ' · ' + fmtTime(it.mtime)),
        ),
        h('button.btn.btn-ghost.btn-xs', { onclick: (e) => { e.stopPropagation(); trash(it); } }, svgIcon('trash', 15)),
      );
    }
    function draw() {
      window.Dom.clear(bodyBox);
      const items = sorted();
      if (!items.length) {
        bodyBox.append(h('div.empty', null, h('div.empty-icon', null, kind === 'screenshots' ? svgIcon('shot', 34) : kind === 'shaderpacks' ? svgIcon('sun', 34) : svgIcon('box', 34)), '这里还是空的 —— 点「打开文件夹」把文件放进去'));
        return;
      }
      if (view === 'grid') {
        const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' } });
        for (const it of items) grid.append(assetCard(it));
        bodyBox.append(grid);
      } else {
        const listEl = h('div.col', { style: { gap: '6px' } });
        for (const it of items) listEl.append(assetRow(it));
        bodyBox.append(listEl);
      }
    }
    async function load() {
      window.Dom.clear(bodyBox).append(h('div.skeleton', { style: { height: '120px' } }));
      try { data = await window.smcl.instanceAssets(v.dir, v.id, kind); } catch (e) { window.Dom.clear(bodyBox).append(h('div.empty', null, String(e.message || e).replace(/^Error: /, ''))); return; }
      draw();
    }
    load();
    return pane;
  }

  function buildSettingsPane(v, onSaved) {
    const pane = h('div');
    pane.append(h('div.skeleton', { style: { height: '120px' } }));
    window.smcl.instanceGetSettings(v.dir, v.id).then((cfg) => {
      window.Dom.clear(pane);
      const nameInput = h('input.input', { value: cfg.displayName || '', placeholder: '留空则使用实例目录名' });
      const javaInput = h('input.input.mono', { value: cfg.javaPath || '', placeholder: '留空则使用全局设置（javaw.exe）' });
      const memInput = h('input.input.tnum', { value: cfg.memory ? String(cfg.memory) : '', placeholder: '留空则使用全局设置', min: '256', step: '512' });
      const jvmInput = h('input.input.mono', { value: cfg.jvmArgs || '', placeholder: '留空则使用全局设置' });
      const renameInput = h('input.input', { value: v.id });
      const isolateSel = h('select.select', null,
        h('option', { value: 'auto', selected: (cfg.isolate === undefined || cfg.isolate === 'auto') }, '跟随全局设置'),
        h('option', { value: 'true', selected: cfg.isolate === true }, '版本隔离'),
        h('option', { value: 'false', selected: cfg.isolate === false }, '共享目录'),
      );
      pane.append(
        h('div.field', null, h('span.field-label', null, '显示名'), nameInput),
        h('div.field.mt-8', null,
          h('div.row', null,
            h('span.field-label.grow', null, 'Java（此实例专用）'),
            h('button.btn.btn-ghost.btn-xs', { onclick: () => window.JavaPicker.open(javaInput.value, (p) => { javaInput.value = p; }) }, svgIcon('list', 14), '从列表选择'),
            h('button.btn.btn-ghost.btn-xs', { onclick: async () => { try { const p = await window.smcl.pickJava(); if (p) javaInput.value = p; } catch (e) { window.Toast.error(e.message); } } }, '浏览…'),
          ),
          javaInput,
        ),
        h('div.field.mt-8', null, h('span.field-label', null, '内存（MB，留空跟随全局；建议不超过物理内存的 60%）'), memInput),
        h('div.field.mt-8', null, h('span.field-label', null, 'JVM 参数'), jvmInput),
        h('div.field.mt-8', null, h('span.field-label', null, '版本隔离'), isolateSel),
        h('hr.divider'),
        h('div.field', null, h('span.field-label', null, '重命名实例（目录与文件同步改名）'), renameInput),
        h('div.row.mt-12', null,
          h('button.btn.btn-danger.btn-sm.pressable', { onclick: async () => {
            const newId = (renameInput.value || '').trim();
            if (!newId || newId === v.id) return window.Toast.warn('请输入新实例名');
            try {
              await window.smcl.instanceRename(v.dir, v.id, newId);
              window.Toast.success('已改名 → ' + newId);
              window.app.refreshInstalled();
              selectedId = newId;
              if (onSaved) onSaved();
            } catch (e) { window.Toast.error(e.message.replace(/^Error: /, '')); }
          } }, '应用改名'),
          h('span.spacer'),
          h('button.btn.btn-primary.pressable', { onclick: async () => {
            try {
              await window.smcl.instanceSaveSettings(v.dir, v.id, {
                displayName: nameInput.value.trim(),
                javaPath: javaInput.value.trim(),
                memory: memInput.value.trim() === '' ? 0 : Number(memInput.value),
                jvmArgs: jvmInput.value,
                isolate: isolateSel.value === 'auto' ? 'auto' : isolateSel.value === 'true',
              });
              window.Toast.success('实例设置已保存');
              window.app.refreshInstalled();
              if (onSaved) onSaved();
            } catch (e) { window.Toast.error(e.message.replace(/^Error: /, '')); }
          } }, '保存设置'),
        ),
      );
    }).catch((e) => { window.Dom.clear(pane).append(h('div.empty', null, e.message)); });
    return pane;
  }

  function buildLogsPane(v) {
    const pane = h('div');
    const pre = h('pre', {
      style: {
        maxHeight: '480px', overflow: 'auto', fontSize: '11.5px', lineHeight: '1.55',
        whiteSpace: 'pre-wrap', fontFamily: 'Consolas, monospace',
        background: 'rgba(10, 13, 20, 0.6)', borderRadius: '10px', padding: '10px 12px', margin: '8px 0 0',
      },
    });
    window.smcl.instanceLog(v.id, 500).then((r) => {
      pre.textContent = (r.lines || []).join('\n') || '（这个实例还没有游戏日志）';
      pre.scrollTop = pre.scrollHeight;
    }).catch(() => {});
    pane.append(
      h('div.row', null,
        h('div.faint.grow', null, '每个实例的日志单独保存，不会和其它实例混在一起。'),
        h('button.btn.btn-ghost.btn-xs', { onclick: async () => { try { const r = await window.smcl.instanceLog(v.id, 1); await window.smcl.openPath(r.file); } catch (e) { window.Toast.error(e.message); } } }, '打开日志文件'),
        h('button.btn.btn-ghost.btn-xs', { onclick: async () => { try { await window.smcl.instanceLogClear(v.id); pre.textContent = '（已清空）'; } catch (e) { window.Toast.error(e.message); } } }, '清空'),
      ),
      pre,
    );
    return pane;
  }


  // ---------------------------------------------------------- 实例设置弹窗（复用共享构建器）
  function openInstanceSettings(v, initialTab) {
    const TABS = [['settings', '设置'], ['worlds', '世界'], ['resourcepacks', '资源包'], ['shaderpacks', '光影'], ['screenshots', '截图'], ['logs', '日志']];
    let tab = initialTab || 'settings';
    const seg = h('div.seg', { style: { marginBottom: '12px' } });
    const host = h('div');
    function show() {
      seg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
      window.Dom.clear(host);
      if (tab === 'settings') host.append(buildSettingsPane(v, () => {}));
      else if (tab === 'worlds') host.append(buildWorldsPane(v));
      else if (tab === 'resourcepacks' || tab === 'shaderpacks' || tab === 'screenshots') host.append(buildAssetsPane(v, tab));
      else host.append(buildLogsPane(v));
    }
    for (const [k, label] of TABS) {
      seg.append(h('button.seg-item' + (tab === k ? '.active' : ''), { dataset: { tab: k }, onclick: () => { tab = k; show(); } }, label));
    }
    modalRef = window.Modal.open({
      title: '实例设置 · ' + (v.displayName || v.id),
      size: 'lg',
      body: (el) => { el.append(seg, host); show(); },
    });
  }

  // ---------------------------------------------------------- 实例详情页（右侧）
  let detailTab = '概览';
  const DETAIL_TABS = ['概览', '世界', '模组', '资源包', '原理图', '光影', '截图', '设置'];

  function openDetail(v, tab) {
    selectedId = v.id;
    window.Store.set({ selectedInstance: v.id });
    detailTab = tab || '概览';
    if (window.app.current !== 'versions') window.app.goto('versions');
    else drawAll();
  }

  function detailView(v) {
    const el = h('div.ver-detail');
    el.append(h('div.ver-detail-head', null,
      h('div.ver-detail-title', null,
        h('span.loader-mini', { style: { width: '26px', flex: 'none' }, innerHTML: window.LoaderIcon.svg(v.loader, 26) }),
        h('span.ellipsis', { title: v.id }, v.displayName || v.id),
      ),
      h('span.spacer'),
      h('button.iconbtn', { title: '打开文件夹', onclick: () => openFolderOf(v) }, svgIcon('folder', 15)),
      h('button.iconbtn', { title: '导出整合包', onclick: () => window.app.goto('packs') }, svgIcon('export', 15)),
      h('button.iconbtn', { title: '移入回收站', style: { color: '#ff6369' }, onclick: () => deleteOne(v) }, svgIcon('trash', 15)),
      h('button.btn.btn-sm.pressable', {
        title: '把该实例设为首页启动实例',
        onclick: () => { window.Store.set({ homeVersionId: v.id }); window.Toast.success('已设为启动实例：' + (v.displayName || v.id)); },
      }, '设为启动实例'),
      h('button.btn.btn-primary.btn-sm.pressable', { onclick: () => launchOne(v) }, svgIcon('play', 14), '启动实例'),
    ));
    const seg = h('div.seg.ver-detail-tabs');
    const bodyEl = h('div.ver-detail-body');
    function show() {
      seg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x.dataset.tab === detailTab));
      window.Dom.clear(bodyEl);
      if (detailTab === '概览') bodyEl.append(buildOverviewPane(v));
      else if (detailTab === '世界') bodyEl.append(buildWorldsPane(v));
      else if (detailTab === '模组') bodyEl.append(buildModsPane(v));
      else if (detailTab === '资源包') bodyEl.append(buildAssetsPane(v, 'resourcepacks'));
      else if (detailTab === '光影') bodyEl.append(buildAssetsPane(v, 'shaderpacks'));
      else if (detailTab === '截图') bodyEl.append(buildAssetsPane(v, 'screenshots'));
      else if (detailTab === '原理图') bodyEl.append(h('div.empty', null, h('div.empty-icon', null, svgIcon('grid', 34)), '原理图目录暂未发现内容'));
      else bodyEl.append(buildSettingsPane(v, () => drawAll()));
    }
    for (const t of DETAIL_TABS) {
      seg.append(h('button.seg-item' + (detailTab === t ? '.active' : ''), { dataset: { tab: t }, onclick: () => { detailTab = t; show(); } }, t));
    }
    el.append(seg, bodyEl);
    show();
    return el;
  }

  // ---------------------------------------------------------- Mod 管理弹窗（PCL 风格）
  // ---------------------------------------------------------- Mod 管理（详情页「模组」标签 / 弹窗共用）
  function buildModsPane(v) {
    // 隔离实例的 mods 在 versions/<id>/mods，共享实例在游戏根目录
    const modsDirOf = () => (v.isolated ? [v.dir, 'versions', v.id, 'mods'] : [v.dir, 'mods']).join('\\');
    const host = h('div');
    let searchEl = null;
    let allMods = [];

    function currentList() {
      const q = (searchEl.value || '').toLowerCase();
      if (!q) return allMods;
      return allMods.filter((m) =>
        ((m.modName || m.name) + ' ' + (m.version || '') + ' ' + (m.authors || '') + ' ' + m.fileName)
          .toLowerCase().includes(q));
    }

    async function loadList() {
      window.Dom.clear(host).append(h('div.skeleton', { style: { height: '160px' } }));
      try {
        allMods = await window.smcl.modsList(v.dir, v.id);
      } catch (e) {
        window.Dom.clear(host).append(h('div.empty', null, e.message));
        return;
      }
      window.Dom.clear(host);
      searchEl = h('input.input', {
        placeholder: '搜索模组（名称 / 作者 / 版本）…',
        oninput: window.Dom.debounce(() => drawRows(), 160),
      });
      host.append(
        h('div.row.mb-12', null,
          searchEl,
          h('span.spacer'),
          h('button.btn.btn-sm.pressable', {
            onclick: () => window.smcl.openPath(modsDirOf()).catch((e) => window.Toast.error(String(e.message || e).replace(/^Error: /, ''))),
          }, svgIcon('folder', 14), '打开 mods 文件夹'),
        ),
        h('div.row.mod-table-head', null,
          h('div.mod-icon'),
          h('div.grow', null, '名称'),
          h('div.mod-ver', null, '版本'),
          h('div.mod-ops', null, '操作'),
        ),
        h('div.col.mod-table-body', { style: { gap: '8px' } }),
        h('div.faint.mt-8.mod-summary'),
      );
      drawRows();
    }

    function drawRows() {
      const body = host.querySelector('.mod-table-body');
      const summary = host.querySelector('.mod-summary');
      window.Dom.clear(body);
      const rows = currentList();
      if (!rows.length) {
        body.append(h('div.empty', null, allMods.length
          ? '没有匹配的模组'
          : '这个实例还没有装 Mod — 去「资源」页搜索安装，或把 .jar 拖进 mods 文件夹'));
        if (summary) summary.textContent = '';
        return;
      }
      for (const m of rows) body.append(modRow(m));
      const enabledCount = allMods.filter((m) => m.enabled).length;
      if (summary) summary.textContent = `共 ${allMods.length} 个 · 启用 ${enabledCount} · 禁用 ${allMods.length - enabledCount}`;
    }

    function modRow(m) {
      const icon = h('div.mod-icon', null,
        m.icon
          ? h('img', { src: m.icon, style: { width: '34px', height: '34px', borderRadius: '7px', imageRendering: 'pixelated' } })
          : h('div.mod-icon-fallback', null, svgIcon('box', 16)),
      );
      const sw = h('button.switch' + (m.enabled ? '.on' : ''), {
        title: m.enabled ? '禁用' : '启用',
        onclick: async () => {
          sw.disabled = true;
          try {
            await window.smcl.modsToggle(m.file, !m.enabled);
            m.enabled = !m.enabled;
            sw.classList.toggle('on', m.enabled);
            sw.disabled = false;
          } catch (err) { window.Toast.error(err.message); sw.disabled = false; }
        },
      });
      return h('div.row.dl-row', { style: { gap: '12px' } },
        icon,
        h('div.grow', { style: { minWidth: 0 } },
          h('div', { style: { fontWeight: '600', fontSize: '13px' }, className: m.enabled ? '' : 'faint' },
            m.modName || m.name,
            m.authors ? h('span.faint', null, `  · ${m.authors}`) : null,
          ),
          m.description ? h('div.faint.ellipsis', null, m.description) : null,
        ),
        h('div.mod-ver.tnum', null, m.version || '—'),
        h('div.mod-ops', null,
          sw,
          h('button.iconbtn', {
            title: '删除（回收站）',
            onclick: async () => {
              try {
                await window.smcl.modsDelete(m.file);
                allMods = allMods.filter((x) => x.file !== m.file);
                drawRows();
              } catch (err) { window.Toast.error(err.message); }
            },
          }, svgIcon('trash', 15)),
        ),
      );
    }

    loadList();
    return host;
  }

  function openModManager(v) {
    window.Modal.open({
      title: 'Mod 管理 · ' + (v.displayName || v.id),
      size: 'lg',
      body: (el) => el.append(buildModsPane(v)),
    });
  }

  async function launchOne(v) {
    try {
      await window.smcl.launch(v.id, v.dir);
      window.Toast.success(`已启动 ${v.id}`);
      window.app.goto('home');
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^Error:\s*/, '');
      window.Toast.error(msg);
    }
  }

  async function repairOne(v) {
    const bar = v && null;
    window.Toast.info(`开始体检 ${v.id}…`);
    try {
      const r = await window.smcl.repair(v.id, v.dir);
      if (r.ok) window.Toast.success(r.fixed ? `修复完成：补齐 ${r.fixed} 个文件` : '依赖完整，无需修复');
      else window.Toast.error(`仍有 ${r.remaining.length} 个文件未补齐，可尝试切换下载源后重试`);
      window.app.refreshInstalled();
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
    }
  }

  async function deleteOne(v) {
    const ok = await window.Modal.confirm({
      title: '删除实例',
      message: `确定删除实例「${v.id}」吗？`,
      detail: `${v.dir}\\versions\\${v.id}（将移入回收站，可恢复）`,
      okText: '移入回收站',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.smcl.deleteVersion(v.id, v.dir);
      window.Toast.success('已移入回收站');
      window.app.refreshInstalled();
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
    }
  }

  async function importPackFlow() {
    window.app.goto('packs');
  }

  async function addDirFlow() {
    try {
      await window.smcl.addDir();
      window.Toast.success('目录已添加');
      window.app.refreshInstalled();
    } catch {}
  }

  window.Pages = window.Pages || {};
  window.Pages.versions = {
    invalidateDetailCache() { detailNodeCache.clear(); },
    openModManager,
    openDetail,
    render(root) { render(root); },
    onShow() { drawAll(); },
    /** 体积后台推送（目录路径带反斜杠，不能用属性选择器直接拼，逐个比对才可靠） */
    onSize(payload) {
      if (!rootEl) return;
      const key = `${payload.dir}|${payload.id}`;
      const el = [...rootEl.querySelectorAll('[data-size-for]')].find((n) => n.dataset.sizeFor === key);
      if (el) el.textContent = `占用 ${fmtSize(payload.size)}`;
    },
  };
})();
