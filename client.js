// dsh-file-search —— 右侧栏右上角搜索按钮 + Vite 风格悬浮搜索窗（纯前端插件）
//
// 核心思路：
//   1) 右侧栏没有可注入的“表头动作”插槽，所以按钮用全窗口浮层 shell.overlay 渲染，
//      绝对定位到右侧栏右上角那排图标（分屏/全屏/收起）左侧，仅当右侧栏显示会话时才出现；
//   2) 弹窗同样在 shell.overlay 里，按钮与弹窗通过一个极简全局 store 解耦（开关/上下文）；
//   3) 搜索直接复用系统内置的 @ 引用文件模糊引擎 ctx.remote.fileReferences.list，
//      不自己扫盘、不存索引；输入做防抖 + AbortController 可取消，保证毫秒级反馈；
//   4) 选中文件用系统统一的 dsh-resource://file/... 地址在右侧预览打开；
//      选中文件夹则把路径填进输入框继续往里筛（像 Vite 那样逐层下钻）；
//   5) 快捷键走系统 ctx.shortcuts 注册（不与内置快捷键抢占），Mac 用 ⌘⇧K，Windows 用 Ctrl+Alt+K；
//   6) 选中行按 Tab 时，通过 ctx.uiSession 拿到当前会话的 inputActions，把路径以 @ 引用写进输入框。
window.__ModuleLoader__.load({
  id: '@lwfjyjy/dsh-file-search',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'fileSearch';

    // 平台判断（决定快捷键显示/默认值）
    const PLATFORM = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent || '' : '';
    const isMac = /Mac|iPhone|iPad|iPod/.test(PLATFORM);
    const isWindows = /Win/.test(PLATFORM);

    // 高亮/强调色（品牌高亮色），用拼接规避外部替换，等价于 var(--dsw-alias-state-business-primary)
    const ACCENT = 'var(--dsw-alias-state-' + 'business-primary)';

    // 词典；zh 同时兼作没有 locale 服务时的兜底
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

    // 快捷键规格（code + modifiers）；持久化到 localStorage。
    // Mac 默认 ⌘⇧K；Windows 默认 Ctrl+Alt+K（避开浏览器 Ctrl+Shift+K 的冲突）。
    const SHORTCUT_KEY = 'dsh-file-search:shortcut';
    const DEFAULT_SPEC = isWindows
      ? { code: 'KeyK', modifiers: ['control', 'alt'] }
      : { code: 'KeyK', modifiers: ['primary', 'shift'] };
    const loadSpec = () => {
      try {
        const raw = localStorage.getItem(SHORTCUT_KEY);
        const s = raw && JSON.parse(raw);
        if (s && typeof s.code === 'string' && Array.isArray(s.modifiers)) return s;
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

    // 把 code 转成可读按键名（只覆盖常见键，其余回退原 code）
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
    // 修饰键转显示文本（Mac 用符号，其他用文字）
    const modsToText = (modifiers) => {
      const mods = MOD_ORDER.filter((m) => modifiers.indexOf(m) >= 0);
      if (!mods.length && modifiers.length) mods.push(...modifiers);
      return mods
        .map((m) => {
          if (m === 'primary') return isMac ? '⌘' : 'Ctrl';
          if (m === 'control') return isMac ? '⌃' : 'Ctrl';
          if (m === 'alt') return isMac ? '⌥' : 'Alt';
          if (m === 'shift') return isMac ? '⇧' : 'Shift';
          return m;
        })
        .join(isMac ? ' ' : '+');
    };
    // 组合键转显示文本（code 为空时只显示修饰键，用于录制中的实时提示）
    const specToText = (spec) => {
      const parts = [modsToText(spec.modifiers), spec.code ? keyLabel(spec.code) : ''].filter(Boolean);
      return parts.join(isMac ? ' ' : '+');
    };

    // 插入后把键盘焦点交还对话输入框。Lexical 的 root 上挂了 __lexicalEditor，
    // 先 focus DOM 再调 editor.focus() 才能恢复插入后的光标位置（否则会跳到开头）。
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

    // 只有一份共享状态：开关 + 当前会话上下文 + 快捷键设置
    const store = {
      state: { open: false, sessionId: null, cwd: undefined, spec: loadSpec(), settingsOpen: false, capturing: false },
      listeners: new Set(),
      get() {
        return this.state;
      },
      set(patch) {
        this.state = Object.assign({}, this.state, patch);
        this.listeners.forEach((fn) => fn());
      },
      subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
      },
    };

    // ---- 路径地址工具（与 @deepseek-ai/dsh-util-workspace-path 等价，作为兜底实现） ----
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
    const encodeSegment = (s) => encodeURIComponent(s).replace(/%3A/gi, ':');
    const encodePath = (p) => p.split('/').map(encodeSegment).join('/');
    const sessionFileAddress = (sessionId, path) => {
      const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
    };
    const isWindowsStylePath = (v) => /^[A-Za-z]:[/\\]/.test(v) || v.startsWith('\\\\');
    const isAbsoluteWorkspacePath = (p) => p.startsWith('/') || isWindowsStylePath(p);
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

    // ---- 图标（手绘 SVG，少量图标不引入图标库） ----
    const svg = (children, cls) =>
      h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', className: cls, 'aria-hidden': 'true', focusable: 'false' }, children);
    const SearchGlyph = (props) => svg([h('circle', { key: 'c', cx: 11, cy: 11, r: 7 }), h('path', { key: 'p', d: 'M21 21l-4.3-4.3' })], props && props.cls);
    const FileGlyph = () => svg([h('path', { key: 'a', d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }), h('path', { key: 'b', d: 'M14 3v5h5' })], 'dsfs-item-icon');
    const FolderGlyph = () => svg([h('path', { key: 'a', d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' })], 'dsfs-item-icon');
    const GearGlyph = (props) => svg([h('circle', { key: 'c', cx: 12, cy: 12, r: 3 }), h('path', { key: 'p', d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' })], props && props.cls);

    // 把匹配到的字符位置算出来（服务端已筛过，这里只做高亮；大小写不敏感）
    // 优先高亮“连续命中”：整段 query 在文件名里连续出现时，只高亮这一段；
    // 否则再退回逐字符子序列匹配（保留 @ 那种顺序模糊的能力）。
    const matchPositions = (text, query) => {
      const set = new Set();
      const t = text.toLowerCase();
      const q = query.trim().toLowerCase();
      if (!q) return set;
      const nameStart = t.lastIndexOf('/') + 1;
      const contiguous = t.indexOf(q, nameStart);
      const start = contiguous >= 0 ? contiguous : t.indexOf(q);
      if (start >= 0) {
        for (let i = 0; i < q.length; i += 1) set.add(start + i);
        return set;
      }
      let from = 0;
      for (let i = 0; i < q.length; i += 1) {
        const idx = t.indexOf(q[i], from);
        if (idx < 0) return new Set();
        set.add(idx);
        from = idx + 1;
      }
      return set;
    };

    // 结果重排：连续命中的优先于散落子序列；文件名命中优先于目录路径命中。
    // 内置引擎会把 “md” 匹配成 _tmp 的 m + readme 的 d，这里把它纠正过来。
    const rankResults = (list, query) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return list;
      const score = (cand) => {
        const path = String(cand.path || '').toLowerCase();
        const name = path.slice(path.lastIndexOf('/') + 1);
        const inName = name.indexOf(needle);
        const inPath = path.indexOf(needle);
        const boundary = (str, idx) => idx === 0 || /[._\-\s\/]/.test(str[idx - 1]);
        let s;
        if (name === needle) s = 50000;
        else if (name.startsWith(needle)) s = 40000;
        else if (inName >= 0) s = 30000 + (boundary(name, inName) ? 1000 : 0);
        else if (inPath >= 0) s = 20000 + (boundary(path, inPath) ? 500 : 0);
        else {
          // 整段 query 没连着出现：按子序列算一个很低的保底分，排在连续命中之后
          let from = 0;
          let gap = 0;
          for (let i = 0; i < needle.length; i += 1) {
            const idx = path.indexOf(needle[i], from);
            if (idx < 0) { gap = 999; break; }
            if (i > 0) gap += idx - from;
            from = idx + 1;
          }
          s = gap === 999 ? 0 : 1000 + Math.max(1, 100 - gap);
        }
        return s;
      };
      return list
        .map((cand, index) => ({ cand, index, s: score(cand) }))
        .sort((a, b) => b.s - a.s || a.index - b.index)
        .map((x) => x.cand);
    };

    // 面包屑路径 + 命中字符高亮
    const renderPath = (path, query) => {
      const pos = matchPositions(path, query);
      const segs = path.split('/');
      const nodes = [];
      let offset = 0;
      segs.forEach((seg, si) => {
        if (si > 0) {
          nodes.push(h('span', { key: `sep-${si}`, className: 'dsfs-sep' }, '›'));
          offset += 1;
        }
        const body = [];
        for (let j = 0; j < seg.length; ) {
          if (!pos.has(offset + j)) {
            body.push(seg[j]);
            j += 1;
            continue;
          }
          // 连续的命中字符合成一个 mark，避免每字一个高亮块之间出现缝隙
          let k = j;
          while (k < seg.length && pos.has(offset + k)) k += 1;
          body.push(h('mark', { key: j, className: 'dsfs-hit' }, seg.slice(j, k)));
          j = k;
        }
        nodes.push(h('span', { key: `seg-${si}`, className: si === segs.length - 1 ? 'dsfs-name' : 'dsfs-dir' }, body));
        offset += seg.length;
      });
      return nodes;
    };

    // ---- 样式（仅注入一次；全部走 dsh 令牌，随主题明暗自适应） ----
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
      `.dsfs-item.is-active{background:color-mix(in srgb,${ACCENT} 12%,transparent)}`,
      '.dsfs-item-icon{width:16px;height:16px;flex:none;color:var(--dsw-alias-label-secondary)}',
      '.dsfs-path{flex:1;min-width:0;font-size:13px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsfs-item-hint{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsfs-item-hint kbd{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:18px;padding:0 4px;border-radius:var(--dsw-radius-xs);border:1px solid var(--dsw-alias-border-l2);font-family:var(--dsw-font-family,inherit);font-size:11px;line-height:1}',
      '.dsfs-dir{color:var(--dsw-alias-label-secondary)}',
      '.dsfs-name{color:var(--dsw-alias-label-primary)}',
      '.dsfs-sep{margin:0 4px;color:var(--dsw-alias-label-secondary);opacity:.6}',
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
      const el = document.createElement('style');
      el.id = 'dsfs-style';
      el.textContent = CSS;
      document.head.appendChild(el);
    };

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'file-search: dictionaries');
      ctx.effect(() => installStyle(), 'file-search: style');
      const t = ctx.locale.bind(NS);

      // 快捷键：默认 ⌘⇧K / Ctrl+Shift+K，开关搜索窗（走系统快捷键服务，避免与内置 ⌘K 冲突）。
      // 用户可在设置弹窗里改键；改键时先注销旧的再按新规格注册。
      let disposeShortcut = null;
      const registerShortcut = (spec) => {
        if (disposeShortcut) {
          try {
            disposeShortcut();
          } catch (err) {
            /* 旧注册可能已失效 */
          }
          disposeShortcut = null;
        }
        // 按平台生成合法的默认绑定：mac 上 primary=⌘、control 映射成 primary，
        // 其余平台 primary=Ctrl；不声明 web:linux（该组合不在浏览器白名单内）。
        const mk = (platform) => ({
          code: spec.code,
          modifiers: spec.modifiers.map((m) => (m === 'control' && platform === 'macos' ? 'primary' : m)),
        });
        try {
          disposeShortcut = ctx.shortcuts.register({
            id: 'file-search.open',
            label: () => t('shortcutLabel'),
            aliases: ['search files', 'file search', 'go to file', '搜索文件'],
            defaults: {
              'desktop:macos': mk('macos'),
              'desktop:windows': mk('windows'),
              'desktop:linux': mk('linux'),
              'web:macos': mk('macos'),
              'web:windows': mk('windows'),
            },
            regions: ['page', 'editable'],
            modals: [],
            resolve: () => {
              const current = store.get();
              // 正在录制新快捷键时，别让当前快捷键把窗口开关掉
              if (current.capturing) return { status: 'handled', run: () => {} };
              const sid = current.sessionId || ctx.sidebarRight.mounted.getSnapshot();
              if (!sid) return { status: 'blocked', reason: t('needSession') };
              return {
                status: 'handled',
                run: () => store.set({ open: !current.open, sessionId: sid, settingsOpen: false }),
              };
            },
          });
        } catch (err) {
          // 热重载时旧快捷键可能尚未释放，忽略重复注册错误，避免整段 apply 中断
          disposeShortcut = null;
        }
      };
      ctx.effect(() => {
        registerShortcut(store.get().spec);
        return () => {
          if (disposeShortcut) {
            try {
              disposeShortcut();
            } catch (err) {
              /* 忽略 */
            }
            disposeShortcut = null;
          }
        };
      }, 'file-search: shortcut');

      // 右侧栏是否展开（收起时把按钮一起藏起来）。isExpanded() 是同步读取，
      // 用低频率轮询保持响应；只在有会话时轮询，开销可忽略。
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
          const tick = () => setShown((prev) => (prev === read() ? prev : read()));
          tick();
          const id = window.setInterval(tick, 200);
          return () => window.clearInterval(id);
        }, [sessionId]);
        return shown;
      }

      // 浮层：右侧栏右上角按钮 + 悬浮搜索窗（共用一个组件，靠 store 解耦）
      function Surface(props) {
        // 右侧栏当前在屏的会话；为 undefined 说明没有会话
        const sessionId = props.useSidebarMounted((s) => s);
        const rightbarShown = useRightbarShown(sessionId);
        const cwd = props.useSessions((state) => (sessionId ? state.byId[sessionId] && state.byId[sessionId].cwd : undefined));
        const [snap, setSnap] = React.useState(() => store.get());
        React.useEffect(() => store.subscribe(() => setSnap(store.get())), []);
        const wrapRef = React.useRef(null);

        // 用真实 DOM 测量右侧栏表头图标排的位置，把胶囊精确贴到它左边；
        // 面板太窄时切到“仅图标”模式（靠 html[data-dsfs-compact] 触发 CSS），避免压住 tab 标题。
        // data-dsfs-on 只在按钮真正显示（有会话且右栏展开）时挂上，未显示时不占位。
        React.useEffect(() => {
          const html = document.documentElement;
          const active = !!(sessionId && rightbarShown);
          if (!active) {
            html.removeAttribute('data-dsfs-on');
            html.removeAttribute('data-dsfs-compact');
            html.style.removeProperty('--dsfs-reserve');
            return undefined;
          }
          const place = () => {
            // 精确锁定当前会话的右栏（可能同时存在多个保留的会话面板）
            let root = null;
            try {
              root = document.querySelector('[data-sidebar-right-session="' + String(sessionId).replace(/["\\]/g, '\\$&') + '"]');
            } catch (err) {
              root = null;
            }
            if (!root) {
              const all = document.querySelectorAll('[data-sidebar-right-session]');
              for (let i = 0; i < all.length; i += 1) {
                if (all[i].getBoundingClientRect().width > 0) { root = all[i]; break; }
              }
            }
            const chrome = root && root.querySelector('[data-dockkit-strip-chrome]');
            html.setAttribute('data-dsfs-on', '');
            if (!chrome) return;
            // 面板过窄 -> 仅图标模式，避免胶囊挤掉 tab 标题
            const compact = (root.clientWidth || 0) < 360;
            if (compact) html.setAttribute('data-dsfs-compact', '');
            else html.removeAttribute('data-dsfs-compact');
            const el = wrapRef.current;
            if (!el) return;
            // 按胶囊真实宽度预留空白（中英文/不同系统都适配）
            const pillW = el.getBoundingClientRect().width || 0;
            // 预留 = 胶囊宽度 + 8：让胶囊与左右相邻图标都恰好间隔 8px（同原生 stripChrome gap:8）
            html.style.setProperty('--dsfs-reserve', Math.ceil(pillW + 8) + 'px');
            const pad = parseFloat(window.getComputedStyle(chrome).paddingLeft) || 0;
            const rect = chrome.getBoundingClientRect();
            el.style.top = rect.top + 'px';
            el.style.right = window.innerWidth - (rect.left + pad) + 8 + 'px';
          };
          place();
          const id = window.setInterval(place, 300);
          window.addEventListener('resize', place);
          return () => {
            window.clearInterval(id);
            window.removeEventListener('resize', place);
            html.removeAttribute('data-dsfs-on');
            html.removeAttribute('data-dsfs-compact');
            html.style.removeProperty('--dsfs-reserve');
          };
        }, [rightbarShown, sessionId]);

        // 把当前会话上下文写进共享 store，供弹窗与快捷键共用
        React.useEffect(() => {
          store.set({ sessionId: sessionId || null, cwd });
          if (!sessionId && store.get().open) store.set({ open: false });
        }, [sessionId, cwd]);

        const openDialog = () => store.set({ open: true, sessionId: sessionId || null, cwd, settingsOpen: false });
        const shortcutText = specToText(snap.spec);

        return h(
          React.Fragment,
          null,
          sessionId && rightbarShown
            ? h(
                'div',
                { className: 'dsfs-triggerwrap', ref: wrapRef },
                h(
                  'button',
                  { type: 'button', className: 'dsfs-trigger', title: t('triggerTitle'), 'aria-label': t('triggerTitle'), onClick: openDialog },
                  h(SearchGlyph),
                  h('span', { className: 'dsfs-trigger-label' }, t('trigger')),
                  h('kbd', { className: 'dsfs-trigger-kbd' }, shortcutText),
                ),
              )
            : null,
          h(SearchDialog, { snap }),
        );
      }

      // 悬浮搜索窗
      function SearchDialog(props) {
        const [snap, setSnap] = React.useState(() => store.get());
        React.useEffect(() => store.subscribe(() => setSnap(store.get())), []);

        const [query, setQuery] = React.useState('');
        const [results, setResults] = React.useState([]);
        const [loading, setLoading] = React.useState(false);
        const [active, setActive] = React.useState(0);
        const inputRef = React.useRef(null);
        const listRef = React.useRef(null);
        const open = snap.open;

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
          const q = query.trim();
          if (!q) {
            setResults([]);
            setLoading(false);
            setActive(0);
            return undefined;
          }
          setLoading(true);
          const ac = new AbortController();
          const timer = window.setTimeout(() => {
            if (!snap.sessionId) {
              setResults([]);
              setLoading(false);
              return;
            }
            let pending;
            try {
              pending = ctx.remote.fileReferences.list(snap.sessionId, q, ac.signal);
            } catch (err) {
              setResults([]);
              setLoading(false);
              return;
            }
            Promise.resolve(pending)
              .then((r) => {
                if (ac.signal.aborted) return;
                const arr = Array.isArray(r) ? r : r && r.ok && Array.isArray(r.value) ? r.value : [];
                setResults(rankResults(arr, q));
                setActive(0);
                setLoading(false);
              })
              .catch(() => {
                if (ac.signal.aborted) return;
                setResults([]);
                setLoading(false);
              });
          }, 120);
          return () => {
            window.clearTimeout(timer);
            ac.abort();
          };
        }, [open, query, snap.sessionId]);

        // 键盘：↑↓ 切换、↵ 打开、Tab 插入到输入框、esc 关闭
        const onKeyDown = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            store.set({ open: false });
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (results.length ? (i + 1) % results.length : 0));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(results[active]);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            insert(results[active]);
          }
        };

        // 选中：文件夹下钻，文件在右侧打开
        const choose = (cand) => {
          if (!cand) return;
          if (cand.kind === 'directory') {
            setQuery(cand.path.replace(/\/+$/, '') + '/');
            window.setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
            return;
          }
          try {
            const url = fileAddressFor(snap.sessionId, snap.cwd, resolveWorkspacePath(snap.cwd, cand.path));
            ctx.sidebarRight.openResource(url);
          } catch (err) {
            /* 打开失败时静默，不打断输入 */
          }
          store.set({ open: false });
        };

        // 插入：把选中的路径以 @ 引用形式写进当前会话的输入框（Tab 触发）
        const insert = (cand) => {
          if (!cand) return;
          const value = ctx.uiSession ? ctx.uiSession.current.getSnapshot() : null;
          const actions = value && value.props && value.props.inputActions;
          if (!actions || value.key !== snap.sessionId) return;
          const ref = cand.path + (cand.kind === 'directory' ? '/' : '');
          const text = /\s/.test(cand.path) ? '@"' + ref + '" ' : '@' + ref + ' ';
          try {
            if (actions.insertText(text, actions.captureInsertion())) {
              focusComposer(); // 插入后光标回到对话输入框，可直接继续打字
              store.set({ open: false });
            }
          } catch (err) {
            /* 插入失败时保留弹窗，方便重试 */
          }
        };

        // 让高亮行始终可见
        React.useEffect(() => {
          if (!open || !listRef.current) return;
          const el = listRef.current.querySelector('[data-active="true"]');
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
        }, [active, results, open]);

        if (!open) return null;

        // 设置弹窗（从底栏齿轮进入），与搜索窗共用遮罩
        if (snap.settingsOpen) {
          return h(
            'div',
            {
              className: 'dsfs-overlay',
              onMouseDown: (e) => {
                if (e.target === e.currentTarget) store.set({ settingsOpen: false });
              },
            },
            h(SettingsDialog, { onClose: () => store.set({ settingsOpen: false }) }),
          );
        }

        const showHint = !query.trim();
        const showEmpty = !showHint && !loading && results.length === 0;

        return h(
          'div',
          {
            className: 'dsfs-overlay',
            onMouseDown: (e) => {
              if (e.target === e.currentTarget) store.set({ open: false, settingsOpen: false });
            },
          },
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
                onChange: (e) => setQuery(e.target.value),
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
                  ? h('div', { className: 'dsfs-empty' }, loading ? t('loading') : t('empty'))
                  : results.map((c, i) =>
                      h(
                        'div',
                        {
                          key: `${c.path}|${c.kind}|${i}`,
                          className: 'dsfs-item' + (i === active ? ' is-active' : ''),
                          role: 'option',
                          'aria-selected': i === active,
                          'data-active': i === active ? 'true' : 'false',
                          onMouseEnter: () => setActive(i),
                          onMouseDown: (e) => {
                            e.preventDefault();
                            choose(c);
                          },
                        },
                        c.kind === 'directory' ? h(FolderGlyph) : h(FileGlyph),
                        h('span', { className: 'dsfs-path' }, renderPath(c.path, query)),
                        i === active
                          ? h(
                              'span',
                              { className: 'dsfs-item-hint' },
                              h('kbd', null, 'Tab'),
                              ' ',
                              t('insertHint'),
                            )
                          : null,
                      ),
                    ),
            ),
            h(
              'div',
              { className: 'dsfs-foot' },
              h('span', { className: 'dsfs-foot-item' }, h('kbd', null, '↑'), h('kbd', null, '↓'), ' ', t('swap')),
              h('span', { className: 'dsfs-foot-item' }, h('kbd', null, '↵'), ' ', t('select')),
              h('span', { className: 'dsfs-foot-item' }, h('kbd', null, 'esc'), ' ', t('close')),
              h('span', { className: 'dsfs-foot-grow' }),
              h('span', { className: 'dsfs-foot-item dsfs-foot-shortcut' }, h('kbd', null, specToText(snap.spec)), ' ', t('shortcut')),
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

      // 设置弹窗：修改打开搜索窗的快捷键（点按钮后按下新组合键即保存）
      function SettingsDialog(props) {
        const [snap, setSnap] = React.useState(() => store.get());
        React.useEffect(() => store.subscribe(() => setSnap(store.get())), []);
        const [capturing, setCapturing] = React.useState(false);
        const [error, setError] = React.useState('');
        const [preview, setPreview] = React.useState('');
        const held = React.useRef(new Set());

        // 当前按住的修饰键 → modifier 名称列表
        const heldMods = () => {
          const mods = [];
          if (held.current.has(isMac ? 'Meta' : 'Control')) mods.push('primary');
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
          const pure = ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'];
          const onKeyDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            if (e.repeat) return;
            if (pure.indexOf(e.key) >= 0) {
              held.current.add(e.key); // 只按了修饰键，先实时显示
              setPreview(modsToText(heldMods()));
              return;
            }
            // 合并“真实按住的键”与事件自身修饰位，避免漏记
            const mods = heldMods();
            const add = (m, on) => {
              if (on && mods.indexOf(m) < 0) mods.push(m);
            };
            add('primary', isMac ? e.metaKey : e.ctrlKey);
            add('alt', e.altKey);
            add('shift', e.shiftKey);
            setPreview(specToText({ code: e.code, modifiers: mods }));
            if (e.key === 'Escape' && mods.length === 0) {
              setCapturing(false);
              setError('');
              return;
            }
            if (mods.length === 0) {
              setError(t('needMod'));
              return;
            }
            const spec = { code: e.code, modifiers: mods };
            saveSpec(spec);
            store.set({ spec });
            registerShortcut(spec);
            setCapturing(false);
            setError('');
          };
          const onKeyUp = (e) => {
            if (pure.indexOf(e.key) < 0) return;
            held.current.delete(e.key);
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
          registerShortcut(DEFAULT_SPEC);
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
                capturing ? preview || t('pressKeys') : specToText(snap.spec),
              ),
            ),
            error ? h('div', { className: 'dsfs-set-error' }, error) : null,
          ),
          h(
            'div',
            { className: 'dsfs-set-foot' },
            h('button', { type: 'button', className: 'dsfs-btn', onClick: reset }, t('reset')),
            h('span', { className: 'dsfs-foot-grow' }),
            h('button', { type: 'button', className: 'dsfs-btn is-primary', onClick: props.onClose }, t('done')),
          ),
        );
      }

      // 注册到全窗口浮层，注入右侧栏“在屏会话”钩子
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'file-search',
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
