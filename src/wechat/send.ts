import { WeChatApi } from './api.js';
import { MessageItemType, MessageType, MessageState, type MessageItem, type OutboundMessage } from './types.js';
import { logger } from '../logger.js';

// Only back off when WeChat actually returns -2 (rate-limited)
const RATE_LIMIT_BACKOFF_MS = 12_000;

export function createSender(api: WeChatApi, botAccountId: string) {
  let rateLimitedUntil = 0; // timestamp until which we must wait

  function generateClientId(): string {
    const randomPart = crypto.getRandomValues(new Uint8Array(8));
    const hex = Buffer.from(randomPart).toString('hex');
    return `wcc-${Date.now()}-${hex}`;
  }

  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const clientId = generateClientId();

    const items: MessageItem[] = [
      {
        type: MessageItemType.TEXT,
        text_item: { text },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    // Only wait if we were previously rate-limited
    const now = Date.now();
    if (now < rateLimitedUntil) {
      const wait = rateLimitedUntil - now;
      logger.info('Rate-limit cooldown, waiting', { waitMs: wait });
      await new Promise(r => setTimeout(r, wait));
    }

    logger.info('Sending text message', { toUserId, clientId, textLength: text.length });
    const wasRateLimited = await api.sendMessage({ msg });

    if (wasRateLimited) {
      rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      logger.warn('Rate-limited, cooling down', { cooldownMs: RATE_LIMIT_BACKOFF_MS });
    }

    logger.info('Text message sent', { toUserId, clientId });
  }

  function resetInterval(): void {
    rateLimitedUntil = 0;
  }

  return { sendText, resetInterval };
}
