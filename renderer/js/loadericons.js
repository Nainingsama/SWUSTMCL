'use strict';
'use strict';
/**
 * 加载器图标：各加载器官方原图（assets/loaders/，随包分发）。
 * LoaderIcon.svg('forge'|'fabric'|'neoforge'|'quilt'|'原版'|'vanilla', size) → <img> HTML
 */
(function () {
  const key = (name) => {
    const n = String(name || '').toLowerCase();
    if (n.includes('fabric')) return 'fabric';
    if (n.includes('quilt')) return 'quilt';
    if (n.includes('neoforge')) return 'neoforge';
    if (n.includes('forge')) return 'forge';
    return 'vanilla';
  };
  window.LoaderIcon = {
    svg(name, size = 32) {
      const k = key(name);
      const ext = k === 'forge' ? 'jpg' : 'png';
      return '<img src="assets/loaders/' + k + '.' + ext + '" width="' + size + '" height="' + size + '" style="border-radius:7px;object-fit:cover" alt="' + k + '">';
    },
    key,
  };
})();
