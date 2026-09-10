/**
 * dsh-sidebar-open-in-ide — Node 后端服务
 *
 * 通过官方 Streamable HTTP MCP 协议直连 IntelliJ IDEA 本地服务（默认端口 64342），
 * 彻底抛弃历史重量级 Java 子进程与 Jar 包依赖，提供高可用、低延迟的 IDE 交互。
 *
 * 核心对外暴露的 HTTP 路由：
 *   POST /open-in-ide            { "path": "<绝对路径或相对路径>", "cwd": "<会话工作区目录>" }
 *   GET  /open-in-ide/status     探查 IDEA MCP 连通性、就绪状态及已打开的项目列表
 *   POST /open-in-ide/settings   设置项读取与保存（兼容历史配置）
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { join as joinPath } from 'node:path';
import z from 'schemastery';
import { SettingsConflictError } from '@deepseek-ai/dsh-settings';

export const name = 'dsh-sidebar-open-in-ide';
export const inject = ['webServer'];

/** 用户配置命名空间 */
const PREFS_NS = 'open-in-ide';

/** 用户偏好设置模式定义 */
const IdeaPrefsSchema = z.object({
  /** IntelliJ IDEA MCP 端口，默认为 64342 */
  port: z.number().default(64342),
  /** 兼容历史路径字段（已无需指定 JBR 路径） */
  ideaHome: z.string().default(''),
});

/** 默认配置常量 */
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 64342;
const TCP_PROBE_TIMEOUT_MS = 200;
const MCP_CALL_TIMEOUT_MS = 25_000;
const HEADER_PROJECT_PATH = 'IJ_MCP_SERVER_PROJECT_PATH';

/** 统一错误码定义 */
export const ERROR_CODES = {
  IDE_UNAVAILABLE: 'IDE_UNAVAILABLE',
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  NOT_IN_PROJECT: 'NOT_IN_PROJECT',
  IDE_CALL_FAILED: 'IDE_CALL_FAILED',
  TIMEOUT: 'TIMEOUT',
  GIT_ROOT_NOT_FOUND: 'GIT_ROOT_NOT_FOUND',
  // 兼容历史错误码
  JAVA_MISSING: 'JAVA_MISSING',
  SPAWN_FAILED: 'SPAWN_FAILED',
  IDE_CRASHED: 'IDE_CRASHED',
};

/** 自定义业务异常类 */
class IdeError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/** 动态导入辅助函数 */
async function dynamicImport(specifier) {
  return import(/* @vite-ignore */ specifier);
}

/** MCP SDK 导出类缓存 */
let cachedSdk = null;

/**
 * 跨环境动态加载官方 MCP SDK 类
 * @returns {Promise<{Client: any, StreamableHTTPClientTransport: any}>}
 */
async function loadOfficialMcpSdk() {
  if (cachedSdk) return cachedSdk;

  const candidatePaths = [
    '@modelcontextprotocol/sdk/client/index.js',
    '@modelcontextprotocol/sdk/dist/esm/client/index.js',
    'file:///Users/eee/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js',
    'file:///Users/eee/.pi/agent/npm/node_modules/@modelcontextprotocol/client/dist/index.mjs',
  ];

  for (const clientPath of candidatePaths) {
    try {
      let clientMod = await dynamicImport(clientPath);
      let transportPath = clientPath.includes('/index.')
        ? clientPath.replace('/index.', '/streamableHttp.')
        : clientPath;
      let transportMod = await dynamicImport(transportPath);

      if (clientMod?.Client && transportMod?.StreamableHTTPClientTransport) {
        cachedSdk = {
          Client: clientMod.Client,
          StreamableHTTPClientTransport: transportMod.StreamableHTTPClientTransport,
        };
        return cachedSdk;
      }
    } catch {
      // 继续尝试下一个候选路径
    }
  }

  throw new IdeError(
    ERROR_CODES.IDE_UNAVAILABLE,
    '未检测到官方 MCP SDK 依赖，请确保 DSH 环境完备'
  );
}

/**
 * 快速 TCP 端口探针（防止服务未开启时 HTTP 握手卡死）
 * @param {number} port 目标端口
 * @param {string} host 目标主机
 * @param {number} timeoutMs 超时毫秒数
 * @returns {Promise<boolean>}
 */
function probeTcp(port, host = DEFAULT_HOST, timeoutMs = TCP_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * 基于官方 Streamable HTTP MCP 协议的 IntelliJ IDEA 通信客户端
 */
class IdeaMcpClient {
  constructor({ portGetter, log } = {}) {
    this.portGetter = portGetter ?? (() => DEFAULT_PORT);
    this.log = log ?? console.log;
    this.clientPool = new Map(); // projectRoot -> { client, transport }
    this.projectsCache = [];
    this.toolsCache = [];
    this.lastProbeTime = 0;
    this.isOnline = false;
  }

  /** 获取当前配置的端口 */
  getPort() {
    return this.portGetter() || DEFAULT_PORT;
  }

  /**
   * 探查 IDEA MCP 端口连通性
   * @returns {Promise<boolean>}
   */
  async checkOnline() {
    const port = this.getPort();
    const online = await probeTcp(port, DEFAULT_HOST, TCP_PROBE_TIMEOUT_MS);
    this.isOnline = online;
    this.lastProbeTime = Date.now();
    if (!online) {
      this.clearPool();
    }
    return online;
  }

  /**
   * 确保 IDEA 在线并可用
   */
  async ensureReady() {
    const online = await this.checkOnline();
    if (!online) {
      throw new IdeError(
        ERROR_CODES.IDE_UNAVAILABLE,
        `IntelliJ IDEA 未运行或 MCP 服务未开启（端口 ${this.getPort()} 无法连接）`
      );
    }
  }

  /**
   * 清理连接池
   */
  clearPool() {
    for (const { client } of this.clientPool.values()) {
      try { client.close(); } catch { /* 忽略 */ }
    }
    this.clientPool.clear();
  }

  /**
   * 获取或复用特定项目路径的 MCP 客户端连接
   * @param {string} projectRoot 项目根路径
   * @returns {Promise<any>}
   */
  async getClientForProject(projectRoot) {
    await this.ensureReady();
    const key = projectRoot || '/';
    const existing = this.clientPool.get(key);
    if (existing) {
      return existing.client;
    }

    const { Client, StreamableHTTPClientTransport } = await loadOfficialMcpSdk();
    const endpoint = new URL(`http://${DEFAULT_HOST}:${this.getPort()}/stream`);

    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers: {
          [HEADER_PROJECT_PATH]: key,
        },
      },
    });

    const client = new Client(
      { name: 'dsh-sidebar-open-in-ide', version: '0.3.0' },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
      this.clientPool.set(key, { client, transport });
      return client;
    } catch (err) {
      try { await client.close(); } catch { /* 忽略 */ }
      throw new IdeError(
        ERROR_CODES.IDE_UNAVAILABLE,
        `连接 IntelliJ IDEA MCP 失败：${err.message}`
      );
    }
  }

  /**
   * 获取所有当前已在 IDEA 中打开的项目目录
   * @returns {Promise<string[]>}
   */
  async getProjects() {
    await this.ensureReady();
    try {
      const client = await this.getClientForProject('/');
      // 故意向根目录请求，IDEA 会在歧义错误或返回值中附带当前打开的所有项目清单
      const res = await client.callTool(
        { name: 'get_repositories', arguments: {} },
        undefined,
        { timeout: 5000 }
      );
      const list = extractProjectsFromMcpResult(res);
      if (list && list.length > 0) {
        this.projectsCache = list;
        return list;
      }
    } catch (err) {
      const list = extractProjectsFromError(err);
      if (list && list.length > 0) {
        this.projectsCache = list;
        return list;
      }
    }
    return this.projectsCache;
  }

  /**
   * 调用 open_file_in_editor 打开指定文件
   * @param {string} projectRoot 项目根路径
   * @param {string} filePath 相对或绝对路径
   * @returns {Promise<{project: string, relative: string}>}
   */
  async openFile(projectRoot, filePath) {
    const client = await this.getClientForProject(projectRoot);
    const relative = filePath.startsWith(projectRoot)
      ? filePath.slice(projectRoot.length).replace(/^[/\\]+/, '')
      : filePath;

    let res;
    try {
      res = await client.callTool(
        {
          name: 'open_file_in_editor',
          arguments: {
            filePath: filePath,
            projectPath: projectRoot,
          },
        },
        undefined,
        { timeout: MCP_CALL_TIMEOUT_MS }
      );
    } catch (err) {
      throw new IdeError(
        ERROR_CODES.IDE_CALL_FAILED,
        `IDEA 拒绝打开文件：${err.message}`,
        { project: projectRoot, relative, filePath }
      );
    }

    if (res?.isError) {
      const text = extractMcpResultText(res);
      throw new IdeError(
        ERROR_CODES.IDE_CALL_FAILED,
        `IDEA 打开失败：${text}`,
        { project: projectRoot, relative, filePath }
      );
    }

    return { project: projectRoot, relative };
  }

  /**
   * 刷新工具列表
   */
  async refreshTools() {
    try {
      const client = await this.getClientForProject('/');
      const res = await client.listTools();
      this.toolsCache = (res?.tools || []).map((t) => t.name);
    } catch {
      // 保持静默
    }
  }

  /**
   * 释放并关闭所有连接
   */
  dispose() {
    this.clearPool();
    this.isOnline = false;
  }
}

/** 从 MCP 返回结果中解析项目列表 */
function extractProjectsFromMcpResult(res) {
  const text = extractMcpResultText(res);
  return parseProjectsJson(text);
}

/** 从错误信息中解析项目列表 */
function extractProjectsFromError(err) {
  const msg = err?.message || String(err);
  return parseProjectsJson(msg);
}

/** 从文本中智能提取 projects JSON */
function parseProjectsJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const match = text.match(/\{"projects":\s*\[.*?\]\}/s);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed.projects)) {
      return parsed.projects.map((p) => p.path).filter(Boolean);
    }
  } catch {
    // 忽略非合法 JSON
  }
  return null;
}

/** 提取 MCP 响应文本 */
function extractMcpResultText(res) {
  if (!res) return '';
  const contentList = Array.isArray(res.content) ? res.content : [];
  return contentList
    .map((c) => (c?.type === 'text' ? String(c.text || '') : JSON.stringify(c)))
    .join('\n')
    .trim();
}

/**
 * 读取 HTTP 请求体
 */
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

/** 统一 JSON 成功响应 */
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 统一 JSON 错误响应 */
function errJson(res, status, err) {
  json(res, status, {
    ok: false,
    error: err.code ?? 'INTERNAL',
    message: err.message ?? String(err),
    ...(err.extra ? { detail: err.extra } : {}),
  });
}

/**
 * 最长前缀匹配：在已打开的 IDEA 项目中寻找与文件最匹配的项目根路径
 */
function matchProject(projects, absPath) {
  if (!Array.isArray(projects) || projects.length === 0) return null;
  let best = null;
  for (const root of projects) {
    const r = root.endsWith('/') ? root : root + '/';
    if (absPath === root || absPath.startsWith(r)) {
      if (best === null || root.length > best.length) {
        best = root;
      }
    }
  }
  return best;
}

/**
 * 获取 cwd 所在的 git 仓库根目录
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
 * 唤醒并聚焦 IntelliJ IDEA 窗口（原生操作系统级，高可靠免挂起）
 */
function activateIde(log) {
  const run = (cmd, args, next) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => {
      if (err && next) next(err);
      else if (err) log?.(`[open-in-ide] activate failed (${cmd}): ${err.message}`);
      else log?.('[open-in-ide] IntelliJ IDEA activated');
    });
  };
  if (process.platform === 'darwin') {
    run('open', ['-a', 'IntelliJ IDEA']);
  } else if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', "(New-Object -ComObject WScript.Shell).AppActivate('IntelliJ IDEA')"]);
  } else {
    run('wmctrl', ['-a', 'IntelliJ IDEA'], () => {
      run('xdotool', ['search', '--name', 'IntelliJ IDEA', 'windowactivate'], (err) => {
        log?.(`[open-in-ide] activate failed (no wmctrl/xdotool): ${err.message}`);
      });
    });
  }
}

/**
 * 操作系统级使用 IntelliJ IDEA 打开文件（用于项目外文件的全域平滑兜底）
 */
function openInIdeViaSystem(targetPath, log) {
  return new Promise((resolve) => {
    const finish = (err) => {
      if (err) log?.(`[open-in-ide] native open failed: ${err.message}`);
      else log?.(`[open-in-ide] native opened via system: ${targetPath}`);
      resolve(!err);
    };
    if (process.platform === 'darwin') {
      execFile('open', ['-a', 'IntelliJ IDEA', targetPath], { timeout: 6000 }, finish);
    } else if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', 'idea64', targetPath], { timeout: 6000 }, finish);
    } else {
      execFile('idea', [targetPath], { timeout: 6000 }, finish);
    }
  });
}

/**
 * Cordis 插件入口
 */
export function apply(ctx, config) {
  let settingsPort = null;
  let settingsUpdate = null;

  ctx.inject(['settings'], (sctx) => {
    const ns = PREFS_NS;
    const scope = sctx.settings.register(ns, IdeaPrefsSchema);
    const sync = () => {
      settingsPort = scope.get()?.port || null;
    };
    sync();
    scope.watch(sync);
    settingsUpdate = (patch, expectedRevision) =>
      sctx.settings.update(ns, patch, expectedRevision);
  });

  const getEffectivePort = () => settingsPort || config?.port || DEFAULT_PORT;

  const client = new IdeaMcpClient({
    portGetter: getEffectivePort,
    log: (m) => (ctx.logger?.info ? ctx.logger.info(m) : console.log(m)),
  });

  /**
   * 处理文件在 IDEA 中打开的主请求
   */
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

      let targetPath = rawPath;
      if (!targetPath.startsWith('/')) {
        // 相对路径解析：优先使用提供的 cwd，再尝试解析 git root
        const cwd = typeof body?.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : null;
        if (!cwd) {
          throw new IdeError(ERROR_CODES.BAD_REQUEST, '相对路径需要 cwd 字段（会话工作目录）');
        }
        const gitRoot = await findGitRoot(cwd);
        const baseRoot = gitRoot || cwd;
        targetPath = joinPath(baseRoot, targetPath);
      }

      if (!fs.existsSync(targetPath)) {
        throw new IdeError(ERROR_CODES.NOT_FOUND, `文件不存在：${targetPath}`);
      }

      // 探查并确保 IDEA MCP 连通
      await client.ensureReady();

      // 获取当前已打开的项目
      let projects = await client.getProjects();
      let matchedRoot = matchProject(projects, targetPath);

      if (!matchedRoot) {
        // 尝试二次刷新项目列表
        projects = await client.getProjects();
        matchedRoot = matchProject(projects, targetPath);
      }

      let result;
      if (matchedRoot) {
        try {
          result = await client.openFile(matchedRoot, targetPath);
          activateIde(client.log.bind(client));
        } catch (mcpErr) {
          // 若 MCP 报 outside of project 错误，平滑兜底系统级打开
          client.log(`[open-in-ide] MCP open failed, falling back to system open: ${mcpErr.message}`);
          await openInIdeViaSystem(targetPath, client.log.bind(client));
          result = { project: matchedRoot, relative: targetPath, mode: 'system-fallback' };
        }
      } else {
        // 文件属于当前未在 IDEA 中打开的项目：使用原生系统级平滑打开
        client.log(`[open-in-ide] File not in open projects, opening via system: ${targetPath}`);
        await openInIdeViaSystem(targetPath, client.log.bind(client));
        result = { project: null, relative: targetPath, mode: 'system-native' };
      }

      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const isClientError = err instanceof IdeError && [
        ERROR_CODES.NOT_FOUND,
        ERROR_CODES.NOT_IN_PROJECT,
        ERROR_CODES.BAD_REQUEST,
        ERROR_CODES.GIT_ROOT_NOT_FOUND,
      ].includes(err.code);
      errJson(res, isClientError ? 404 : 503, err);
    }
  };

  /**
   * 状态探测路由
   */
  const handleStatus = async (req, res) => {
    const isOnline = await client.checkOnline();
    if (isOnline) {
      await client.refreshTools();
      await client.getProjects();
    }

    json(res, 200, {
      ok: true,
      ide: isOnline,
      mcpReady: isOnline,
      port: client.getPort(),
      protocol: 'streamable-http',
      projects: client.projectsCache,
      tools: client.toolsCache,
    });
  };

  /**
   * 设置存取路由
   */
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
          throw new IdeError(ERROR_CODES.BAD_REQUEST, '设置服务不可用');
        }
        const portVal = Number(body.port) || DEFAULT_PORT;
        try {
          await settingsUpdate(
            { port: portVal },
            typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
          );
        } catch (err) {
          if (err instanceof SettingsConflictError) {
            throw new IdeError('SETTINGS_CONFLICT', `设置已被其他窗口修改，请刷新重试（${err.message}）`);
          }
          throw err;
        }
        json(res, 200, { ok: true, port: portVal, protocol: 'streamable-http' });
        return;
      }

      // 获取当前设置
      json(res, 200, {
        ok: true,
        port: getEffectivePort(),
        protocol: 'streamable-http',
        defaultPort: DEFAULT_PORT,
      });
    } catch (err) {
      errJson(res, err instanceof IdeError && err.code === 'SETTINGS_CONFLICT' ? 409 : 503, err);
    }
  };

  ctx.effect(() => {
    const webServer = ctx.webServer ?? ctx.get('webServer');
    const disposers = [
      webServer.register({ kind: 'exact', path: '/open-in-ide', handler: handleOpen }),
      webServer.register({ kind: 'exact', path: '/open-in-ide/status', handler: handleStatus }),
      webServer.register({ kind: 'exact', path: '/open-in-ide/settings', handler: handleSettings }),
    ];
    console.log('[open-in-ide] Streamable HTTP MCP routes registered on webServer');
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* 忽略 */ }
      }
      client.dispose();
      console.log('[open-in-ide] MCP client disposed');
    };
  }, 'dsh-sidebar-open-in-ide: Streamable HTTP MCP routes');
}
