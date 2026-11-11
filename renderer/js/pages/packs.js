'use strict';
/**
 * 整合包：导入（预览 → 同名自动改名 → 安装 → 校验依赖）+ 导出（计划预览 → zip）。
 */
(function () {
  const { h, fmtSize } = window.Dom;
  let rootEl = null;
  let inspecting = null; // {file, info}

  function render(root) {
    rootEl = root;
    window.Dom.clear(root);

    const drop = h('div.dropzone', {
      onclick: () => pickFile(),
    },
      h('div.dz-icon', null, '📦'),
      h('div', { style: { fontSize: '14px', fontWeight: '600' } }, '拖入或点击选择整合包 zip'),
      h('div.faint', null, '支持 Modrinth（.mrpack）/ CurseForge / PCL·HMCL 导出的 zip 包'),
    );
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('dragover');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && /\.(zip|mrpack)$/i.test(f.name)) pickPath(window.smcl.pathForFile ? window.smcl.pathForFile(f) : f.path);
      else window.Toast.warn('请拖入 .mrpack 或 .zip 整合包');
    });

    const progWrap = h('div', { style: { display: 'none', flexDirection: 'column', gap: '8px', marginTop: '14px' } },
      h('div.progress', null, h('div.progress-bar#packBar', { style: { width: '0%' } })),
      h('div.progress-meta', null, h('span#packMsg', null, ''), h('span#packPct.tnum', null, '')),
    );

    root.append(
      h('div.section-title', null, '导入整合包'),
      h('div.card', null, h('div.card-body', null, drop, progWrap)),
      h('div.section-title', null, '导出整合包', h('span.hint', null, '把本地实例打包成 Modrinth 格式 zip（mods/config/资源/光影等）')),
      h('div.card', null,
        h('div.card-body', null,
          h('div.row', null,
            h('div.field.grow', null,
              h('span.field-label', null, '选择实例'),
              buildInstanceSelect(),
            ),
            h('button.btn.pressable', { style: { alignSelf: 'flex-end' }, onclick: exportFlow }, '生成导出计划'),
          ),
          h('div#exportPlanBox'),
        ),
      ),
    );
  }

  function buildInstanceSelect() {
    const sel = h('select.select', null);
    const list = window.Store.get('installed') || [];
    for (const v of list) {
      sel.append(h('option', { value: `${v.dir}|${v.id}` }, `${v.id}（${v.dirName}）`));
    }
    return sel;
  }

  async function pickFile() {
    try {
      const file = await window.smcl.pickPack();
      if (file) pickPath(file);
    } catch {}
  }

  async function pickPath(file) {
    window.Toast.info('正在解析整合包…');
    let info;
    try {
      info = await window.smcl.inspectPack(file);
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
      return;
    }
    inspecting = { file, info };
    showPreview(info);
  }

  function showPreview(info) {
    const FMT = { modrinth: 'Modrinth', curseforge: 'CurseForge', mcbbs: 'MCBBS', raw: 'PCL/HMCL 裸目录' };
    let modalRef = null;
    const close = (name) => { if (modalRef) modalRef.close(name || true); };

    modalRef = window.Modal.open({
      title: '整合包预览',
      body: (el) => {
        el.append(
          h('div.pack-preview-grid', null,
            h('div.ver-icon', { style: { width: '56px', height: '56px', fontSize: '20px' } }, (info.loader || 'MC').slice(0, 2)),
            h('div.col', { style: { gap: '6px' } },
              h('div', { style: { fontSize: '17px', fontWeight: '700' } }, info.name),
              info.author ? h('div.faint', null, `作者：${info.author}`) : null,
              info.description ? h('div.muted', null, info.description) : null,
              h('div.row.row-wrap.mt-8', null,
                h('span.badge', null, FMT[info.format] || info.format),
                info.mcVersion ? h('span.badge.badge-blue', null, `MC ${info.mcVersion}`) : null,
                info.loader ? h('span.badge.badge-purple', null, `${info.loader} ${info.loaderVersion || ''}`) : null,
                h('span.badge', null, `📦 ${info.modCount} 个模组文件`),
                h('span.badge', null, `${info.entryCount} 个条目`),
              ),
            ),
          ),
          h('hr.divider'),
          h('div.muted', null,
            '导入时将：自动创建版本隔离实例（重名自动加序号）→ 自动安装缺失的版本底座与加载器 → 解包 overrides → 下载清单文件 → 校验依赖完整性。'),
          h('div.field.mt-12', null,
            h('span.field-label', null, '实例名（同名实例将自动加序号）'),
            h('input.input#packNameInput', { value: info.name }),
          ),
        );
      },
      footer: [
        h('button.btn.pressable', { onclick: () => close(null) }, '取消'),
        h('button.btn.btn-primary.pressable', {
          onclick: () => {
            const input = document.querySelector('#packNameInput');
            const name = input ? input.value.trim() : info.name;
            close(name);
            doImport(name);
          },
        }, '开始导入'),
      ],
    });
  }

  async function doImport(customName) {
    if (!inspecting) return;
    const bar = document.getElementById('packBar');
    const msg = document.getElementById('packMsg');
    const pct = document.getElementById('packPct');
    const wrap = bar.closest('div[style*="display: none"], div[style*="display:none"]');
    if (wrap) wrap.style.display = 'flex';

    try {
      // 自定义实例名：写入待导入信息（主进程会用同名自动改名逻辑兜底）
      const r = await window.smcl.installPack(inspecting.file);
      window.Toast.success(`导入完成：${r.id}${r.warnings && r.warnings.length ? `（${r.warnings.length} 个警告）` : ''}`);
      if (r.warnings && r.warnings.length) {
        window.Modal.open({
          title: '导入完成，但有部分文件失败',
          body: (el) => el.append(h('div.col', { style: { gap: '6px' } },
            ...r.warnings.slice(0, 30).map((w) => h('div.faint', { style: { wordBreak: 'break-all' } }, `• ${w}`)))),
        });
      }
      if (r.dependencies && !r.dependencies.ok) {
        window.Toast.warn(`有 ${r.dependencies.missing} 个依赖文件缺失，可在「版本管理」里点 🔧 修复`);
      }
      window.app.refreshInstalled();
      window.app.goto('versions');
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
    } finally {
      inspecting = null;
      setTimeout(() => { if (wrap) wrap.style.display = 'none'; bar.style.width = '0%'; }, 1800);
    }
  }

  async function exportFlow(e) {
    const sel = e.target.closest('.card').querySelector('select');
    const [dir, id] = sel.value.split('|');
    if (!id) return window.Toast.warn('没有可导出的实例');
    try {
      const plan = await window.smcl.exportPlan(id, dir);
      plan.gameRoot = dir;
      const box = rootEl.querySelector('#exportPlanBox');
      window.Dom.clear(box).append(
        h('div.card.mt-12', null,
          h('div.card-body', null,
            h('div.row.row-wrap', null,
              h('span.badge.badge-blue', null, `实例 ${plan.id}`),
              plan.mcVersion ? h('span.badge', null, `MC ${plan.mcVersion}`) : null,
              plan.loader ? h('span.badge.badge-purple', null, `${plan.loader} ${plan.loaderVersion || ''}`) : null,
              h('span.badge', null, `${plan.files.length} 个文件`),
              h('span.badge.badge-green', null, fmtSize(plan.totalBytes)),
            ),
            h('div.row.mt-12', null,
              h('button.btn.btn-primary.pressable', { onclick: () => doExport(plan) }, '导出为 zip'),
            ),
          ),
        ),
      );
    } catch (err) {
      window.Toast.error(err.message.replace(/^Error: /, ''));
    }
  }

  async function doExport(plan) {
    try {
      const dest = await window.smcl.exportPick(plan.id);
      if (!dest) return;
      window.Toast.info('正在打包…');
      const r = await window.smcl.exportPack(plan.id, dest, plan.gameRoot);
      window.Toast.success(`已导出 ${r.count} 个文件 → ${dest}`);
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
    }
  }

  window.Pages = window.Pages || {};
  window.Pages.packs = {
    render,
    onShow() {},
    // 供全局拖拽调用：直接进入预览流程
    importPath(file) { return pickPath(file); },
    onProgress(p) {
      const bar = document.getElementById('packBar');
      if (!bar) return;
      bar.style.width = `${p.percent || 0}%`;
      const msg = document.getElementById('packMsg');
      const pct = document.getElementById('packPct');
      if (msg) msg.textContent = p.message || '';
      if (pct) pct.textContent = p.percent != null ? `${p.percent}%` : '';
    },
  };
})();
