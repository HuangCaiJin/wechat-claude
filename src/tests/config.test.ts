import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, saveConfig } from '../config.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Override DATA_DIR via env for isolation
const TEST_DIR = join(tmpdir(), `wcc-test-${process.pid}`);
process.env['WCC_DATA_DIR'] = TEST_DIR;
mkdirSync(TEST_DIR, { recursive: true });

const CONFIG_PATH = join(TEST_DIR, 'config.env');

describe('config', () => {
  it('loadConfig 文件不存在时返回默认值', () => {
    try { rmSync(CONFIG_PATH); } catch {}
    const cfg = loadConfig();
    assert.ok(cfg.workingDirectory);
    assert.equal(cfg.model, undefined);
  });

  it('saveConfig + loadConfig 往返一致', () => {
    saveConfig({ workingDirectory: '/tmp/test', model: 'claude-opus-4-6', permissionMode: 'acceptEdits' });
    const cfg = loadConfig();
    assert.equal(cfg.workingDirectory, '/tmp/test');
    assert.equal(cfg.model, 'claude-opus-4-6');
    assert.equal(cfg.permissionMode, 'acceptEdits');
  });

  it('systemPrompt 多行正确编解码', () => {
    const prompt = 'line1\nline2\nline3';
    saveConfig({ workingDirectory: '/tmp', systemPrompt: prompt });
    const cfg = loadConfig();
    assert.equal(cfg.systemPrompt, prompt);
  });

  it('无效 permissionMode 被忽略', () => {
    writeFileSync(CONFIG_PATH, 'workingDirectory=/tmp\npermissionMode=invalid\n');
    const cfg = loadConfig();
    assert.equal(cfg.permissionMode, undefined);
  });
});
