import { db } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { encryptToken, decryptToken } from '../db/encrypt.js';
import { env } from '../env.js';

// Keys that must be stored encrypted at rest. Anything not listed is plaintext.
const ENCRYPTED_KEYS = new Set([
  'resend_api_key',
]);

export const APP_SETTING_KEYS = {
  resendApiKey: 'resend_api_key',
  resendFrom: 'resend_from',
  routinesPerUserCap: 'routines_per_user_cap',
} as const;

export const DEFAULTS = {
  routinesPerUserCap: 20,
} as const;

export async function getAppSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  if (!row) return null;
  if (row.isEncrypted) {
    try { return decryptToken(row.value, env.TOKEN_ENCRYPTION_KEY); } catch { return null; }
  }
  return row.value;
}

export async function setAppSetting(key: string, value: string, updatedBy: string): Promise<void> {
  const isEncrypted = ENCRYPTED_KEYS.has(key);
  const stored = isEncrypted ? encryptToken(value, env.TOKEN_ENCRYPTION_KEY) : value;
  const existing = await db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  if (existing.length > 0) {
    await db
      .update(appSettings)
      .set({ value: stored, isEncrypted, updatedBy, updatedAt: new Date() })
      .where(eq(appSettings.key, key));
  } else {
    await db.insert(appSettings).values({ key, value: stored, isEncrypted, updatedBy });
  }
}

export async function deleteAppSetting(key: string): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, key));
}

/**
 * Read a numeric setting with a fallback default. Non-numeric values fall back.
 */
export async function getNumericSetting(key: string, fallback: number): Promise<number> {
  const raw = await getAppSetting(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Returns metadata for the admin settings UI: which keys are set, never the
 * decrypted values for encrypted keys.
 */
export async function listAdminSettings(): Promise<{
  resend_from: string | null;
  resend_api_key_set: boolean;
  routines_per_user_cap: number;
}> {
  const rows = await db
    .select()
    .from(appSettings)
    .where(inArray(appSettings.key, [
      APP_SETTING_KEYS.resendApiKey,
      APP_SETTING_KEYS.resendFrom,
      APP_SETTING_KEYS.routinesPerUserCap,
    ]));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const cap = byKey.get(APP_SETTING_KEYS.routinesPerUserCap);
  return {
    resend_from: byKey.get(APP_SETTING_KEYS.resendFrom)?.value ?? null,
    resend_api_key_set: !!byKey.get(APP_SETTING_KEYS.resendApiKey),
    routines_per_user_cap: cap ? Number(cap.value) : DEFAULTS.routinesPerUserCap,
  };
}
