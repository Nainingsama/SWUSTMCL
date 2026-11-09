'use strict';
/**
 * 下载任务中心：进行中 / 历史记录。
 * 数据源：Store.taskMap（app.js 的任务系统由四类进度事件驱动登记）。
 */
(function () {
  const { h, fmtSize } = window.Dom;
  let rootEl = null;
  let tab = 'running';
  let query = '';
  let sourceFilter = 'all';

  function tasks() {
    return Object.values(window.Store.get('taskMap') || {});
  }

  function render(root) {
    rootEl = root;
    window.Dom.clear(root);
    root.classList.add('downloads-page');

    const tabs = h('div.seg', null,
      h('button.seg-item' + (tab === 'running' ? '.active' : ''), { onclick: () => { tab = 'running'; render(rootEl); } }, '⬇ 正在进行'),
      h('button.seg-item' + (tab === 'history' ? '.active' : ''), { onclick: () => { tab = 'history'; render(rootEl); } }, '◷ 历史记录'),
    );

    const search = h('input.input', {
      placeholder: '搜索下载任务…',
      style: { maxWidth: '320px' },
      oninput: window.Dom.debounce((e) => { query = e.target.value.trim().toLowerCase(); draw(); }, 150),
    });
    const srcSel = h('select.select', { style: { maxWidth: '170px' }, onchange: (e) => { sourceFilter = e.target.value; draw(); } },
      ...['all', 'Minecraft', 'Java', 'Modrinth', 'CurseForge', '本地'].map((v) =>
        h('option', { value: v, selected: sourceFilter === v }, v === 'all' ? '所有来源' : v)),
    );

    root.append(
      h('div.row', null, tabs, h('span.spacer')),
      h('div.row.mb-12', null, search, srcSel, h('span.spacer')),
      h('div#taskList'),
    );
    draw();
    // running 卡耗时每秒跳动
    if (!window.Pages.downloads._tickTimer) {
      window.Pages.downloads._tickTimer = setInterval(() => {
        if (window.Store.state.view !== 'downloads') return;
        const rows = [...document.querySelectorAll('#taskList .tnum')];
        const running = tasks().filter((t) => t.status === 'running');
        if (!running.length) return;
        rows.forEach((el) => {
          const key = el.dataset.taskkey;
          const t = running.find((x) => x.name === key);
          if (t) el.textContent = Math.round((Date.now() - t.start) / 1000) + 's';
        });
      }, 1000);
    }
    // 实时：taskMap 变化自动刷新
    if (!window.Pages.downloads._wired) {
      window.Pages.downloads._wired = true;
      window.Store.on('taskMap', () => {
        if (window.Store.state.view === 'downloads' && rootEl) draw();
      });
    }
  }

  function filtered() {
    return tasks().filter((t) => {
      if (tab === 'running' && t.status !== 'running') return false;
      if (tab === 'history' && t.status === 'running') return false;
      if (sourceFilter !== 'all' && t.source !== sourceFilter) return false;
      if (query && !t.name.toLowerCase().includes(query)) return false;
      return true;
    }).sort((a, b) => (b.start || 0) - (a.start || 0));
  }

  function draw() {
    const el = rootEl.querySelector('#taskList');
    if (!el) return;
    window.Dom.clear(el);
    const rows = filtered();
    if (!rows.length) {
      el.append(h('div.card', null, h('div.empty', null,
        h('div.empty-icon', null, tab === 'running' ? '☕' : '◷'),
        h('div', { style: { fontSize: '16px', fontWeight: '700' } }, tab === 'running' ? '暂无下载任务' : '暂无历史记录'),
        h('div.faint', null, tab === 'running' ? '新的下载与安装进度会显示在这里。' : '完成的下载与安装会归档到这里。'),
      )));
      return;
    }
    const list = h('div.col', { style: { gap: '10px' } });
    for (const t of rows) list.append(taskCard(t));
    el.append(list);
  }

  function taskCard(t) {
    const dur = t.end ? Math.round((t.end - t.start) / 1000) : Math.round((Date.now() - t.start) / 1000);
    const running = t.status === 'running';
    const bar = h('div.progress', null, h('div.progress-bar' + (running && !t.percent ? '.indeterminate' : ''), { style: { width: (t.percent || (running ? 0 : 100)) + '%' } }));
    return h('div.card', { style: { padding: '14px 16px' } },
      h('div.row', null,
        h('span.badge.badge-blue', null, t.source),
        h('div.grow.ellipsis', { style: { fontWeight: '650', fontSize: '13.5px' } }, t.name),
        running ? h('span.pulse-dot') : h('span.badge.' + (t.status === 'failed' ? 'badge-red' : 'badge-green'), null, t.status === 'failed' ? '失败' : '完成'),
      ),
      bar,
      h('div.progress-meta', null,
        h('span', null, t.message || (running ? '进行中…' : '')),
        h('span.tnum', { dataset: { taskkey: t.name } }, running ? Math.round((Date.now() - t.start) / 1000) + 's' : '耗时 ' + dur + 's'),
      ),
    );
  }

  window.Pages = window.Pages || {};
  window.Pages.downloads = {
    render,
    onShow() { if (rootEl) draw(); },
  };
})();
