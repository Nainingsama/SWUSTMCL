'use strict';
/**
 * 资源：Modrinth / CurseForge 搜索（模组/光影/材质包），
 * 按实例版本与加载器筛选，自动补齐依赖。
 */
(function () {
  const { h, fmtNum } = window.Dom;
  let rootEl = null;
  let state = { source: 'modrinth', type: 'mod', query: '', hits: [], total: 0, effectiveGv: '' };
  let autoLoaded = false;
  let filters = { instance: '', gameVersion: '', loader: '' };
  let lastDomainId = null;

  /** 当前域是否提供 CurseForge 中转（由皮肤站持有 Key）。 */
  function cfDomain() {
    const domain = window.DomainContext && window.DomainContext.active ? window.DomainContext.active() : null;
    if (!domain || domain.personal) return null;
    const cf = (domain.manifest || {}).curseforge;
    if (!cf || !cf.relayUrl) return null;
    return { domain, configured: Boolean(cf.configured) };
  }

  function iconSvg(name, size = 16) {
    const P = {
      grid: '<path d="M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z"/>',
      list: '<path d="M7.5 6h9M7.5 10h9M7.5 14h9M4 6h.1M4 10h.1M4 14h.1"/>',
    };
    const el = h('span', { style: { display: 'inline-flex', width: size + 'px', height: size + 'px', alignItems: 'center' } });
    el.innerHTML = '<svg viewBox="0 0 20 20" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || '') + '</svg>';
    return el;
  }
  function syncViewSeg(seg) {
    seg.querySelectorAll('.seg-item').forEach((x, i) => x.classList.toggle('active', (i === 0) === (viewMode === 'grid')));
  }

  const TYPE_LABEL = { mod: '模组', shader: '光影', resourcepack: '材质包', datapack: '数据包' };

  function render(root) {
    rootEl = root;
    window.Dom.clear(root);
    const activeDomain = window.DomainContext && window.DomainContext.active ? window.DomainContext.active() : null;
    const domainKey = (activeDomain && activeDomain.id) || 'personal';
    if (lastDomainId !== domainKey) {
      lastDomainId = domainKey;
      state.hits = [];
      state.total = 0;
      state.effectiveGv = '';
      autoLoaded = false;
      page = 1;
    }
    if (window.DomainContext && window.DomainContext.renderResources) window.DomainContext.renderResources(root);

    const search = h('input.input', {
      placeholder: '搜索模组 / 光影 / 材质包…（回车立即搜索）',
      style: { maxWidth: '300px' },
      oninput: window.Dom.debounce((e) => { state.query = e.target.value.trim(); doSearch(); }, 350),
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          state.query = e.target.value.trim();
          doSearch();
        }
      },
    });

    const sourceSeg = h('div.seg', null,
      segItem('source', 'modrinth', 'Modrinth'),
      segItem('source', 'curseforge', 'CurseForge'),
    );
    const typeSeg = h('div.seg', null,
      segItem('type', 'mod', '模组'),
      segItem('type', 'shader', '光影'),
      segItem('type', 'resourcepack', '材质包'),
    );

    filters.instance = filters.instance || (window.Store.get('installed') || [])[0]?.id || '';
    const instanceSel = h('select.select', { style: { maxWidth: '220px' }, onchange: (e) => updateFilters(e) });
    fillInstances(instanceSel);
    const cf = cfDomain();

    root.append(
      h('div.section-title', null, '资源下载',
        h('span.hint', null, cf
          ? (cf.configured ? 'Modrinth 全功能 · CurseForge 由当前域提供' : 'Modrinth 全功能 · 当前域未配置 CurseForge')
          : 'Modrinth 全功能 · CurseForge 需在设置里填写 API Key')),
      h('div.res-toolbar', null, search, sourceSeg, typeSeg, instanceSel,
        h('span.spacer'),
        h('div.seg', null,
          h('button.seg-item' + (viewMode === 'grid' ? '.active' : ''), { title: '网格视图', onclick: (e) => { viewMode = 'grid'; localStorage.setItem('swustmcl.resView', viewMode); syncViewSeg(e.currentTarget.parentElement); drawHits(); } }, iconSvg('grid', 15)),
          h('button.seg-item' + (viewMode === 'list' ? '.active' : ''), { title: '列表视图', onclick: (e) => { viewMode = 'list'; localStorage.setItem('swustmcl.resView', viewMode); syncViewSeg(e.currentTarget.parentElement); drawHits(); } }, iconSvg('list', 15)),
        ),
      ),
      h('div.faint.mb-8#resFilterHint'),
      h('div.res-grid#resGrid', null, h('div.empty', { style: { gridColumn: '1/-1' } }, h('div.empty-icon', null, '🔍'), '输入关键词开始搜索')),
    );

    function segItem(kind, value, label) {
      return h(`button.seg-item.${state[kind] === value ? 'active' : ''}`, {
        onclick: (e) => {
          state[kind] = value;
          const seg = e.currentTarget.parentElement;
          seg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === e.currentTarget));
          doSearch();
        },
      }, label);
    }

    updateFilters();
    if (state.hits.length) drawHits();
    // 默认加载热门内容（空关键词按下载量排序）
    else if (!autoLoaded) {
      autoLoaded = true;
      doSearch();
    }
  }

  function fillInstances(sel) {
    window.Dom.clear(sel);
    const list = window.Store.get('installed') || [];
    if (!list.length) sel.append(h('option', { value: '' }, '（暂无实例）'));
    for (const v of list) {
      sel.append(h('option', { value: v.id, dataset: { mc: v.mcVersion || '', loader: v.loader } },
        `${v.id} · ${v.mcVersion || v.type}`));
    }
  }

  function updateFilters() {
    const sel = rootEl.querySelector('select');
    if (!sel) return;
    const opt = sel.selectedOptions[0];
    filters.instance = sel.value;
    filters.gameVersion = opt ? opt.dataset.mc : '';
    const ldr = opt ? (opt.dataset.loader || '') : '';
    filters.loader = ldr === '原版' ? '' : ldr; // 原版实例不做加载器过滤
    const hint = rootEl.querySelector('#resFilterHint');
    if (hint) {
      hint.textContent = filters.instance
        ? `安装到实例「${filters.instance}」 · 按 ${filters.gameVersion || '任意版本'}${filters.loader && filters.loader !== '原版' ? ` · ${filters.loader}` : ''} 筛选`
        : '没有可用实例 —— 安装一个游戏后即可按版本筛选';
    }
  }

  let viewMode = localStorage.getItem('swustmcl.resView') || 'grid';
  let page = 1; // 当前页（从 1 开始）
  const PAGE_SIZE = 24;
  let searching = false;
  let searchSeq = 0; // 快速切换源/连续输入时，只认最后一次请求的结果

  /** 单源请求（q 可覆盖关键词，用于降级到「全部版本热门」） */
  const req = (source, gv, offset, q) => window.smcl.contentSearch({
    source,
    type: state.type,
    query: q !== undefined ? q : state.query,
    gameVersion: gv,
    loader: filters.loader,
    limit: PAGE_SIZE,
    offset,
  });

  /**
   * 搜索（分页制）。
   * - Modrinth 恒查；CurseForge 已配 Key 时并行聚合（CF 中文内容多，中文搜索主要靠它）
   * - 空关键词不带版本过滤；有关键词且该版本 0 适配时自动去版本过滤重试
   */
  async function doSearch(pageNum = 1) {
    const mySeq = ++searchSeq;
    searching = true;
    page = Math.max(1, pageNum);
    const grid = rootEl.querySelector('#resGrid');
    if (!grid) { searching = false; return; }
    window.Dom.clear(grid).append(
      h('div.empty', { style: { gridColumn: '1/-1' } }, h('span.spinner', { style: { borderTopColor: 'var(--accent)', width: '24px', height: '24px', border: '2px solid rgba(255,255,255,0.2)' } }), '搜索中…'),
    );
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const gv = state.effectiveGv !== undefined && page > 1 ? state.effectiveGv : filters.gameVersion;
      let degraded = false;

      const hint2El = rootEl.querySelector('#resFilterHint');
      const jobs = [];
      // 中文关键词：先经 MC百科 译名桥接换成英文名再搜
      let aliasNote = '';
      if (/[\u4e00-\u9fa5]/.test(state.query)) {
        try {
          const aliases = await window.smcl.contentChineseAlias(state.query);
          if (aliases.length) {
            state.effectiveGv = '';
            state.query = aliases[0].en;
            const src = aliases[0].offline ? '离线译名库' : 'MC百科';
            aliasNote = `经 ${src} 译名：「${aliases[0].zh}」→ ${aliases[0].en}`;
            if (hint2El) hint2El.innerHTML = '✓ ' + aliasNote;
          }
        } catch {}
      }
      // 译名后 state.query 已是英文原名；req 第二个参数是版本过滤（gv），不能传查询词
      // 按所选源查询：CurseForge 需要 Key（发布版内置），Modrinth 恒可用
      if (state.source === 'curseforge') {
        const cfCtx = cfDomain();
        if (!window.Store.get('cfReady')) {
          throw new Error(cfCtx
            ? '当前域尚未配置 CurseForge API Key，请联系域管理员'
            : 'CurseForge 未启用：请在设置里填写 API Key');
        }
        jobs.push(req('curseforge', gv, offset));
      } else {
        jobs.push(req('modrinth', gv, offset));
      }
      const [first] = await Promise.all(jobs);
      if (mySeq !== searchSeq) return; // 已切换到别的源/更新的关键词，丢弃本次结果
      const mr = state.source === 'curseforge' ? { hits: [], total: 0 } : (first || { hits: [], total: 0 });
      const cf = state.source === 'curseforge' ? (first || { hits: [], total: 0 }) : null;

      let hits = (mr.hits || []).map((x) => ({ ...x, __src: 'modrinth' }));
      let total = mr.total || 0;
      if (cf && cf.hits) {
        hits = hits.concat((cf.hits || []).map((x) => ({ ...x, __src: 'curseforge' })));
        total += cf.total || 0;
      }

      // 有关键词 + 版本过滤但 0 结果：去掉版本和关键词，回退为「全部版本热门内容」
      // （提示文案承诺的就是热门内容；若仍带着关键词，单字/生僻词会导致兜底也空）
      // 有关键词 + 版本过滤但 0 结果：去掉版本和关键词，回退为「全部版本热门内容」
      if (!hits.length && state.query && filters.gameVersion) {
        const retry = state.source === 'curseforge'
          ? req('curseforge', '', offset, '')
          : req('modrinth', '', offset, '');
        const r2 = await Promise.all([retry]).then((x) => x[0]).catch(() => ({ hits: [], total: 0 }));
        hits = (r2.hits || []).map((x) => ({ ...x, __src: state.source === 'curseforge' ? 'curseforge' : 'modrinth' }));
        total = r2.total || 0;
        degraded = true;
      }

      if (mySeq !== searchSeq) return;
      state.hits = hits;
      state.total = total;
      state.effectiveGv = degraded ? '' : (filters.gameVersion || '');
      drawHits();
      const hint2 = rootEl.querySelector('#resFilterHint');
      if (hint2 && degraded) hint2.innerHTML = '⚠ 当前版本暂无适配结果，已显示全部版本的热门内容';
      if (hint2 && !state.query && !window.Store.get('cfReady')) {
        const cfCtx = cfDomain();
        hint2.innerHTML = cfCtx
          ? '提示：当前域尚未配置 CurseForge API Key，请联系域管理员'
          : '提示：CurseForge 未启用（发布版自带；开发版可在设置填写 Key）—— CurseForge 资源以英文索引，中文资源请用英文名搜索';
      } else if (hint2 && state.query && /[\u4e00-\u9fa5]/.test(state.query)) {
        hint2.innerHTML = '提示：Modrinth / CurseForge 都以英文索引资源，中文一般搜不到 —— 请使用英文名（中文译名可在 MC百科 查询）';
      }
    } catch (e) {
      if (mySeq !== searchSeq) return;
      const msg = e.message
        .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
        .replace(/^Error:\s*/, '');
      if (/API Key/i.test(msg)) {
        const cfCtx = cfDomain();
        window.Dom.clear(grid).append(
          h('div.empty', { style: { gridColumn: '1/-1', gap: '10px' } },
            h('div.empty-icon', null, '🔑'),
            h('div', null, cfCtx ? '当前域 CurseForge 不可用' : 'CurseForge 需要 API Key 才能搜索'),
            cfCtx
              ? h('div.faint', null, msg)
              : h('div.row', { style: { justifyContent: 'center', marginTop: '4px' } },
                h('button.btn.btn-primary.btn-sm.pressable', {
                  onclick: () => {
                    window.app.goto('settings');
                    if (window.Pages.settings && window.Pages.settings.focusCfKey) window.Pages.settings.focusCfKey();
                  },
                }, '前往设置填写'),
                h('button.btn.btn-ghost.btn-sm.pressable', {
                  onclick: () => window.smcl.openUrl('https://console.curseforge.com/').catch(() => {}),
                }, '申请 API Key ↗'),
              ),
          ),
        );
      } else {
        window.Dom.clear(grid).append(
          h('div.empty', { style: { gridColumn: '1/-1' } }, h('div.empty-icon', null, '📡'), msg),
        );
      }
    } finally {
      if (mySeq === searchSeq) searching = false;
    }
  }

  function drawHits() {
    const grid = rootEl.querySelector('#resGrid');
    if (!grid) return;
    grid.className = viewMode === 'list' ? 'res-list' : 'res-grid';
    window.Dom.clear(grid);
    if (!state.hits.length) {
      grid.append(h('div.empty', { style: { gridColumn: '1/-1' } }, h('div.empty-icon', null, '🈳'),
        state.query ? `没有找到「${state.query}」相关资源 —— 试试更长的关键词或换英文名` : '没有结果'));
      return;
    }
    for (const hit of state.hits) {
      grid.append(viewMode === 'list' ? resRow(hit) : resCard(hit));
    }
    // 分页栏
    const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    const pager = h('div', { style: { gridColumn: '1/-1', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', padding: '12px 0 4px' } },
      h('button.btn.btn-sm.pressable', { disabled: page <= 1 ? true : null, onclick: () => { doSearch(page - 1); rootEl.querySelector('.main') && document.getElementById('main').scrollTo(0, 0); } }, '‹ 上一页'),
      h('span.faint.tnum', null, `第 ${page} / ${totalPages} 页 · 共 ${state.total} 个`),
      h('button.btn.btn-sm.pressable', { disabled: page >= totalPages ? true : null, onclick: () => { doSearch(page + 1); document.getElementById('main').scrollTo(0, 0); } }, '下一页 ›'),
    );
    grid.append(pager);
  }

  function resRow(hit) {
    const img = h('img.res-row-thumb', {
      src: hit.iconUrl || 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      loading: 'lazy',
      onerror: (e) => { e.target.style.visibility = 'hidden'; },
    });
    return h('div.card.hoverable.res-row.pressable', {
      onclick: () => showVersions(hit, hit.__src || state.source),
    },
      img,
      h('div.grow', { style: { minWidth: 0 } },
        h('div.res-title', null, hit.title),
        h('div.res-desc.res-row-desc', null, hit.description || ''),
        h('div.res-meta', null,
          hit.__src ? h('span.badge.' + (hit.__src === 'curseforge' ? 'badge-orange' : 'badge-green'), null, hit.__src === 'curseforge' ? 'CF' : 'MR') : null,
          h('span', null, '⬇ ' + fmtNum(hit.downloads)),
          h('span', null, '❤ ' + fmtNum(hit.follows)),
          h('span.ellipsis.grow', null, hit.author || ''),
          hit.versions && hit.versions.length ? h('span.badge.badge-blue', null, hit.versions[hit.versions.length - 1]) : null,
        ),
      ),
    );
  }

  function resCard(hit) {
    const img = h('img.res-thumb', {
      src: hit.iconUrl || 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      loading: 'lazy',
      onerror: (e) => { e.target.style.visibility = 'hidden'; },
    });
    return h('div.card.hoverable.res-card.pressable', {
      onclick: () => showVersions(hit, hit.__src || state.source),
    },
      img,
      h('div.res-title', null, hit.title),
      h('div.res-desc', null, hit.description || ''),
      h('div.res-meta', null,
        hit.__src ? h('span.badge.' + (hit.__src === 'curseforge' ? 'badge-orange' : 'badge-green'), null, hit.__src === 'curseforge' ? 'CF' : 'MR') : null,
        h('span', null, `⬇ ${fmtNum(hit.downloads)}`),
        h('span', null, `❤ ${fmtNum(hit.follows)}`),
        h('span.ellipsis.grow', null, hit.author || ''),
      ),
      h('div.row.row-wrap', { style: { gap: '4px' } },
        (hit.categories || []).slice(0, 3).map((c) => h('span.badge', null, c)),
        h('span.badge.badge-blue', null, hit.versions && hit.versions.length ? hit.versions[hit.versions.length - 1] : ''),
      ),
    );
  }

  async function showVersions(hit, sourceOverride) {
    if (!filters.instance) {
      window.Toast.warn('请先安装一个游戏实例');
      return;
    }
    const modal = window.Modal.open({ title: hit.title, size: 'lg' });
    const body = modal.bodyEl;
    body.append(h('div.skeleton', { style: { height: '160px' } }));
    try {
      let degradedVer = false;
      let list = await window.smcl.contentVersions({ source: sourceOverride || state.source, projectId: hit.id, type: state.type, gameVersion: filters.gameVersion, loader: filters.loader });
      if (!list.length && filters.gameVersion) {
        // 实例版本没有适配文件：回退为全部版本（保留加载器筛选），并提示
        degradedVer = true;
        list = await window.smcl.contentVersions({ source: sourceOverride || state.source, projectId: hit.id, type: state.type, gameVersion: '', loader: filters.loader });
      }
      window.Dom.clear(body);
      if (!list.length) {
        body.append(h('div.empty', null, '该资源没有匹配当前版本的文件'));
        return;
      }
      if (degradedVer) {
        body.append(h('div.banner.banner-warn', { style: { marginBottom: '10px' } },
          `当前实例版本（${filters.gameVersion}）没有适配文件，已显示全部版本`));
      }
      const listEl = h('div.col', { style: { gap: '8px' } });
      for (const v of list.slice(0, 12)) {
        const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
        if (!file) continue;
        const requiredDeps = (v.dependencies || []).filter((d) => d.type === 'required');
        // 安装时前置会自动带上；名称可点击跳到该前置的版本列表
        listEl.append(h('div.dl-row', null,
          h('div.grow', { style: { minWidth: 0 } },
            h('div', { style: { fontWeight: '600', fontSize: '13px' } }, v.versionNumber || v.name),
            h('div.faint', null, `${(v.gameVersions || []).slice(0, 3).join(', ')} · ${(v.loaders || []).join('/') || '-'}`),
            requiredDeps.length ? h('div.faint', null,
              '前置（安装时自动带上）：',
              ...requiredDeps.map((d, i) => [
                i > 0 ? '、' : null,
                h('a', {
                  style: { color: 'var(--accent-2)', cursor: 'pointer', textDecoration: 'underline' },
                  title: '查看该前置的版本',
                  onclick: async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                      const proj = await window.smcl.contentVersions({ source: 'modrinth', projectId: d.projectId, type: state.type, gameVersion: filters.gameVersion, loader: filters.loader });
                      void proj;
                      showVersions({ id: d.projectId, title: d.title || d.projectId }, 'modrinth');
                    } catch (err) { window.Toast.error(err.message); }
                  },
                }, d.title || d.projectId),
              ]),
            ) : null,
          ),
          h('button.btn.btn-primary.btn-sm.pressable', {
            onclick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              btn.textContent = '安装中…';
              try {
                const r = await window.smcl.contentInstall({
                  source: sourceOverride || state.source, projectId: hit.id, versionId: v.id, instance: filters.instance,
                  dir: (window.Store.get('installed') || []).find((x) => x.id === filters.instance)?.dir, type: state.type,
                });
                window.Toast.success(`已安装 ${r.files.map((f) => f.filename).join('、')}${r.files.length > 1 ? '（含依赖）' : ''}`);
                modal.close(true);
              } catch (err) {
                window.Toast.error(err.message.replace(/^Error: /, ''));
                btn.disabled = false;
                btn.textContent = '安装';
              }
            },
          }, '安装'),
        ));
      }
      body.append(listEl);
    } catch (e) {
      window.Dom.clear(body).append(h('div.empty', null, e.message.replace(/^Error: /, '')));
    }
  }

  window.Pages = window.Pages || {};
  window.Pages.content = {
    render,
    onShow() { updateFilters(); },
  };
})();
