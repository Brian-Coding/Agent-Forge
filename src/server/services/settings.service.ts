import type { AppSettings } from '../../shared/protocol';
import { persistenceService } from './persistence.service';
import { runDurableMutation } from './durable-mutation';

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
    return runDurableMutation(async () => {
      const previous = state.settings;
      state.settings = { ...state.settings, ...updates };
      try {
        await persistenceService.saveNow();
        return state.settings;
      } catch (error) {
        state.settings = previous;
        throw error;
      }
    });
  },

  /** Load settings from persisted data */
  load(settings: AppSettings | undefined) {
    if (settings) {
      state.settings = settings;
    }
  },
};
