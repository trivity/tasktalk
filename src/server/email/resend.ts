import { Resend } from 'resend';
import { env } from '../env.js';

const resend = new Resend(env.RESEND_API_KEY);

export async function sendMagicLinkEmail(to: string, link: string): Promise<void> {
  await resend.emails.send({
    from: 'Tasktalk <noreply@tasktalk.app>',
    to,
    subject: 'Your Tasktalk sign-in link',
    text: `Click to sign in (expires in 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
  });
}
