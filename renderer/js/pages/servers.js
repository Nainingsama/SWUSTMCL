'use strict';
/**
 * 服务器：校服 + 自定义服务器列表。
 * 卡片展示地址 / 在线人数 / 延迟 / 版本 / 备注，支持一键进服（绑定实例）。
 */
(function () {
  const { h } = window.Dom;
  let rootEl = null;
  let viewMode = localStorage.getItem('swustmcl.serversView') || 'grid';
  let lastPing = {};

  function ic(name, size = 16) {
    const P = {
      refresh: '<path d="M15.6 8.2A5.6 5.6 0 1 0 16 12.4"/><path d="M15.6 3.6v4.6h-4.6"/>',
      plus: '<path d="M10 4.5v11M4.5 10h11"/>',
      copy: '<rect x="6.5" y="6.5" width="9" height="9" rx="1.6"/><path d="M13.5 6.5V5A1.5 1.5 0 0 0 12 3.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5"/>',
      play: '<path d="M7 4.8l7.6 5.2L7 15.2z"/>',
      grid: '<path d="M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z"/>',
      list: '<path d="M7.5 6h9M7.5 10h9M7.5 14h9M4 6h.1M4 10h.1M4 14h.1"/>',
      dots: '<circle cx="5" cy="10" r="1.2" fill="currentColor"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/><circle cx="15" cy="10" r="1.2" fill="currentColor"/>',
      trash: '<path d="M5 6h10M8.2 6V4.6h3.6V6M6.6 6l.7 9.2h5.4L13.4 6M8.6 8.6v4.8M11.4 8.6v4.8"/>',
      edit: '<path d="M4 16l.7-3.4L14 3.3l2.7 2.7L7.4 15.3z"/>',
      server: '<rect x="3" y="4" width="14" height="5" rx="1.4"/><rect x="3" y="11" width="14" height="5" rx="1.4"/><path d="M6 6.5h.1M6 13.5h.1"/>',
    };
    const el = h('span', { style: { display: 'inline-flex', width: size + 'px', height: size + 'px', flex: 'none', alignItems: 'center' } });
    el.innerHTML = '<svg viewBox="0 0 20 20" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || '') + '</svg>';
    return el;
  }

  let subscribed = false;
  /** 实例列表晚于页面加载时，绑定状态起初会显示「未安装」；订阅后自动重绘 */
  function ensureSub() {
    if (subscribed) return;
    subscribed = true;
    window.Store.on('installed', () => {
      if (rootEl && window.Store.state.view === 'servers') draw();
    });
  }

  function render(root) {
    rootEl = root;
    ensureSub();
    window.Dom.clear(root);
    draw();
  }

  async function draw() {
    if (!rootEl) return;
    let list = [];
    try { list = await window.smcl.serversList(); } catch {}
    window.Dom.clear(rootEl);

    const viewSeg = h('div.seg', null,
      h('button.seg-item' + (viewMode === 'grid' ? '.active' : ''), { title: '网格', onclick: () => { viewMode = 'grid'; localStorage.setItem('swustmcl.serversView', viewMode); draw(); } }, ic('grid', 15)),
      h('button.seg-item' + (viewMode === 'list' ? '.active' : ''), { title: '列表', onclick: () => { viewMode = 'list'; localStorage.setItem('swustmcl.serversView', viewMode); draw(); } }, ic('list', 15)),
    );

    rootEl.append(
      h('div.section-title', null, '服务器',
        h('span.hint', null, list.length + ' 个服务器 · 实时在线状态'),
        h('span.spacer'),
        h('button.iconbtn', { title: '重新探测', onclick: () => { lastPing = {}; draw(); } }, ic('refresh', 16)),
        viewSeg,
        h('button.btn.btn-sm.pressable', { onclick: () => editServerFlow(null) }, ic('plus', 14), '添加服务器'),
      ),
    );

    if (!list.length) {
      rootEl.append(h('div.empty', null,
        h('div.empty-icon', null, ic('server', 34)),
        h('div', null, '还没有服务器'),
        h('button.btn.btn-primary.btn-sm.pressable', { style: { marginTop: '10px' }, onclick: () => editServerFlow(null) }, '添加服务器'),
      ));
      return;
    }

    if (viewMode === 'grid') {
      const grid = h('div.srv-grid');
      for (const srv of list) grid.append(serverCard(srv));
      rootEl.append(grid);
    } else {
      const rows = h('div.col', { style: { gap: '6px' } });
      for (const srv of list) rows.append(serverRow(srv));
      rootEl.append(rows);
    }

    for (const srv of list) probe(srv);
  }

  function statusDot() {
    return h('span.srv-dot.loading');
  }

  function playersBar(srv) {
    const bar = h('div.srv-players-bar', null, h('div.srv-players-fill', { style: { width: '0%' } }));
    const label = h('div.srv-players-label', null, '探测中…');
    const wrap = h('div.srv-players-wrap', null, label, bar);
    wrap.__set = (r) => {
      if (!r || !r.online) {
        label.textContent = '离线';
        bar.style.display = 'none';
        return;
      }
      const on = (r.players && r.players.online) || 0;
      const max = (r.players && r.players.max) || 0;
      label.textContent = on + ' / ' + max + ' 人在线';
      bar.style.display = 'block';
      wrap.querySelector('.srv-players-fill').style.width = Math.min(100, max ? (on / max) * 100 : 0) + '%';
    };
    return wrap;
  }

  function metaLine(srv) {
    const el = h('div.faint.srv-meta-line', null, srv.note || '');
    el.__set = (r) => {
      const bits = [];
      if (r && r.online && r.version) bits.push(r.version);
      if (r && r.online && r.latency != null) bits.push(r.latency + ' ms');
      if (r && r.online && r.motd) bits.push(r.motd);
      if (!bits.length && srv.note) bits.push(srv.note);
      el.textContent = bits.join(' · ');
    };
    return el;
  }

  function addrRow(srv) {
    return h('div.srv-addr-row', null,
      h('span.mono.ellipsis.grow', { title: srv.host + ':' + srv.port }, srv.host + ':' + srv.port),
      h('button.btn.btn-ghost.btn-xs', {
        onclick: async () => {
          try { await window.smcl.clipboardWrite(srv.host + ':' + srv.port); window.Toast.success('已复制地址'); } catch (e) { window.Toast.error(e.message); }
        },
      }, ic('copy', 14), '复制'),
    );
  }

  function serverCard(srv) {
    const dot = statusDot();
    const pb = playersBar(srv);
    const meta = metaLine(srv);
    const installed = window.Store.get('installed') || [];
    const boundOk = srv.instanceId && installed.some((v) => v.id === srv.instanceId);
    const avatarEl = h('div.srv-avatar', null, (srv.name || '?').slice(0, 1));
    const card = h('div.card.srv-card', { dataset: { srvKey: srv.host + ':' + srv.port } },
      h('div.srv-head', null,
        avatarEl,
        h('div.grow', { style: { minWidth: 0 } },
          h('div.srv-name-row', null,
            h('span.srv-name.ellipsis', { title: srv.name }, srv.name),
            srv.builtin ? h('span.badge.badge-blue', null, '校服') : null,
          ),
          h('div.faint', null, srv.instanceId ? (boundOk ? '绑定实例：' + srv.instanceId : '绑定实例未安装：' + srv.instanceId) : '未绑定整合包'),
        ),
        dot,
        h('button.iconbtn', { title: '编辑 / 删除', onclick: () => editServerFlow(srv) }, ic('dots', 16)),
      ),
      meta,
      pb,
      addrRow(srv),
      h('button.btn.btn-primary.btn-sm.srv-join.pressable', { onclick: () => joinFlow(srv) }, ic('play', 14), '一键进服'),
    );
    card.__dot = dot; card.__pb = pb; card.__meta = meta; card.__avatar = avatarEl;
    return card;
  }

  function serverRow(srv) {
    const dot = statusDot();
    const pb = playersBar(srv);
    const meta = metaLine(srv);
    const rowAvatarEl = h('div.srv-avatar.sm', null, (srv.name || '?').slice(0, 1));
    const row = h('div.ver-row', { dataset: { srvKey: srv.host + ':' + srv.port } },
      dot,
      rowAvatarEl,
      h('div.grow', { style: { minWidth: 0 } },
        h('div.ver-row-name.ellipsis', { title: srv.name }, srv.name + (srv.builtin ? '（校服）' : '')),
        meta,
      ),
      h('span.mono.faint', { style: { flex: 'none' } }, srv.host + ':' + srv.port),
      pb,
      h('button.btn.btn-ghost.btn-xs', {
        onclick: async () => { try { await window.smcl.clipboardWrite(srv.host + ':' + srv.port); window.Toast.success('已复制地址'); } catch (e) { window.Toast.error(e.message); } },
      }, ic('copy', 14)),
      h('button.btn.btn-primary.btn-xs.pressable', { onclick: () => joinFlow(srv) }, ic('play', 13), '进服'),
      h('button.iconbtn', { title: '编辑 / 删除', onclick: () => editServerFlow(srv) }, ic('dots', 16)),
    );
    row.__dot = dot; row.__pb = pb; row.__meta = meta; row.__avatar = rowAvatarEl;
    return row;
  }

  async function probe(srv) {
    const key = srv.host + ':' + srv.port;
    let r = lastPing[key];
    if (!r) {
      try { r = await window.smcl.serversPing(srv.host, srv.port); } catch { r = { online: false }; }
      lastPing[key] = r;
    }
    const els = rootEl ? [...rootEl.querySelectorAll('[data-srv-key]')].filter((el) => el.dataset.srvKey === key) : [];
    for (const el of els) {
      if (!el.__dot) continue;
      el.__dot.className = 'srv-dot ' + (r && r.online ? 'on' : 'off');
      if (el.__avatar && r && r.favicon && !el.__avatar.__done) {
        el.__avatar.__done = true;
        const im = h('img', { src: r.favicon, style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', display: 'block' } });
        im.addEventListener('error', () => im.remove());
        window.Dom.clear(el.__avatar).append(im);
        el.__avatar.style.padding = '0';
        el.__avatar.style.background = 'transparent';
      }
      if (el.__pb && el.__pb.__set) el.__pb.__set(r);
      if (el.__meta && el.__meta.__set && r && r.online) el.__meta.__set(r);
    }
  }

  function editServerFlow(srv) {
    const isNew = !srv;
    const name = h('input.input', { value: srv ? srv.name : '', placeholder: '服务器名称' });
    const addr = h('input.input', { value: srv ? srv.host + ':' + srv.port : '', placeholder: '地址，如 mc.example.com:25565' });
    const note = h('input.input', { value: srv ? srv.note || '' : '', placeholder: '备注（可选，如周目 / 版本 / 加载器）' });
    const installed = window.Store.get('installed') || [];
    const bindSel = h('select.select', null,
      h('option', { value: '' }, '不绑定实例'),
      ...installed.map((v) => h('option', { value: v.id, selected: srv && srv.instanceId === v.id }, v.id + (v.mcVersion ? ' · ' + v.mcVersion : ''))),
    );
    const m = window.Modal.open({
      title: isNew ? '添加服务器' : '编辑服务器',
      body: (el) => el.append(
        h('div.field', null, h('span.field-label', null, '名称'), name),
        h('div.field.mt-8', null, h('span.field-label', null, '地址'), addr),
        h('div.field.mt-8', null, h('span.field-label', null, '备注'), note),
        h('div.field.mt-8', null, h('span.field-label', null, '绑定实例（一键进服用）'), bindSel),
      ),
      footer: [
        isNew ? null : h('button.btn.btn-danger', {
          onclick: async () => {
            const ok = await window.Modal.confirm({ title: '移除服务器', message: '移除「' + srv.name + '」？', danger: true, okText: '移除' });
            if (!ok) return;
            try { await window.smcl.serversRemove(srv.id); window.Toast.success('已移除'); m.close(true); draw(); } catch (e) { window.Toast.error(e.message); }
          },
        }, ic('trash', 14), '移除'),
        h('span.spacer'),
        h('button.btn', { onclick: () => m.close(null) }, '取消'),
        h('button.btn.btn-primary', {
          onclick: async () => {
            const raw = addr.value.trim();
            if (!raw) return window.Toast.warn('请填写服务器地址');
            const mm = raw.match(/^([^:\s]+)(?::(\d+))?$/);
            if (!mm) return window.Toast.warn('地址格式不对，应为 host 或 host:port');
            try {
              await window.smcl.serversSave({
                id: srv ? srv.id : undefined,
                name: name.value.trim() || mm[1],
                host: mm[1],
                port: Number(mm[2]) || 25565,
                note: note.value.trim(),
                instanceId: bindSel.value,
              });
              lastPing = {};
              window.Toast.success(isNew ? '已添加服务器' : '已保存');
              m.close(true);
              draw();
            } catch (e) { window.Toast.error(e.message); }
          },
        }, '保存'),
      ].filter(Boolean),
    });
  }

  function joinFlow(srv) {
    const installed = window.Store.get('installed') || [];
    let inst = installed.find((v) => v.id === srv.instanceId);
    if (!inst) {
      if (!installed.length) { window.Toast.warn('还没有安装实例，请先到「下载游戏」安装'); return; }
      const sel = h('select.select', { style: { width: '100%' } },
        ...installed.map((v) => h('option', { value: v.id }, v.id + (v.mcVersion ? ' · ' + v.mcVersion : ''))));
      const m = window.Modal.open({
        title: '一键进服 · ' + srv.name,
        body: (el) => el.append(
          h('div.muted', { style: { marginBottom: '10px' } }, '选择用于加入 ' + srv.host + ':' + srv.port + ' 的实例（同时保存为该服务器默认实例）：'),
          sel,
        ),
        footer: [
          h('button.btn', { onclick: () => m.close(null) }, '取消'),
          h('button.btn.btn-primary', {
            onclick: async () => {
              const picked = installed.find((v) => v.id === sel.value);
              m.close(null);
              if (!picked) return;
              try { await window.smcl.serversSave({ ...srv, instanceId: picked.id }); } catch {}
              launchJoin(picked, srv);
            },
          }, '启动并记住'),
        ],
      });
      return;
    }
    launchJoin(inst, srv);
  }

  async function launchJoin(inst, srv) {
    try {
      window.Toast.info('正在启动 ' + inst.id + ' 并加入 ' + srv.host + ':' + srv.port + '…');
      await window.smcl.launch(inst.id, inst.dir, { server: { host: srv.host, port: srv.port } });
      window.Store.set({ gameRunning: true });
    } catch (e) {
      window.Toast.error(String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^Error:\s*/, ''));
    }
  }

  window.Pages = window.Pages || {};
  window.Pages.servers = {
    render,
    onShow() { ensureSub(); lastPing = {}; draw(); },
  };
})();
