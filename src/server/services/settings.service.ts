import type { AppSettings } from '../../shared/protocol';
import { persistenceService } from './persistence.service';

// HMR-safe state
const state: { settings: AppSettings } = (globalThis as any).__settingsState ??= { settings: {} };

export const settingsService = {
  get(): AppSettings {
    return { ...state.settings };
  },

  getRef(): AppSettings {
    return state.settings;
  },

  async update(updates: Partial<AppSettings>): Promise<AppSettings> {
    state.settings = { ...state.settings, ...updates };
    await persistenceService.saveNow();
    return state.settings;
  },

  /** Load settings from persisted data */
  load(settings: AppSettings | undefined) {
    if (settings) {
      state.settings = settings;
    }
  },
};
