import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

test('IntelliJ IDEA MCP 64342 端口在线性与可用性验证', async () => {
  const isOnline = await new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(64342, '127.0.0.1');
  });

  assert.equal(isOnline, true, '本地 IntelliJ IDEA MCP 服务（端口 64342）必须处于在线监听状态');
});

test('MCP Streamable HTTP /stream 端点连通性测试', async () => {
  const res = await fetch('http://127.0.0.1:64342/stream', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });

  assert.equal(res.status, 200, 'MCP 握手必须返回 200 OK');
  const sessionId = res.headers.get('mcp-session-id');
  assert.ok(sessionId, '返回头必须包含 mcp-session-id');
});

test('MCP open_file_in_editor 真实工程文件打开测试', async () => {
  const projectPath = '/Users/eee/work/zrsj/shian-client-service';
  const filePath = 'pom.xml';

  const initRes = await fetch('http://127.0.0.1:64342/stream', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'IJ_MCP_SERVER_PROJECT_PATH': projectPath,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'init-2',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });

  const sessionId = initRes.headers.get('mcp-session-id');
  assert.ok(sessionId);

  // 调用 open_file_in_editor
  const callRes = await fetch('http://127.0.0.1:64342/stream', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
      'IJ_MCP_SERVER_PROJECT_PATH': projectPath,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'call-1',
      method: 'tools/call',
      params: {
        name: 'open_file_in_editor',
        arguments: {
          filePath: filePath,
          projectPath: projectPath,
        },
      },
    }),
  });

  assert.equal(callRes.status, 200);
  const data = await callRes.json();
  assert.equal(data.result?.isError, false, '调用 open_file_in_editor 必须成功且 isError 为 false');
  assert.ok(data.result?.content?.[0]?.text?.includes('success'), '返回文本应包含 success');
});

test('原生系统级兜底打开命令测试 (macOS open -a "IntelliJ IDEA")', async () => {
  const { execFile } = await import('node:child_process');
  const opened = await new Promise((resolve) => {
    execFile('open', ['-a', 'IntelliJ IDEA', '/Users/eee/work/zr/pri/TODO.md'], (err) => {
      resolve(!err);
    });
  });
  assert.equal(opened, true, '系统级唤醒 IDEA 打开外部文件必须成功');
});

