import { authorizeUpdate } from '../policy/authorize.mjs';
export function acceptTelegramUpdate(update, config, store) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return null;
  return store.acceptUpdate(update.update_id, authorizeUpdate(update, config));
}
