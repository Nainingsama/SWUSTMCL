'use strict';
/**
 * 账户页（SAUMCL 风格）：左侧来源过滤 + 右侧账户卡片网格。
 * 「添加角色」为居中弹窗：角色类型分段选择（离线/微软/第三方认证）+ 底部取消/确定。
 * 多账户存储在主进程 accountstore（safeStorage 加密）。
 */
(function () {
  const { h, icon } = window.Dom;
  let rootEl = null;
  let filter = 'all';

  const TYPE_LABEL = { offline: '离线模式', msa: '微软账户', authlib: '皮肤站' };
  /** 皮肤站显示名：自定义名 > 登录时记录的站点名 > 域名 */
  function authNameOf(root, fallback) {
    const names = (window.Store.get('settings') || {}).authlibNames || {};
    return names[root] || fallback || String(root || '').replace(/^https?:\/\//, '').split('/')[0] || '认证服务器';
  }
  function rootOf(a) {
    return (a && a.payload && a.payload.root) || (a && a.root) || '';
  }

  async function loadStore() {
    const r = await window.smcl.accountsList();
    window.Store.set({ accountsStore: r });
    return r;
  }

  /** 重新拉取账户数据并重绘本页（登录成功 / 添加账户后自动刷新） */
  async function reload() {
    try {
      window.Store.set({ account: await window.smcl.authStatus() });
    } catch {}
    await render();
  }

  /** 添加成功统一出口：关弹窗 + 刷新网格 + 同步首页卡片 */
  async function afterAdded(api, tip) {
    window.Toast.success(tip);
    if (api) api.close(true);
    await reload();
    window.app.updateAccountCard();
  }

  /** SJMC 式「添加角色」弹窗：角色类型分段 + 内容区 + 底部取消/确定 */
  function openAddModal(defaultTab) {
    let tab = defaultTab || 'offline';
    let submit = () => {};
    let api = null;
    let closeSubs = []; // 弹窗关闭时清理的事件订阅
    const okBtn = h('button.btn.btn-primary.pressable', { onclick: () => submit() }, '确定');

    const errEl = h('div', { style: { display: 'none', marginTop: '10px' } });
    const showErr = (msg) => {
      window.Dom.clear(errEl).append(h('div', {
        style: {
          display: 'flex', gap: '9px', alignItems: 'flex-start', padding: '10px 13px',
          borderRadius: '10px', background: 'rgba(200, 50, 55, 0.12)',
          border: '1px solid rgba(200, 50, 55, 0.32)', color: '#ff8d92',
          fontSize: '12.5px', lineHeight: '1.55',
        },
      }, '⚠ ' + msg));
      errEl.style.display = 'block';
    };
    const clearErr = () => { errEl.style.display = 'none'; };
    const busy = (on, text) => { okBtn.disabled = on; okBtn.textContent = text ? text : '确定'; };

    // ---- 离线模式 ----
    function bodyOffline() {
      const name = h('input.input', { placeholder: '请输入角色名称' });
      submit = async () => {
        clearErr();
        const n = name.value.trim();
        if (!n) return showErr('请输入角色名称');
        busy(true, '添加中…');
        try {
          window.Store.set({ account: await window.smcl.accountsAddOffline(n) });
          await afterAdded(api, '已添加离线账户：' + n);
        } catch (e) {
          showErr(String(e.message || e).replace(/^Error: /, ''));
          busy(false);
        }
      };
      setTimeout(() => name.focus(), 80);
      return h('div', null,
        h('div.field', null,
          h('div.field-label', null, '角色名称 ', h('span', { style: { color: 'var(--accent)' } }, '*')),
          name,
        ),
        h('div.faint.mt-8', null, '可添加多个离线角色，点击卡片即可切换当前账户。'),
      );
    }

    // ---- 微软账户 ----
    function bodyMsa() {
      const stage = h('div', { style: { marginTop: '12px' } });
      const subs = () => closeSubs;
      const unsubs = () => { closeSubs.forEach((u) => { try { u(); } catch {} }); closeSubs = []; };
      submit = async () => {
        clearErr();
        busy(true, '等待授权…');
        window.Dom.clear(stage).append(h('div.muted', null, '正在获取设备码…'));
        closeSubs.push(window.smcl.onAuthStage((st) => {
          if (st.stage === 'device') { window.Dom.clear(stage).append(h('div.muted', null, st.message)); return; }
          if (st.stage === 'code') {
            window.Dom.clear(stage).append(h('div.device-code', null,
              st.resumed ? h('div.badge.badge-blue', null, '登录流程进行中') : null,
              h('a.device-code-box', { href: st.url, onclick: (e) => { e.preventDefault(); window.smcl.openUrl(st.url).catch(() => {}); } }, st.userCode),
              h('div.faint', null, st.copied ? '✓ 已自动复制 — 打开链接直接粘贴' : '点击打开 microsoft.com/link'),
              h('button.btn.btn-ghost.btn-xs', { onclick: () => window.smcl.authCancel() }, '取消登录'),
            ));
          }
        }));
        closeSubs.push(window.smcl.onAuthDone(async () => {
          unsubs();
          try { await afterAdded(api, '登录成功'); } catch {}
        }));
        closeSubs.push(window.smcl.onAuthFailed((e) => {
          unsubs();
          window.Dom.clear(stage);
          showErr(String(e.message || e).replace(/^Error: /, ''));
          busy(false);
        }));
        try {
          const r = await window.smcl.authLogin();
          if (r && r.already) unsubs();
        } catch { /* 失败走 onAuthFailed */ }
      };
      const s = window.Store.state.settings || {};
      return h('div', null,
        h('div.muted', null, '微软正版登录（设备码流程，令牌由系统凭据加密保存）'),
        h('div.faint.mt-8', null, (s.msClientId ? '当前使用自注册 Azure 应用。' : '使用 Live 免注册通道。') + '点「确定」获取设备码，在打开的页面输入即可。'),
        stage,
      );
    }

    // ---- 第三方认证（皮肤站） ----
    function bodyAuthlib() {
      const metaBox = h('div', { style: { marginTop: '10px' } });
      const formBox = h('div');
      const url = h('input.input.mono#alUrl', { placeholder: 'https://…/api/yggdrasil' });
      const user = h('input.input', { placeholder: '皮肤站账号（邮箱/用户名）', style: { marginTop: '8px' } });
      const pass = h('input.input', { type: 'password', placeholder: '密码', style: { marginTop: '8px' } });
      const dispName = h('input.input', { placeholder: '显示名（可选，默认用站点名称，如 LittleSkin）', style: { marginTop: '8px' } });
      let meta = null;
      async function identify(raw) {
        window.Dom.clear(metaBox).append(h('div.muted', null, '识别中…'));
        window.Dom.clear(formBox);
        try {
          meta = await window.smcl.authlibMeta(raw);
          window.Dom.clear(metaBox).append(h('div.row', null,
            h('span.badge.badge-purple', null, meta.serverName),
            h('span.faint.ellipsis', null, meta.root),
          ));
          window.Dom.clear(formBox).append(user, pass, dispName);
        } catch (e) {
          meta = null;
          window.Dom.clear(metaBox).append(h('div.faint', { style: { color: '#ff8d92' } }, String(e.message || e).replace(/^Error: /, '')));
        }
      }
      url.addEventListener('change', () => { const v = url.value.trim(); if (v) identify(v); });
      // Ctrl+V 粘贴后自动识别
      url.addEventListener('paste', () => setTimeout(() => { const v = url.value.trim(); if (v) identify(v); }, 60));
      submit = async () => {
        clearErr();
        if (!meta) {
          const v = url.value.trim();
          if (!v) return showErr('请先填写皮肤站 API 地址');
          busy(true, '识别中…');
          await identify(v);
          busy(false);
          if (!meta) return showErr('API 地址识别失败，请检查链接是否为 authlib-injector 兼容站');
        }
        if (!user.value.trim() || !pass.value) return showErr('请输入皮肤站账号和密码');
        busy(true, '登录中…');
        try {
          const r = await window.smcl.authlibLogin(meta.root, user.value.trim(), pass.value);
          const nmv = dispName.value.trim();
          if (nmv) {
            const names = (window.Store.get('settings') || {}).authlibNames || {};
            try {
              const s2 = await window.smcl.save({ authlibNames: { ...names, [meta.root]: nmv } });
              window.Store.set({ settings: s2 });
            } catch {}
          }
          await afterAdded(api, `已登录：${r.selected ? r.selected.name : ''}（${nmv || meta.serverName}）`);
        } catch (e) {
          showErr(String(e.message || e).replace(/^Error: /, ''));
          busy(false);
        }
      };
      const clipBtn = h('button.btn.btn-ghost.btn-xs', { onclick: async () => {
        try {
          const text = await window.smcl.clipboardRead();
          const mm = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
          if (!mm) return window.Toast.warn('剪贴板里没有网址');
          url.value = mm[0].replace(/\/+$/, '');
          identify(url.value);
        } catch (e) { window.Toast.error(e.message); }
      } }, '📋 剪贴板');
      return h('div', null,
        h('div.field', null, h('div.row', null, h('span.field-label.grow', null, 'API 地址（Yggdrasil Root）'), clipBtn), url),
        metaBox, formBox,
        h('div.faint.mt-8', null, '三种导入方式：把 API 卡片拖进窗口松手 / 网页上点「复制」后拖进来悬停 / 点 📋 剪贴板 或 Ctrl+V'),
      );
    }

    const TABS = [
      ['offline', '离线模式', bodyOffline],
      ['msa', '微软账户', bodyMsa],
      ['authlib', '第三方认证', bodyAuthlib],
    ];
    const seg = h('div.seg', { style: { marginBottom: '14px' } });
    for (const [t, label] of TABS) {
      seg.append(h(`button.seg-item${t === tab ? '.active' : ''}`, {
        dataset: { tab: t },
        onclick: (e) => {
          tab = t;
          clearErr();
          okBtn.disabled = false; okBtn.textContent = '确定';
          seg.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === e.currentTarget));
          window.Dom.clear(content).append(TABS.find((x) => x[0] === t)[2]());
        },
      }, label));
    }
    const content = h('div');
    const bodyFn = (bodyEl) => {
      bodyEl.append(
        h('div.field-label', { style: { marginBottom: '8px' } }, '角色类型'),
        seg, content, errEl,
      );
      window.Dom.clear(content).append(TABS.find((x) => x[0] === tab)[2]());
    };
    api = window.Modal.open({
      title: '添加角色',
      dismissible: false, // 授权过程中误点空白处会中断等待，必须显式点取消
      body: bodyFn,
      footer: [
        h('button.btn.pressable', { onclick: () => api && api.close(null) }, '取消'),
        okBtn,
      ],
    });
    api.then(() => { // 弹窗以任何方式关闭：清理订阅
      closeSubs.forEach((u) => { try { u(); } catch {} });
      closeSubs = [];
    });
    return api;
  }

  /** 皮肤站多角色切换：同一站点下选择要使用的角色 */
  function openProfileSwitch(a) {
    const profiles = (a.payload && a.payload.profiles) || [];
    const cur = (a.payload && a.payload.selected) || {};
    const m = window.Modal.open({
      title: '切换角色 · ' + a.name,
      body: (el) => {
        el.append(h('div.muted', { style: { marginBottom: '10px' } }, '该皮肤站账号下有多个角色，选择要使用的角色：'));
        for (const p of profiles) {
          const canvas = h('canvas', { width: 8, height: 8, style: { width: '32px', height: '32px', borderRadius: '0', imageRendering: 'pixelated', flex: 'none' } });
          el.append(h('div.acct-row' + (p.id === cur.id ? '.chosen' : ''), {
            onclick: async () => {
              if (p.id === cur.id) { m.close(null); return; }
              try {
                const st = await window.smcl.accountsSelectProfile(a.uid, p.id);
                window.Store.set({ account: st });
                window.app.updateAccountCard();
                window.Toast.success('已切换到角色：' + p.name);
                m.close(true);
                render();
              } catch (e) { window.Toast.error(String(e.message || e).replace(/^Error invoking remote method '[^']+':s*(Error:s*)?/, '').replace(/^Error:s*/, '')); }
            },
          },
            h('span.inst-radio' + (p.id === cur.id ? '.on' : '')),
            canvas,
            h('div.grow', null,
              h('div', { style: { fontWeight: '650', fontSize: '13.5px' } }, p.name),
              p.id === cur.id ? h('div.faint', null, '当前使用') : null,
            ),
          ));
          window.smcl.getAvatar(p.id, p.name).then((r) => window.SkinView.drawHead(canvas, r && r.dataUrl)).catch(() => {});
        }
      },
      footer: [h('button.btn', { onclick: () => m.close(null) }, '取消')],
    });
  }

  /** 编辑某个认证服务器：自定义显示名（地址只读，换站请重新添加登录） */
  function editAuthServer(root) {
    const cur = (window.Store.get('settings') || {}).authlibNames || {};
    const nameIn = h('input.input', { value: cur[root] || '', placeholder: '显示名（默认使用站点名）' });
    const m = window.Modal.open({
      title: '认证服务器设置',
      body: (el) => el.append(
        h('div.field', null, h('span.field-label', null, '显示名'), nameIn),
        h('div.field.mt-8', null,
          h('span.field-label', null, 'API 地址（只读，换地址请重新添加并登录）'),
          h('div.faint.mono', { style: { wordBreak: 'break-all', marginTop: '4px' } }, root),
        ),
      ),
      footer: [
        h('button.btn', { onclick: () => m.close(null) }, '取消'),
        h('button.btn.btn-primary', { onclick: async () => {
          const next = { ...cur };
          const v = nameIn.value.trim();
          if (v) next[root] = v;
          else delete next[root];
          try {
            const s2 = await window.smcl.save({ authlibNames: next });
            window.Store.set({ settings: s2 });
            m.close(true);
            window.Toast.success('已保存显示名');
            render();
          } catch (e) { window.Toast.error(e.message); }
        } }, '保存'),
      ],
    });
  }

  let renderSeq = 0;
  async function render(root) {
    rootEl = root || rootEl || document.querySelector('.view[data-view="account"]');
    root = rootEl;
    const seq = ++renderSeq;
    window.Dom.clear(root);
    root.classList.add('account-page');
    const store = await loadStore();
    if (seq !== renderSeq) return; // 已有更新的渲染，放弃本次

    const list = store.list || [];
    const activeId = store.activeId || '';

    // ---- 左：来源过滤（每个皮肤站单独一行）----
    const counts = { all: list.length };
    for (const a of list) counts[a.type] = (counts[a.type] || 0) + 1;
    const authRoots = [...new Set(list.filter((a) => a.type === 'authlib').map(rootOf).filter(Boolean))];
    // 与版本管理左侧一致的面板样式：整块列表 + 底部固定「添加认证服务器」
    const sideRow = (key, label, n, ic, extra) => h('div.ver-side-row' + (filter === key ? '.chosen' : ''), {
      onclick: () => { filter = key; render(); },
    },
      h('span.nav-icon', { style: { display: 'inline-flex', flex: 'none' } }, ic),
      h('span.ellipsis.grow', { style: { fontWeight: '600', fontSize: '13px' } }, label),
      n ? h('span.badge', null, String(n)) : null,
      extra || null,
    );
    const sources = h('div.ver-side', { style: { width: '230px', flex: 'none', height: 'calc(100vh - 112px)' } },
      sideRow('all', '全部来源', counts.all, icon('person', 16)),
      sideRow('offline', '离线模式', counts.offline || 0, icon('bolt', 16)),
      sideRow('msa', '微软账户', counts.msa || 0, icon('apps', 16)),
      ...authRoots.map((root) => {
        const sample = list.find((a) => a.type === 'authlib' && rootOf(a) === root);
        return sideRow('authlib:' + root, authNameOf(root, sample && sample.payload && sample.payload.serverName),
          list.filter((a) => a.type === 'authlib' && rootOf(a) === root).length,
          icon('server', 16),
          h('button.iconbtn', { title: '编辑显示名 / 查看地址', onclick: (e) => { e.stopPropagation(); editAuthServer(root); } }, '…'));
      }),
      h('span.spacer'),
      h('button.ver-side-btn', { onclick: () => openAddModal('authlib') }, icon('plus', 14), '添加认证服务器'),
    );

    // ---- 右：标题 + 添加按钮 ----
    const head = h('div.row', null,
      h('div', { style: { fontWeight: '700', fontSize: '15px' } },
        filter.startsWith('authlib:') ? authNameOf(filter.slice(8)) : (filter === 'all' ? '全部来源' : TYPE_LABEL[filter] || '全部来源')),
      h('span.spacer'),
      h('button.btn.btn-primary.btn-sm.pressable', { onclick: () => openAddModal('offline') }, '＋ 添加角色'),
    );

    // ---- 网格 ----
    const shown = list.filter((a) => {
      if (filter === 'all') return true;
      if (filter.startsWith('authlib:')) return a.type === 'authlib' && rootOf(a) === filter.slice(8);
      return a.type === filter;
    });
    const grid = h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '14px' } });
    if (!shown.length) {
      grid.append(h('div.empty', { style: { gridColumn: '1/-1' } }, h('div.empty-icon', null, icon('person', 34)), '该来源还没有账户 —— 点右上「＋ 添加角色」'));
    }
    for (const a of shown) {
      grid.append(accountCard(a, a.uid === activeId));
    }

    root.append(
      h('div.row', { style: { alignItems: 'stretch' } }, sources, h('div.col.grow', null, head, grid)),
    );

    function accountCard(a, isActive) {
      const canvas = h('canvas', { width: 8, height: 8, style: { width: '100%', height: '100%', borderRadius: '0', imageRendering: 'pixelated' } });
      const card = h('div.card.hoverable', { style: { padding: '14px', position: 'relative' } },
        h('div.row', { style: { justifyContent: 'space-between' } },
          isActive ? h('span.badge.badge-blue', null, '● 当前') : h('span', { style: { width: '18px' } }),
          h('button.iconbtn', {
            title: '移除该账户',
            onclick: async (e) => {
              e.stopPropagation();
              const ok = await window.Modal.confirm({ title: '移除账户', message: `移除「${a.name}」（${TYPE_LABEL[a.type]}）？`, danger: true });
              if (!ok) return;
              await window.smcl.accountsRemove(a.uid);
              window.Store.set({ account: await window.smcl.authStatus() });
              window.app.updateAccountCard();
              render();
            },
          }, h('span', { style: { color: '#ff6369', display: 'inline-flex' } }, icon('trash', 15))),
        ),
        h('div', { style: { textAlign: 'center', margin: '6px 0 10px' } }, h('div.avatar-tile', null, canvas)),
        h('div', { style: { textAlign: 'center', fontWeight: '700', fontSize: '14px' } }, a.name),
        h('div', { style: { textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px', marginTop: '3px' } }, a.type === 'authlib' ? authNameOf(rootOf(a), a.payload && a.payload.serverName) : (TYPE_LABEL[a.type] || a.type)),
        (a.type === 'authlib' && ((a.payload && a.payload.profiles) || []).length > 1)
          ? h('div', { style: { textAlign: 'center', marginTop: '6px' } },
              h('button.btn.btn-ghost.btn-xs', {
                onclick: (e) => { e.stopPropagation(); openProfileSwitch(a); },
              }, '切换角色'),
            )
          : null,
      );
      // 点击卡片 = 切换为当前账户
      card.addEventListener('click', async () => {
        if (isActive) return;
        try {
          const st = await window.smcl.accountsSwitch(a.uid);
          window.Store.set({ account: st, settings: await window.smcl.state().then((x) => x.settings) });
          window.app.updateAccountCard();
          window.Theme.applyAll(window.Store.state.settings, window.Store.get('wallpaperTheme'));
          window.Toast.success('已切换到：' + a.name);
          render();
        } catch (e) { window.Toast.error(e.message); }
      });
      if (isActive) card.classList.add('acct-active');
      window.smcl.getAvatar(a.uuid, a.name).then((r) => window.SkinView.drawHead(canvas, r && r.dataUrl)).catch(() => {});
      return card;
    }
  }

  window.Pages = window.Pages || {};
  /** 拖入皮肤站地址时调用：打开添加角色弹窗（第三方认证）并预填识别 */
  function openAuthlibUrl(url) {
    openAddModal('authlib');
    setTimeout(() => {
      const inp = document.querySelector('#alUrl');
      if (inp) {
        inp.value = url;
        inp.dispatchEvent(new Event('change'));
      }
    }, 180);
  }

  window.Pages.account = {
    render,
    openAuthlibUrl,
    onShow() {
      // goto 已完成首次渲染；这里仅刷新账户数据并重绘一次
      setTimeout(async () => {
        try {
          const acc = await window.smcl.authStatus();
          window.Store.set({ account: acc });
          if (rootEl) await render(rootEl);
        } catch {}
      }, 0);
    },
  };
})();
