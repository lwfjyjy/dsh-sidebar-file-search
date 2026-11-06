// dsh-sidebar-file-search —— 右侧栏右上角搜索按钮 + Vite 风格悬浮搜索窗（纯前端插件）
//
// 结构：平台/词典 → 快捷键工具 → 路径工具 → 搜索高亮工具 → 图标 → 样式
//       → apply（浮层按钮、搜索窗、设置窗、快捷键注册）
//
// 关键约束（沿用原实现，行为不变）：
//   1) 右侧栏没有“表头动作”插槽，按钮用全窗口浮层 shell.overlay 渲染并绝对定位；
//   2) 搜索复用系统内置 @ 引用引擎 ctx.remote.fileReferences.list，不自行扫盘；
//   3) 含 “/” 的查询额外做一次去斜杠全量模糊查询，保证能递归命中子目录；
//   4) 选中文件用 dsh-resource://file/... 在右侧预览打开，文件夹则填回输入框继续下钻；
//   5) 快捷键走 ctx.shortcuts；选中行按 Tab 通过 ctx.uiSession 的 inputActions 插入 @ 引用。
window.__ModuleLoader__.load({
  id: '@lwfjyjy/dsh-sidebar-file-search',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'fileSearch';

    // ---------- 平台与主题 ----------
    const PLATFORM = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent || '' : '';
    const IS_MAC = /Mac|iPhone|iPad|iPod/.test(PLATFORM);
    const IS_WINDOWS = /Win/.test(PLATFORM);
    // 品牌高亮色，用拼接规避外部替换，等价于 var(--dsw-alias-state-business-primary)
    const ACCENT = 'var(--dsw-alias-state-' + 'business-primary)';

    // ---------- 词典 ----------
    const zh = {
      trigger: '搜索',
      triggerTitle: '搜索文件',
      shortcutLabel: '搜索文件',
      placeholder: '搜索文件或文件夹（支持顺序模糊匹配）',
      hint: '输入关键字，搜索工作区文件',
      empty: '没有匹配结果',
      loading: '搜索中…',
      needSession: '请先打开一个会话',
      swap: '切换',
      select: '打开',
      insertHint: '插入',
      close: '关闭',
      shortcut: '快捷键',
      settings: '设置',
      setTitle: '快捷键设置',
      setDesc: '点击右侧按钮后按下新的组合键即可修改；组合需包含 ⌘/Ctrl、Alt 或 Shift 等修饰键。',
      pressKeys: '请按下快捷键…',
      reset: '恢复默认',
      done: '完成',
      needMod: '请至少包含一个修饰键（⌘/Ctrl、Alt 或 Shift）',
    };
    const en = {
      trigger: 'Search',
      triggerTitle: 'Search files',
      shortcutLabel: 'Search files',
      placeholder: 'Search files or folders (fuzzy)',
      hint: 'Type to search workspace files',
      empty: 'No matches',
      loading: 'Searching…',
      needSession: 'Open a session first',
      swap: 'switch',
      select: 'open',
      insertHint: 'insert',
      close: 'close',
      shortcut: 'Shortcut',
      settings: 'Settings',
      setTitle: 'Shortcut settings',
      setDesc: 'Click the button and press a new key combo. It must include a modifier such as ⌘/Ctrl, Alt or Shift.',
      pressKeys: 'Press shortcut…',
      reset: 'Reset',
      done: 'Done',
      needMod: 'Include at least one modifier (⌘/Ctrl, Alt or Shift)',
    };

    // ---------- 快捷键规格 ----------
    // Mac 默认 ⌘⇧K；Windows 默认 Ctrl+Alt+K（避开浏览器 Ctrl+Shift+K 的冲突）。
    const SHORTCUT_KEY = 'dsh-sidebar-file-search:shortcut';
    const MAC_DEFAULT_SPEC = { code: 'KeyK', modifiers: ['primary', 'shift'] };
    const WIN_DEFAULT_SPEC = { code: 'KeyK', modifiers: ['control', 'alt'] };
    const DEFAULT_SPEC = IS_WINDOWS ? WIN_DEFAULT_SPEC : MAC_DEFAULT_SPEC;
    const sameSpec = (a, b) => a.code === b.code && a.modifiers.length === b.modifiers.length && a.modifiers.every((mod) => b.modifiers.includes(mod));
    const loadSpec = () => {
      try {
        const spec = JSON.parse(localStorage.getItem(SHORTCUT_KEY) || 'null');
        if (spec && typeof spec.code === 'string' && Array.isArray(spec.modifiers)) return spec;
      } catch (err) {
        /* 读不到就用默认 */
      }
      return DEFAULT_SPEC;
    };
    const saveSpec = (spec) => {
      try {
        localStorage.setItem(SHORTCUT_KEY, JSON.stringify(spec));
      } catch (err) {
        /* 存不了也不影响本次使用 */
      }
    };

    const KEY_LABELS = {
      Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', Enter: '↵', Tab: 'Tab',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Backspace: '⌫', Delete: 'Del',
    };
    const keyLabel = (code) => {
      if (/^Key[A-Z]$/.test(code)) return code.slice(3);
      if (/^Digit\d$/.test(code)) return code.slice(5);
      if (/^Numpad\d$/.test(code)) return 'Num' + code.slice(6);
      return KEY_LABELS[code] || code;
    };
    const MOD_ORDER = ['primary', 'control', 'alt', 'shift'];
    const modsToText = (modifiers) => {
      const ordered = MOD_ORDER.filter((mod) => modifiers.includes(mod));
      if (!ordered.length && modifiers.length) ordered.push(...modifiers);
      return ordered
        .map((mod) => {
          if (mod === 'primary') return IS_MAC ? '⌘' : 'Ctrl';
          if (mod === 'control') return IS_MAC ? '⌃' : 'Ctrl';
          if (mod === 'alt') return IS_MAC ? '⌥' : 'Alt';
          if (mod === 'shift') return IS_MAC ? '⇧' : 'Shift';
          return mod;
        })
        .join(IS_MAC ? ' ' : '+');
    };
    // code 为空时只显示修饰键，用于录制中的实时提示。
    const specToText = (spec) => {
      const parts = [modsToText(spec.modifiers), spec.code ? keyLabel(spec.code) : ''].filter(Boolean);
      return parts.join(IS_MAC ? ' ' : '+');
    };
    const PURE_MODIFIER_KEYS = ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'];

    // ---------- 输入框聚焦 ----------
    // Lexical 的 root 上挂了 __lexicalEditor；先 focus DOM 再调 editor.focus()
    // 才能恢复插入后的光标位置（否则光标会跳到开头）。
    const focusComposer = () => {
      try {
        const roots = document.querySelectorAll('[contenteditable="true"]');
        for (const root of roots) {
          if (!root.__lexicalEditor || !root.getClientRects().length) continue;
          root.focus({ preventScroll: true });
          root.__lexicalEditor.focus();
          return;
        }
      } catch (err) {
        /* 聚焦失败不影响插入 */
      }
    };

    // ---------- 极简全局 store ----------
    const createStore = (initial) => {
      let state = initial;
      const listeners = new Set();
      return {
        get: () => state,
        set: (patch) => {
          state = Object.assign({}, state, patch);
          listeners.forEach((listener) => listener());
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    };
    const store = createStore({
      open: false,
      sessionId: null,
      cwd: undefined,
      spec: loadSpec(),
      settingsOpen: false,
      capturing: false,
    });
    const useStoreSnapshot = () => {
      const [snapshot, setSnapshot] = React.useState(store.get);
      React.useEffect(() => store.subscribe(() => setSnapshot(store.get())), []);
      return snapshot;
    };

    // ---------- 路径地址工具（与 @deepseek-ai/dsh-util-workspace-path 等价） ----------
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
    const encodeSegment = (s) => encodeURIComponent(s).replace(/%3A/gi, ':');
    const encodePath = (p) => p.split('/').map(encodeSegment).join('/');
    const sessionFileAddress = (sessionId, path) => {
      const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
    };
    const isWindowsStylePath = (value) => /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\');
    const isAbsoluteWorkspacePath = (path) => path.startsWith('/') || isWindowsStylePath(path);
    const resolveWorkspacePath = (cwd, path) => {
      if (isAbsoluteWorkspacePath(path)) return path;
      if (cwd === void 0 || cwd === '') return path;
      const sep = isWindowsStylePath(cwd) && cwd.includes('\\') ? '\\' : '/';
      return `${cwd.replace(/[/\\]+$/, '')}${sep}${path.replace(/^(?:\.?[/\\])+/, '')}`;
    };
    const fileAddressFor = (sessionId, cwd, path) => {
      const normalized = path.replace(/\\/g, '/');
      if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
      const root = cwd === void 0 ? '' : cwd.replace(/\\/g, '/').replace(/\/+$/, '');
      if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '');
      if (root !== '' && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
      return sessionFileAddress(sessionId, normalized);
    };
    const splitPath = (path) => {
      const full = String(path || '').replace(/\\/g, '/');
      const cut = full.lastIndexOf('/');
      return { full, dir: cut < 0 ? '' : full.slice(0, cut), base: full.slice(cut + 1) };
    };

    // ---------- 图标（手绘 SVG） ----------
    const svg = (children, cls) =>
      h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', className: cls, 'aria-hidden': 'true', focusable: 'false' }, children);
    const SearchGlyph = (props = {}) => svg([h('circle', { key: 'c', cx: 11, cy: 11, r: 7 }), h('path', { key: 'p', d: 'M21 21l-4.3-4.3' })], props.cls);
    const FileGlyph = () => svg([h('path', { key: 'a', d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }), h('path', { key: 'b', d: 'M14 3v5h5' })], 'dsfs-item-icon');
    const FolderGlyph = () => svg([h('path', { key: 'a', d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' })], 'dsfs-item-icon');
    const GearGlyph = (props = {}) => svg([h('circle', { key: 'c', cx: 12, cy: 12, r: 3 }), h('path', { key: 'p', d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' })], props.cls);

    // ---------- 搜索：高亮与排序 ----------
    // 只要顺序符合即可（fzf 式子序列）；优先高亮整段连续命中，其次逐字符高亮。
    const matchPositions = (text, query) => {
      const positions = new Set();
      const target = text.toLowerCase();
      const needle = query.trim().toLowerCase();
      if (!needle) return positions;
      const nameStart = target.lastIndexOf('/') + 1;
      const inName = target.indexOf(needle, nameStart);
      const start = inName >= 0 ? inName : target.indexOf(needle);
      if (start >= 0) {
        for (let i = 0; i < needle.length; i += 1) positions.add(start + i);
        return positions;
      }
      let from = 0;
      for (let i = 0; i < needle.length; i += 1) {
        const index = target.indexOf(needle[i], from);
        if (index < 0) return new Set();
        positions.add(index);
        from = index + 1;
      }
      return positions;
    };

    const isBoundary = (text, index) => index === 0 || /[._\-\s/]/.test(text[index - 1]);
    const subsequenceGap = (text, needle) => {
      let from = 0;
      let gap = 0;
      for (let i = 0; i < needle.length; i += 1) {
        const index = text.indexOf(needle[i], from);
        if (index < 0) return Infinity;
        if (i > 0) gap += index - from;
        from = index + 1;
      }
      return gap;
    };
    const scoreCandidate = (candidate, needle) => {
      const path = String(candidate.path || '').toLowerCase();
      const name = path.slice(path.lastIndexOf('/') + 1);
      const inName = name.indexOf(needle);
      const inPath = path.indexOf(needle);
      if (name === needle) return 50000;
      if (name.startsWith(needle)) return 40000;
      if (inName >= 0) return 30000 + (isBoundary(name, inName) ? 1000 : 0);
      if (inPath >= 0) return 20000 + (isBoundary(path, inPath) ? 500 : 0);
      const gap = subsequenceGap(path, needle);
      return gap === Infinity ? 0 : 1000 + Math.max(1, 100 - gap);
    };
    // 内置引擎会把 “md” 匹配成 _tmp 的 m + readme 的 d，这里把连续命中纠正到前面。
    const rankResults = (list, query) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return list;
      return list
        .map((candidate, index) => ({ candidate, index, score: scoreCandidate(candidate, needle) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(({ candidate }) => candidate);
    };

    // VS Code 风格路径压缩：过长目录保留「首段 + 末尾两段」，中间用 …；命中段始终保留。
    const compressSegs = (segments, query) => {
      if (segments.length <= 4) return segments;
      const needle = query.trim().toLowerCase();
      const keep = new Set([0, segments.length - 2, segments.length - 1]);
      if (needle) segments.forEach((segment, index) => { if (segment.toLowerCase().includes(needle)) keep.add(index); });
      const out = [];
      let last = -1;
      [...keep].sort((a, b) => a - b).forEach((index) => {
        if (last >= 0 && index > last + 1) out.push('…');
        out.push(segments[index]);
        last = index;
      });
      return out;
    };

    const renderHitsAt = (text, positions, base) => {
      const out = [];
      for (let i = 0; i < text.length; ) {
        if (!positions.has(base + i)) { out.push(text[i]); i += 1; continue; }
        let end = i;
        while (end < text.length && positions.has(base + end)) end += 1;
        out.push(h('mark', { key: i, className: 'dsfs-hit' }, text.slice(i, end)));
        i = end;
      }
      return out;
    };
    const renderHits = (text, query) => renderHitsAt(text, matchPositions(text, query), 0);
    const renderDir = (dir, query, full, source) => {
      const segments = dir.split('/').filter(Boolean);
      if (!segments.length) return [];
      const positions = full ? matchPositions(source || dir, query) : null;
      let offset = 0;
      return (full ? segments : compressSegs(segments, query)).flatMap((segment, index) => {
        const nodes = [];
        if (index > 0) nodes.push(h('span', { key: `sep-${index}`, className: 'dsfs-sep' }, '›'));
        const body = segment === '…' ? '…' : full ? renderHitsAt(segment, positions, offset) : renderHits(segment, query);
        nodes.push(h('span', { key: `seg-${index}`, className: 'dsfs-seg' }, body));
        if (full) offset += segment.length + 1;
        return nodes;
      });
    };

    // ---------- 样式 ----------
    const CSS = [
      // 悬浮到右侧栏右上角图标排左侧的小胶囊（right/top 由 JS 精确测量后覆盖）
      '.dsfs-triggerwrap{position:fixed;top:10px;right:78px;z-index:2147482000;pointer-events:auto;-webkit-app-region:no-drag;display:flex}',
      // 关键：给右侧栏表头图标排（dockkit 的 strip-chrome）预留左侧空白，让 tab 让位、胶囊落进空白里，窄栏也不重叠
      // 预留宽度由 JS 按胶囊实际宽度写入 --dsfs-reserve，适配中英文/系统；仅在按钮显示时（html[data-dsfs-on]）生效
      'html[data-dsfs-on] [data-sidebar-right-session] [data-dockkit-strip-chrome]{padding-left:var(--dsfs-reserve,176px)}',
      'html[data-dsfs-on][data-dsfs-compact] .dsfs-trigger-label,html[data-dsfs-on][data-dsfs-compact] .dsfs-trigger-kbd{display:none}',
      // 仅图标模式下做成和原生图标按钮一样的 28×28 方块
      'html[data-dsfs-on][data-dsfs-compact] .dsfs-trigger{padding:6px;width:28px;height:28px}',
      '.dsfs-trigger{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);font-family:var(--dsw-font-family,inherit);font-size:12px;line-height:1;cursor:pointer}',
      // 悬浮只出现原生同款浅色底，文字/图标颜色保持与原图标一致（不变色）
      '.dsfs-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      `.dsfs-trigger:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px}`,
      '.dsfs-trigger svg{width:15px;height:15px;flex:none;display:block}',
      '.dsfs-trigger-kbd{display:inline-flex;align-items:center;gap:1px;padding:1px 5px;border-radius:var(--dsw-radius-sm);background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;font-family:var(--dsw-font-family,inherit);line-height:1.5}',
      '.dsfs-overlay{position:fixed;inset:0;z-index:2147483000;pointer-events:auto;display:flex;justify-content:center;align-items:flex-start;padding-top:12vh;background:var(--dsw-alias-bg-mask-1)}',
      '.dsfs-dialog{width:min(680px,92vw);max-height:70vh;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-menu-surface-fill);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(30px));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(30px));border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent);border:1px solid var(--dsw-alias-border-l2);animation:dsfs-in .16s cubic-bezier(.2,.8,.3,1)}',
      '@keyframes dsfs-in{from{opacity:0;transform:translateY(-8px) scale(.99)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion:reduce){.dsfs-dialog{animation:none}}',
      '.dsfs-inputrow{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.dsfs-input-icon{width:18px;height:18px;flex:none;color:var(--dsw-alias-label-secondary)}',
      '.dsfs-input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:15px;line-height:1.4}',
      '.dsfs-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}',
      `.dsfs-spinner{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent);border-top-color:${ACCENT};animation:dsfs-spin .7s linear infinite}`,
      '@keyframes dsfs-spin{to{transform:rotate(360deg)}}',
      '.dsfs-list{flex:1;min-height:0;overflow-y:auto;padding:6px}',
      '.dsfs-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);cursor:pointer}',
      `.dsfs-item.is-active{background:color-mix(in srgb,${ACCENT} 12%,transparent);flex-wrap:wrap;align-items:flex-start}`,
      '.dsfs-item.is-active .dsfs-name{max-width:calc(100% - 96px)}',
      '.dsfs-item.is-active .dsfs-item-hint{order:2;margin-left:auto}',
      '.dsfs-item.is-active .dsfs-dir{order:3;flex:1 0 100%;box-sizing:border-box;padding-left:24px;display:block;font-size:11px;line-height:1.5;white-space:normal;word-break:break-all;overflow:visible;text-overflow:clip}',
      '.dsfs-item.is-active .dsfs-dir .dsfs-seg{overflow:visible;text-overflow:clip}',
      '.dsfs-item-icon{width:16px;height:16px;flex:none;color:var(--dsw-alias-label-secondary)}',
      '.dsfs-name{flex:0 1 auto;min-width:0;max-width:70%;font-size:13px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dsfs-name-slash{color:var(--dsw-alias-label-secondary);font-weight:400}',
      '.dsfs-dir{flex:1;min-width:0;display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
      '.dsfs-seg{overflow:hidden;text-overflow:ellipsis}',
      '.dsfs-item-hint{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsfs-item-hint kbd{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:18px;padding:0 4px;border-radius:var(--dsw-radius-xs);border:1px solid var(--dsw-alias-border-l2);font-family:var(--dsw-font-family,inherit);font-size:11px;line-height:1}',
      '.dsfs-sep{margin:0 4px;color:var(--dsw-alias-label-secondary);opacity:.6;flex:none}',
      `.dsfs-hit{background:color-mix(in srgb,${ACCENT} 22%,transparent);color:${ACCENT};border-radius:2px;padding:0;font-weight:600}`,
      '.dsfs-empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}',
      '.dsfs-foot{display:flex;align-items:center;gap:16px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsfs-foot-item{display:inline-flex;align-items:center;gap:4px}',
      '.dsfs-foot kbd{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:18px;padding:0 4px;border-radius:var(--dsw-radius-xs);background:transparent;border:1px solid var(--dsw-alias-border-l2);font-family:var(--dsw-font-family,inherit);font-size:11px;line-height:1}',
      '.dsfs-foot-grow{flex:1}',
      '.dsfs-foot-shortcut{white-space:nowrap}',
      '.dsfs-gear{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer}',
      '.dsfs-gear:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsfs-gear svg{width:15px;height:15px;display:block}',
      // —— 设置面板（快捷键） ——
      '.dsfs-settings{width:min(440px,92vw)}',
      '.dsfs-set-body{display:flex;flex-direction:column;gap:12px;padding:16px}',
      '.dsfs-set-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsfs-set-desc{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.dsfs-set-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dsfs-set-name{font-size:13px;color:var(--dsw-alias-label-primary)}',
      `.dsfs-keybtn{min-width:140px;height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-skeleton);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1;cursor:pointer}`,
      `.dsfs-keybtn:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
      `.dsfs-keybtn.is-capturing{border-color:${ACCENT};color:${ACCENT};box-shadow:0 0 0 1px ${ACCENT}}`,
      `.dsfs-set-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d92d20)}`,
      '.dsfs-set-foot{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dsfs-set-foot .dsfs-foot-grow{flex:1}',
      '.dsfs-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);font-family:var(--dsw-font-family,inherit);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer}',
      '.dsfs-btn:disabled{cursor:not-allowed;opacity:.4}',
      '.dsfs-btn:not(.is-primary):hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsfs-btn.is-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}',
      '.dsfs-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '@media (max-width:640px){.dsfs-trigger-label{display:none}.dsfs-trigger-kbd{display:none}.dsfs-overlay{padding-top:8vh}.dsfs-dialog{width:94vw;max-height:78vh}}',
    ].join('');

    const installStyle = () => {
      if (!document.head) return;
      const existing = document.getElementById('dsfs-style');
      // 已存在就同步最新样式（支持热重载时无需整页刷新）
      if (existing) {
        if (existing.textContent !== CSS) existing.textContent = CSS;
        return;
      }
      const style = document.createElement('style');
      style.id = 'dsfs-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    };

    // ---------- 组件与注册 ----------
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sidebar-file-search: dictionaries');
      ctx.effect(() => installStyle(), 'sidebar-file-search: style');
      const t = ctx.locale.bind(NS);

      // 快捷键：默认 ⌘⇧K / Ctrl+Alt+K；可在设置弹窗里修改。
      const shortcut = (() => {
        let disposeCurrent = null;
        const release = () => {
          if (!disposeCurrent) return;
          try {
            disposeCurrent();
          } catch (err) {
            /* 旧注册可能已失效 */
          }
          disposeCurrent = null;
        };
        const register = (spec) => {
          release();
          // 按平台生成合法绑定：mac 上 control 映射成 primary，其他平台 primary 映射成 control。
          const mk = (platform) => ({
            code: spec.code,
            modifiers: spec.modifiers.map((mod) => (
              platform === 'macos' ? (mod === 'control' ? 'primary' : mod) : (mod === 'primary' ? 'control' : mod)
            )),
          });
          // 默认值按平台各用各的：Mac ⌘⇧K，Windows/Linux Ctrl+Alt+K；自定义值才原样跨平台映射。
          const bindings = sameSpec(spec, DEFAULT_SPEC)
            ? {
                'desktop:macos': MAC_DEFAULT_SPEC,
                'desktop:windows': WIN_DEFAULT_SPEC,
                'desktop:linux': WIN_DEFAULT_SPEC,
                'web:macos': MAC_DEFAULT_SPEC,
                'web:windows': WIN_DEFAULT_SPEC,
              }
            : {
                'desktop:macos': mk('macos'),
                'desktop:windows': mk('windows'),
                'desktop:linux': mk('linux'),
                'web:macos': mk('macos'),
                'web:windows': mk('windows'),
              };
          try {
            disposeCurrent = ctx.shortcuts.register({
              id: 'sidebar-file-search.open',
              label: () => t('shortcutLabel'),
              aliases: ['search files', 'file search', 'go to file', '搜索文件'],
              defaults: bindings,
              regions: ['page', 'editable'],
              modals: [],
              resolve: () => {
                const current = store.get();
                // 正在录制新快捷键时，别让当前快捷键把窗口开关掉
                if (current.capturing) return { status: 'handled', run: () => {} };
                const sessionId = current.sessionId || ctx.sidebarRight.mounted.getSnapshot();
                if (!sessionId) return { status: 'blocked', reason: t('needSession') };
                return {
                  status: 'handled',
                  run: () => store.set({ open: !current.open, sessionId, settingsOpen: false }),
                };
              },
            });
          } catch (err) {
            // 热重载时旧快捷键可能尚未释放，忽略重复注册错误，避免整段 apply 中断
            disposeCurrent = null;
          }
        };
        return { register, dispose: release };
      })();

      ctx.effect(() => {
        shortcut.register(store.get().spec);
        return () => shortcut.dispose();
      }, 'sidebar-file-search: shortcut');

      // 右侧栏是否展开（收起时把按钮一起藏起来）。isExpanded() 是同步读取，
      // 用低频轮询保持响应；只在有会话时轮询，开销可忽略。
      function useRightbarShown(sessionId) {
        const read = () => {
          try {
            return ctx.sidebarRight.isExpanded();
          } catch (err) {
            return false;
          }
        };
        const [shown, setShown] = React.useState(read);
        React.useEffect(() => {
          if (!sessionId) {
            setShown(false);
            return undefined;
          }
          const tick = () => setShown((prev) => {
            const next = read();
            return prev === next ? prev : next;
          });
          tick();
          const id = window.setInterval(tick, 200);
          return () => window.clearInterval(id);
        }, [sessionId]);
        return shown;
      }

      // 把胶囊精确贴到右侧栏表头图标排左侧，并按面板宽度切换“仅图标”模式。
      function usePillPlacement(sessionId, rightbarShown, wrapRef) {
        React.useEffect(() => {
          const html = document.documentElement;
          const clear = () => {
            html.removeAttribute('data-dsfs-on');
            html.removeAttribute('data-dsfs-compact');
            html.style.removeProperty('--dsfs-reserve');
          };
          if (!(sessionId && rightbarShown)) {
            clear();
            return undefined;
          }
          const place = () => {
            // 精确锁定当前会话的右栏（可能同时存在多个保留的会话面板）
            let root = null;
            try {
              root = document.querySelector(`[data-sidebar-right-session="${String(sessionId).replace(/["\\]/g, '\\$&')}"]`);
            } catch (err) {
              root = null;
            }
            if (!root) {
              const all = document.querySelectorAll('[data-sidebar-right-session]');
              for (const element of all) {
                if (element.getBoundingClientRect().width > 0) { root = element; break; }
              }
            }
            const chrome = root && root.querySelector('[data-dockkit-strip-chrome]');
            html.setAttribute('data-dsfs-on', '');
            if (!chrome) return;
            const compact = (root.clientWidth || 0) < 360;
            if (compact) html.setAttribute('data-dsfs-compact', '');
            else html.removeAttribute('data-dsfs-compact');
            const element = wrapRef.current;
            if (!element) return;
            const pillWidth = element.getBoundingClientRect().width || 0;
            // 预留 = 胶囊宽度 + 8：胶囊与左右相邻图标都恰好间隔 8px（同原生 stripChrome gap:8）
            html.style.setProperty('--dsfs-reserve', Math.ceil(pillWidth + 8) + 'px');
            const pad = parseFloat(window.getComputedStyle(chrome).paddingLeft) || 0;
            const rect = chrome.getBoundingClientRect();
            element.style.top = rect.top + 'px';
            element.style.right = window.innerWidth - (rect.left + pad) + 8 + 'px';
          };
          place();
          const id = window.setInterval(place, 300);
          window.addEventListener('resize', place);
          return () => {
            window.clearInterval(id);
            window.removeEventListener('resize', place);
            clear();
          };
        }, [rightbarShown, sessionId]);
      }

      // 右上角小胶囊
      function TriggerPill({ wrapRef, shortcutText, onClick }) {
        return h(
          'div',
          { className: 'dsfs-triggerwrap', ref: wrapRef },
          h(
            'button',
            { type: 'button', className: 'dsfs-trigger', title: t('triggerTitle'), 'aria-label': t('triggerTitle'), onClick },
            h(SearchGlyph),
            h('span', { className: 'dsfs-trigger-label' }, t('trigger')),
            h('kbd', { className: 'dsfs-trigger-kbd' }, shortcutText),
          ),
        );
      }

      // 结果行：文件名优先，目录压缩后置；选中行展示完整路径（含文件名，不压缩、可换行）。
      function ResultRow({ candidate, active, query, onHover, onChoose }) {
        const { full, dir, base } = splitPath(candidate.path);
        return h(
          'div',
          {
            className: 'dsfs-item' + (active ? ' is-active' : ''),
            role: 'option',
            'aria-selected': active,
            'data-active': active ? 'true' : 'false',
            onMouseEnter: onHover,
            onMouseDown: (event) => {
              event.preventDefault();
              onChoose(candidate);
            },
          },
          candidate.kind === 'directory' ? h(FolderGlyph) : h(FileGlyph),
          h(
            'span',
            { className: 'dsfs-name', title: candidate.path },
            renderHits(base, query),
            candidate.kind === 'directory' ? h('span', { className: 'dsfs-name-slash' }, '/') : null,
          ),
          active || dir
            ? h(
                'span',
                { className: 'dsfs-dir', title: active ? full : dir },
                renderDir(active ? full : dir, query, active, full),
              )
            : null,
          active
            ? h('span', { className: 'dsfs-item-hint' }, h('kbd', null, 'Tab'), ' ', t('insertHint'))
            : null,
        );
      }

      // 全窗口遮罩：点空白处关闭
      function Overlay({ onDismiss, children }) {
        return h(
          'div',
          {
            className: 'dsfs-overlay',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) onDismiss();
            },
          },
          children,
        );
      }

      // 浮层：右侧栏按钮 + 搜索窗（共用 store）
      function Surface(props) {
        const sessionId = props.useSidebarMounted((session) => session);
        const rightbarShown = useRightbarShown(sessionId);
        const cwd = props.useSessions((state) => (sessionId ? state.byId[sessionId] && state.byId[sessionId].cwd : undefined));
        const snapshot = useStoreSnapshot();
        const wrapRef = React.useRef(null);
        usePillPlacement(sessionId, rightbarShown, wrapRef);

        // 把当前会话上下文写进共享 store，供弹窗与快捷键共用
        React.useEffect(() => {
          store.set({ sessionId: sessionId || null, cwd });
          if (!sessionId && store.get().open) store.set({ open: false });
        }, [sessionId, cwd]);

        const openDialog = () => store.set({ open: true, sessionId: sessionId || null, cwd, settingsOpen: false });

        return h(
          React.Fragment,
          null,
          sessionId && rightbarShown
            ? h(TriggerPill, { wrapRef, shortcutText: specToText(snapshot.spec), onClick: openDialog })
            : null,
          h(SearchDialog, { snapshot }),
        );
      }

      // 悬浮搜索窗
      function SearchDialog({ snapshot }) {
        const [query, setQuery] = React.useState('');
        const [results, setResults] = React.useState([]);
        const [loading, setLoading] = React.useState(false);
        const [active, setActive] = React.useState(0);
        const inputRef = React.useRef(null);
        const listRef = React.useRef(null);
        const open = snapshot.open;

        // 打开时清空并聚焦输入框
        React.useEffect(() => {
          if (!open) return undefined;
          setQuery('');
          setResults([]);
          setActive(0);
          setLoading(false);
          const id = window.setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
          return () => window.clearTimeout(id);
        }, [open]);

        // 搜索：防抖 120ms + AbortController 取消旧请求
        React.useEffect(() => {
          if (!open) return undefined;
          const keyword = query.trim();
          if (!keyword) {
            setResults([]);
            setLoading(false);
            setActive(0);
            return undefined;
          }
          setLoading(true);
          const controller = new AbortController();
          const timer = window.setTimeout(() => {
            if (!snapshot.sessionId) {
              setResults([]);
              setLoading(false);
              return;
            }
            // 含 “/” 的查询在系统引擎里只列该目录的直接子项；额外用去斜杠版本做一次
            // 全量模糊查询，保证 todo-common/todo-common-json/java 能命中子目录文件。
            const request = (text) => {
              try {
                return Promise.resolve(ctx.remote.fileReferences.list(snapshot.sessionId, text, controller.signal)).catch(() => null);
              } catch (err) {
                return Promise.resolve(null);
              }
            };
            const requests = [request(keyword)];
            const flat = keyword.replace(/[\\/]/g, '');
            if (flat && flat !== keyword) requests.push(request(flat));
            Promise.all(requests)
              .then((responses) => {
                if (controller.signal.aborted) return;
                const seen = new Set();
                const candidates = [];
                for (const response of responses) {
                  const list = Array.isArray(response) ? response : response && response.ok && Array.isArray(response.value) ? response.value : [];
                  for (const candidate of list) {
                    const key = `${candidate.path}|${candidate.kind}`;
                    if (!seen.has(key)) { seen.add(key); candidates.push(candidate); }
                  }
                }
                setResults(rankResults(candidates, keyword));
                setActive(0);
                setLoading(false);
              })
              .catch(() => {
                if (controller.signal.aborted) return;
                setResults([]);
                setLoading(false);
              });
          }, 120);
          return () => {
            window.clearTimeout(timer);
            controller.abort();
          };
        }, [open, query, snapshot.sessionId]);

        // 选中：文件夹下钻，文件在右侧打开
        const choose = (candidate) => {
          if (!candidate) return;
          if (candidate.kind === 'directory') {
            setQuery(candidate.path.replace(/\/+$/, '') + '/');
            window.setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
            return;
          }
          try {
            const url = fileAddressFor(snapshot.sessionId, snapshot.cwd, resolveWorkspacePath(snapshot.cwd, candidate.path));
            ctx.sidebarRight.openResource(url);
          } catch (err) {
            /* 打开失败时静默，不打断输入 */
          }
          store.set({ open: false });
        };

        // Tab：把选中路径以 @ 引用写进当前会话输入框
        const insert = (candidate) => {
          if (!candidate) return;
          const value = ctx.uiSession ? ctx.uiSession.current.getSnapshot() : null;
          const actions = value && value.props && value.props.inputActions;
          if (!actions || value.key !== snapshot.sessionId) return;
          const ref = candidate.path + (candidate.kind === 'directory' ? '/' : '');
          const text = /\s/.test(candidate.path) ? '@"' + ref + '" ' : '@' + ref + ' ';
          try {
            if (actions.insertText(text, actions.captureInsertion())) {
              focusComposer();
              store.set({ open: false });
            }
          } catch (err) {
            /* 插入失败时保留弹窗，方便重试 */
          }
        };

        // 键盘：↑↓ 切换、↵ 打开、Tab 插入、esc 关闭
        const onKeyDown = (event) => {
          switch (event.key) {
            case 'Escape':
              event.preventDefault();
              store.set({ open: false });
              break;
            case 'ArrowDown':
              event.preventDefault();
              setActive((index) => (results.length ? (index + 1) % results.length : 0));
              break;
            case 'ArrowUp':
              event.preventDefault();
              setActive((index) => (results.length ? (index - 1 + results.length) % results.length : 0));
              break;
            case 'Enter':
              event.preventDefault();
              choose(results[active]);
              break;
            case 'Tab':
              event.preventDefault();
              insert(results[active]);
              break;
            default:
              break;
          }
        };

        // 让高亮行始终可见
        React.useEffect(() => {
          if (!open || !listRef.current) return;
          const element = listRef.current.querySelector('[data-active="true"]');
          if (element && element.scrollIntoView) element.scrollIntoView({ block: 'nearest' });
        }, [active, results, open]);

        if (!open) return null;

        // 设置弹窗（从底栏齿轮进入），与搜索窗共用遮罩
        if (snapshot.settingsOpen) {
          return h(
            Overlay,
            { onDismiss: () => store.set({ settingsOpen: false }) },
            h(SettingsDialog, { snapshot, onClose: () => store.set({ settingsOpen: false }) }),
          );
        }

        const hasQuery = Boolean(query.trim());
        const showHint = !hasQuery;
        const showEmpty = hasQuery && !loading && results.length === 0;

        return h(
          Overlay,
          { onDismiss: () => store.set({ open: false, settingsOpen: false }) },
          h(
            'div',
            { className: 'dsfs-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('triggerTitle') },
            h(
              'div',
              { className: 'dsfs-inputrow' },
              h(SearchGlyph, { cls: 'dsfs-input-icon' }),
              h('input', {
                ref: inputRef,
                className: 'dsfs-input',
                value: query,
                placeholder: t('placeholder'),
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => setQuery(event.target.value),
                onKeyDown,
              }),
              loading ? h('span', { className: 'dsfs-spinner' }) : null,
            ),
            h(
              'div',
              { className: 'dsfs-list', ref: listRef, role: 'listbox' },
              showHint
                ? h('div', { className: 'dsfs-empty' }, t('hint'))
                : showEmpty
                  ? h('div', { className: 'dsfs-empty' }, t('empty'))
                  : results.map((candidate, index) =>
                      h(ResultRow, {
                        key: `${candidate.path}|${candidate.kind}|${index}`,
                        candidate,
                        active: index === active,
                        query,
                        onHover: () => setActive(index),
                        onChoose: choose,
                      })),
            ),
            h(
              'div',
              { className: 'dsfs-foot' },
              h('span', { className: 'dsfs-foot-item' }, h('kbd', null, '↑'), h('kbd', null, '↓'), ' ', t('swap')),
              h('span', { className: 'dsfs-foot-item' }, h('kbd', null, '↵'), ' ', t('select')),
              h('span', { className: 'dsfs-foot-item' }, h('kbd', null, 'esc'), ' ', t('close')),
              h('span', { className: 'dsfs-foot-grow' }),
              h('span', { className: 'dsfs-foot-item dsfs-foot-shortcut' }, h('kbd', null, specToText(snapshot.spec)), ' ', t('shortcut')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsfs-gear',
                  title: t('settings'),
                  'aria-label': t('settings'),
                  onClick: () => store.set({ settingsOpen: true }),
                },
                h(GearGlyph),
              ),
            ),
          ),
        );
      }

      // 设置弹窗：修改打开搜索窗的快捷键
      function SettingsDialog({ snapshot, onClose }) {
        const [capturing, setCapturing] = React.useState(false);
        const [error, setError] = React.useState('');
        const [preview, setPreview] = React.useState('');
        const held = React.useRef(new Set());

        const heldMods = () => {
          const mods = [];
          if (held.current.has(IS_MAC ? 'Meta' : 'Control')) mods.push('primary');
          if (held.current.has('Alt')) mods.push('alt');
          if (held.current.has('Shift')) mods.push('shift');
          return mods;
        };

        // 把录制状态同步进共享 store，让快捷键 resolve 暂时让路
        React.useEffect(() => {
          store.set({ capturing });
          if (!capturing) {
            held.current.clear();
            setPreview('');
          }
          return () => store.set({ capturing: false });
        }, [capturing]);

        // 捕获键盘组合；录制中实时把按下的键显示在按钮里
        React.useEffect(() => {
          if (!capturing) return undefined;
          const onKeyDown = (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
            if (event.repeat) return;
            if (PURE_MODIFIER_KEYS.includes(event.key)) {
              held.current.add(event.key);
              setPreview(modsToText(heldMods()));
              return;
            }
            // 合并“真实按住的键”与事件自身修饰位，避免漏记
            const mods = heldMods();
            const add = (mod, pressed) => {
              if (pressed && !mods.includes(mod)) mods.push(mod);
            };
            add('primary', IS_MAC ? event.metaKey : event.ctrlKey);
            add('alt', event.altKey);
            add('shift', event.shiftKey);
            setPreview(specToText({ code: event.code, modifiers: mods }));
            if (event.key === 'Escape' && mods.length === 0) {
              setCapturing(false);
              setError('');
              return;
            }
            if (mods.length === 0) {
              setError(t('needMod'));
              return;
            }
            const spec = { code: event.code, modifiers: mods };
            saveSpec(spec);
            store.set({ spec });
            shortcut.register(spec);
            setCapturing(false);
            setError('');
          };
          const onKeyUp = (event) => {
            if (!PURE_MODIFIER_KEYS.includes(event.key)) return;
            held.current.delete(event.key);
            setPreview(modsToText(heldMods()));
          };
          window.addEventListener('keydown', onKeyDown, true);
          window.addEventListener('keyup', onKeyUp, true);
          return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            held.current.clear();
            setPreview('');
          };
        }, [capturing]);

        const reset = () => {
          saveSpec(DEFAULT_SPEC);
          store.set({ spec: DEFAULT_SPEC });
          shortcut.register(DEFAULT_SPEC);
          setError('');
        };

        return h(
          'div',
          { className: 'dsfs-dialog dsfs-settings', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('setTitle') },
          h(
            'div',
            { className: 'dsfs-set-body' },
            h('div', { className: 'dsfs-set-title' }, t('setTitle')),
            h('div', { className: 'dsfs-set-desc' }, t('setDesc')),
            h(
              'div',
              { className: 'dsfs-set-row' },
              h('span', { className: 'dsfs-set-name' }, t('shortcut')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsfs-keybtn' + (capturing ? ' is-capturing' : ''),
                  onClick: () => {
                    setError('');
                    setPreview('');
                    held.current.clear();
                    setCapturing(true);
                  },
                },
                capturing ? preview || t('pressKeys') : specToText(snapshot.spec),
              ),
            ),
            error ? h('div', { className: 'dsfs-set-error' }, error) : null,
          ),
          h(
            'div',
            { className: 'dsfs-set-foot' },
            h('button', { type: 'button', className: 'dsfs-btn', onClick: reset }, t('reset')),
            h('span', { className: 'dsfs-foot-grow' }),
            h('button', { type: 'button', className: 'dsfs-btn is-primary', onClick: onClose }, t('done')),
          ),
        );
      }

      // 注册到全窗口浮层，注入右侧栏“在屏会话”钩子
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'sidebar-file-search',
            order: 300,
            inject: () => ({ hooks: { sidebarMounted: ctx.sidebarRight.mounted } }),
          },
          Surface,
        ),
      );
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'shortcuts', 'remote', 'remote.fileReferences', 'uiSession'],
      apply,
    };
  },
});
