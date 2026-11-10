'use strict';
/**
 * 域上下文：个人域 / 站点型域。域不是独立页面，而是启动器的当前环境。
 * 切换域会切换可见账号、首页与服务器页内容，并限制域内只能登录对应皮肤站。
 */
(function () {
  const { h } = window.Dom;
  let state = { activeId: 'personal', items: [] };
  let bound = false;

  function active() {
    return (state.items || []).find((item) => item.id === state.activeId)
      || (state.items || []).find((item) => item.id === 'personal')
      || null;
  }

  function managed() {
    const item = active();
    return Boolean(item && !item.personal);
  }

  function authRoot() {
    const item = active();
    if (!item || item.personal) return '';
    const manifest = item.manifest || {};
    return String((manifest.auth && manifest.auth.yggdrasilUrl) || manifest.yggdrasilUrl || '').replace(/\/+$/, '');
  }

  function iconSvg(size = 16) {
    const el = h('span', { style: { display: 'inline-flex', width: size + 'px', height: size + 'px', alignItems: 'center' } });
    el.innerHTML = '<svg viewBox="0 0 20 20" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5c2.2 2.2 2.2 10.8 0 13M10 3.5c-2.2 2.2-2.2 10.8 0 13" stroke-width="1.3"/></svg>';
    return el;
  }

  function paint() {
    const item = active();
    const nameEl = document.getElementById('domainCardName');
    const hintEl = document.getElementById('domainCardHint');
    const iconEl = document.getElementById('domainCardIcon');
    if (!nameEl || !hintEl || !iconEl) return;
    const manifest = (item && item.manifest) || {};
    nameEl.textContent = item ? item.name : '个人域';
    hintEl.textContent = item && !item.personal ? (manifest.description || '站点型域') : '本地环境';
    const card = document.getElementById('domainCard');
    if (card) card.title = item ? ('当前域：' + item.name + ' · 点击切换') : '切换域';
    window.Dom.clear(iconEl);
    if (item && item.icon) iconEl.append(h('img', { src: item.icon, alt: '' }));
    else iconEl.append(iconSvg(16));
    document.body.classList.toggle('has-domain', managed());
  }

  async function reloadState() {
    state = await window.smcl.domainsState();
    window.Store.set({ domain: state });
    paint();
    return state;
  }

  async function switchTo(id) {
    try {
      const result = await window.smcl.domainsSetActive(id);
      state = result.state;
      window.Store.set({ domain: state, account: result.account || null, cfReady: Boolean(result.cfReady) });
      paint();
      window.app.updateAccountCard();
      window.app.reloadView();
      const item = active();
      window.Toast.success('已切换到：' + (item ? item.name : '个人域'));
    } catch (e) {
      window.Toast.error(String((e && e.message) || e));
    }
  }

  async function openSwitcher() {
    let modal = null;
    const body = h('div.domain-switch-list');
    const rows = () => {
      window.Dom.clear(body);
      for (const item of state.items || []) {
        const isActive = item.id === state.activeId;
        const manifest = item.manifest || {};
        body.append(h('div.domain-switch-row' + (isActive ? '.active' : ''), {
          onclick: () => { modal.close(true); switchTo(item.id); },
        },
          h('span.domain-switch-icon', null, item.icon ? h('img', { src: item.icon, alt: '' }) : iconSvg(18)),
          h('span.grow', { style: { minWidth: 0 } },
            h('span.domain-switch-name', null, item.name, isActive ? h('span.badge.badge-green', { style: { marginLeft: '8px' } }, '当前') : null),
            h('span.faint.ellipsis', null, item.personal ? '本机个人环境，可使用离线/微软/任意皮肤站账户' : (manifest.description || item.url)),
          ),
          item.personal ? null : h('span.domain-switch-actions', null,
            h('button.iconbtn', { title: '刷新', onclick: (e) => { e.stopPropagation(); refresh(item.id, rows); } }, '↻'),
            h('button.iconbtn', { title: '移除', style: { color: '#ff6369' }, onclick: (e) => { e.stopPropagation(); remove(item, rows); } }, '×'),
          ),
        ));
      }
    };
    rows();
    modal = window.Modal.open({
      title: '切换域',
      body: (el) => el.append(
        h('div.muted', { style: { marginBottom: '10px' } }, '个人域使用本地账户；站点型域会接管服务器、资源与登录账号。'),
        body,
      ),
      footer: [
        h('button.btn', { onclick: () => modal.close(false) }, '关闭'),
        h('span.spacer'),
        h('button.btn.btn-primary', { onclick: () => { modal.close(true); addFlow(); } }, '＋ 添加域'),
      ],
    });
  }

  async function addFlow() {
    const input = h('input.input', { placeholder: 'https://www.swustmc.com 或 swustmcl:domain:...' });
    const modal = window.Modal.open({
      title: '添加域',
      body: (el) => el.append(
        h('div.muted', { style: { marginBottom: '10px' } }, '填写站点地址，或从皮肤站「社团域」页面复制/拖拽邀请。添加后会切换到该域。'),
        input,
        h('div.faint', { style: { marginTop: '8px' } }, '协议：swustmcl://add-domain?url=...'),
      ),
      footer: [
        h('button.btn', { onclick: () => modal.close(null) }, '取消'),
        h('button.btn.btn-primary', {
          onclick: async () => {
            const value = input.value.trim();
            if (!value) return window.Toast.warn('请填写域地址');
            try {
              const item = await window.smcl.domainsAdd(value);
              modal.close(true);
              await reloadState();
              await switchTo(item.id);
            } catch (e) { window.Toast.error(String((e && e.message) || e)); }
          },
        }, '添加'),
      ],
    });
    setTimeout(() => input.focus(), 60);
  }

  async function refresh(id, after, silent = false) {
    try {
      const wasActive = state.activeId === id;
      await window.smcl.domainsRefresh(id);
      await reloadState();
      if (wasActive) {
        // 清单里的认证地址可能被管理员改过，重新匹配该域的皮肤站账号
        const result = await window.smcl.domainsSetActive(id);
        state = result.state;
        window.Store.set({ domain: state, account: result.account || null, cfReady: Boolean(result.cfReady) });
        paint();
        window.app.updateAccountCard();
        window.app.reloadView();
      }
      if (!silent) window.Toast.success('域已刷新');
      if (after) after();
      if (!wasActive) window.app.reloadView();
    } catch (e) {
      if (!silent) window.Toast.error(String((e && e.message) || e));
    }
  }

  async function remove(item, after) {
    const ok = await window.Modal.confirm({ title: '移除域', message: '移除「' + item.name + '」？', danger: true, okText: '移除' });
    if (!ok) return;
    try {
      await window.smcl.domainsRemove(item.id);
      await reloadState();
      await switchTo('personal');
      window.Toast.success('域已移除');
      if (after) after();
    } catch (e) { window.Toast.error(String((e && e.message) || e)); }
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
    return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function resourceLabel(type) {
    return { modpack: '整合包', resourcepack: '资源包', shaderpack: '光影', other: '资源' }[type] || type;
  }

  /** 资源页顶部的「域资源」区块；没有域资源时不插入任何内容。 */
  function renderResources(host) {
    const item = active();
    if (!item || item.personal) return;
    const resources = (item.manifest && item.manifest.resources) || [];
    if (!resources.length) return;
    const list = h('div.domain-res-list');
    for (const resource of resources) {
      list.append(h('div.card.domain-res-row', null,
        h('div.domain-res-icon', null, iconSvg(18)),
        h('div.grow', { style: { minWidth: 0 } },
          h('div.domain-res-name', null, resource.name),
          h('div.faint', null, resourceLabel(resource.type) + (resource.version ? ' · ' + resource.version : '') + (resource.size ? ' · ' + formatBytes(resource.size) : '')),
          resource.description ? h('div.muted.ellipsis', { title: resource.description }, resource.description) : null,
        ),
        h('div.domain-res-actions', null,
          h('button.btn.btn-ghost.btn-sm', { onclick: () => download(item, resource) }, '下载'),
          resource.type === 'modpack'
            ? h('button.btn.btn-primary.btn-sm', { onclick: () => importPack(item, resource) }, '导入整合包')
            : resource.type === 'resourcepack' || resource.type === 'shaderpack'
              ? h('button.btn.btn-primary.btn-sm', { onclick: () => install(item, resource) }, '安装到实例')
              : null,
        ),
      ));
    }
    host.append(
      h('div.section-title', null, '来自域 · ' + item.name, h('span.hint', null, '域管理员发布的资源')),
      list,
    );
  }

  async function download(item, resource) {
    try {
      window.Toast.info('正在下载 ' + resource.name + '…');
      const file = await window.smcl.domainDownloadResource(item.id, resource.id);
      window.Toast.success('已下载到：' + file.path);
    } catch (e) { window.Toast.error(String((e && e.message) || e)); }
  }

  async function importPack(item, resource) {
    try {
      window.Toast.info('正在下载整合包…');
      const file = await window.smcl.domainDownloadResource(item.id, resource.id);
      const ok = await window.Modal.confirm({ title: '导入整合包', message: '已下载「' + resource.name + '」，现在导入为新实例？', okText: '导入' });
      if (!ok) return;
      window.Toast.info('正在导入整合包…');
      await window.smcl.installPack(file.path);
      window.Toast.success('整合包导入完成');
    } catch (e) { window.Toast.error(String((e && e.message) || e)); }
  }

  async function install(item, resource) {
    const installed = window.Store.get('installed') || [];
    if (!installed.length) return window.Toast.warn('还没有安装实例');
    const sel = h('select.select', { style: { width: '100%' } },
      ...installed.map((v) => h('option', { value: v.id }, v.id + (v.mcVersion ? ' · ' + v.mcVersion : ''))));
    let modal = null;
    modal = window.Modal.open({
      title: '安装资源 · ' + resource.name,
      body: (el) => el.append(h('div.muted', { style: { marginBottom: '10px' } }, '选择目标实例：'), sel),
      footer: [
        h('button.btn', { onclick: () => modal.close(null) }, '取消'),
        h('button.btn.btn-primary', {
          onclick: async () => {
            const picked = installed.find((v) => v.id === sel.value);
            modal.close(null);
            if (!picked) return;
            try {
              window.Toast.info('正在下载并安装…');
              const file = await window.smcl.domainInstallResource(item.id, resource.id, picked.dir);
              window.Toast.success('已安装：' + file.path);
            } catch (e) { window.Toast.error(String((e && e.message) || e)); }
          },
        }, '安装'),
      ],
    });
  }

  async function init() {
    state = await window.smcl.domainsState();
    if (state.activeId !== 'personal') {
      try {
        const result = await window.smcl.domainsSetActive(state.activeId);
        state = result.state;
        window.Store.set({ account: result.account || null, cfReady: Boolean(result.cfReady) });
      } catch {}
    }
    window.Store.set({ domain: state });
    paint();
    // 后台静默刷新当前域清单，及时拿到站点新增的 CurseForge 中转/服务器/资源
    if (state.activeId !== 'personal') {
      const activeId = state.activeId;
      setTimeout(() => refresh(activeId, null, true), 2000);
    }
    if (!bound) {
      bound = true;
      document.getElementById('domainCard')?.addEventListener('click', openSwitcher);
      window.smcl.onDomainAdded(async (item) => {
        await reloadState();
        await switchTo(item.id);
      });
      window.smcl.onDomainError((payload) => {
        window.Toast.error((payload && payload.message) || '域邀请处理失败');
      });
      window.smcl.onDomainResourceProgress((p) => {
        if (p && p.total && p.received >= p.total) window.Toast.info('资源下载完成');
      });
      window.Store.on('domain', paint);
    }
  }

  window.DomainContext = { init, active, managed, authRoot, paint, openSwitcher, renderResources, switchTo, reloadState };
})();
