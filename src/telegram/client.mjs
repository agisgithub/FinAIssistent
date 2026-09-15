import { AppError } from '../errors.mjs';
import { readJsonLimited } from '../http.mjs';

export class TelegramClient {
  constructor({ config, resolveSecret, fetchImpl = fetch }) {
    this.config = config;
    this.resolveSecret = resolveSecret;
    this.fetch = fetchImpl;
  }
  async call(method, payload, { signal, delivery = false, timeoutMs = 35000 } = {}) {
    const token = await this.resolveSecret(this.config.telegram.tokenRef);
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new AppError('SECRET_UNAVAILABLE');
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let result;
    try {
      const response = await this.fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: requestSignal, redirect: 'error'
      });
      result = await readJsonLimited(response);
      if (result?.ok === false) {
        const delay = result.parameters?.retry_after;
        if (result.error_code === 429 && Number.isSafeInteger(delay) && delay >= 1 && delay <= 3600) throw new AppError('TELEGRAM_RATE_LIMITED', { retryAfterSeconds: delay });
        throw new AppError('TELEGRAM_REJECTED');
      }
      if (!response.ok || result?.ok !== true) throw new AppError(delivery ? 'DELIVERY_UNCERTAIN' : 'NETWORK_FAILED');
    } catch (error) {
      if (error instanceof AppError && ['TELEGRAM_REJECTED', 'TELEGRAM_RATE_LIMITED'].includes(error.code)) throw error;
      throw new AppError(delivery ? 'DELIVERY_UNCERTAIN' : 'NETWORK_FAILED');
    }
    return result.result;
  }
  async getUpdates(offset, signal) {
    const result = await this.call('getUpdates', { offset, timeout: 25, limit: 100, allowed_updates: ['message', 'callback_query'] }, { signal });
    if (!Array.isArray(result) || result.length > 100) throw new AppError('NETWORK_FAILED');
    return result;
  }
  async getMe() {
    const result = await this.call('getMe', {}, { timeoutMs: 10000 });
    if (result?.is_bot !== true || !Number.isSafeInteger(result.id) || result.id <= 0) throw new AppError('TELEGRAM_REJECTED');
    return { id: result.id };
  }
  async assertPollingAvailable() {
    const info = await this.call('getWebhookInfo', {}, { timeoutMs: 10000 });
    if (typeof info?.url !== 'string') throw new AppError('TELEGRAM_REJECTED');
    if (info.url) throw new AppError('TELEGRAM_WEBHOOK_ACTIVE');
  }
  async sendMessage(chatId, payload) {
    if (chatId !== this.config.telegram.chatId) throw new AppError('UNAUTHORIZED');
    const result = await this.call('sendMessage', { ...payload, chat_id: chatId, link_preview_options: { is_disabled: true } }, { delivery: true, timeoutMs: 15000 });
    if (!Number.isSafeInteger(result?.message_id)) throw new AppError('DELIVERY_UNCERTAIN');
    return result.message_id;
  }
  answerCallbackQuery(callbackId) { return this.call('answerCallbackQuery', { callback_query_id: callbackId }, { timeoutMs: 10000 }); }
}
