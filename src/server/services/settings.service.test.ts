import { expect, test } from 'bun:test';
import { persistenceService } from './persistence.service';
import { settingsService } from './settings.service';

test('settings updates are not visible after persistence rejects', async () => {
  const original = structuredClone(settingsService.getRef());
  const originalSaveNow = persistenceService.saveNow;
  persistenceService.saveNow = async () => { throw new Error('settings write failed'); };
  try {
    await expect(settingsService.update({ sidebarWidth: 999 })).rejects.toThrow('settings write failed');
    expect(settingsService.getRef()).toEqual(original);
  } finally {
    persistenceService.saveNow = originalSaveNow;
    settingsService.load(original);
  }
});
