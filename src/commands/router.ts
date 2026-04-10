import type { Session } from '../session.js';
import { findSkill } from '../claude/skill-scanner.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleCwd, handleModel, handlePermission, handleStatus, handleSkills, handleHistory, handleReset, handleCompact, handleUndo, handleVersion, handlePrompt, handleProvider, handleUnknown } from './handlers.js';

export interface CommandContext {
  accountId: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  getChatHistoryText?: (limit?: number) => string;
  rejectPendingPermission?: () => boolean;
  text: string;
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  claudePrompt?: string; // If set, this text should be sent to Claude
  restart?: boolean; // If true, process should exit after sending reply (daemon manager will restart)
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /status   - Show current session info
 *   /skills   - List all installed skills
 *   /<skill>  - Invoke a skill by name (args are forwarded to Claude)
 */
export function routeCommand(ctx: CommandContext): CommandResult {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'clear':
      return handleClear(ctx);
    case 'reset':
      return handleReset(ctx);
    case 'cwd':
      return handleCwd(ctx, args);
    case 'model':
      return handleModel(ctx, args);
    case 'permission':
      // Special case: /permission auto confirm — two-step confirmation
      if (args.trim() === 'auto confirm') {
        ctx.updateSession({ permissionMode: 'auto' });
        return { handled: true, reply: '✅ 权限模式已切换为: auto\n⚠️ 所有工具调用将自动批准，无需手动确认。' };
      }
      return handlePermission(ctx, args);
    case 'prompt':
      return handlePrompt(ctx, args);
    case 'status':
      return handleStatus(ctx);
    case 'skills':
      return handleSkills(args);
    case 'history':
      return handleHistory(ctx, args);
    case 'undo':
      return handleUndo(ctx, args);
    case 'compact':
      return handleCompact(ctx);
    case 'version':
    case 'v':
      return handleVersion();
    case 'provider':
    case 'prov':
      return handleProvider(ctx, args);
    case 'restart':
      return { handled: true, reply: '⟳ 重启中...', restart: true };
    default:
      return handleUnknown(cmd, args);
  }
}
