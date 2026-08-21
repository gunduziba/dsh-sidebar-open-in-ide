/**
 * dsh-sidebar-open-in-ide — Node half.
 *
 * Spawns the JetBrains MCP stdio server (com.intellij.mcpserver.stdio.McpStdioRunnerKt)
 * as a long-lived child and exposes two HTTP routes on the DSH web server:
 *
 *   POST /open-in-ide            { "path": "<absolute path>" } → open that file in IDEA
 *   GET  /open-in-ide/status     → IDE availability + open projects
 *
 * The browser half (lib/client.js) calls these routes from the composer dock.
 *
 * Failure modes are mapped to explicit JSON error codes (see ERROR_CODES) so the
 * UI can render a human-readable message: IDE not running, file not in any open
 * project, JBR missing, MCP call rejected, child crash, etc.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import { join as joinPath, delimiter as PATH_DELIMITER } from 'node:path';
import z from 'schemastery';
import { SettingsConflictError, settingsNamespace } from '@deepseek-ai/dsh-settings';

export const name = 'dsh-sidebar-open-in-ide';
export const inject = ['webServer'];

/** User-settings namespace: `ideaHome` is edited from the DSH Settings page. */
const PREFS_NS = 'open-in-ide';
/** Schemastery schema for the user-facing preferences (validated by the settings service). */
const IdeaPrefsSchema = z.object({
  /** IDEA installation root; empty = probe the platform default (macOS /Applications). */
  ideaHome: z.string().default(''),
});

// ── JetBrains MCP stdio server ────────────────────────────────────────────────
// Same entry point as the mcp-jetbrains entry in cordis.patch.yml. The install
// layout is resolved at apply() time from the optional `ideaHome` config (the
// IDEA installation root). Supported layouts:
//   macOS .app bundle : <home>/Contents/{jbr,plugins,lib}   (java at jbr/Contents/Home/bin/java)
//   Windows / Linux   : <home>/{jbr,plugins,lib}            (java at jbr/bin/java[.exe])
const DEFAULT_IDEA_HOME = '/Applications/IntelliJ IDEA.app';
const MAIN = 'com.intellij.mcpserver.stdio.McpStdioRunnerKt';
const ENV = { IJ_MCP_SERVER_PORT: '64342' };

/** The 9 support jars that live next to the mcpserver-frontend jar, in <layout>/lib/. */
const LIB_JARS = [
  'util-8.jar',
  'module-intellij.libraries.ktor.client.cio.jar',
  'module-intellij.libraries.ktor.client.jar',
  'module-intellij.libraries.ktor.network.tls.jar',
  'module-intellij.libraries.ktor.io.jar',
  'module-intellij.libraries.ktor.utils.jar',
  'module-intellij.libraries.kotlinx.io.jar',
  'module-intellij.libraries.kotlinx.serialization.core.jar',
  'module-intellij.libraries.kotlinx.serialization.json.jar',
];

/**
 * Probe one install layout under `home` with optional `prefix` ('Contents' for
 * macOS .app bundles). Returns { java, classpath, home } when the layout is
 * valid (jbr java + mcpserver-frontend.jar both present), else null.
 */
function probeLayout(home, prefix) {
  const jbrJava = [
    joinPath(home, prefix, 'jbr', 'Contents', 'Home', 'bin', 'java'),
    joinPath(home, prefix, 'jbr', 'bin', 'java'),
    joinPath(home, prefix, 'jbr', 'bin', 'java.exe'),
  ].find((p) => fs.existsSync(p));
  const mcpserver = joinPath(home, prefix, 'plugins', 'mcpserver', 'lib', 'mcpserver-frontend.jar');
  if (!jbrJava || !fs.existsSync(mcpserver)) return null;
  const classpath = [mcpserver, ...LIB_JARS.map((j) => joinPath(home, prefix, 'lib', j))]
    .join(PATH_DELIMITER);
  return { java: jbrJava, classpath, home };
}

/**
 * Resolve the install layout: an explicitly configured `ideaHome` is probed
 * first (both layouts tried); without config, the macOS default is probed.
 * Returns null when nothing valid is found (→ JAVA_MISSING at call time).
 */
function resolveLayout(config) {
  const homes = config?.ideaHome
    ? [String(config.ideaHome).trim()].filter(Boolean)
    : [DEFAULT_IDEA_HOME];
  for (const home of homes) {
    const layout = probeLayout(home, 'Contents') ?? probeLayout(home, '');
    if (layout) return layout;
  }
  return null;
}

const INIT_TIMEOUT_MS = 12_000;
const CALL_TIMEOUT_MS = 30_000;
const RESTART_BACKOFF_MS = 2_000;

export const ERROR_CODES = {
  JAVA_MISSING: 'JAVA_MISSING',
  SPAWN_FAILED: 'SPAWN_FAILED',
  IDE_UNAVAILABLE: 'IDE_UNAVAILABLE',
  IDE_CRASHED: 'IDE_CRASHED',
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  NOT_IN_PROJECT: 'NOT_IN_PROJECT',
  IDE_CALL_FAILED: 'IDE_CALL_FAILED',
  TIMEOUT: 'TIMEOUT',
  GIT_ROOT_NOT_FOUND: 'GIT_ROOT_NOT_FOUND',
};

class IdeError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

// ── JSON-RPC 2.0 client over stdio ───────────────────────────────────────────
class JetBrainsMcpClient {
  constructor({ layoutResolver, log } = {}) {
    // 布局不再在构造时固定：_start() 每次调 layoutResolver() 取当前布局，
    // 用户在设置页改 ideaHome 后下一次打开即生效（无需重启 dsh-web）。
    this.layoutResolver = layoutResolver ?? (() => null);
    this.log = log ?? (() => {});
    this.proc = null;
    this.state = 'idle'; // idle | starting | ready | dead
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.buffer = '';
    this.nextId = 1;
    this.tools = new Set();
    this.projectsCache = [];
    this.lastStartAttempt = 0;
    this.startPromise = null;
    this.serverInfo = null;
    this.queue = Promise.resolve(); // serialization chain for tools/call
  }

  /** Resolve when the MCP session is ready; starts the child on first use. */
  async ensureReady() {
    if (this.state === 'ready') return;
    if (this.state === 'starting' && this.startPromise) return this.startPromise;

    const now = Date.now();
    if (this.state === 'dead' && now - this.lastStartAttempt < RESTART_BACKOFF_MS) {
      throw new IdeError(ERROR_CODES.IDE_CRASHED,
        `IntelliJ IDEA MCP 子进程刚退出（冷却中，${Math.ceil((RESTART_BACKOFF_MS - (now - this.lastStartAttempt)) / 1000)}s 后可重试）`);
    }
    this.lastStartAttempt = now;
    this.state = 'starting';
    this.startPromise = this._start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async _start() {
    const layout = this.layoutResolver();
    if (!layout) {
      this.state = 'dead';
      throw new IdeError(ERROR_CODES.JAVA_MISSING,
        `未找到 IntelliJ IDEA 安装布局（请在 DSH 设置 → 在 IDEA 中打开 中配置 ideaHome，指向 IDEA 安装根目录）`);
    }
    this.buffer = '';
    this.pending.clear();
    this.serverInfo = null;
    this.tools.clear();

    let proc;
    try {
      proc = spawn(layout.java, ['-classpath', layout.classpath, MAIN], {
        env: { ...process.env, ...ENV },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.state = 'dead';
      throw new IdeError(ERROR_CODES.SPAWN_FAILED, `无法启动 IDEA MCP 进程：${err.message}`);
    }
    this.proc = proc;
    this.log(`[open-in-ide] spawned java pid=${proc.pid}`);

    proc.stdout.on('data', (chunk) => this._onData(chunk.toString()));
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.log(`[open-in-ide] java stderr: ${text.slice(0, 500)}`);
    });
    proc.on('error', (err) => {
      this.log(`[open-in-ide] proc error: ${err.message}`);
      this._die();
    });
    proc.on('exit', (code, signal) => {
      this.log(`[open-in-ide] java exited code=${code} signal=${signal}`);
      this._die();
    });

    // initialize
    const initId = this._nextId();
    const initPromise = this._request(initId, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-sidebar-open-in-ide', version: '0.1.0' },
    });
    const initTimer = setTimeout(() => {
      this._rejectAll(new IdeError(ERROR_CODES.TIMEOUT, 'IDEA MCP initialize 超时（12s）'));
      this._die();
    }, INIT_TIMEOUT_MS);
    try {
      const res = await initPromise;
      this.serverInfo = res.serverInfo ?? res.result?.serverInfo ?? null;
      this.log(`[open-in-ide] MCP ready: ${JSON.stringify(this.serverInfo)}`);
    } catch (err) {
      this.state = 'dead';
      throw err instanceof IdeError ? err
        : new IdeError(ERROR_CODES.IDE_UNAVAILABLE, `IDEA MCP 初始化失败：${err.message}`);
    } finally {
      clearTimeout(initTimer);
    }
    if (this.proc !== proc) throw new IdeError(ERROR_CODES.IDE_CRASHED, 'IDEA MCP 进程在初始化期间退出');

    // notifications/initialized (fire and forget)
    this._send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    // tools/list → cache tool names
    // NOTE: use _request directly here — this.call() would deadlock: state is
    // still 'starting' while _start is the very promise ensureReady waits on.
    try {
      const toolsRes = await this._request(this._nextId(), 'tools/list', {});
      this.tools = new Set((toolsRes.tools ?? []).map((t) => t.name));
      this.log(`[open-in-ide] tools: ${[...this.tools].join(', ')}`);
    } catch (err) {
      this.log(`[open-in-ide] tools/list failed: ${err.message}`);
    }

    this.state = 'ready';
  }

  _die() {
    const proc = this.proc;
    this.proc = null;
    this.state = 'dead';
    this._rejectAll(new IdeError(ERROR_CODES.IDE_CRASHED, 'IntelliJ IDEA MCP 进程已退出'));
    if (proc && proc.exitCode === null && !proc.killed) {
      try { proc.kill(); } catch { /* already gone */ }
    }
  }

  _rejectAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  _onData(text) {
    this.buffer += text;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log(`[open-in-ide] non-JSON line: ${line.slice(0, 300)}`);
        continue;
      }
      if (msg && typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new IdeError(ERROR_CODES.IDE_CALL_FAILED,
          `IDEA MCP 返回错误：${msg.error.message ?? JSON.stringify(msg.error)}`));
        else resolve(msg.result ?? {});
      }
    }
  }

  _nextId() { return this.nextId++; }

  _send(obj) {
    if (!this.proc || this.proc.stdin.destroyed) {
      throw new IdeError(ERROR_CODES.IDE_CRASHED, 'IDEA MCP 子进程不可写');
    }
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _request(id, method, params) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new IdeError(ERROR_CODES.TIMEOUT, `IDEA MCP 调用超时（${method}）`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Serialized tools/call — one MCP call at a time (JetBrains side is single-shot). */
  async call(method, params) {
    if (this.state !== 'ready') await this.ensureReady();
    return this._request(this._nextId(), method, params);
  }

  /** tools/call, serialized — one MCP call in flight at a time (JetBrains side is single-shot). */
  call(method, params) {
    if (this.state !== 'ready') return this.ensureReady().then(() => this.call(method, params));
    const run = this.queue.then(() => this._request(this._nextId(), method, params));
    this.queue = run.catch(() => {});
    return run;
  }

  async getProjects() {
    const res = await this.call('tools/call', { name: 'get_repositories', arguments: {} });
    const projects = extractProjects(res);
    if (projects) this.projectsCache = projects;
    return projects ?? this.projectsCache;
  }

  async openFile(projectRoot, relativePath) {
    const res = await this.call('tools/call', {
      name: 'open_file_in_editor',
      arguments: { filePath: relativePath, projectPath: projectRoot },
    });
    if (res.isError) {
      const message = extractErrorMessage(res);
      throw new IdeError(ERROR_CODES.IDE_CALL_FAILED,
        `IDEA 拒绝打开文件：${message}`, { project: projectRoot, relative: relativePath });
    }
    return { project: projectRoot, relative: relativePath };
  }

  dispose() {
    this._rejectAll(new IdeError(ERROR_CODES.IDE_CRASHED, '插件卸载'));
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
    this.state = 'dead';
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function extractProjects(res) {
  const sc = res?.structuredContent;
  if (sc && Array.isArray(sc.projects)) {
    const paths = sc.projects.map((p) => p.path).filter(Boolean);
    if (paths.length) return paths;
  }
  const text = res?.content?.[0]?.text;
  if (typeof text === 'string') {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.projects)) {
        const paths = parsed.projects.map((p) => p.path).filter(Boolean);
        if (paths.length) return paths;
      }
    } catch { /* not JSON — ignore */ }
  }
  return null;
}

function extractErrorMessage(res) {
  const sc = res?.structuredContent;
  if (sc && typeof sc.message === 'string' && sc.message) return sc.message;
  const text = res?.content?.[0]?.text;
  if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 300);
  return JSON.stringify(res).slice(0, 300);
}

function collectBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new IdeError(ERROR_CODES.BAD_REQUEST, '请求体过大（上限 1MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(new IdeError(ERROR_CODES.BAD_REQUEST, `读取请求失败：${err.message}`)));
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function errJson(res, status, err) {
  json(res, status, {
    ok: false,
    error: err.code ?? 'INTERNAL',
    message: err.message ?? String(err),
    ...(err.extra ? { detail: err.extra } : {}),
  });
}

/**
 * Longest-prefix match of `absPath` against open project roots.
 * Returns the matching root or null.
 */
function matchProject(projects, absPath) {
  let best = null;
  for (const root of projects) {
    const r = root.endsWith('/') ? root : root + '/';
    if (absPath === root || absPath.startsWith(r)) {
      if (best === null || root.length > best.length) best = root;
    }
  }
  return best;
}

/**
 * Resolve the git work-tree root containing `cwd` (git discovers upward from
 * the -C directory, so any depth inside the repo works). Null when `cwd` is
 * not inside any repository.
 */
function findGitRoot(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const root = String(stdout ?? '').trim();
      resolve(root || null);
    });
  });
}

/**
 * Bring IntelliJ IDEA to the foreground (best-effort; failures are logged,
 * never fail the request):
 *   macOS   : `open -a` activates the already-running instance
 *   Windows : PowerShell AppActivate brings the window to the front
 *   Linux   : try wmctrl, then xdotool
 */
function activateIde(log) {
  const run = (cmd, args, next) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => {
      if (err && next) next(err);
      else if (err) log(`[open-in-ide] activate failed (${cmd}): ${err.message}`);
      else log('[open-in-ide] IntelliJ IDEA activated');
    });
  };
  if (process.platform === 'darwin') {
    run('open', ['-a', 'IntelliJ IDEA']);
  } else if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', "(New-Object -ComObject WScript.Shell).AppActivate('IntelliJ IDEA')"]);
  } else {
    run('wmctrl', ['-a', 'IntelliJ IDEA'], () => {
      run('xdotool', ['search', '--name', 'IntelliJ IDEA', 'windowactivate'], (err) => {
        log(`[open-in-ide] activate failed (no wmctrl/xdotool): ${err.message}`);
      });
    });
  }
}

// ── plugin ───────────────────────────────────────────────────────────────────
export function apply(ctx, config) {
  // 设置页（settings.yaml 的 open-in-ide 段）优先于 patch config：
  // 用户写入 ideaHome 后立即成为权威来源，未写入时回退到 config.ideaHome。
  let settingsIdeaHome = null; // '' / null → 未配置
  let settingsUpdate = null;   // (patch, expectedRevision) => Promise，settings 服务不可用时为 null

  ctx.inject(['settings'], (sctx) => {
    const ns = settingsNamespace(PREFS_NS);
    const scope = sctx.settings.register(ns, IdeaPrefsSchema);
    const sync = () => {
      settingsIdeaHome = scope.get()?.ideaHome?.trim() || null;
    };
    sync();
    scope.watch(sync);
    settingsUpdate = (patch, expectedRevision) =>
      sctx.settings.update(ns, patch, expectedRevision);
  });

  /** 当前生效的布局：设置页 ideaHome → patch config → 平台默认。 */
  const resolveLayoutNow = () => resolveLayout(settingsIdeaHome ? { ideaHome: settingsIdeaHome } : config);

  const client = new JetBrainsMcpClient({
    layoutResolver: resolveLayoutNow,
    log: (m) => ctx.logger?.info ? ctx.logger.info(m) : console.log(m),
  });

  const handleOpen = async (req, res) => {
    try {
      let body;
      try {
        body = JSON.parse(await collectBody(req));
      } catch (err) {
        if (err instanceof IdeError) throw err;
        throw new IdeError(ERROR_CODES.BAD_REQUEST, `请求体不是合法 JSON：${err.message}`);
      }
      const rawPath = typeof body?.path === 'string' ? body.path.trim() : '';
      if (!rawPath) throw new IdeError(ERROR_CODES.BAD_REQUEST, '缺少 path 字段');
      let path = rawPath;
      if (!path.startsWith('/')) {
        // Repo-relative path (sidebar source-control rows): resolve against the
        // git work-tree root of the session's working directory.
        const cwd = typeof body?.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : null;
        if (!cwd) throw new IdeError(ERROR_CODES.BAD_REQUEST, '相对路径需要 cwd 字段（会话工作目录）');
        const root = await findGitRoot(cwd);
        if (!root) throw new IdeError(ERROR_CODES.GIT_ROOT_NOT_FOUND,
          `会话目录不在任何 Git 仓库中：${cwd}`);
        path = joinPath(root, path);
      }

      try {
        await client.ensureReady();
      } catch (err) {
        throw err instanceof IdeError ? err
          : new IdeError(ERROR_CODES.IDE_UNAVAILABLE, `IDEA MCP 不可用：${err.message}`);
      }

      if (!fs.existsSync(path)) {
        throw new IdeError(ERROR_CODES.NOT_FOUND, `文件不存在：${path}`);
      }

      if (!client.tools.has('get_repositories') || !client.tools.has('open_file_in_editor')) {
        throw new IdeError(ERROR_CODES.IDE_UNAVAILABLE,
          `IDEA MCP 工具不完整（缺 get_repositories / open_file_in_editor）——请确认 IDE 内打开了项目`);
      }

      let projects;
      try {
        projects = await client.getProjects();
      } catch (err) {
        throw err instanceof IdeError ? err
          : new IdeError(ERROR_CODES.IDE_CALL_FAILED, `获取项目列表失败：${err.message}`);
      }
      if (!projects || projects.length === 0) {
        throw new IdeError(ERROR_CODES.NOT_IN_PROJECT, 'IDEA 中没有任何已打开的项目', { projects: [] });
      }

      const root = matchProject(projects, path);
      if (root === null) {
        throw new IdeError(ERROR_CODES.NOT_IN_PROJECT,
          `文件不在任何已打开的 IDEA 项目中`, { projects });
      }

      const relative = root.length === path.length ? path.split('/').pop() : path.slice(root.length + 1);
      const result = await client.openFile(root, relative);
      activateIde(client.log.bind(client)); // jump to the IDE window after opening
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      errJson(res, err instanceof IdeError && [ERROR_CODES.NOT_FOUND, ERROR_CODES.NOT_IN_PROJECT, ERROR_CODES.BAD_REQUEST, ERROR_CODES.GIT_ROOT_NOT_FOUND].includes(err.code) ? 404 : 503, err);
    }
  };

  const handleStatus = async (req, res) => {
    const layout = resolveLayoutNow();
    json(res, 200, {
      ok: true,
      ide: client.state === 'ready',
      java: Boolean(layout),
      layoutHome: layout?.home ?? null,
      spawnedPid: client.proc?.pid ?? null,
      serverInfo: client.serverInfo,
      projects: client.projectsCache,
      tools: [...client.tools],
    });
  };

  // 设置页读写：GET-ish {action:'get'} 读当前值 + 布局探测结果；
  // {action:'update', ideaHome, expectedRevision} 持久化到 settings.yaml（revision 防冲突）。
  const handleSettings = async (req, res) => {
    try {
      let body;
      try {
        body = JSON.parse(await collectBody(req));
      } catch (err) {
        if (err instanceof IdeError) throw err;
        throw new IdeError(ERROR_CODES.BAD_REQUEST, `请求体不是合法 JSON：${err.message}`);
      }
      if (body?.action === 'update') {
        if (!settingsUpdate) {
          throw new IdeError(ERROR_CODES.BAD_REQUEST, '设置服务不可用（settings 未注册）');
        }
        const raw = typeof body.ideaHome === 'string' ? body.ideaHome.trim() : '';
        try {
          await settingsUpdate({ ideaHome: raw },
            typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined);
        } catch (err) {
          if (err instanceof SettingsConflictError) {
            throw new IdeError('SETTINGS_CONFLICT', `设置已被其他窗口修改，请刷新设置页后重试（${err.message}）`);
          }
          throw err;
        }
        const resolved = resolveLayoutNow();
        json(res, 200, {
          ok: true,
          ideaHome: raw,
          resolved: resolved?.home ?? null,
          java: Boolean(resolved),
        });
        return;
      }
      // action get（默认）
      const layout = resolveLayoutNow();
      json(res, 200, {
        ok: true,
        ideaHome: settingsIdeaHome ?? (typeof config?.ideaHome === 'string' ? config.ideaHome.trim() : ''),
        resolved: layout?.home ?? null,
        java: Boolean(layout),
        defaultHome: DEFAULT_IDEA_HOME,
        configHome: typeof config?.ideaHome === 'string' ? config.ideaHome.trim() : '',
      });
    } catch (err) {
      errJson(res, err instanceof IdeError && err.code === 'SETTINGS_CONFLICT' ? 409 : 503, err);
    }
  };

  // ctx.effect 语义（同 dsh-mcp-client lib/index.js:765-783）：回调立即执行注册副作用，
  // 返回的 cleanup 在插件卸载时调用。绝不能把 disposer 当回调传入（路由会注册即销毁）。
  ctx.effect(() => {
    const webServer = ctx.webServer ?? ctx.get('webServer');
    const disposers = [
      webServer.register({ kind: 'exact', path: '/open-in-ide', handler: handleOpen }),
      webServer.register({ kind: 'exact', path: '/open-in-ide/status', handler: handleStatus }),
      webServer.register({ kind: 'exact', path: '/open-in-ide/settings', handler: handleSettings }),
    ];
    console.log('[open-in-ide] routes registered: POST /open-in-ide, GET /open-in-ide/status, POST /open-in-ide/settings');
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* ignore */ }
      }
      client.dispose();
      console.log('[open-in-ide] disposed');
    };
  }, 'dsh-sidebar-open-in-ide: routes + MCP client');
}
