'use strict';
/**
 * 域服务器整合包进服流程：必装包强制安装/更新；
 * 原版增强包提供「本地实例 / 增强包 / 纯净原版」三选一。
 */
(function () {
  const { h, fmtSize } = window.Dom;

  function activeDomain() {
    return window.DomainContext && window.DomainContext.active ? window.DomainContext.active() : null;
  }

  function installedList() {
    return (window.Store.get('installed') || []);
  }

  async function installedPacks() {
    try { return await window.smcl.domainPackInstalled(); } catch { return []; }
  }

  function matchingLocal(pack) {
    const mc = String((pack.instance && pack.instance.mcVersion) || '');
    if (!mc) return null;
    const list = installedList().filter((inst) => String(inst.mcVersion || '') === mc);
    if (!list.length) return null;
    const loader = String((pack.instance && pack.instance.loader) || '');
    return list.find((inst) => loader && inst.loader === loader) || list[0];
  }

  function progressModal(title) {
    const text = h('div.faint', { style: { minHeight: '22px', lineHeight: '1.7' } }, '准备中…');
    const bar = h('div.progress-bar', { style: { width: '0%' } });
    const modal = window.Modal.open({
      title,
      dismissible: false,
      body: (el) => el.append(text, h('div.progress', { style: { marginTop: '10px' } }, bar)),
    });
    const unsub = window.smcl.onDomainPackProgress((p) => {
      if (!p) return;
      text.textContent = p.message || '处理中…';
      if (p.stage === 'upload') {
        bar.style.width = p.total ? Math.min(100, Math.round(((p.uploaded || 0) / p.total) * 100)) + '%' : '60%';
      } else if (p.stage === 'files') {
        bar.style.width = p.total ? Math.min(100, Math.round(((p.done || 0) / p.total) * 100)) + '%' : '60%';
      } else if (p.percent) {
        bar.style.width = Math.max(2, Number(p.percent) || 2) + '%';
      } else {
        bar.style.width = '30%';
      }
    });
    return {
      set(message) { text.textContent = message; },
      close() { unsub(); modal.close(true); },
      fail(message) { unsub(); modal.close(false); window.Toast.error(message); },
    };
  }

  async function runInstall(payload, title) {
    const progress = progressModal(title);
    try {
      const result = await window.smcl.domainPackInstall(payload);
      progress.close();
      window.Toast.success('整合包已就绪');
      window.app.refreshInstalled();
      return result;
    } catch (e) {
      const message = String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^Error:\s*/, '');
      progress.fail(message);
      return null;
    }
  }

  function confirmInstall(pack, update, installed) {
    return new Promise((resolve) => {
      let modal = null;
      const size = pack.totalSize ? `，约 ${fmtSize(pack.totalSize)}` : '';
      const title = update ? '更新必装整合包' : '安装必装整合包';
      const message = update
        ? `服务器「${pack.name}」有新版本 v${pack.latestVersion}${size}。更新后才能进入服务器。`
        : `进入该服务器前必须安装「${pack.name}」v${pack.latestVersion}${size}。`;
      modal = window.Modal.open({
        title,
        body: (el) => el.append(
          h('div.muted', { style: { lineHeight: '1.8' } }, message),
          h('div.faint', { style: { marginTop: '8px' } },
            update ? '将更新该整合包管理的文件，玩家自己新增的文件会保留。' : '将新建一个实例并安装；已有的其他实例不会被覆盖。'),
        ),
        footer: [
          h('button.btn', { onclick: () => { modal.close(false); resolve(false); } }, '取消'),
          h('button.btn.btn-primary', { onclick: () => { modal.close(true); resolve(true); } }, update ? '更新并启动' : '安装并启动'),
        ],
      });
      modal.then((ok) => { if (!ok) resolve(false); });
    });
  }

  function chooseOptional(pack) {
    return new Promise((resolve) => {
      const local = matchingLocal(pack);
      let modal = null;
      const choose = (value) => { modal.close(value); };
      const buttons = [];
      if (local) {
        buttons.push(h('button.btn.btn-primary', { onclick: () => choose({ type: 'local', instance: local }) }, '本地实例启动'));
      }
      buttons.push(h('button.btn' + (local ? '.btn-ghost' : '.btn-primary'), {
        onclick: () => choose({ type: 'pack' }),
      }, '下载原版增强包'));
      buttons.push(h('button.btn.btn-ghost', { onclick: () => choose({ type: 'vanilla' }) }, '下载纯净原版'));
      modal = window.Modal.open({
        title: '进入 ' + pack.name,
        body: (el) => el.append(...[
          h('div.muted', { style: { lineHeight: '1.8' } },
            `该服务器提供「原版增强包」v${pack.latestVersion}。你可以直接使用本地对应版本实例，也可以下载增强包，或安装纯净原版。`,
          ),
          local ? h('div.faint', { style: { marginTop: '8px' } }, `本地匹配实例：${local.displayName || local.id}（${local.mcVersion || ''}）`) : null,
          h('div.faint', { style: { marginTop: '8px' } },
            '增强包会新建实例，不会覆盖你现有的实例。',
          ),
        ].filter(Boolean)),
        footer: [
          h('button.btn', { onclick: () => modal.close(null) }, '取消'),
          ...buttons,
        ],
      });
      modal.then((value) => resolve(value || null));
    });
  }

  /**
   * 处理服务器整合包，并返回用于启动的实例。
   * @returns {Promise<{id:string,dir:string}|null>}
   */
  async function prepareJoin(srv) {
    const domain = activeDomain();
    const pack = srv && srv.pack;
    if (!domain || domain.personal || !pack || !pack.id) return { id: srv.instanceId, dir: srv.dir || '' };
    const policy = pack.policy === 'required' ? 'required' : 'optional';
    const installed = (await installedPacks()).filter((item) => item.packId === pack.id);
    const current = installed.sort((a, b) => b.version - a.version)[0] || null;

    if (policy === 'required') {
      const latest = Number(pack.latestVersion) || 0;
      if (current && current.version === latest) {
        return { id: current.id, dir: current.dir };
      }
      const ok = await confirmInstall(pack, Boolean(current), current);
      if (!ok) return null;
      const result = await runInstall({
        mode: 'pack',
        domainId: domain.id,
        packId: pack.id,
        serverId: srv.id,
        mcDir: current ? current.dir : '',
        instanceId: current ? current.id : '',
      }, current ? '正在更新必装整合包…' : '正在安装必装整合包…');
      return result ? { id: result.instanceId, dir: result.dir } : null;
    }

    const choice = await chooseOptional(pack);
    if (!choice) return null;
    if (choice.type === 'local') return { id: choice.instance.id, dir: choice.instance.dir };
    if (choice.type === 'vanilla') {
      const result = await runInstall({
        mode: 'vanilla',
        mcVersion: (pack.instance && pack.instance.mcVersion) || '',
      }, '正在安装纯净原版…');
      return result ? { id: result.instanceId, dir: result.dir } : null;
    }
    const result = await runInstall({
      mode: 'pack',
      domainId: domain.id,
      packId: pack.id,
      serverId: srv.id,
      mcDir: current ? current.dir : '',
      instanceId: current ? current.id : '',
    }, current ? '正在更新原版增强包…' : '正在下载原版增强包…');
    return result ? { id: result.instanceId, dir: result.dir } : null;
  }

  window.DomainPackJoin = { prepareJoin };
})();
