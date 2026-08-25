/**
 * dsh-sidebar-open-in-ide — browser half (sidebar edition).
 *
 * Hand-written bundle in the standard DSH client-plugin format:
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * Sits inside dsh-better-sidebar: every FILE row of the file manager
 * (explorer) and every row of the source-control (git, staged/unstaged) list
 * gets an extra "idea" pill button that opens that exact file in IntelliJ
 * IDEA (POST /open-in-ide from the Node half; failure codes map to
 * human-readable Chinese messages).
 *
 * - No official row-action extension point exists in better-sidebar, so the
 *   buttons are injected via MutationObserver (the same DOM-enhancement
 *   pattern as dsh-auto-collapse). better-sidebar class names are CSS Modules
 *   `<hash>_<local>` — the hash prefix (e.g. nArs4W) is build-generated and
 *   changes between versions, so the plugin matches the stable LOCAL part
 *   dynamically: classList suffix checks (hasLocal/prefixOf/findLocal) locate
 *   rows hash-agnostically, and the discovered prefix is re-attached to the
 *   injected `_explorerRef` button so it keeps the built-in pill look.
 *   Explorer rows carry the absolute path in their `title` attribute (file
 *   rows only; dir/broken/loading rows are skipped); git rows carry the
 *   repo-relative path on `<hash>_gitRowMain[title]`, which the Node half
 *   resolves against the session cwd's git work-tree root.
 * - The explorer button reuses the built-in `<hash>_explorerRef` class so it
 *   inherits the pill look and the hover-to-reveal behavior for free; the git
 *   button mirrors the same CSS.
 * - Global shortcut Cmd/Ctrl+Shift+O opens the file currently open in the
 *   sidebar editor (read from `<hash>_editorPathInput[title]`, which is the
 *   absolute path; `value` is only the cwd-relative display).
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-open-in-ide',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const NAME = 'dsh-sidebar-open-in-ide';

    /** Services required by this client plugin (sessions → session cwd for git rows). */
    const inject = ['sessions', 'slots'];

    // ── Settings page (settings.section slot) ──
    // React is a shell seed external (dsh-chat-outline proves the pattern).
    const React = require('react');
    const h = React.createElement;

    /** One preference row in the DSH Settings shell → 「在 IDEA 中打开」page. */
    function IdeSettingsSection() {
      const [value, setValue] = React.useState('');
      const [meta, setMeta] = React.useState(null); // {resolved, java, defaultHome, configHome}
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null); // {kind: 'ok'|'err', text}

      const load = React.useCallback(() => {
        fetch('/open-in-ide/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'get' }),
        })
          .then((r) => r.json().catch(() => null))
          .then((data) => {
            if (data && data.ok) {
              setValue(data.ideaHome ?? '');
              setMeta(data);
            } else {
              setNotice({ kind: 'err', text: data?.message || '读取设置失败' });
            }
          })
          .catch(() => setNotice({ kind: 'err', text: '读取设置失败（网络错误）' }));
      }, []);
      React.useEffect(() => { load(); }, [load]);

      const save = () => {
        setBusy(true);
        setNotice(null);
        fetch('/open-in-ide/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'update', ideaHome: value.trim() }),
        })
          .then((r) => r.json().catch(() => null))
          .then((data) => {
            if (data && data.ok) {
              setMeta(data);
              setNotice({
                kind: 'ok',
                text: data.java
                  ? `已保存 ✓（布局有效：${data.resolved}）`
                  : '已保存，但未找到有效 IDEA 布局——请检查路径是否正确',
              });
            } else {
              setNotice({ kind: 'err', text: data?.message || '保存失败' });
            }
          })
          .catch(() => setNotice({ kind: 'err', text: '保存失败（网络错误）' }))
          .finally(() => setBusy(false));
      };

      const row = { display: 'flex', gap: '8px', alignItems: 'center', margin: '8px 0' };
      const inputStyle = {
        flex: '1 1 320px',
        minWidth: 0,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '6px',
        padding: '5px 10px',
        fontSize: '13px',
        outline: 'none',
      };
      const btnStyle = {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        cursor: 'pointer',
        borderRadius: '6px',
        padding: '5px 14px',
        flex: 'none',
      };
      const hint = {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '12px',
        lineHeight: '1.6',
        margin: '6px 0 0',
      };
      const noticeStyle = (kind) => ({
        color: kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
        fontSize: '12px',
        margin: '6px 0 0',
      });

      return h('div', { style: { padding: '2px 0' } },
        h('p', { style: hint }, '设置 IntelliJ IDEA 的安装根目录，留空表示使用平台默认路径。保存后下次在侧边栏点击「idea」按钮即生效，无需重启。'),
        h('div', { style: row },
          h('input', {
            style: inputStyle,
            value: value,
            onChange: (e) => setValue(e.target.value),
            placeholder: meta?.defaultHome || '/Applications/IntelliJ IDEA.app',
            spellCheck: false,
          }),
          h('button', { style: btnStyle, onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
        ),
        notice ? h('p', { style: noticeStyle(notice.kind) }, notice.text) : null,
        meta
          ? h('p', { style: hint },
              `当前生效布局：${meta.resolved || '未找到'}${meta.java ? '（有效）' : '（无效）'}` +
              (meta.configHome ? ` ｜ patch 配置：${meta.configHome}` : '') +
              ` ｜ 默认路径：${meta.defaultHome}`)
          : null,
        h('p', { style: hint }, '三平台默认：macOS 为 /Applications/IntelliJ IDEA.app（无需配置）；Windows 如 C:\\Program Files\\JetBrains\\IntelliJ IDEA；Linux 如 /opt/idea。'),
      );
    }

    // ── better-sidebar DOM contract (DYNAMIC) ──
    // better-sidebar 的类名是 CSS Modules 格式 <哈希>_<局部名>（如 nArs4W_explorerRow）：
    // 哈希（nArs4W）是构建时生成、随版本变化的随机前缀，局部名（explorerRow）才是源码
    // 里的正经类名。这里只依赖局部名——运行时用 classList 后缀匹配定位元素（哈希无关），
    // 并把发现的前缀拼回按钮的 _explorerRef 类，免费继承内置 pill 样式。
    const ROW_LOCAL = 'explorerRow';
    const DIR_LOCAL = 'explorerDir';
    const BROKEN_LOCAL = 'explorerBroken';
    const REF_LOCAL = 'explorerRef';
    const BTN_CLASS = 'openInIdeBtn';
    const GIT_ROW_LOCAL = 'gitRow';
    const GIT_ROW_MAIN_LOCAL = 'gitRowMain';
    const GIT_BTN_CLASS = 'gitInIdeBtn';
    const PATH_INPUT_LOCAL = 'editorPathInput';
    const PREVIEW_BTN_CLASS = 'openInIdePreviewBtn';
    const LABEL = 'idea';

    /** True when the element carries a `<哈希>_<local>` class (exact suffix check). */
    function hasLocal(el, local) {
      for (const c of el.classList) {
        if (c.endsWith('_' + local)) return true;
      }
      return false;
    }

    /** The hash prefix of the first `<哈希>_<local>` class (null when absent). */
    function prefixOf(el, local) {
      for (const c of el.classList) {
        if (c.endsWith('_' + local)) return c.slice(0, c.length - local.length - 1);
      }
      return null;
    }

    /**
     * Find elements carrying `<哈希>_<local>` inside `root` (default document).
     * The attribute selector only narrows the candidate set — the classList
     * suffix check is authoritative (prevents substring false positives).
     */
    function findLocal(local, root) {
      const out = [];
      const cands = (root || document).querySelectorAll('[class*="_' + local + '"]');
      for (const el of cands) {
        if (hasLocal(el, local)) out.push(el);
      }
      return out;
    }

    const ERROR_MESSAGES = {
      JAVA_MISSING: '未找到 IntelliJ IDEA 的 JBR 运行时',
      SPAWN_FAILED: '无法启动 IDEA MCP 进程',
      IDE_UNAVAILABLE: 'IntelliJ IDEA 未运行或 MCP 未就绪',
      IDE_CRASHED: 'IDEA MCP 进程已退出，正在冷却重试',
      NOT_FOUND: '文件不存在',
      NOT_IN_PROJECT: '文件不在任何已打开的 IDEA 项目中',
      IDE_CALL_FAILED: 'IDEA 拒绝了操作',
      TIMEOUT: 'IDEA 响应超时',
      BAD_REQUEST: '请求参数错误',
      GIT_ROOT_NOT_FOUND: '会话目录不在任何 Git 仓库中',
    };

    const CSS = [
      '.' + BTN_CLASS + '.openInIdeOk{color:var(--dsw-alias-state-success-primary)}',
      '.' + BTN_CLASS + '.openInIdeErr{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.' + BTN_CLASS + ':disabled{opacity:.5;cursor:default}',
      // git-row pill (mirrors the explorer @-button look; revealed on row hover).
      // `[class*="_gitRow"]` matches gitRow/gitRowSelected/gitRowMain — all the
      // same row family, so the hover reveal behaves identically to the old
      // exact-class rule while being hash-agnostic.
      '.' + GIT_BTN_CLASS + '{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);height:20px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-strong-11);cursor:pointer;border-radius:999px;flex:none;align-items:center;padding:0 8px;display:none}',
      '.' + GIT_BTN_CLASS + ':hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '[class*="_' + GIT_ROW_LOCAL + '"]:hover .' + GIT_BTN_CLASS + ',[class*="_' + GIT_ROW_LOCAL + '"]:focus-within .' + GIT_BTN_CLASS + '{display:inline-flex}',
      '.' + GIT_BTN_CLASS + '.openInIdeOk{color:var(--dsw-alias-state-success-primary)}',
      '.' + GIT_BTN_CLASS + '.openInIdeErr{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.' + GIT_BTN_CLASS + ':disabled{opacity:.5;cursor:default}',
      // file-preview header button (next to the path input; always visible)
      '.' + PREVIEW_BTN_CLASS + '{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);height:28px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-strong-11);cursor:pointer;border-radius:6px;flex:none;align-items:center;padding:0 10px;display:inline-flex}',
      '.' + PREVIEW_BTN_CLASS + ':hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.' + PREVIEW_BTN_CLASS + ':disabled{opacity:.5;cursor:default}',
      '.' + PREVIEW_BTN_CLASS + '.openInIdeOk{color:var(--dsw-alias-state-success-primary)}',
      '.' + PREVIEW_BTN_CLASS + '.openInIdeErr{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.openInIdeToast{position:fixed;top:12px;right:12px;z-index:9999;max-width:320px;padding:8px 12px;border-radius:8px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;opacity:0;transform:translateY(-4px);transition:opacity .18s ease,transform .18s ease}',
      '.openInIdeToast.show{opacity:1;transform:none}',
      '.openInIdeToast.err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
    ].join('\n');

    // ── session cwd (resolves repo-relative git paths on the Node half) ──
    let currentCtx = null;
    function currentCwd() {
      try {
        const snap = currentCtx?.sessions?.list?.getSnapshot();
        const sid = snap?.current;
        return (sid && snap.byId?.[sid]?.cwd) || null;
      } catch {
        return null;
      }
    }

    // ── toast (shortcut / non-button feedback) ──
    let toastTimer = null;
    function showToast(text, kind) {
      let el = document.getElementById('open-in-ide-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'open-in-ide-toast';
        el.className = 'openInIdeToast';
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.classList.toggle('err', kind === 'err');
      // force reflow so the transition restarts for consecutive toasts
      void el.offsetWidth;
      el.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
    }

    // ── open in IDEA ──
    async function openInIde(path, btn) {
      const prev = btn ? btn.textContent : null;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '…';
      }
      const payload = { path };
      if (!path.startsWith('/')) {
        // repo-relative path (git rows): the Node half resolves it against the
        // work-tree root of the session's working directory
        const cwd = currentCwd();
        if (cwd) payload.cwd = cwd;
      }
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch('/open-in-ide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const data = await res.json().catch(() => null);
        if (res.ok && data?.ok) {
          if (btn) flash(btn, 'ok', '✓', '已在 IDEA 中打开', 1200);
          else showToast(`已在 IDEA 中打开：${path}`, 'ok');
        } else {
          const code = data?.error || 'IDE_UNAVAILABLE';
          const msg = ERROR_MESSAGES[code] || data?.message || `打开失败（${code}）`;
          if (btn) flash(btn, 'err', '✕', msg, 2600);
          showToast(msg, 'err');
        }
      } catch {
        const msg = '请求失败：无法连接 DSH 服务';
        if (btn) flash(btn, 'err', '✕', msg, 2600);
        showToast(msg, 'err');
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    /** Swap the button to a feedback glyph, then restore the label. */
    function flash(btn, kind, glyph, title, ms) {
      btn.classList.add(kind === 'ok' ? 'openInIdeOk' : 'openInIdeErr');
      btn.textContent = glyph;
      btn.title = title;
      setTimeout(() => {
        btn.classList.remove('openInIdeOk', 'openInIdeErr');
        btn.textContent = LABEL;
        btn.title = '在 IntelliJ IDEA 中打开';
      }, ms);
    }

    // ── explorer row button injection ──
    function injectButtons() {
      const rows = findLocal(ROW_LOCAL);
      for (const row of rows) {
        if (row.querySelector('.' + BTN_CLASS)) continue;
        if (hasLocal(row, DIR_LOCAL)) continue;        // directories
        if (hasLocal(row, BROKEN_LOCAL)) continue;     // broken symlinks
        const path = row.getAttribute('title');
        if (!path) continue; // root/loading/error rows carry no path
        const btn = document.createElement('button');
        btn.type = 'button';
        // Reuse the built-in `_explorerRef` pill class (hash prefix discovered
        // from the row itself) so the button inherits the hover-to-reveal look.
        const prefix = prefixOf(row, ROW_LOCAL);
        btn.className = (prefix ? prefix + '_' + REF_LOCAL + ' ' : '') + BTN_CLASS;
        btn.textContent = LABEL;
        btn.title = '在 IntelliJ IDEA 中打开';
        btn.setAttribute('aria-label', '在 IntelliJ IDEA 中打开');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openInIde(path, btn);
        });
        // keep the row's Enter/Space open-file handler from firing
        btn.addEventListener('keydown', (e) => e.stopPropagation());
        const ref = findLocal(REF_LOCAL, row)[0];
        if (ref) row.insertBefore(btn, ref);
        else row.appendChild(btn);
      }
    }

    // ── source-control (git) row button injection ──
    // Rows carry the repo-relative path on `<哈希>_gitRowMain[title]`; the
    // Node half resolves it against the session cwd's git work-tree root.
    function injectGitButtons() {
      const rows = findLocal(GIT_ROW_LOCAL);
      for (const row of rows) {
        if (row.querySelector('.' + GIT_BTN_CLASS)) continue;
        const main = findLocal(GIT_ROW_MAIN_LOCAL, row)[0];
        const rel = main?.getAttribute('title');
        if (!rel) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = GIT_BTN_CLASS;
        btn.textContent = LABEL;
        btn.title = '在 IntelliJ IDEA 中打开';
        btn.setAttribute('aria-label', '在 IntelliJ IDEA 中打开');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openInIde(rel, btn);
        });
        btn.addEventListener('keydown', (e) => e.stopPropagation());
        main.after(btn);
      }
    }

    // ── file-preview header button (right of the path input) ──
    // The input's `title` is the absolute path; `value` is cwd-relative.
    function injectPreviewButtons() {
      const inputs = findLocal(PATH_INPUT_LOCAL);
      for (const input of inputs) {
        const next = input.nextElementSibling;
        if (next && next.classList.contains(PREVIEW_BTN_CLASS)) continue;
        const abs = input.getAttribute('title');
        if (!abs) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = PREVIEW_BTN_CLASS;
        btn.textContent = LABEL;
        btn.title = '在 IntelliJ IDEA 中打开';
        btn.setAttribute('aria-label', '在 IntelliJ IDEA 中打开');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openInIde(abs, btn);
        });
        btn.addEventListener('keydown', (e) => e.stopPropagation());
        input.after(btn);
      }
    }

    function scan() {
      injectButtons();
      injectGitButtons();
      injectPreviewButtons();
    }

    function startObserver() {
      let scheduled = false;
      const run = () => { scheduled = false; scan(); };
      const mo = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(run);
      });
      mo.observe(document.body, { childList: true, subtree: true });
      scan();
      // safety net: React re-renders can rebuild rows without a row-level mutation
      const iv = setInterval(scan, 2000);
      return () => { mo.disconnect(); clearInterval(iv); };
    }

    // ── global shortcut: open the sidebar editor's current file ──
    function currentEditorPath() {
      const inputs = findLocal(PATH_INPUT_LOCAL);
      for (const el of inputs) {
        if (el.offsetParent === null) continue; // hidden pane
        const p = el.getAttribute('title');
        if (p) return p;
      }
      return null;
    }

    function onKey(e) {
      if (!((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'o' || e.key === 'O'))) return;
      e.preventDefault();
      const path = currentEditorPath();
      if (!path) {
        showToast('先在侧边栏打开一个文件（⌘⇧O 会把它带到 IDEA）', 'err');
        return;
      }
      openInIde(path, null);
    }

    function apply(ctx) {
      currentCtx = ctx;
      // Settings page: one nav entry + the preference row component. Follows the
      // dsh-better-sidebar recipe: ctx.slots.inject('settings.section', () =>
      // ctx.slots.register({name, id, order, label}, Component)).
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'open-in-ide',
        order: 200,
        label: () => '在 IDEA 中打开',
      }, IdeSettingsSection));

      ctx.effect(() => {
        const style = document.createElement('style');
        style.id = 'open-in-ide-css';
        style.textContent = CSS;
        document.head.appendChild(style);

        const stopObserver = startObserver();
        window.addEventListener('keydown', onKey);

        return () => {
          style.remove();
          stopObserver();
          window.removeEventListener('keydown', onKey);
          currentCtx = null;
          // drop injected buttons so an HMR re-apply starts clean
          document.querySelectorAll('.' + BTN_CLASS).forEach((el) => el.remove());
          document.querySelectorAll('.' + GIT_BTN_CLASS).forEach((el) => el.remove());
          document.querySelectorAll('.' + PREVIEW_BTN_CLASS).forEach((el) => el.remove());
        };
      }, 'dsh-sidebar-open-in-ide: explorer + git buttons');
    }

    module.exports = { name: NAME, apply, inject };
    return module.exports;
  },
});
