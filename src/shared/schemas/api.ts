import { z } from 'zod';

export const loginRequest = z.discriminatedUnion('method', [
  z.object({ method: z.literal('magic_link'), email: z.string().email() }),
  z.object({ method: z.literal('password'), email: z.string().email(), password: z.string().min(1) }),
]);

export const callbackRequest = z.object({ token: z.string().min(1) });

export const inviteRequest = z.object({ email: z.string().email(), name: z.string().optional() });

export const setPasswordRequest = z.object({ password: z.string().min(8) });
