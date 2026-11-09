'use strict';
/**
 * 下载游戏：官方版本清单（正式/快照/旧版筛选）+ 逐行进度 + 修复按钮
 * + 加载器在线安装（Fabric/Quilt/Forge/NeoForge，底座缺失自动补装）。
 */
(function () {
  const { h } = window.Dom;
  let rootEl = null;
  let manifestData = null;
  let type = 'release';
  let query = '';
  let manifestLoading = false;

  const installState = {}; // id -> {bar, meta}

  function render(root) {
    rootEl = root;
    window.Dom.clear(root);

    const search = h('input.input', {
      placeholder: '搜索版本号，如 1.21.2',
      style: { maxWidth: '240px' },
      oninput: window.Dom.debounce((e) => { query = e.target.value.trim().toLowerCase(); drawRows(); }, 180),
    });
    const seg = h('div.seg', null,
      segItem('release', '正式版'),
      segItem('snapshot', '快照'),
      segItem('old', '旧版'),
      segItem('all', '全部'),
    );
    function segItem(t, label) {
      return h(`button.seg-item${t === type ? '.active' : ''}`, {
        onclick: (e) => {
          type = t;
          seg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === e.currentTarget));
          drawRows();
        },
      }, label);
    }

    root.append(
      h('div.section-title', null, '官方版本',
        h('span.spacer'),
        h('button.btn.btn-primary.btn-sm.pressable', { onclick: () => window.Pages.download.openCreateWizard() }, '➕ 创建实例'),
        h('span.hint', null, manifestData ? `清单来源：${manifestData.source === 'race' ? '双源竞速' : manifestData.source}` : '加载中…')),
      h('div.dl-tabs', null, search, seg),
      h('div.dl-list#dlList', null, h('div.skeleton', { style: { height: '48px' } })),
    );

    loadManifest();
  }

  async function loadManifest(force) {
    if (manifestLoading) return;
    manifestLoading = true;
    try {
      manifestData = await window.smcl.manifest({ force: Boolean(force), type: 'all' });
      drawRows();
      const hint = rootEl.querySelector('.section-title .hint');
      if (hint) hint.textContent = `清单来源：${manifestData.source === 'race' ? '双源竞速' : manifestData.source}`;
    } catch (e) {
      const list = rootEl.querySelector('#dlList');
      window.Dom.clear(list).append(
        h('div.empty', null, h('div.empty-icon', null, '📡'), h('div', null, `清单获取失败：${e.message}`)),
        h('button.btn.btn-sm', { style: { margin: '0 auto' }, onclick: () => loadManifest(true) }, '重试'),
      );
    } finally {
      manifestLoading = false;
    }
  }

  function drawRows() {
    const list = rootEl.querySelector('#dlList');
    if (!list || !manifestData) return;
    window.Dom.clear(list);
    let rows = manifestData.versions || [];
    if (type === 'old') rows = rows.filter((v) => v.type === 'old_beta' || v.type === 'old_alpha');
    else if (type !== 'all') rows = rows.filter((v) => v.type === type);
    if (query) rows = rows.filter((v) => v.id.toLowerCase().includes(query));
    rows = rows.slice(0, 600);

    const installed = window.Store.get('installed') || [];
    const installedIds = new Set(installed.map((v) => v.id));

    if (!rows.length) {
      list.append(h('div.empty', null, h('div.empty-icon', null, '🔍'), '没有匹配的版本'));
      return;
    }
    for (const v of rows) {
      list.append(rowOf(v, installedIds.has(v.id)));
    }
  }

  function rowOf(v, installed) {
    const bar = h('div.progress-bar', { style: { width: '0%' } });
    const prog = h('div.dl-progress', null,
      h('div.progress', null, bar),
      h('div.progress-meta', null, h('span.msg', null, ''), h('span.pct.tnum', null, '')),
    );
    const badge = v.type === 'release' ? 'badge-green' : v.type === 'snapshot' ? 'badge-orange' : 'badge';
    // 无论是否已安装，点「安装」都进入创建向导（可选加载器；已存在的文件增量跳过）
    const action = h('button.btn.btn-sm.pressable', {
      title: installed ? '重新安装（可选择加载器，已存在的文件会跳过）' : '',
      onclick: () => window.Pages.download.openCreateWizard({ mc: v.id, mcEntry: v, startStep: 2 }),
    }, '安装');

    const row = h('div.dl-row', null,
      h('span.badge.' + badge, null, typeLabel(v.type)),
      h('span.dl-name', null, v.id),
      installed ? h('span.badge.badge-green', null, '✓ 已安装') : null,
      h('span.dl-time.grow', null, (v.releaseTime || '').slice(0, 10)),
      prog,
      action,
    );
    installState[v.id] = { bar, prog, action, row };
    return row;
  }

  function typeLabel(t) {
    return { release: '正式', snapshot: '快照', old_beta: 'Beta', old_alpha: 'Alpha' }[t] || t;
  }

  async function installFlow(v, action) {
    action.disabled = true;
    action.textContent = '安装中…';
    const st = installState[v.id];
    if (st) st.row.classList.add('installing');
    try {
      const r = await window.smcl.install(v.id, v.url);
      if (!r.ok) window.Tasks && window.Tasks.fail('安装 ' + v.id, r.error);
      if (r.ok) {
        window.Toast.success(`${v.id} 安装完成（${r.files} 个文件${r.skipped ? `，复用 ${r.skipped}` : ''}，${(r.bytes / 1048576).toFixed(1)} MB）`);
        window.__sizesAt = 0; // 解除体积扫描节流，让新实例的占用尽快显示
        window.app.refreshInstalled();
      } else {
        window.Toast.error(r.error || '安装失败');
        action.disabled = false;
        action.textContent = '修复';
      }
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
      action.disabled = false;
      action.textContent = '重试';
    } finally {
      if (st) st.row.classList.remove('installing');
    }
  }

  async function repairFlow(v) {
    window.Toast.info(`开始体检 ${v.id}…`);
    try {
      const inst = (window.Store.get('installed') || []).find((x) => x.id === v.id);
      const r = await window.smcl.repair(v.id, inst ? inst.dir : undefined);
      if (r.ok) window.Toast.success(r.fixed ? `修复完成：补齐 ${r.fixed} 个文件` : '依赖完整，无需修复');
      else window.Toast.error(`仍有 ${r.remaining.length} 个未补齐，可切换下载源重试`);
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
    }
  }

  // ------------------------------------------------------------ 加载器卡
  function buildLoaderCard(key, name, desc, color) {
    const grid = rootEl.querySelector('#loaderGrid');
    if (!grid) return;

    const mcInput = h('select.select', null, h('option', { value: '' }, '加载中…'));
    const lvSelect = h('select.select', null, h('option', { value: '' }, '先选游戏版本'));
    const instBtn = h('button.btn.btn-primary.btn-sm.pressable.block', { disabled: true }, '安装');
    const bar = h('div.progress-bar', { style: { width: '0%' } });
    const prog = h('div', { style: { display: 'none', flexDirection: 'column', gap: '6px', marginTop: '10px' } },
      h('div.progress', null, bar),
      h('div.progress-meta', null, h('span.msg', null, ''), h('span.pct.tnum', null, '')),
    );

    // MC 版本选项：取本地已装 + 清单里最近 30 个正式版
    const fillMc = () => {
      window.Dom.clear(mcInput);
      const local = (window.Store.get('installed') || []).map((v) => v.mcVersion).filter(Boolean);
      const remote = ((manifestData && manifestData.versions) || []).filter((v) => v.type === 'release').slice(0, 30).map((v) => v.id);
      const all = [...new Set([...local, ...remote])].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of all.slice(0, 40)) mcInput.append(h('option', { value: v }, v));
      if (!all.length) mcInput.append(h('option', { value: '' }, '暂无可用版本'));
    };
    fillMc();

    mcInput.addEventListener('change', async () => {
      const mc = mcInput.value;
      window.Dom.clear(lvSelect).append(h('option', { value: '' }, '加载中…'));
      instBtn.disabled = true;
      if (!mc) return;
      try {
        const list = await window.smcl.listLoaders(key, mc);
        window.Dom.clear(lvSelect);
        for (const l of list.slice(0, 25)) {
          lvSelect.append(h('option', { value: l.version }, `${l.version}${l.stable ? '' : '（测试）'}`));
        }
        if (!list.length) lvSelect.append(h('option', { value: '' }, '该版本暂无'));
        else instBtn.disabled = false;
      } catch (e) {
        window.Dom.clear(lvSelect).append(h('option', { value: '' }, '获取失败'));
      }
    });

    instBtn.addEventListener('click', async () => {
      const mc = mcInput.value;
      const lv = lvSelect.value;
      if (!mc || !lv) return;
      instBtn.disabled = true;
      prog.style.display = 'flex';
      try {
        const r = await window.smcl.installLoader(key, mc, lv, '');
        window.Toast.success(`${name} ${lv} 安装完成 → ${r.id || mc}`);
        window.__sizesAt = 0;
        window.app.refreshInstalled();
      } catch (e) {
        window.Toast.error(e.message.replace(/^Error: /, ''));
      } finally {
        instBtn.disabled = false;
        setTimeout(() => { prog.style.display = 'none'; bar.style.width = '0%'; }, 1500);
      }
    });

    grid.append(h('div.card.hoverable', { style: { padding: '16px' } },
      h('div.row', null,
        h('div.ver-icon.ver-icon-img', { innerHTML: window.LoaderIcon.svg(key, 30) }),
        h('div.grow', null,
          h('div.ver-title', null, name),
          h('div.ver-sub', null, desc),
        ),
      ),
      h('div.row.mt-12', null, h('div.field.grow', null, h('span.field-label', null, '游戏版本'), mcInput)),
      h('div.row.mt-8', null, h('div.field.grow', null, h('span.field-label', null, '加载器版本'), lvSelect)),
      h('div.mt-12', null, instBtn),
      prog,
    ));
  }

  window.Pages = window.Pages || {};
  window.Pages.download = {
    render,
    onShow() { if (!manifestData) loadManifest(); window.app.refreshInstalled(); },
    /** 安装进度事件（主进程推送） */
    onProgress(p) {
      const st = installState[p.id];
      if (!st) return;
      st.bar.style.width = `${p.percent || 0}%`;
      const msg = st.prog.querySelector('.msg');
      const pct = st.prog.querySelector('.pct');
      if (msg) msg.textContent = p.message || '';
      if (pct) pct.textContent = p.percent != null ? `${p.percent}%` : '';
    },
  };
})();


// ============================================================ 创建实例向导
(function () {
  let loaderVers = null;
  const typeLabel = (t) => ({ release: '正式', snapshot: '快照', old_beta: 'Beta', old_alpha: 'Alpha' }[t] || t);
  async function openCreateWizard(preset) {
  const p0 = preset || {};
  let step = p0.startStep || 1;
  const sel = { mc: p0.mc || null, mcEntry: p0.mcEntry || null, loader: p0.loader || null, loaderVer: null, name: p0.name || '', isolate: 'auto' };
  let manifest = null;
  let modalRef = null;
  let bodyEl = null;
  const STEPS = ['选择游戏版本', '选择加载器', '基本设置'];

  modalRef = window.Modal.open({
    title: '创建新实例',
    size: 'lg',
    body: (el) => {
      bodyEl = el;
      el.append(h('div.skeleton', { style: { height: '320px' } }));
      window.smcl.manifest({ type: 'all' }).then((m) => { manifest = m; draw(); }).catch((e) => {
        window.Dom.clear(el).append(h('div.empty', null, e.message));
      });
    },
  });

  function draw() {
    const el = bodyEl;
    window.Dom.clear(el);
    el.append(h('div.wizard-steps', null, STEPS.map((label, i) => {
      const n = i + 1;
      const state = n < step ? 'done' : n === step ? 'cur' : '';
      return h('div.wizard-step.' + state, null,
        h('div.wizard-dot', null, n < step ? '✓' : String(n)),
        h('div.wizard-label', null, label),
        n < STEPS.length ? h('div.wizard-line.' + (n < step ? 'done' : '')) : null,
      );
    })));
    const content = h('div.wizard-content');
    el.append(content);
    if (step === 1) drawStep1(content);
    else if (step === 2) drawStep2(content);
    else drawStep3(content);
    el.append(h('div.row.mt-16', null,
      h('button.btn.pressable', { onclick: () => modalRef.close(null) }, '取消'),
      h('span.spacer'),
      step > 1 ? h('button.btn.pressable', { onclick: () => { step -= 1; draw(); } }, '上一步') : null,
      h('button.btn.btn-primary.pressable', {
        style: canNext() ? {} : { opacity: 0.45, pointerEvents: 'none' },
        onclick: () => { if (canNext()) next(); },
      }, step === 3 ? '🚀 创建实例' : '下一步'),
    ));
  }

  function canNext() {
    if (step === 1) return Boolean(sel.mc);
    if (step === 2) return sel.loader === 'vanilla' || Boolean(sel.loaderVer);
    return true;
  }

  function next() {
    if (step === 3) return create();
    step += 1;
    draw();
  }

  let mcFilter = 'release';
  let mcQuery = '';
  function drawStep1(box) {
    window.Dom.clear(box); // 防叠加
    const list = h('div.wizard-list');
    const drawVersions = () => {
      window.Dom.clear(list);
      let rows = (manifest.versions || []);
      if (mcFilter === 'old') rows = rows.filter((v) => v.type === 'old_beta' || v.type === 'old_alpha');
      else if (mcFilter !== 'all') rows = rows.filter((v) => v.type === mcFilter);
      if (mcQuery) rows = rows.filter((v) => v.id.toLowerCase().includes(mcQuery));
      rows = rows.slice(0, 600);
      if (sel.mc && !rows.some((v) => v.id === sel.mc)) {
        const hit = (manifest.versions || []).find((v) => v.id === sel.mc);
        if (hit) rows.unshift(hit);
      }
      for (const v of rows) {
        const chosen = sel.mc === v.id;
        list.append(h('div.wizard-row' + (chosen ? '.chosen' : ''), {
          onclick: () => {
            sel.mc = v.id; sel.mcEntry = v; draw();
            // 预取四个加载器的版本列表（loaders.js 有 60s 缓存）→ 第 2 步秒出
            ['fabric', 'quilt', 'forge', 'neoforge'].forEach((ld) => {
              window.smcl.listLoaders(ld, v.id).catch(() => {});
            });
          },
        },
          h('span.badge.' + (v.type === 'release' ? 'badge-green' : v.type === 'snapshot' ? 'badge-orange' : 'badge'), null, typeLabel(v.type)),
          h('div.grow', { style: { fontWeight: '600', fontSize: '13px' } }, v.id),
          h('span.dl-time', null, (v.releaseTime || '').slice(0, 10)),
        ));
      }
      if (!rows.length) list.append(h('div.empty', null, '没有匹配的版本'));
    };
    box.append(h('div.row.mb-12', null,
      h('input.input', {
        placeholder: '搜索版本号…',
        style: { maxWidth: '220px' },
        oninput: window.Dom.debounce((e) => { mcQuery = e.target.value.trim().toLowerCase(); drawVersions(); }, 150),
      }),
      h('div.seg', null, ['release', 'snapshot', 'old', 'all'].map((t) =>
        h('button.seg-item.' + (mcFilter === t ? '.active' : ''), {
          onclick: (e) => {
            mcFilter = t;
            box.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === e.currentTarget));
            drawVersions();
          },
        }, { release: '正式版', snapshot: '快照', old: '旧版', all: '全部' }[t]),
      )),
    ));
    box.append(list);
    drawVersions();
  }

  function drawStep2(box) {
    window.Dom.clear(box); // 防叠加
    const LOADERS = [
      { key: 'vanilla', name: '不装加载器', desc: '纯净原版', icon: 'MC', cls: '' },
      { key: 'fabric', name: 'Fabric', desc: '轻量 · 生态最活跃', icon: 'Fa', cls: 'loader-Fabric' },
      { key: 'quilt', name: 'Quilt', desc: 'Fabric 兼容', icon: 'Qu', cls: 'loader-Quilt' },
      { key: 'forge', name: 'Forge', desc: '老牌 · 大型模组', icon: 'Fo', cls: 'loader-Forge' },
      { key: 'neoforge', name: 'NeoForge', desc: '1.20.1+ 新生态', icon: 'Ne', cls: 'loader-NeoForge' },
    ];
    const grid = h('div.wizard-loaders');
    const verPane = h('div.wizard-list.loader-vers');
    box.append(grid, verPane);

    const drawVers = async () => {
      window.Dom.clear(verPane);
      if (sel.loader === 'vanilla' || !sel.loader) return;
      verPane.append(h('div.muted', null, '加载器版本加载中…'));
      try {
        loaderVers = await window.smcl.listLoaders(sel.loader, sel.mc);
        window.Dom.clear(verPane);
        if (!loaderVers.length) { verPane.append(h('div.empty', null, '该 MC 版本暂无此加载器')); return; }
        for (const l of loaderVers.slice(0, 25)) {
          const chosen = sel.loaderVer === l.version;
          verPane.append(h('div.wizard-row' + (chosen ? '.chosen' : ''), {
            onclick: () => {
              sel.loaderVer = l.version;
              if (!sel.name || sel.name === sel.mc || sel.name.indexOf(sel.loader) === 0) {
                sel.name = L_NAME(sel.loader) + '-' + l.version + '-' + sel.mc;
              }
              draw();
            },
          },
            h('div.grow', { style: { fontWeight: '600', fontSize: '13px' } }, l.version),
            h('span.badge.' + (l.stable ? 'badge-green' : 'badge-orange'), null, l.stable ? '稳定' : '测试'),
          ));
        }
      } catch (e) {
        window.Dom.clear(verPane).append(
          h('div.empty', null, h('div.empty-icon', null, '📡'), e.message),
          h('div.row', { style: { justifyContent: 'center' } },
            h('button.btn.btn-sm.pressable', { onclick: () => drawVers() }, '🔄 重试'),
          ),
        );
      }
    };
    const L_NAME = (k) => k;

    for (const L of LOADERS) {
      const idx = LOADERS.indexOf(L);
      const card = h('div.wizard-loader' + (sel.loader === L.key ? '.chosen' : '') + (L.cls ? '.' + L.cls : ''), {
        onclick: () => {
          sel.loader = L.key;
          sel.loaderVer = null;
          if (L.key === 'vanilla') sel.name = sel.mc;
          else if (!sel.name || sel.name.indexOf(LOADERS.some((x) => sel.name.indexOf(x.key) === 0) ? sel.name.slice(0, 6) : '') === 0) {
            sel.name = L.key + '-' + sel.mc;
          }
          grid.querySelectorAll('.wizard-loader').forEach((x) => x.classList.remove('chosen'));
          card.classList.add('chosen');
          drawVers();
        },
      },
        h('div.ver-icon.ver-icon-img', { innerHTML: window.LoaderIcon.svg(L.key, 30) }),
        h('div.grow', null,
          h('div', { style: { fontWeight: '650', fontSize: '13.5px' } }, L.name),
          h('div.faint', null, L.desc),
        ),
      );
      grid.append(card);
    }
    if (sel.loader) drawVers();
  }

  function drawStep3(box) {
    const nameInput = h('input.input', { value: sel.name, oninput: (e) => { sel.name = e.target.value; } });
    const isolateSel = h('select.select', null,
      h('option', { value: 'auto', selected: sel.isolate === 'auto' }, '跟随全局设置'),
      h('option', { value: 'true', selected: sel.isolate === 'true' }, '版本隔离（独立 mods/saves）'),
      h('option', { value: 'false', selected: sel.isolate === 'false' }, '共享目录'),
    );
    isolateSel.addEventListener('change', () => { sel.isolate = isolateSel.value; });
    box.append(
      h('div.field', null,
        h('span.field-label', null, '实例名'),
        nameInput,
        h('span.field-hint', null, sel.loader === 'vanilla'
          ? '纯原版实例，稍后可在实例设置里改名/装加载器'
          : `将安装 ${sel.loader} ${sel.loaderVer}，底座 ${sel.mc} 缺失时自动补装`),
      ),
      h('div.field.mt-8', null, h('span.field-label', null, '版本隔离'), isolateSel),
    );
  }

  let creating = false;
  async function create() {
    if (creating) return;
    creating = true;
    const el = bodyEl;
    window.Dom.clear(el);
    el.append(
      h('div.col', { style: { gap: '12px', padding: '30px 6px' } },
        h('div.row', null,
          h('div', { style: { fontWeight: '700', fontSize: '15px' }, className: 'grow' }, `正在创建 ${sel.name || sel.mc} …`),
          h('button.btn.btn-sm.pressable', { onclick: () => {
            modalRef.close(null);
            window.Toast.info('任务已转入后台，进度见右下角');
          } }, '后台运行'),
        ),
        h('div.progress', null, h('div.progress-bar', { id: 'createWizBar', style: { width: '0%' } })),
        h('div.progress-meta', null, h('span', { id: 'createWizMsg' }, '准备中…'), h('span', { id: 'createWizPct' }, '')),
      ),
    );
    const onLoaderSub = window.smcl.onLoader((p) => {
      const bar = document.getElementById('createWizBar');
      if (!bar) return;
      bar.style.width = (p.percent || 0) + '%';
      document.getElementById('createWizMsg').textContent = p.message || '';
      document.getElementById('createWizPct').textContent = p.percent != null ? p.percent + '%' : '';
    });
    const onInstallSub = window.smcl.onInstall((p) => {
      const bar = document.getElementById('createWizBar');
      if (!bar) return;
      bar.style.width = (p.percent || 0) + '%';
      document.getElementById('createWizMsg').textContent = p.message || '';
      document.getElementById('createWizPct').textContent = p.percent != null ? p.percent + '%' : '';
    });
    try {
      if (sel.loader === 'vanilla') {
        const r = await window.smcl.install(sel.mc, sel.mcEntry.url);
        if (!r.ok) throw new Error(r.error || '安装失败');
      } else {
        await window.smcl.installLoader(sel.loader, sel.mc, sel.loaderVer, sel.name || '');
      }
      if (sel.isolate !== 'auto') {
        const inst = (window.Store.get('installed') || []).find((x) => x.id === (sel.name || sel.mc));
        if (inst) await window.smcl.instanceSaveSettings(inst.dir, inst.id, { isolate: sel.isolate === 'true' }).catch(() => {});
      }
      window.Toast.success('实例创建成功：' + (sel.name || sel.mc));
      onLoaderSub(); onInstallSub();
      modalRef.close(true);
      window.__sizesAt = 0;
      window.app.refreshInstalled();
      window.app.goto('versions');
    } catch (e) {
      onLoaderSub(); onInstallSub();
      window.Tasks && window.Tasks.fail('创建实例 ' + (sel.name || sel.mc), e.message);
      if (!document.body.contains(el)) {
        window.TaskCard.finish(false, '实例创建失败');
        window.Toast.error(e.message.replace(/^Error: /, ''));
        return;
      }
      window.Dom.clear(el).append(
        h('div.empty', null, h('div.empty-icon', null, '⚠'), e.message.replace(/^Error: /, '')),
        h('div.row', { style: { justifyContent: 'center' } },
          h('button.btn.btn-primary.pressable', { onclick: () => { creating = false; step = 1; draw(); } }, '返回重试'),
        ),
      );
    }
  }
  }
  window.Pages = window.Pages || {};
  window.Pages.download = window.Pages.download || {};
  window.Pages.download.openCreateWizard = openCreateWizard;
})();