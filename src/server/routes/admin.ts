import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import {
  APP_SETTING_KEYS,
  DEFAULTS,
  deleteAppSetting,
  listAdminSettings,
  setAppSetting,
} from '../settings/app-settings.js';

const resendApiKeySchema = z.object({ value: z.string().min(1).max(500) });
const resendFromSchema = z.object({ value: z.string().min(1).max(200) });
const capSchema = z.object({ value: z.number().int().min(1).max(1000) });

export const adminRoutes = new Hono()
  .use('*', requireAuth, requireAdmin)
  .get('/settings', async (c) => {
    const data = await listAdminSettings();
    return c.json({ ...data, defaults: DEFAULTS });
  })
  .put('/settings/resend-api-key', async (c) => {
    const u = c.get('user');
    const body = resendApiKeySchema.parse(await c.req.json());
    await setAppSetting(APP_SETTING_KEYS.resendApiKey, body.value, u.id);
    return c.json({ ok: true });
  })
  .delete('/settings/resend-api-key', async (c) => {
    await deleteAppSetting(APP_SETTING_KEYS.resendApiKey);
    return c.json({ ok: true });
  })
  .put('/settings/resend-from', async (c) => {
    const u = c.get('user');
    const body = resendFromSchema.parse(await c.req.json());
    await setAppSetting(APP_SETTING_KEYS.resendFrom, body.value, u.id);
    return c.json({ ok: true });
  })
  .put('/settings/routines-cap', async (c) => {
    const u = c.get('user');
    const body = capSchema.parse(await c.req.json());
    await setAppSetting(APP_SETTING_KEYS.routinesPerUserCap, String(body.value), u.id);
    return c.json({ ok: true });
  });
