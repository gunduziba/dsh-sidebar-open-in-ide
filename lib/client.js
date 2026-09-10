/**
 * dsh-sidebar-open-in-ide — 浏览器端插件（全域增强版）
 *
 * 遵循标准 DSH client-plugin 格式：
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * 核心功能：
 * 1. 【主界面修改产物】：每次对话修改后，主界面「本轮文件改动 / Produced Files」行中的每个文件，
 *    自动注入紧贴文件的「IDEA」彩色品牌胶囊跳转按钮；
 * 2. 【主界面交付产物】：对于「交付产物卡片 / Presented Files」，注入与「预览/打开」操作栏对齐的
 *    「在 IDEA 中打开」专属品牌按钮；
 * 3. 【侧边栏文件树】：文件管理器（explorer）每个文件行 hover 时显现「IDEA」彩色胶囊按钮；
 * 4. 【侧边栏 Git 变更】：Git 暂存/未暂存列表每个文件行 hover 时显现「IDEA」彩色胶囊按钮；
 * 5. 【文件预览头部】：侧边栏文件编辑器顶部路径栏旁常驻「IDEA」品牌跳转按钮；
 * 6. 【全局快捷键】：Cmd/Ctrl+Shift+O 瞬间将侧边栏当前激活的文件在 IDEA 中打开；
 * 7. 【设置页】：清晰展示 IDEA Streamable HTTP MCP 联通状态与当前打开的项目。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-open-in-ide',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const NAME = 'dsh-sidebar-open-in-ide';
    const inject = ['sessions', 'slots'];

    // ── React 依赖 ──
    const React = require('react');
    const h = React.createElement;

    // ── 品牌矢量 SVG 图标定义（全文档共享 symbol） ──
    const SVG_DEFS_ID = 'dsh-open-in-ide-defs';
    const SVG_SYMBOL_ID = 'dsh-icon-ij-brand';

    const SVG_DEFS_HTML = `
      <svg id="${SVG_DEFS_ID}" xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;" aria-hidden="true">
        <defs>
          <linearGradient id="dsh-ij-gradient" x1="1" y1="1" x2="15" y2="15" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#3592C4"/>
            <stop offset="50%" stop-color="#FC801D"/>
            <stop offset="100%" stop-color="#F83B40"/>
          </linearGradient>
          <symbol id="${SVG_SYMBOL_ID}" viewBox="0 0 16 16" fill="none">
            <rect width="16" height="16" rx="3.5" fill="url(#dsh-ij-gradient)"/>
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="#1E1F22"/>
            <path d="M4.5 4.5H5.8V10.2H4.5V4.5ZM7 4.5H8.3V8.8C8.3 9.4 8.7 9.8 9.3 9.8C9.9 9.8 10.3 9.4 10.3 8.8V4.5H11.6V8.9C11.6 10.2 10.6 11.2 9.3 11.2C8 11.2 7 10.2 7 8.9V4.5Z" fill="#FFFFFF"/>
          </symbol>
        </defs>
      </svg>
    `.trim();

    /** 确保全局 SVG Symbol 存在 */
    function ensureSvgDefs() {
      if (document.getElementById(SVG_DEFS_ID)) return;
      const div = document.createElement('div');
      div.innerHTML = SVG_DEFS_HTML;
      const svgEl = div.firstElementChild;
      if (svgEl) document.body.appendChild(svgEl);
    }

    /** 创建标准 JetBrains IDEA 彩色矢量图标元素 */
    function createIdeaIcon(size = 13) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'dsh-idea-brand-icon');
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `#${SVG_SYMBOL_ID}`);
      svg.appendChild(use);
      return svg;
    }

    // ── 设置页面组件 ──
    function IdeSettingsSection() {
      const [port, setPort] = React.useState(64342);
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);

      const checkStatus = React.useCallback(() => {
        fetch('/open-in-ide/status')
          .then((r) => r.json().catch(() => null))
          .then((data) => {
            if (data && data.ok) {
              setStatus(data);
              setPort(data.port || 64342);
            }
          })
          .catch(() => {});
      }, []);

      React.useEffect(() => {
        checkStatus();
        const iv = setInterval(checkStatus, 5000);
        return () => clearInterval(iv);
      }, [checkStatus]);

      const save = () => {
        setBusy(true);
        setNotice(null);
        fetch('/open-in-ide/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'update', port: Number(port) || 64342 }),
        })
          .then((r) => r.json().catch(() => null))
          .then((data) => {
            if (data && data.ok) {
              setNotice({ kind: 'ok', text: '端口已保存，正在重新检测…' });
              setTimeout(checkStatus, 600);
            } else {
              setNotice({ kind: 'err', text: data?.message || '保存失败' });
            }
          })
          .catch(() => setNotice({ kind: 'err', text: '保存失败（网络错误）' }))
          .finally(() => setBusy(false));
      };

      const row = { display: 'flex', gap: '8px', alignItems: 'center', margin: '8px 0' };
      const inputStyle = {
        width: '140px',
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
        h('p', { style: hint }, '基于 JetBrains 官方 Streamable HTTP MCP 协议，直连本地 IntelliJ IDEA。无需配置 Java 运行时或 JBR 路径。'),
        h('div', { style: row },
          h('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, 'MCP 服务端口：'),
          h('input', {
            style: inputStyle,
            type: 'number',
            value: port,
            onChange: (e) => setPort(e.target.value),
            placeholder: '64342',
          }),
          h('button', { style: btnStyle, onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          h('button', { style: btnStyle, onClick: checkStatus }, '刷新状态'),
        ),
        notice ? h('p', { style: noticeStyle(notice.kind) }, notice.text) : null,
        status ? h('div', { style: { margin: '8px 0', fontSize: '12px' } },
          h('span', {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              color: status.mcpReady ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
              fontWeight: 500,
            },
          },
            status.mcpReady ? '● IntelliJ IDEA 已连通 (就绪)' : '○ IntelliJ IDEA 未就绪 (未连接)'
          ),
          status.projects && status.projects.length > 0 ? h('p', { style: hint },
            `当前打开项目（${status.projects.length} 个）：${status.projects.join('，')}`
          ) : null,
        ) : null,
      );
    }

    // ── DOM 类名与选择器定义（哈希无关动态匹配） ──
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

    // 新增：产物文件按钮类名
    const PRODUCED_BTN_CLASS = 'producedInIdeBtn';
    const PRESENTED_BTN_CLASS = 'presentedInIdeBtn';

    /** 检查元素是否携带 `<hash>_<local>` 局部类名 */
    function hasLocal(el, local) {
      if (!el || !el.classList) return false;
      for (const c of el.classList) {
        if (c.endsWith('_' + local)) return true;
      }
      return false;
    }

    /** 提取第一个 `<hash>_<local>` 的哈希前缀 */
    function prefixOf(el, local) {
      if (!el || !el.classList) return null;
      for (const c of el.classList) {
        if (c.endsWith('_' + local)) return c.slice(0, c.length - local.length - 1);
      }
      return null;
    }

    /** 查找包含特定局部类名的元素 */
    function findLocal(local, root) {
      const out = [];
      const cands = (root || document).querySelectorAll('[class*="_' + local + '"]');
      for (const el of cands) {
        if (hasLocal(el, local)) out.push(el);
      }
      return out;
    }

    const ERROR_MESSAGES = {
      IDE_UNAVAILABLE: 'IntelliJ IDEA 未运行或 MCP 端口无法连接',
      NOT_FOUND: '文件不存在',
      NOT_IN_PROJECT: '文件不在任何已打开的 IDEA 项目中',
      IDE_CALL_FAILED: 'IDEA 拒绝了打开请求',
      TIMEOUT: 'IDEA 响应超时',
      BAD_REQUEST: '请求参数错误',
      GIT_ROOT_NOT_FOUND: '会话目录不在任何 Git 仓库中',
    };

    // ── 样式表定义 ──
    const CSS = `
      /* 品牌图标样式 */
      .dsh-idea-brand-icon {
        flex: none;
        display: inline-block;
        vertical-align: middle;
        pointer-events: none;
      }

      /* 通用反馈状态 */
      .openInIdeOk {
        color: var(--dsw-alias-state-success-primary) !important;
        border-color: var(--dsw-alias-state-success-primary) !important;
      }
      .openInIdeErr {
        color: var(--dsw-alias-state-error-primary) !important;
        border-color: var(--dsw-alias-state-error-primary) !important;
      }

      /* 1. 文件树 explorerRow 按钮（继承 _explorerRef 的 hover 胶囊风格） */
      .${BTN_CLASS} {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        user-select: none;
      }
      .${BTN_CLASS}:disabled {
        opacity: .5;
        cursor: default;
      }

      /* 2. Git 行按钮（镜像 explorer 风格，hover 时显现） */
      .${GIT_BTN_CLASS} {
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
        height: 20px;
        color: var(--dsw-alias-label-secondary);
        font: var(--dsw-font-xxxs-strong-11);
        cursor: pointer;
        border-radius: 999px;
        flex: none;
        align-items: center;
        gap: 4px;
        padding: 0 7px;
        display: none;
        transition: all .15s ease;
      }
      .${GIT_BTN_CLASS}:hover {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
        border-color: var(--dsw-alias-border-l2);
      }
      [class*="_${GIT_ROW_LOCAL}"]:hover .${GIT_BTN_CLASS},
      [class*="_${GIT_ROW_LOCAL}"]:focus-within .${GIT_BTN_CLASS} {
        display: inline-flex;
      }
      .${GIT_BTN_CLASS}:disabled {
        opacity: .5;
        cursor: default;
      }

      /* 3. 侧边栏文件预览头部常驻按钮 */
      .${PREVIEW_BTN_CLASS} {
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        height: 28px;
        color: var(--dsw-alias-label-secondary);
        font: var(--dsw-font-xxxs-strong-11);
        cursor: pointer;
        border-radius: 6px;
        flex: none;
        align-items: center;
        gap: 6px;
        padding: 0 10px;
        display: inline-flex;
        transition: all .15s ease;
      }
      .${PREVIEW_BTN_CLASS}:hover {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
        border-color: var(--dsw-alias-border-l2);
      }
      .${PREVIEW_BTN_CLASS}:disabled {
        opacity: .5;
        cursor: default;
      }

      /* 4. 【核心新增】主界面对话修改产物 (Produced Files) 按钮 */
      .${PRODUCED_BTN_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        height: 20px;
        padding: 0 6px;
        border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-secondary);
        font-size: 11px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        flex: none;
        box-sizing: border-box;
        margin-left: -4px;
        margin-right: 4px;
        transition: all .15s cubic-bezier(.4, 0, .2, 1);
        opacity: 0.88;
      }
      .${PRODUCED_BTN_CLASS}:hover {
        opacity: 1;
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
        border-color: var(--dsw-alias-border-l3);
        transform: translateY(-0.5px);
        box-shadow: 0 2px 6px rgba(0, 0, 0, .08);
      }
      .${PRODUCED_BTN_CLASS}:active {
        transform: translateY(0);
      }
      .${PRODUCED_BTN_CLASS}:disabled {
        opacity: .45;
        cursor: default;
      }

      /* 5. 【核心新增】主界面交付产物大卡片 (Presented Files) 按钮 */
      .${PRESENTED_BTN_CLASS} {
        box-sizing: border-box;
        pointer-events: auto;
        border: .5px solid var(--dsw-alias-border-l3);
        background: var(--dsw-alias-button-floating-fill);
        border-radius: 12px;
        flex: none;
        align-items: center;
        justify-content: center;
        height: 32px;
        padding: 0 10px;
        gap: 6px;
        display: inline-flex;
        color: var(--dsw-alias-label-primary);
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        font-family: var(--dsw-font-family);
        transition: all .15s ease;
        margin-right: 6px;
      }
      .${PRESENTED_BTN_CLASS}:hover {
        background: var(--dsw-alias-interactive-bg-hover);
        border-color: var(--dsw-alias-border-l2);
      }
      .${PRESENTED_BTN_CLASS}:disabled {
        opacity: .5;
        cursor: default;
      }

      /* 全局 Toast 通知 */
      .openInIdeToast {
        position: fixed;
        top: 14px;
        right: 14px;
        z-index: 99999;
        max-width: 360px;
        padding: 9px 14px;
        border-radius: 8px;
        font: var(--dsw-font-xxs-12);
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l2);
        box-shadow: 0 6px 20px rgba(0, 0, 0, .22);
        pointer-events: none;
        opacity: 0;
        transform: translateY(-6px);
        transition: opacity .18s ease, transform .18s ease;
      }
      .openInIdeToast.show {
        opacity: 1;
        transform: none;
      }
      .openInIdeToast.err {
        border-color: var(--dsw-alias-state-error-primary);
        color: var(--dsw-alias-state-error-primary);
      }
      .openInIdeToast.ok {
        border-color: var(--dsw-alias-state-success-primary);
      }
    `.trim();

    // ── 当前会话上下文管理 ──
    let currentCtx = null;

    /** 获取当前活动会话的根工作区工作目录（cwd） */
    function currentCwd() {
      try {
        const snap = currentCtx?.sessions?.list?.getSnapshot();
        const sid = snap?.current;
        return (sid && snap.byId?.[sid]?.cwd) || null;
      } catch {
        return null;
      }
    }

    // ── Toast 通知组件 ──
    let toastTimer = null;
    function showToast(text, kind = 'info') {
      let el = document.getElementById('open-in-ide-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'open-in-ide-toast';
        el.className = 'openInIdeToast';
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.className = `openInIdeToast show ${kind}`;
      void el.offsetWidth;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.classList.remove('show');
      }, 2600);
    }

    // ── 核心打开逻辑 ──
    async function openInIde(path, btn) {
      if (!path) return;
      ensureSvgDefs();

      let originalContent = null;
      if (btn) {
        btn.disabled = true;
        originalContent = Array.from(btn.childNodes);
        btn.replaceChildren(document.createTextNode('…'));
      }

      const payload = { path };
      if (!path.startsWith('/')) {
        const cwd = currentCwd();
        if (cwd) payload.cwd = cwd;
      }

      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        const res = await fetch('/open-in-ide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const data = await res.json().catch(() => null);

        if (res.ok && data?.ok) {
          if (btn) {
            flash(btn, 'ok', '✓', '已在 IntelliJ IDEA 中打开', 1300, originalContent);
          } else {
            showToast(`已在 IDEA 中打开：${path.split('/').pop()}`, 'ok');
          }
        } else {
          const code = data?.error || 'IDE_UNAVAILABLE';
          const msg = ERROR_MESSAGES[code] || data?.message || `打开失败（${code}）`;
          if (btn) {
            flash(btn, 'err', '✕', msg, 2600, originalContent);
          }
          showToast(msg, 'err');
        }
      } catch (err) {
        const msg = '打开失败：无法连接 DSH 服务或请求超时';
        if (btn) {
          flash(btn, 'err', '✕', msg, 2600, originalContent);
        }
        showToast(msg, 'err');
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    /** 按钮操作反馈闪烁 */
    function flash(btn, kind, glyph, tooltip, durationMs, restoreNodes) {
      btn.classList.add(kind === 'ok' ? 'openInIdeOk' : 'openInIdeErr');
      btn.replaceChildren(document.createTextNode(glyph));
      btn.title = tooltip;

      setTimeout(() => {
        btn.classList.remove('openInIdeOk', 'openInIdeErr');
        if (restoreNodes && restoreNodes.length > 0) {
          btn.replaceChildren(...restoreNodes);
        }
        btn.title = '在 IntelliJ IDEA 中打开';
      }, durationMs);
    }

    // ── 1. 【核心新增】主界面对话修改产物 (Produced Files) 按钮注入 ──
    function injectProducedFilesButtons() {
      // 匹配包含 data-produced-files-row 的容器
      const rows = document.querySelectorAll('[data-produced-files-row]');
      for (const row of rows) {
        // 查找其中的文件按钮（通常带有 title="path"，且具有 _file 或类似 class）
        const fileBtns = row.querySelectorAll('button[title]');
        for (const fileBtn of fileBtns) {
          // 如果该按钮本身是注入的产物按钮，跳过
          if (fileBtn.classList.contains(PRODUCED_BTN_CLASS)) continue;

          // 检查该文件按钮后是否已经挂载了跳转按钮
          const next = fileBtn.nextElementSibling;
          if (next && next.classList.contains(PRODUCED_BTN_CLASS)) continue;

          const filePath = fileBtn.getAttribute('title');
          if (!filePath || filePath.includes('\n')) continue;

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = PRODUCED_BTN_CLASS;
          btn.title = `在 IntelliJ IDEA 中打开：${filePath}`;
          btn.setAttribute('aria-label', `在 IntelliJ IDEA 中打开 ${filePath}`);

          // 图标 + 文本
          btn.appendChild(createIdeaIcon(12));
          const labelSpan = document.createElement('span');
          labelSpan.textContent = 'IDEA';
          btn.appendChild(labelSpan);

          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openInIde(filePath, btn);
          });
          btn.addEventListener('keydown', (e) => e.stopPropagation());

          // 插入在对应文件按钮后方
          fileBtn.after(btn);
        }
      }
    }

    // ── 2. 【核心新增】主界面交付产物大卡片 (Presented Files) 按钮注入 ──
    function injectPresentedDeliverablesButtons() {
      const cards = document.querySelectorAll('[data-presented-file]');
      for (const card of cards) {
        if (card.querySelector('.' + PRESENTED_BTN_CLASS)) continue;

        // 尝试从 cardPreview 或其内部元素获取文件路径
        const previewEl = card.querySelector('[class*="_cardPreview"]');
        const filePath = previewEl?.getAttribute('title');
        if (!filePath) continue;

        // 寻找操作栏 split 元素
        const splitEl = card.querySelector('[class*="_split"]');
        if (!splitEl) continue;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = PRESENTED_BTN_CLASS;
        btn.title = `在 IntelliJ IDEA 中打开：${filePath}`;
        btn.setAttribute('aria-label', `在 IntelliJ IDEA 中打开 ${filePath}`);

        btn.appendChild(createIdeaIcon(14));
        const labelSpan = document.createElement('span');
        labelSpan.textContent = '在 IDEA 中打开';
        btn.appendChild(labelSpan);

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openInIde(filePath, btn);
        });
        btn.addEventListener('keydown', (e) => e.stopPropagation());

        // 插入在 split 操作组左侧
        splitEl.before(btn);
      }
    }

    // ── 3. 侧边栏文件树列表按钮注入 ──
    function injectExplorerButtons() {
      const rows = findLocal(ROW_LOCAL);
      for (const row of rows) {
        if (row.querySelector('.' + BTN_CLASS)) continue;
        if (hasLocal(row, DIR_LOCAL)) continue;
        if (hasLocal(row, BROKEN_LOCAL)) continue;

        const path = row.getAttribute('title');
        if (!path) continue;

        const btn = document.createElement('button');
        btn.type = 'button';
        const prefix = prefixOf(row, ROW_LOCAL);
        btn.className = (prefix ? prefix + '_' + REF_LOCAL + ' ' : '') + BTN_CLASS;
        btn.title = '在 IntelliJ IDEA 中打开';
        btn.setAttribute('aria-label', '在 IntelliJ IDEA 中打开');

        btn.appendChild(createIdeaIcon(13));
        const labelSpan = document.createElement('span');
        labelSpan.textContent = 'IDEA';
        btn.appendChild(labelSpan);

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openInIde(path, btn);
        });
        btn.addEventListener('keydown', (e) => e.stopPropagation());

        const ref = findLocal(REF_LOCAL, row)[0];
        if (ref) row.insertBefore(btn, ref);
        else row.appendChild(btn);
      }
    }

    // ── 4. 侧边栏 Git 变更列表按钮注入 ──
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
        btn.title = '在 IntelliJ IDEA 中打开';
        btn.setAttribute('aria-label', '在 IntelliJ IDEA 中打开');

        btn.appendChild(createIdeaIcon(13));
        const labelSpan = document.createElement('span');
        labelSpan.textContent = 'IDEA';
        btn.appendChild(labelSpan);

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openInIde(rel, btn);
        });
        btn.addEventListener('keydown', (e) => e.stopPropagation());
        main.after(btn);
      }
    }

    // ── 5. 侧边栏文件预览头部常驻按钮注入 ──
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
        btn.title = '在 IntelliJ IDEA 中打开';
        btn.setAttribute('aria-label', '在 IntelliJ IDEA 中打开');

        btn.appendChild(createIdeaIcon(14));
        const labelSpan = document.createElement('span');
        labelSpan.textContent = 'IDEA';
        btn.appendChild(labelSpan);

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openInIde(abs, btn);
        });
        btn.addEventListener('keydown', (e) => e.stopPropagation());
        input.after(btn);
      }
    }

    /** 执行所有注入扫描 */
    function scan() {
      ensureSvgDefs();
      injectProducedFilesButtons();
      injectPresentedDeliverablesButtons();
      injectExplorerButtons();
      injectGitButtons();
      injectPreviewButtons();
    }

    /** 启动 DOM 监听器 */
    function startObserver() {
      let scheduled = false;
      const run = () => {
        scheduled = false;
        scan();
      };
      const mo = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(run);
      });
      mo.observe(document.body, { childList: true, subtree: true });
      scan();
      const iv = setInterval(scan, 2000);
      return () => {
        mo.disconnect();
        clearInterval(iv);
      };
    }

    // ── 全局快捷键：Cmd/Ctrl + Shift + O ──
    function currentEditorPath() {
      const inputs = findLocal(PATH_INPUT_LOCAL);
      for (const el of inputs) {
        if (el.offsetParent === null) continue;
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
        showToast('先在侧边栏打开一个文件（⌘⇧O 会将其在 IDEA 中打开）', 'err');
        return;
      }
      openInIde(path, null);
    }

    function apply(ctx) {
      currentCtx = ctx;

      // 注册设置页标签
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'open-in-ide',
        order: 200,
        label: () => '在 IDEA 中打开',
      }, IdeSettingsSection));

      ctx.effect(() => {
        ensureSvgDefs();
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
          // 清理所有已注入的按钮，防止热重载堆叠
          document.querySelectorAll('.' + BTN_CLASS).forEach((el) => el.remove());
          document.querySelectorAll('.' + GIT_BTN_CLASS).forEach((el) => el.remove());
          document.querySelectorAll('.' + PREVIEW_BTN_CLASS).forEach((el) => el.remove());
          document.querySelectorAll('.' + PRODUCED_BTN_CLASS).forEach((el) => el.remove());
          document.querySelectorAll('.' + PRESENTED_BTN_CLASS).forEach((el) => el.remove());
          const defs = document.getElementById(SVG_DEFS_ID);
          if (defs) defs.remove();
        };
      }, 'dsh-sidebar-open-in-ide: full ide button injection');
    }

    module.exports = { name: NAME, apply, inject };
    return module.exports;
  },
});
