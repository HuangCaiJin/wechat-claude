import { logger } from './logger.js';
import type { PendingPermission } from './session.js';

const PERMISSION_TIMEOUT = 120_000;
const GRACE_PERIOD = 15_000;

export type OnPermissionTimeout = () => void;

const PERMISSION_HINT_THRESHOLD = 3; // After N approvals in one session, suggest switching mode

export function createPermissionBroker(onTimeout?: OnPermissionTimeout) {
  const pending = new Map<string, PendingPermission>();
  const timedOut = new Map<string, number>(); // accountId → timestamp
  const approvalCounts = new Map<string, number>(); // accountId → count of approvals in current session

  function createPending(accountId: string, toolName: string, toolInput: string): Promise<boolean> {
    // Clear any existing pending permission for this account to prevent timer leak
    const existing = pending.get(accountId);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(accountId);
      existing.resolve(false);
      logger.warn('Replaced existing pending permission', { accountId, toolName: existing.toolName });
    }

    timedOut.delete(accountId); // clear any previous timeout flag
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn('Permission timeout, auto-denied', { accountId, toolName });
        pending.delete(accountId);
        timedOut.set(accountId, Date.now());
        setTimeout(() => timedOut.delete(accountId), GRACE_PERIOD);
        resolve(false);
        try { onTimeout?.(); } catch (err) {
          logger.error('onTimeout callback threw', { error: err instanceof Error ? err.message : String(err) });
        }
      }, PERMISSION_TIMEOUT);

      pending.set(accountId, { toolName, toolInput, resolve, timer });
    });
  }

  function resolvePermission(accountId: string, allowed: boolean): string | null {
    const perm = pending.get(accountId);
    if (!perm) return null;
    clearTimeout(perm.timer);
    pending.delete(accountId);
    perm.resolve(allowed);
    logger.info('Permission resolved', { accountId, toolName: perm.toolName, allowed });

    // Track approval count and generate hint when threshold is reached
    if (allowed) {
      const count = (approvalCounts.get(accountId) ?? 0) + 1;
      approvalCounts.set(accountId, count);
      if (count === PERMISSION_HINT_THRESHOLD) {
        return '💡 提示：已连续审批 ' + count + ' 次。如果嫌烦，可以发送 /permission acceptEdits 自动批准文件编辑，或 /permission auto 全自动。';
      }
    }
    return null;
  }

  function resetApprovalCount(accountId: string): void {
    approvalCounts.delete(accountId);
  }

  function isTimedOut(accountId: string): boolean {
    return timedOut.has(accountId);
  }

  function clearTimedOut(accountId: string): void {
    timedOut.delete(accountId);
  }

  function getPending(accountId: string): PendingPermission | undefined {
    return pending.get(accountId);
  }

  function formatPendingMessage(perm: PendingPermission): string {
    const toolInput = perm.toolInput.length > 300
      ? perm.toolInput.slice(0, 300) + '...'
      : perm.toolInput;
    return [
      `🔒 权限审批 · ${perm.toolName}`,
      `┌──────────────────`,
      `${toolInput}`,
      `└──────────────────`,
      `回复 y 允许 · n 拒绝`,
    ].join('\n');
  }

  function rejectPending(accountId: string): boolean {
    const perm = pending.get(accountId);
    if (!perm) return false;
    clearTimeout(perm.timer);
    pending.delete(accountId);
    perm.resolve(false);
    logger.info('Permission auto-rejected (session cleared)', { accountId, toolName: perm.toolName });
    return true;
  }

  return { createPending, resolvePermission, rejectPending, isTimedOut, clearTimedOut, getPending, formatPendingMessage, resetApprovalCount };
}
