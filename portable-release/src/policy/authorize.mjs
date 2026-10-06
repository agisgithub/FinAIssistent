export function identityFromConfig(config) {
  return Object.freeze({ householdId: config.householdId, budgetId: config.actual.budgetId, userId: config.telegram.userId, chatId: config.telegram.chatId, timezone: config.timezone, currency: config.currency });
}

export function authorizeUpdate(update, config) {
  const callback = update?.callback_query;
  const message = callback ? callback.message : update?.message;
  const user = callback ? callback.from : message?.from;
  if (!message || message.chat?.type !== 'private' || user?.is_bot !== false || user.id !== config.telegram.userId || message.chat.id !== config.telegram.chatId) return null;
  const identity = identityFromConfig(config);
  if (callback) {
    if (typeof callback.id !== 'string' || callback.id.length > 256 || typeof callback.data !== 'string' || Buffer.byteLength(callback.data) > 64) return null;
    return { type: 'callback', callbackId: callback.id, data: callback.data, identity };
  }
  if (typeof message.text !== 'string' || message.text.length < 1 || message.text.length > 4096 || message.forward_origin || message.sender_chat) return null;
  return { type: 'message', text: message.text.trim(), identity };
}
