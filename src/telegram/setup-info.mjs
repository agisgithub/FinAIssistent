import { TelegramClient } from './client.mjs';
import { secretResolver } from '../secrets/resolver.mjs';
import { errorCode, AppError } from '../errors.mjs';

export async function telegramSetupInfo({ secretDir = '/run/secrets', tokenRef = 'telegram-token', fetchImpl = fetch } = {}) {
  try {
    const client = new TelegramClient({ config: { telegram: { tokenRef } }, resolveSecret: secretResolver(secretDir), fetchImpl });
    const bot = await client.getMe();
    await client.assertPollingAvailable();
    // Deliberately omit offset and allowed_updates: do not acknowledge updates,
    // change the subscription, send a message or replace an existing webhook.
    const updates = await client.call('getUpdates', { timeout: 0, limit: 100 }, { timeoutMs: 10000 });
    if (!Array.isArray(updates) || updates.length > 100) throw new AppError('TELEGRAM_REJECTED');
    const candidates = new Map();
    for (const update of updates) {
      const message = update?.message;
      const user = message?.from, chat = message?.chat;
      if (user?.is_bot === false && chat?.type === 'private' && Number.isSafeInteger(user.id) && user.id > 0 && chat.id === user.id) {
        candidates.set(user.id, { userId: user.id, chatId: chat.id });
      }
    }
    return { event: 'telegram_info_ok', botId: bot.id, candidates: [...candidates.values()], updatesAtLimit: updates.length === 100,
      reason: updates.length === 100 ? 'first_100_updates_only_do_not_assume_owner' : candidates.size ? 'verify_your_private_chat_ids' : 'send_start_in_private_chat_then_retry' };
  } catch (error) { return { event: 'telegram_info_failed', code: errorCode(error, 'NETWORK_FAILED') }; }
}
