'use strict';
/**
 * 把版本隔离实例发布为当前域的服务器整合包。
 * 首次发布需要皮肤站「域管理」生成的发布令牌；之后按文件哈希做增量上传。
 */
(function () {
  const { h, fmtSize } = window.Dom;

  const MIN_JAVA_OPTIONS = [0, 8, 11, 16, 17, 21, 25, 26];

  function fmtBytes(value) {
    return fmtSize(Number(value) || 0);
  }

  function promptToken(domain) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const input = h('input.input.mono', {
        type: 'password',
        placeholder: '粘贴皮肤站生成的发布令牌（spt_...）',
        autocomplete: 'off',
        spellcheck: 'false',
      });
      let modal = null;
      modal = window.Modal.open({
        title: '填写发布令牌',
        body: (el) => el.append(
          h('div.muted', { style: { marginBottom: '10px' } },
            '发布令牌由皮肤站「域管理 → 启动器发布令牌」生成，只显示一次。',
          ),
          input,
          h('div.row', { style: { marginTop: '10px' } },
            h('button.btn.btn-ghost.btn-sm', {
              onclick: () => window.smcl.openUrl(domain.url + '/#/admin/plugin/launcher-domain').catch(() => {}),
            }, '打开域管理'),
          ),
        ),
        footer: [
          h('button.btn', { onclick: () => { done(null); modal.close(false); } }, '取消'),
          h('button.btn.btn-primary', {
            onclick: async () => {
              const token = input.value.trim();
              if (!token) return window.Toast.warn('请填写发布令牌');
              try {
                await window.smcl.domainPackSetToken(domain.id, token);
                modal.close(true);
                done(token);
              } catch (e) {
                window.Toast.error(String(e.message || e));
              }
            },
          }, '保存'),
        ],
      });
      modal.then((ok) => { if (!ok) done(null); });
      setTimeout(() => input.focus(), 80);
    });
  }

  async function ensureToken(domain) {
    const status = await window.smcl.domainPackTokenStatus(domain.id);
    if (status && status.configured) return true;
    const token = await promptToken(domain);
    return Boolean(token);
  }

  async function openPublish(instance) {
    const domain = window.DomainContext && window.DomainContext.active ? window.DomainContext.active() : null;
    if (!domain || domain.personal) return window.Toast.warn('请先切换到站点型域');
    if (!instance.isolated) {
      return window.Toast.warn('只允许发布版本隔离实例，请先在实例设置中开启版本隔离');
    }
    let scan;
    try {
      scan = await window.smcl.domainPackScan(instance.dir, instance.id);
    } catch (e) {
      return window.Toast.error(String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
    }
    if (!(await ensureToken(domain))) return;

    const servers = ((domain.manifest && domain.manifest.servers) || []).filter((server) => server.visible !== false);
    const marker = scan.marker || {};
    const defaultName = marker.packName || instance.displayName || instance.id;

    const name = h('input.input', { value: defaultName, maxlength: '80' });
    const desc = h('input.input', { placeholder: '整合包介绍（可选）' });
    const serverSel = h('select.select', { style: { width: '100%' } },
      ...servers.map((server) => h('option', {
        value: server.id,
        selected: marker.serverId === server.id,
      }, server.name + (server.pack ? `（已绑定：${server.pack.name}）` : ''))),
    );
    let policy = marker.policy === 'required' ? 'required' : 'optional';
    let minJava = marker.minJava || 0;
    if (!MIN_JAVA_OPTIONS.includes(Number(minJava))) minJava = 0;
    const minJavaSel = h('select.select', { style: { width: '100%' } },
      ...MIN_JAVA_OPTIONS.map((value) => h('option', { value: String(value), selected: Number(minJava) === value },
        value ? `Java ${value}+` : '不设置')),
    );
    const notes = h('input.input', { placeholder: '本次版本说明（可选，如：更新模组列表）' });

    const policyCards = [];
    const setPolicy = (value) => {
      policy = value;
      for (const card of policyCards) {
        card.el.style.borderColor = card.value === value ? 'var(--accent)' : 'var(--card-border)';
        card.el.style.background = card.value === value ? 'var(--accent-soft)' : 'transparent';
      }
    };
    const policyCard = (value, title, detail) => {
      const el = h('div', {
        style: {
          padding: '12px', border: '1px solid var(--card-border)', borderRadius: '12px',
          cursor: 'pointer', marginTop: '8px', transition: 'border-color .15s, background .15s',
        },
        onclick: () => setPolicy(value),
      },
        h('div', { style: { fontWeight: '650', fontSize: '13.5px' } }, title),
        h('div.faint', { style: { marginTop: '4px', lineHeight: '1.6' } }, detail),
      );
      policyCards.push({ el, value });
      return el;
    };

    const info = h('div.muted', { style: { lineHeight: '1.8' } },
      `实例：${scan.instance.name} · ${scan.instance.mcVersion || '未知版本'} · ${scan.instance.loader || '原版'}`,
      h('br'),
      `文件：${scan.fileCount} 个 · ${fmtBytes(scan.totalSize)}`,
      marker.packId ? h('span', null, h('br'), `已发布过：${marker.packName || marker.packId} v${marker.version || 1}`) : null,
    );
    const progressText = h('div.faint', { style: { minHeight: '20px', marginTop: '8px' } });
    const progressBar = h('div.progress-bar', { style: { width: '0%' } });
    const progressWrap = h('div.progress', { style: { display: 'none', marginTop: '8px' } }, progressBar);
    const errorBox = h('div', { style: { display: 'none', marginTop: '8px', color: '#ff8d92', fontSize: '12.5px' } });

    let modal = null;
    let finished = false;
    const okBtn = h('button.btn.btn-primary.pressable', { onclick: () => submit() }, '开始发布');
    const unsub = window.smcl.onDomainPackProgress((p) => {
      if (!p) return;
      progressWrap.style.display = 'block';
      if (p.stage === 'diff') {
        progressText.textContent = p.message || '清单比对完成';
      } else if (p.stage === 'upload') {
        progressText.textContent = p.message || '上传中…';
        if (p.total) progressBar.style.width = Math.min(100, Math.round(((p.uploaded || 0) / p.total) * 100)) + '%';
        else progressBar.style.width = '50%';
      } else if (p.stage === 'base') {
        progressText.textContent = p.message || '准备基础版本…';
        progressBar.style.width = Math.max(2, Number(p.percent) || 2) + '%';
      } else if (p.stage === 'files') {
        progressText.textContent = p.message || '同步文件…';
        if (p.total) progressBar.style.width = Math.min(100, Math.round(((p.done || 0) / p.total) * 100)) + '%';
      } else if (p.message) {
        progressText.textContent = p.message;
      }
    });

    async function submit() {
      if (finished) { modal.close(true); return; }
      if (!servers.length) return window.Toast.warn('当前域还没有服务器，请先在域管理添加服务器');
      if (!serverSel.value) return window.Toast.warn('请选择绑定服务器');
      okBtn.disabled = true;
      okBtn.textContent = '发布中…';
      errorBox.style.display = 'none';
      try {
        const result = await window.smcl.domainPackPublish({
          domainId: domain.id,
          dir: instance.dir,
          instanceId: instance.id,
          serverId: serverSel.value,
          policy,
          minJava: Number(minJavaSel.value) || 0,
          notes: notes.value.trim(),
          name: name.value.trim() || instance.id,
          description: desc.value.trim(),
        });
        finished = true;
        progressBar.style.width = '100%';
        const diff = result.diff || {};
        progressText.textContent = `发布成功：v${result.pack && result.pack.latestVersion ? result.pack.latestVersion : ''} · 新增 ${diff.added || 0} / 修改 ${diff.modified || 0} / 移动 ${diff.moved || 0} / 删除 ${diff.deleted || 0}`;
        okBtn.textContent = '完成';
        okBtn.disabled = false;
        window.Toast.success('整合包已发布');
        window.app.reloadView();
      } catch (e) {
        okBtn.disabled = false;
        okBtn.textContent = '开始发布';
        const message = String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^Error:\s*/, '');
        errorBox.textContent = message;
        errorBox.style.display = 'block';
      }
    }

    modal = window.Modal.open({
      title: marker.packId ? '更新整合包发布' : '发布整合包到域',
      body: (el) => el.append(
        info,
        h('div.field.mt-12', null, h('span.field-label', null, '整合包名称'), name),
        h('div.field.mt-8', null, h('span.field-label', null, '介绍'), desc),
        h('div.field.mt-8', null, h('span.field-label', null, '绑定服务器'), serverSel),
        h('div.field-label', { style: { marginTop: '12px' } }, '绑定方式'),
        policyCard('required', '必装整合包', '玩家进服前必须安装；未安装时引导新建实例并安装，已安装时自动更新。'),
        policyCard('optional', '原版增强包', '玩家可选；进服时三选一：本地对应实例 / 下载增强包 / 下载纯净原版。'),
        h('div.field.mt-8', null, h('span.field-label', null, '最低 Java 版本'), minJavaSel),
        h('div.field.mt-8', null, h('span.field-label', null, '版本说明'), notes),
        progressText,
        progressWrap,
        errorBox,
      ),
      footer: [
        h('button.btn', { onclick: () => modal.close(false) }, '取消'),
        okBtn,
      ],
    });
    setPolicy(policy);
    modal.then(() => { unsub(); if (!finished) okBtn.textContent = '开始发布'; });
  }

  window.PublishPack = { open: openPublish };
})();
