'use strict';
/**
 * 域：站点型域的添加 / 切换 / 公告 / 服务器 / 资源 / 账号同步。
 */
(function () {
  const { h } = window.Dom;
  let rootEl = null;
  let domains = [];
  let selectedId = '';
  let drawing = false;
  let subscribed = false;
  const pings = {};

  function ic(name, size = 16) {
    const P = {
      plus: '<path d="M10 4.5v11M4.5 10h11"/>',
      refresh: '<path d="M15.6 8.2A5.6 5.6 0 1 0 16 12.4"/><path d="M15.6 3.6v4.6h-4.6"/>',
      trash: '<path d="M5 6h10M8.2 6V4.6h3.6V6M6.6 6l.7 9.2h5.4L13.4 6M8.6 8.6v4.8M11.4 8.6v4.8"/>',
      play: '<path d="M7 4.8l7.6 5.2L7 15.2z"/>',
      globe: '<circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5c2.2 2.2 2.2 10.8 0 13M10 3.5c-2.2 2.2-2.2 10.8 0 13"/>',
      copy: '<rect x="6.5" y="6.5" width="9" height="9" rx="1.6"/><path d="M13.5 6.5V5A1.5 1.5 0 0 0 12 3.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5"/>',
      download: '<path d="M10 3.5v9m0 0L6.5 9M10 12.5 13.5 9M4 16h12"/>',
      user: '<circle cx="10" cy="6.5" r="3.2"/><path d="M3.5 17c1-3.4 3.6-5 6.5-5s5.5 1.6 6.5 5"/>',
      package: '<path d="M3.5 7.5 10 4l6.5 3.5v5L10 16l-6.5-3.5zM3.5 7.5 10 11l6.5-3.5M10 11v5"/>',
      x: '<path d="M5 5l10 10M15 5 5 15"/>',
    };
    const el = h('span', { style: { display: 'inline-flex', width: size + 'px', height: size + 'px', flex: 'none', alignItems: 'center' } });
    el.innerHTML = '<svg viewBox="0 0 20 20" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || '') + '</svg>';
    return el;
  }

  function normalizeRoot(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function domainFor(id) {
    return domains.find((item) => item.id === id) || null;
  }

  async function ensureSubscriptions() {
    if (subscribed) return;
    subscribed = true;
    window.smcl.onDomainAdded((item) => {
      selectedId = item.id;
      window.Toast.success('已添加域：' + item.name);
      draw();
    });
    window.smcl.onDomainError((payload) => {
      window.Toast.error(payload && payload.message ? payload.message : '域邀请处理失败');
    });
    window.smcl.onDomainResourceProgress((p) => {
      if (p && p.total) {
        const percent = Math.min(100, Math.round((Number(p.received || 0) / Number(p.total)) * 100));
        if (percent === 100) window.Toast.info('资源下载完成');
      }
    });
  }

  function render(root) {
    rootEl = root;
    ensureSubscriptions();
    window.Dom.clear(root);
    root.addEventListener('dragover', (event) => event.preventDefault());
    root.addEventListener('drop', async (event) => {
      event.preventDefault();
      const text = event.dataTransfer ? event.dataTransfer.getData('text/plain') : '';
      if (!text) return;
      try {
        const item = await window.smcl.domainsAdd(text);
        selectedId = item.id;
        window.Toast.success('已添加域：' + item.name);
        draw();
      } catch (e) {
        window.Toast.error(e.message);
      }
    });
    draw();
  }

  async function draw() {
    if (!rootEl || drawing) return;
    drawing = true;
    try {
      domains = await window.smcl.domainsList();
      if (selectedId && !domainFor(selectedId)) selectedId = '';
      if (!selectedId && domains.length) selectedId = domains[0].id;
      const domain = domainFor(selectedId);
      window.Dom.clear(rootEl);
      rootEl.append(header());
      if (!domains.length) {
        rootEl.append(h('div.empty', null,
          h('div.empty-icon', null, ic('globe', 34)),
          h('div', null, '还没有添加域'),
          h('div.faint', { style: { marginTop: '6px' } }, '在皮肤站的「社团域」页面复制邀请，或手动填写域地址。'),
          h('button.btn.btn-primary.btn-sm.pressable', { style: { marginTop: '10px' }, onclick: addFlow }, '添加域'),
        ));
        return;
      }
      rootEl.append(domainList());
      if (domain) rootEl.append(detail(domain));
    } finally {
      drawing = false;
    }
  }

  function header() {
    return h('div.section-title', null, '域',
      h('span.hint', null, domains.length + ' 个域 · 公告 / 服务器 / 资源 / 账号同步'),
      h('span.spacer'),
      h('button.iconbtn', { title: '刷新全部域', onclick: refreshAll }, ic('refresh', 16)),
      h('button.btn.btn-sm.pressable', { onclick: addFlow }, ic('plus', 14), '添加域'),
    );
  }

  function domainList() {
    const grid = h('div.domain-grid');
    for (const item of domains) {
      const manifest = item.manifest || {};
      const active = item.id === selectedId;
      grid.append(h('div.card.domain-card' + (active ? '.active' : ''), {
        onclick: () => { selectedId = item.id; draw(); },
      },
        h('div.domain-card-top', null,
          h('div.domain-avatar', null, item.icon ? h('img', { src: item.icon, alt: '' }) : ic('globe', 22)),
          h('div.grow', { style: { minWidth: 0 } },
            h('div.domain-name.ellipsis', { title: item.name }, item.name),
            h('div.faint.ellipsis', null, item.url),
          ),
          item.error ? h('span.badge.badge-red', null, '缓存') : null,
        ),
        h('div.domain-card-meta', null,
          h('span', null, (manifest.servers || []).length + ' 个服务器'),
          h('span', null, (manifest.resources || []).length + ' 个资源'),
          h('span', null, item.fetchedAt ? new Date(item.fetchedAt).toLocaleDateString('zh-CN') : '未刷新'),
        ),
        h('div.domain-card-actions', null,
          h('button.btn.btn-ghost.btn-xs', { onclick: (e) => { e.stopPropagation(); refreshDomain(item); } }, ic('refresh', 13), '刷新'),
          h('button.btn.btn-xs.btn-danger', { onclick: (e) => { e.stopPropagation(); removeDomain(item); } }, ic('trash', 13), '移除'),
        ),
      ));
    }
    return grid;
  }

  function detail(domain) {
    const manifest = domain.manifest || {};
    const wrap = h('div.domain-detail');
    wrap.append(detailHero(domain));
    wrap.append(h('div.domain-grid.two', null,
      h('section.card', null,
        h('div.card-body', null,
          h('div.section-subtitle', null, '域公告'),
          h('div.domain-announcement', { style: { whiteSpace: 'pre-wrap' } },
            (manifest.announcement && manifest.announcement.text) || '管理员还没有发布公告。'),
          manifest.announcement && manifest.announcement.updatedAt
            ? h('div.faint', { style: { marginTop: '10px' } }, '更新于 ' + new Date(manifest.announcement.updatedAt).toLocaleString('zh-CN'))
            : null,
        ),
      ),
      accountCard(domain),
    ));
    wrap.append(serversSection(domain));
    wrap.append(resourcesSection(domain));
    return wrap;
  }

  function detailHero(domain) {
    const manifest = domain.manifest || {};
    return h('section.card.domain-hero', null,
      h('div.domain-hero-main', null,
        h('div.domain-avatar.lg', null, domain.icon ? h('img', { src: domain.icon, alt: '' }) : ic('globe', 30)),
        h('div.grow', { style: { minWidth: 0 } },
          h('div.domain-hero-name', null, domain.name),
          h('div.muted', null, manifest.description || '把域添加到启动器，直接获取官方服务器和资源。'),
          h('div.faint', { style: { marginTop: '4px' } }, manifest.siteUrl || domain.url),
        ),
      ),
      h('div.domain-hero-actions', null,
        h('button.btn.btn-ghost.btn-sm', { onclick: () => copyInvite(domain) }, ic('copy', 13), '复制邀请'),
        h('button.btn.btn-ghost.btn-sm', { onclick: () => window.smcl.openUrl(manifest.siteUrl || domain.url).catch((e) => window.Toast.error(e.message)) }, ic('globe', 13), '打开站点'),
      ),
    );
  }

  function accountCard(domain) {
    const manifest = domain.manifest || {};
    const authRoot = normalizeRoot((manifest.auth && manifest.auth.yggdrasilUrl) || manifest.yggdrasilUrl || '');
    const card = h('section.card', null, h('div.card-body', null,
      h('div.section-subtitle', null, '账号同步'),
      h('div.domain-account-host', null, h('div.faint', null, '正在读取账号…')),
    ));
    const host = card.querySelector('.domain-account-host');
    window.smcl.accountsList().then((store) => {
      const list = Array.isArray(store) ? store : (store && store.list) || [];
      const account = list.find((item) => item.type === 'authlib' && normalizeRoot(item.payload && item.payload.root) === authRoot);
      window.Dom.clear(host);
      if (!account) {
        host.append(
          h('div.muted', null, '登录该域所属皮肤站账号，同步角色与皮肤。'),
          h('button.btn.btn-primary.btn-sm.pressable', { style: { marginTop: '10px' }, onclick: () => loginFlow(domain) }, ic('user', 14), '登录站点账号'),
        );
        return;
      }
      const selected = (account.payload && account.payload.selected) || null;
      const profiles = (account.payload && account.payload.profiles) || [];
      host.append(
        h('div.domain-account-current', null,
          h('div.domain-account-avatar', null, ic('user', 16)),
          h('div.grow', null,
            h('strong', null, selected ? selected.name : account.name),
            h('div.faint', null, '已同步 ' + profiles.length + ' 个角色'),
          ),
          h('span.badge.badge-green', null, '已登录'),
        ),
        profiles.length
          ? h('div.domain-profiles', null,
              ...profiles.map((profile) => h('button.btn.btn-xs' + (selected && selected.id === profile.id ? '.btn-primary' : '.btn-ghost'), {
                onclick: async () => {
                  try {
                    await window.smcl.accountsSelectProfile(account.uid, profile.id);
                    window.Toast.success('已切换角色：' + profile.name);
                    draw();
                  } catch (e) { window.Toast.error(e.message); }
                },
              }, profile.name)),
            )
          : null,
        h('button.btn.btn-ghost.btn-xs', { style: { marginTop: '10px' }, onclick: () => loginFlow(domain) }, ic('refresh', 12), '重新登录'),
      );
    }).catch(() => {
      window.Dom.clear(host).append(h('div.faint', null, '账号信息读取失败'));
    });
    return card;
  }

  function serversSection(domain) {
    const servers = (domain.manifest && domain.manifest.servers) || [];
    const section = h('section.domain-section', null,
      h('div.section-subtitle', null, '官方服务器', h('span.hint', null, ' · 实时 SLP 探测')),
      servers.length ? h('div.srv-grid') : h('div.empty', null, h('div', null, '还没有官方服务器')),
    );
    const grid = section.querySelector('.srv-grid');
    if (!grid) return section;
    for (const server of servers) {
      const dot = h('span.srv-dot.loading');
      const players = h('div.faint', null, server.note || '');
      const card = h('div.card.srv-card', null,
        h('div.srv-head', null,
          h('div.srv-avatar', null, (server.name || '?').slice(0, 1)),
          h('div.grow', { style: { minWidth: 0 } },
            h('div.srv-name-row', null, h('span.srv-name.ellipsis', { title: server.name }, server.name)),
            h('div.faint', null, server.host + ':' + server.port),
          ),
          dot,
        ),
        server.note ? h('div.faint', null, server.note) : null,
        players,
        h('button.btn.btn-primary.btn-sm.srv-join.pressable', { onclick: () => joinFlow(domain, server) }, ic('play', 14), '一键进服'),
      );
      grid.append(card);
      probe(server, dot, players, card);
    }
    return section;
  }

  async function probe(server, dot, players, card) {
    const key = server.host + ':' + server.port;
    let result = pings[key];
    if (!result) {
      try { result = await window.smcl.serversPing(server.host, server.port); } catch { result = { online: false }; }
      pings[key] = result;
    }
    dot.className = 'srv-dot ' + (result && result.online ? 'on' : 'off');
    if (result && result.online) {
      const online = (result.players && result.players.online) || 0;
      const max = (result.players && result.players.max) || 0;
      players.textContent = online + ' / ' + max + ' 人在线' + (result.version ? ' · ' + result.version : '');
      if (result.favicon && card) {
        const avatar = card.querySelector('.srv-avatar');
        if (avatar) {
          avatar.style.padding = '0';
          window.Dom.clear(avatar).append(h('img', { src: result.favicon, style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' } }));
        }
      }
    } else {
      players.textContent = server.note || '未探测到在线状态';
    }
  }

  function resourcesSection(domain) {
    const resources = (domain.manifest && domain.manifest.resources) || [];
    const section = h('section.domain-section', null,
      h('div.section-subtitle', null, '资源分发', h('span.hint', null, ' · 整合包 / 资源包 / 光影')),
      resources.length ? h('div.domain-resources') : h('div.empty', null, h('div', null, '还没有发布资源')),
    );
    const host = section.querySelector('.domain-resources');
    if (!host) return section;
    const label = { modpack: '整合包', resourcepack: '资源包', shaderpack: '光影', other: '资源' };
    for (const resource of resources) {
      host.append(h('div.card.domain-resource', null,
        h('div.domain-resource-icon', null, ic('package', 18)),
        h('div.grow', { style: { minWidth: 0 } },
          h('div.domain-resource-name', null, resource.name),
          h('div.faint', null, (label[resource.type] || resource.type) + (resource.version ? ' · ' + resource.version : '') + (resource.size ? ' · ' + formatBytes(resource.size) : '')),
          resource.description ? h('div.muted.ellipsis', { title: resource.description }, resource.description) : null,
        ),
        h('div.domain-resource-actions', null,
          h('button.btn.btn-ghost.btn-sm', { onclick: () => downloadResource(domain, resource) }, ic('download', 13), '下载'),
          resource.type === 'modpack'
            ? h('button.btn.btn-primary.btn-sm', { onclick: () => downloadAndImport(domain, resource) }, ic('package', 13), '导入整合包')
            : resource.type === 'resourcepack' || resource.type === 'shaderpack'
              ? h('button.btn.btn-primary.btn-sm', { onclick: () => installResource(domain, resource) }, ic('check', 13), '安装到实例')
              : null,
        ),
      ));
    }
    return section;
  }

  function addFlow() {
    const input = h('input.input', { placeholder: 'https://www.swustmc.com 或 swustmcl:domain:...' });
    const m = window.Modal.open({
      title: '添加域',
      body: (el) => el.append(
        h('div.muted', { style: { marginBottom: '10px' } }, '填写域地址，或从皮肤站「社团域」页面复制/拖拽邀请。'),
        input,
        h('div.faint', { style: { marginTop: '8px' } }, '协议：swustmcl://add-domain?url=...'),
      ),
      footer: [
        h('button.btn', { onclick: () => m.close(null) }, '取消'),
        h('button.btn.btn-primary', {
          onclick: async () => {
            const value = input.value.trim();
            if (!value) return window.Toast.warn('请填写域地址');
            try {
              const item = await window.smcl.domainsAdd(value);
              selectedId = item.id;
              window.Toast.success('已添加域：' + item.name);
              m.close(true);
              draw();
            } catch (e) { window.Toast.error(e.message); }
          },
        }, '添加'),
      ],
    });
    setTimeout(() => input.focus(), 60);
  }

  async function loginFlow(domain) {
    const manifest = domain.manifest || {};
    const authRoot = (manifest.auth && manifest.auth.yggdrasilUrl) || manifest.yggdrasilUrl || '';
    if (!authRoot) return window.Toast.warn('该域没有配置认证地址');
    const username = h('input.input', { placeholder: '用户名或邮箱' });
    const password = h('input.input', { type: 'password', placeholder: '密码' });
    const m = window.Modal.open({
      title: '登录站点账号 · ' + domain.name,
      body: (el) => el.append(
        h('div.muted', { style: { marginBottom: '10px' } }, '登录后会把该域的角色同步到账户列表，可在启动时选择。'),
        h('div.field', null, h('span.field-label', null, '账号'), username),
        h('div.field.mt-8', null, h('span.field-label', null, '密码'), password),
      ),
      footer: [
        h('button.btn', { onclick: () => m.close(null) }, '取消'),
        h('button.btn.btn-primary', {
          onclick: async () => {
            if (!username.value.trim() || !password.value) return window.Toast.warn('请填写账号和密码');
            try {
              const r = await window.smcl.authlibLogin(authRoot, username.value.trim(), password.value);
              window.Toast.success('登录成功：' + ((r.selected && r.selected.name) || '已同步角色'));
              m.close(true);
              draw();
            } catch (e) { window.Toast.error(e.message); }
          },
        }, '登录'),
      ],
    });
  }

  async function joinFlow(domain, server) {
    const installed = window.Store.get('installed') || [];
    if (!installed.length) return window.Toast.warn('还没有安装实例，请先到「下载游戏」安装');
    const sel = h('select.select', { style: { width: '100%' } },
      ...installed.map((v) => h('option', { value: v.id }, v.id + (v.mcVersion ? ' · ' + v.mcVersion : ''))));
    const m = window.Modal.open({
      title: '一键进服 · ' + server.name,
      body: (el) => el.append(
        h('div.muted', { style: { marginBottom: '10px' } }, '选择用于加入 ' + server.host + ':' + server.port + ' 的实例：'),
        sel,
      ),
      footer: [
        h('button.btn', { onclick: () => m.close(null) }, '取消'),
        h('button.btn.btn-primary', {
          onclick: async () => {
            const picked = installed.find((v) => v.id === sel.value);
            m.close(null);
            if (!picked) return;
            try {
              window.Toast.info('正在启动 ' + picked.id + ' 并加入 ' + server.host + ':' + server.port + '…');
              await window.smcl.launch(picked.id, picked.dir, { server: { host: server.host, port: server.port } });
              window.Store.set({ gameRunning: true });
            } catch (e) {
              window.Toast.error(String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^Error:\s*/, ''));
            }
          },
        }, '启动'),
      ],
    });
  }

  async function downloadResource(domain, resource) {
    try {
      window.Toast.info('正在下载 ' + resource.name + '…');
      const file = await window.smcl.domainDownloadResource(domain.id, resource.id);
      window.Toast.success('已下载到：' + file.path);
    } catch (e) { window.Toast.error(e.message); }
  }

  async function downloadAndImport(domain, resource) {
    try {
      window.Toast.info('正在下载整合包…');
      const file = await window.smcl.domainDownloadResource(domain.id, resource.id);
      const ok = await window.Modal.confirm({ title: '导入整合包', message: '已下载「' + resource.name + '」，现在导入为新实例？', okText: '导入' });
      if (!ok) return;
      window.Toast.info('正在导入整合包…');
      await window.smcl.installPack(file.path);
      window.Toast.success('整合包导入完成');
    } catch (e) { window.Toast.error(String(e.message || e)); }
  }

  async function installResource(domain, resource) {
    const installed = window.Store.get('installed') || [];
    if (!installed.length) return window.Toast.warn('还没有安装实例');
    const sel = h('select.select', { style: { width: '100%' } },
      ...installed.map((v) => h('option', { value: v.id }, v.id + (v.mcVersion ? ' · ' + v.mcVersion : ''))));
    const m = window.Modal.open({
      title: '安装资源 · ' + resource.name,
      body: (el) => el.append(h('div.muted', { style: { marginBottom: '10px' } }, '选择目标实例：'), sel),
      footer: [
        h('button.btn', { onclick: () => m.close(null) }, '取消'),
        h('button.btn.btn-primary', {
          onclick: async () => {
            const picked = installed.find((v) => v.id === sel.value);
            m.close(null);
            if (!picked) return;
            try {
              window.Toast.info('正在下载并安装…');
              const file = await window.smcl.domainInstallResource(domain.id, resource.id, picked.dir);
              window.Toast.success('已安装：' + file.path);
            } catch (e) { window.Toast.error(e.message); }
          },
        }, '安装'),
      ],
    });
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
    return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  async function refreshDomain(item) {
    try {
      await window.smcl.domainsRefresh(item.id);
      window.Toast.success('域已刷新');
      draw();
    } catch (e) { window.Toast.error(e.message); }
  }

  async function refreshAll() {
    if (!domains.length) return;
    for (const item of domains) {
      try { await window.smcl.domainsRefresh(item.id); } catch {}
    }
    pings && Object.keys(pings).forEach((key) => delete pings[key]);
    window.Toast.success('已刷新全部域');
    draw();
  }

  async function removeDomain(item) {
    const ok = await window.Modal.confirm({ title: '移除域', message: '移除「' + item.name + '」？', danger: true, okText: '移除' });
    if (!ok) return;
    try {
      await window.smcl.domainsRemove(item.id);
      if (selectedId === item.id) selectedId = '';
      window.Toast.success('域已移除');
      draw();
    } catch (e) { window.Toast.error(e.message); }
  }

  function copyInvite(domain) {
    const base = (domain.manifest && domain.manifest.siteUrl) || domain.url;
    window.smcl.clipboardWrite('swustmcl:domain:' + encodeURIComponent(base))
      .then(() => window.Toast.success('域邀请已复制'))
      .catch((e) => window.Toast.error(e.message));
  }

  window.Pages = window.Pages || {};
  window.Pages.domains = {
    render,
    onShow() { pings && Object.keys(pings).forEach((key) => delete pings[key]); draw(); },
  };
})();
