import type { CommandContext, CommandResult } from './router.js';
import { scanAllSkills, formatSkillList, findSkill, type SkillInfo } from '../claude/skill-scanner.js';
import { loadConfig, saveConfig } from '../config.js';
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Directories that are off-limits for /cwd
const BLOCKED_PATH_PREFIXES = ['/etc', '/sys', '/proc', '/dev', '/boot', '/root', '/private/etc'];

function validateCwdPath(inputPath: string): { valid: boolean; reason?: string; resolved?: string } {
  const expanded = inputPath.replace(/^~/, homedir());
  const resolved = resolve(expanded);

  if (!isAbsolute(resolved)) {
    return { valid: false, reason: '路径必须是绝对路径' };
  }

  if (!existsSync(resolved)) {
    return { valid: false, reason: `路径不存在: ${resolved}` };
  }

  if (!statSync(resolved).isDirectory()) {
    return { valid: false, reason: `路径不是目录: ${resolved}` };
  }

  // Resolve symlinks to get the real path, then check against blocked prefixes
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    return { valid: false, reason: `无法解析路径: ${resolved}` };
  }

  for (const blocked of BLOCKED_PATH_PREFIXES) {
    if (real === blocked || real.startsWith(blocked + '/')) {
      return { valid: false, reason: `禁止访问系统目录: ${blocked}` };
    }
  }

  return { valid: true, resolved: real };
}

const HELP_TEXT = ` Commands

 /clear     清除会话
 /reset     完全重置
 /status    会话状态
 /compact   压缩上下文
 /history   对话记录
 /undo      撤销消息
 /cwd       切换目录
 /model     切换模型
 /perm      权限模式
 /prompt    系统提示词
 /skills    已安装 Skill
 /provider  切换模型源
 /restart   重启服务
 /<skill>   触发 Skill

发任意文字与 Claude 对话`;

// 缓存 skill 列表，避免每次命令都扫描文件系统
let cachedSkills: SkillInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒

function getSkills(): SkillInfo[] {
  const now = Date.now();
  if (!cachedSkills || now - lastScanTime > CACHE_TTL) {
    cachedSkills = scanAllSkills();
    lastScanTime = now;
  }
  return cachedSkills;
}

/** 清除缓存，用于 /skills 命令强制刷新 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  ctx.rejectPendingPermission?.();
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '↻ 会话已清除', handled: true };
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `📂 ${ctx.session.workingDirectory}`, handled: true };
  }
  const check = validateCwdPath(args);
  if (!check.valid) {
    return { reply: `✗ ${check.reason}`, handled: true };
  }
  ctx.updateSession({ workingDirectory: check.resolved! });
  return { reply: `📂 ${check.resolved}`, handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `模型: ${ctx.session.model ?? '默认'}`, handled: true };
  }
  ctx.updateSession({ model: args });
  return { reply: `✓ 模型 → ${args}`, handled: true };
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
const PERMISSION_LABELS: Record<string, string> = {
  default: '🔒 默认 · 逐次审批',
  acceptEdits: '✏️ 编辑免审 · 其他审批',
  plan: '👁 只读 · 禁止写操作',
  auto: '⚡ 全自动（危险）',
};
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  default: '每次工具使用需手动审批',
  acceptEdits: '自动批准文件编辑，其他需审批',
  plan: '只读模式，不允许任何工具',
  auto: '自动批准所有工具（危险模式）',
};

export function handlePermission(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    const current = ctx.session.permissionMode ?? 'default';
    const lines = [
      PERMISSION_LABELS[current],
      '',
      ...PERMISSION_MODES.map(m => `  /perm ${m.padEnd(14)}${PERMISSION_LABELS[m]}`),
    ];
    return { reply: lines.join('\n'), handled: true };
  }
  const mode = args.trim();
  if (!PERMISSION_MODES.includes(mode as any)) {
    return {
      reply: `✗ 未知模式\n可用: ${PERMISSION_MODES.join(', ')}`,
      handled: true,
    };
  }
  if (mode === 'auto') {
    return {
      reply: '⚠ auto 模式将自动批准所有工具调用\n如确认，发送 /perm auto confirm',
      handled: true,
    };
  }
  ctx.updateSession({ permissionMode: mode as any });
  return { reply: PERMISSION_LABELS[mode], handled: true };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const mode = s.permissionMode ?? 'default';
  const cwd = s.workingDirectory.split('/').slice(-2).join('/');
  const lines = [
    `── Status ──────`,
    `📂 ${cwd}`,
    `🤖 ${s.model ?? '默认'}`,
    `🔐 ${mode}`,
    `📝 ${s.chatHistory?.length ?? 0} 条记录`,
    `──`,
    `状态: ${s.state}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

export function handleSkills(args: string): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: '无已安装 Skill', handled: true };
  }

  const showFull = args.trim().toLowerCase() === 'full';
  if (showFull) {
    const lines = skills.map(s => `/${s.name}\n   ${s.description}`);
    return { reply: `── Skill (${skills.length}) ──\n\n${lines.join('\n\n')}`, handled: true };
  }
  const lines = skills.map(s => `/${s.name}`);
  return { reply: `── Skill (${skills.length}) ──\n\n${lines.join('\n')}\n\n/skills full 查看描述`, handled: true };
}

const MAX_HISTORY_LIMIT = 100;

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: '用法: /history [数量]', handled: true };
  }
  const effectiveLimit = Math.min(limit, MAX_HISTORY_LIMIT);

  const historyText = ctx.getChatHistoryText?.(effectiveLimit) || '暂无记录';

  return { reply: `── 最近 ${effectiveLimit} 条 ──\n\n${historyText}`, handled: true };
}

/** 完全重置会话（包括工作目录等设置） */
export function handleReset(ctx: CommandContext): CommandResult {
  ctx.rejectPendingPermission?.();
  const newSession = ctx.clearSession();
  newSession.workingDirectory = process.cwd();
  newSession.model = undefined;
  newSession.permissionMode = undefined;
  Object.assign(ctx.session, newSession);
  return { reply: '↻ 已完全重置', handled: true };
}

/** 压缩上下文 */
export function handleCompact(ctx: CommandContext): CommandResult {
  const currentSessionId = ctx.session.sdkSessionId;
  if (!currentSessionId) {
    return { reply: '无活动会话，无需压缩', handled: true };
  }
  ctx.updateSession({
    previousSdkSessionId: currentSessionId,
    sdkSessionId: undefined,
  });
  return {
    reply: '✓ 上下文已压缩\n下次消息将开始新会话',
    handled: true,
  };
}

/** 撤销最近 N 条对话 */
export function handleUndo(ctx: CommandContext, args: string): CommandResult {
  const count = args ? parseInt(args, 10) : 1;
  if (isNaN(count) || count <= 0) {
    return { reply: '用法: /undo [数量]', handled: true };
  }
  const history = ctx.session.chatHistory || [];
  if (history.length === 0) {
    return { reply: '无对话可撤销', handled: true };
  }
  const actualCount = Math.min(count, history.length);
  ctx.session.chatHistory = history.slice(0, -actualCount);
  ctx.updateSession({ chatHistory: ctx.session.chatHistory });
  return { reply: `↩ 撤销 ${actualCount} 条`, handled: true };
}

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const version = pkg.version || 'unknown';
    return { reply: `v${version}`, handled: true };
  } catch {
    return { reply: 'v?', handled: true };
  }
}

export function handlePrompt(_ctx: CommandContext, args: string): CommandResult {
  const config = loadConfig();
  if (!args) {
    const current = config.systemPrompt;
    if (current) {
      return { reply: `📝 ${current}\n\n/prompt <内容> 设置\n/prompt clear 清除`, handled: true };
    }
    return { reply: '暂无提示词\n/prompt <内容> 设置', handled: true };
  }
  if (args.trim().toLowerCase() === 'clear') {
    config.systemPrompt = undefined;
    saveConfig(config);
    return { reply: '✓ 提示词已清除', handled: true };
  }
  config.systemPrompt = args.trim();
  saveConfig(config);
  return { reply: `✓ ${config.systemPrompt}`, handled: true };
}

/** List and switch cc-switch providers */
export function handleProvider(_ctx: CommandContext, args: string): CommandResult {
  const dbPath = join(homedir(), '.cc-switch', 'cc-switch.db');
  if (!existsSync(dbPath)) {
    return { reply: 'cc-switch 未安装\nhttps://github.com/anthropics/cc-switch', handled: true };
  }

  try {
    // Use execFileSync to prevent shell injection — arguments are passed as array, not interpolated into shell string
    const opts = { encoding: 'utf-8' as const };

    // Read current provider from cc-switch settings
    const currentProviderId = execFileSync('sqlite3', [dbPath, "SELECT value FROM settings WHERE key='currentProviderClaude';"], opts).trim();

    // Read all providers
    const rows = execFileSync('sqlite3', ['-separator', '|', dbPath, "SELECT id, name FROM providers WHERE app_type='claude';"], opts).trim();

    if (!rows) {
      return { reply: 'cc-switch 无可用 provider', handled: true };
    }

    const providers = rows.split('\n').map(line => {
      const [id, name] = line.split('|');
      return { id, name };
    });

    // No args: list providers
    if (!args.trim()) {
      const lines = providers.map(p => {
        const marker = p.id === currentProviderId ? ' ●' : '  ';
        return `${marker} /provider ${p.name}`;
      });
      return { reply: `── Provider ──\n\n${lines.join('\n')}`, handled: true };
    }

    // Switch by name
    const target = providers.find(p => p.name === args.trim() || p.id === args.trim());
    if (!target) {
      const names = providers.map(p => p.name).join(', ');
      return { reply: `✗ 未找到: ${args.trim()}\n可用: ${names}`, handled: true };
    }

    // Update cc-switch settings — target.id comes from DB but we use parameterized args, safe from injection
    execFileSync('sqlite3', [dbPath, `UPDATE settings SET value='${target.id}' WHERE key='currentProviderClaude';`], opts);

    // Read the provider's settings_config and write to ~/.claude/settings.json
    const configJson = execFileSync('sqlite3', [dbPath, `SELECT settings_config FROM providers WHERE id='${target.id}' AND app_type='claude';`], opts).trim();

    if (configJson) {
      const claudeSettingsPath = join(homedir(), '.claude', 'settings.json');
      writeFileSync(claudeSettingsPath, JSON.stringify(JSON.parse(configJson), null, 2), 'utf-8');
    }

    return { reply: `✓ 已切换 → ${target.name}\n自动重启中...`, handled: true, restart: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { reply: `✗ 切换失败: ${msg}`, handled: true };
  }
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const skills = getSkills();
  const skill = findSkill(skills, cmd);

  if (skill) {
    const prompt = args ? `Use the ${skill.name} skill: ${args}` : `Use the ${skill.name} skill`;
    return { handled: true, claudePrompt: prompt };
  }

  return {
    handled: true,
    reply: `未找到 /${cmd}\n/help 查看命令`,
  };
}
