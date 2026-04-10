import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync } from 'node:fs';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { createPermissionBroker } from './permission.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { claudeQuery, type QueryOptions } from './claude/provider.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 2048;

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    // Linux: try xdg-open
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → display → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux' &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      // Headless Linux: display QR in terminal using qrcode-terminal
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);

      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  // Clean up QR image
  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

  const workingDir = await promptUser('请输入工作目录', process.cwd());
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const session: Session = sessionStore.load(account.accountId);

  // Fix: backfill session workingDirectory from config if it's still the default process.cwd()
  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, session);
  }

  // Fix: reset stale non-idle state on startup (e.g. after crash)
  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }

  const sender = createSender(api, account.accountId);
  const sharedCtx = { lastContextToken: '' };
  const activeControllers = new Map<string, AbortController>();
  const permissionBroker = createPermissionBroker(async () => {
    try {
      await sender.sendText(account.userId ?? '', sharedCtx.lastContextToken, '⏰ 权限请求超时，已自动拒绝。');
    } catch {
      logger.warn('Failed to send permission timeout message');
    }
  });

  // -- Wire the monitor callbacks --

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      await handleMessage(msg, account, session, sessionStore, permissionBroker, sender, config, sharedCtx, activeControllers);
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  // -- Graceful shutdown --

  function shutdown(): void {
    logger.info('Shutting down...');
    monitor.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);

  await monitor.run();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  // Filter: only user messages with required fields
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;

  // Security: only process messages from the bound account owner
  if (account.userId && msg.from_user_id !== account.userId) {
    logger.warn('Ignoring message from unauthorized user', { fromUserId: msg.from_user_id, expectedUserId: account.userId });
    return;
  }

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;

  // Extract text from items
  const userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);

  // Concurrency guard: abort current query when new message arrives
  if (session.state === 'processing') {
    if (userText.startsWith('/clear')) {
      // Force reset stuck session state
      const ctrl = activeControllers.get(account.accountId);
      if (ctrl) { ctrl.abort(); activeControllers.delete(account.accountId); }
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      // Fall through to command routing so /clear executes normally
    } else if (!userText.startsWith('/')) {
      // Abort the current query and process the new message instead
      const ctrl = activeControllers.get(account.accountId);
      if (ctrl) { ctrl.abort(); activeControllers.delete(account.accountId); }
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      // Fall through to send new message to Claude
    } else if (!userText.startsWith('/status') && !userText.startsWith('/help')) {
      return;
    }
  }

  // -- Grace period: catch late y/n after timeout --

  if (session.state === 'idle' && permissionBroker.isTimedOut(account.accountId)) {
    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes' || lower === 'n' || lower === 'no') {
      permissionBroker.clearTimedOut(account.accountId);
      await sender.sendText(fromUserId, contextToken, '⏰ 权限请求已超时，请重新发送你的请求。');
      return;
    }
  }

  // -- Permission state handling --

  if (session.state === 'waiting_permission') {
    // Allow /clear and /reset to break out of waiting_permission state
    if (userText.startsWith('/clear') || userText.startsWith('/reset')) {
      permissionBroker.rejectPending(account.accountId);
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      // Fall through to command routing below
    } else {
      // Check if there's actually a pending permission (may be lost after restart)
      const pendingPerm = permissionBroker.getPending(account.accountId);
      if (!pendingPerm) {
        session.state = 'idle';
        sessionStore.save(account.accountId, session);
        await sender.sendText(fromUserId, contextToken, '⚠️ 权限请求已失效（可能因服务重启），请重新发送你的请求。');
        return;
      }

      const lower = userText.toLowerCase();
      if (lower === 'y' || lower === 'yes') {
        const hint = permissionBroker.resolvePermission(account.accountId, true);
        const msgs = ['✅ 已允许'];
        if (hint) msgs.push(hint);
        await sender.sendText(fromUserId, contextToken, msgs.join('\n\n'));
      } else if (lower === 'n' || lower === 'no') {
        permissionBroker.resolvePermission(account.accountId, false);
        await sender.sendText(fromUserId, contextToken, '❌ 已拒绝');
      } else {
        await sender.sendText(fromUserId, contextToken, '正在等待权限审批，请回复 y 或 n。');
      }
      return;
    }
  }

  // -- Command routing --

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    // Reset permission approval counter on new command context
    if (userText.startsWith('/clear') || userText.startsWith('/reset')) {
      permissionBroker.resetApprovalCount(account.accountId);
    }

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      rejectPendingPermission: () => permissionBroker.rejectPending(account.accountId),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      if (result.restart) {
        // Exit process; launchd/systemd will auto-restart with new settings
        logger.info('Restart requested, exiting for daemon manager to restart');
        setTimeout(() => process.exit(0), 500);
      }
      return;
    }

    if (result.handled && result.claudePrompt) {
      // Fall through to send the claudePrompt to Claude
      await sendToClaude(
        result.claudePrompt,
        imageItem,
        fromUserId,
        contextToken,
        account,
        session,
        sessionStore,
        permissionBroker,
        sender,
        config,
        activeControllers,
      );
      return;
    }

    if (result.handled) {
      // Handled but no reply and no claudePrompt (shouldn't normally happen)
      return;
    }

    // Not handled, treat as normal message (fall through)
  }

  // -- Normal message -> Claude --

  if (!userText && !imageItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字或图片');
    return;
  }

  await sendToClaude(
    userText,
    imageItem,
    fromUserId,
    contextToken,
    account,
    session,
    sessionStore,
    permissionBroker,
    sender,
    config,
    activeControllers,
  );
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

async function sendToClaude(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  // Create abort controller for this query so it can be cancelled by new messages
  let abortController = new AbortController();
  activeControllers.set(account.accountId, abortController);

  // Record user message in chat history
  sessionStore.addChatMessage(session, 'user', userText || '(图片)');

  try {
    // Download image if present
    let images: QueryOptions['images'];
    if (imageItem) {
      const base64DataUri = await downloadImage(imageItem);
      if (base64DataUri) {
        // Convert data URI to the format Claude expects
        const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          images = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: matches[1],
                data: matches[2],
              },
            },
          ];
        }
      }
    }

    const effectivePermissionMode = session.permissionMode ?? config.permissionMode;
    const isAutoPermission = effectivePermissionMode === 'auto';

    // Map 'auto' to bypassPermissions — skips all permission checks in the SDK
    const sdkPermissionMode = isAutoPermission ? 'bypassPermissions' : effectivePermissionMode;

    // --- Streaming buffer with smart flush ---
    // Flush when: content >= threshold chars, natural break point, or time elapsed
    const FLUSH_CHAR_THRESHOLD = 30;    // flush after accumulating this many chars
    const FLUSH_MAX_INTERVAL_MS = 5_000; // flush at least every 5s regardless
    const NATURAL_BREAKS = /[。！？\n]/;  // flush on sentence/line endings

    let pendingBuffer = '';
    let anySent = false;
    let lastFlushTime = Date.now();
    let toolMessagePending = false; // track if we need to separate tool msgs from text

    // Immediately notify user that processing has started
    await sender.sendText(fromUserId, contextToken, '⟳ 思考中...');
    anySent = true;

    async function flushBuffer(force = false): Promise<void> {
      if (!pendingBuffer.trim()) return;
      const now = Date.now();
      const timeElapsed = now - lastFlushTime >= FLUSH_MAX_INTERVAL_MS;
      const enoughContent = pendingBuffer.length >= FLUSH_CHAR_THRESHOLD;
      const naturalBreak = NATURAL_BREAKS.test(pendingBuffer);

      if (!force && !timeElapsed && !enoughContent && !naturalBreak) return;

      const toSend = pendingBuffer.trim();
      pendingBuffer = '';
      lastFlushTime = Date.now();
      toolMessagePending = false;

      const chunks = splitMessage(toSend);
      for (const chunk of chunks) {
        await sender.sendText(fromUserId, contextToken, chunk);
      }
    }

    const queryOptions: QueryOptions = {
      prompt: userText || '请分析这张图片',
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, process.env.HOME || ''),
      resume: session.sdkSessionId,
      model: session.model,
      systemPrompt: config.systemPrompt,
      permissionMode: sdkPermissionMode,
      abortController,
      images,
      onText: async (delta: string) => {
        pendingBuffer += delta;
        await flushBuffer();
      },
      onThinking: async (summary: string) => {
        // Tool calls: flush current text first, then send tool summary as separate message
        await flushBuffer(true);
        await sender.sendText(fromUserId, contextToken, summary);
        toolMessagePending = true;
      },
      onPermissionRequest: isAutoPermission
        ? async () => true  // auto-approve all tools, skip broker
        : async (toolName: string, toolInput: string) => {
            // Set state to waiting_permission
            session.state = 'waiting_permission';
            sessionStore.save(account.accountId, session);

            // Create pending permission
            const permissionPromise = permissionBroker.createPending(
              account.accountId,
              toolName,
              toolInput,
            );

            // Send permission message to WeChat
            const perm = permissionBroker.getPending(account.accountId);
            if (perm) {
              const permMsg = permissionBroker.formatPendingMessage(perm);
              await sender.sendText(fromUserId, contextToken, permMsg);
            }

            const allowed = await permissionPromise;

            // Reset state after permission resolved
            session.state = 'processing';
            sessionStore.save(account.accountId, session);

            return allowed;
          },
    };

    let result = await claudeQuery(queryOptions);

    // If resume failed (e.g. corrupted session), retry without resume
    if (result.error && queryOptions.resume) {
      logger.warn('Resume failed, retrying without resume', { error: result.error, sessionId: queryOptions.resume });
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;
      sessionStore.save(account.accountId, session);

      // The abortController may have been aborted during the failed query.
      // Create a fresh one for the retry to avoid immediate abort.
      if (abortController.signal.aborted) {
        abortController = new AbortController();
        activeControllers.set(account.accountId, abortController);
        queryOptions.abortController = abortController;
      }

      const retryResult = await claudeQuery(queryOptions);
      Object.assign(result, retryResult);
    }

    // Auto-retry on transient errors (empty response without explicit error)
    if (!result.text && !result.error) {
      logger.warn('Empty result, retrying once', { sessionId: result.sessionId });
      queryOptions.resume = undefined;

      // Same: ensure abortController is fresh for retry
      if (abortController.signal.aborted) {
        abortController = new AbortController();
        activeControllers.set(account.accountId, abortController);
        queryOptions.abortController = abortController;
      }

      const retryResult = await claudeQuery(queryOptions);
      if (retryResult.text) Object.assign(result, retryResult);
    }

    // Flush any remaining buffered content
    await flushBuffer(true);

    // Send result back to WeChat
    if (result.text) {
      if (result.error) {
        logger.warn('Claude query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      // If nothing was streamed beyond the initial "⏳" message, send full text now
      if (!anySent || pendingBuffer) {
        const chunks = splitMessage(result.text);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
      logger.error('Claude query error', { error: result.error });
      // Provide actionable hints based on error type
      const err = result.error;
      let hint = '';
      if (err.includes('timed out')) {
        hint = '⏱ 超时了\n↗ 重发消息重试\n↗ 或发 /compact 压缩后重试';
      } else if (err.includes('API key') || err.includes('401') || err.includes('auth') || err.includes('Unauthorized')) {
        hint = '🔑 API Key 失效\n↗ 在电脑终端检查 ANTHROPIC_API_KEY\n↗ 重启: npm run daemon -- restart';
      } else if (err.includes('quota') || err.includes('429') || err.includes('rate') || err.includes('limit')) {
        hint = '📊 被限频或额度不足\n↗ 等几分钟后重试\n↗ 或发 /model 换个模型';
      } else if (err.includes('model') || err.includes('not found') || err.includes('does not exist')) {
        hint = '🤖 模型不可用\n↗ 发 /model <模型名> 切换\n↗ 如 /model claude-sonnet-4-6';
      } else if (err.includes('session') || err.includes('resume') || err.includes('context')) {
        hint = '💬 会话异常\n↗ 发 /clear 清除后重试';
      } else {
        hint = `↗ 重发消息重试\n↗ 或发 /clear 清除会话\n↗ 持续出错: npm run daemon -- restart`;
      }
      await sender.sendText(fromUserId, contextToken, `✗ 请求失败\n\n${hint}`);
    } else if (!anySent) {
      await sender.sendText(fromUserId, contextToken, '∅ 无返回内容（可能因权限被拒）');
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      // Query was cancelled by a new incoming message — exit silently
      logger.info('Claude query aborted by new message');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToClaude', { error: errorMsg });
      await sender.sendText(fromUserId, contextToken, `✗ 处理出错\n\n↗ 重发消息重试\n↗ 或发 /clear 清除会话`);
    }
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } finally {
    // Clean up the abort controller if it's still ours
    if (activeControllers.get(account.accountId) === abortController) {
      activeControllers.delete(account.accountId);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  // 'start' or no argument
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
