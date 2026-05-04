import { Resend } from 'resend';
import { APP_SETTING_KEYS, getAppSetting } from '../settings/app-settings.js';
import { env } from '../env.js';

let cached: { key: string; client: Resend } | null = null;

async function getResend(): Promise<Resend | null> {
  // Prefer admin-configured key over env fallback.
  const key = (await getAppSetting(APP_SETTING_KEYS.resendApiKey)) ?? env.RESEND_API_KEY ?? null;
  if (!key) return null;
  if (cached?.key === key) return cached.client;
  cached = { key, client: new Resend(key) };
  return cached.client;
}

async function getFrom(): Promise<string | null> {
  return await getAppSetting(APP_SETTING_KEYS.resendFrom);
}

export async function sendRoutineReport(opts: {
  to: string;
  subject: string;
  markdown: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = await getResend();
  if (!client) return { ok: false, error: 'Resend not configured (admin must set API key)' };
  const from = await getFrom();
  if (!from) return { ok: false, error: 'Resend "from" address not configured (admin must set)' };

  const html = renderMarkdownToHtml(opts.markdown);
  try {
    const result = await client.emails.send({ from, to: opts.to, subject: opts.subject, html });
    if (result.error) return { ok: false, error: String(result.error.message ?? result.error) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

/**
 * Minimal markdown → HTML for routine reports. Handles the cases routines
 * actually produce: headings, paragraphs, bullet/numbered lists, links, bold,
 * italic, inline code, fenced code, blockquotes. No table support — if a
 * routine response uses tables, they fall through as raw text inside <pre>.
 */
function renderMarkdownToHtml(md: string): string {
  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  let listKind: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listKind) { out.push(`</${listKind}>`); listKind = null; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) {
      closeList();
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { out.push('<pre style="background:#f3f3f0;padding:12px;border-radius:6px;overflow-x:auto"><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(escapeHtml(raw)); continue; }
    if (!line.trim()) { closeList(); continue; }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      out.push(`<h${level} style="margin:16px 0 8px">${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    const ul = /^[-*]\s+(.+)$/.exec(line);
    if (ul) {
      if (listKind !== 'ul') { closeList(); out.push('<ul style="margin:8px 0;padding-left:20px">'); listKind = 'ul'; }
      out.push(`<li>${inline(ul[1]!)}</li>`);
      continue;
    }
    const ol = /^\d+\.\s+(.+)$/.exec(line);
    if (ol) {
      if (listKind !== 'ol') { closeList(); out.push('<ol style="margin:8px 0;padding-left:20px">'); listKind = 'ol'; }
      out.push(`<li>${inline(ol[1]!)}</li>`);
      continue;
    }
    const bq = /^>\s+(.+)$/.exec(line);
    if (bq) {
      closeList();
      out.push(`<blockquote style="border-left:3px solid #ccc;padding-left:12px;margin:8px 0;color:#555">${inline(bq[1]!)}</blockquote>`);
      continue;
    }
    closeList();
    out.push(`<p style="margin:8px 0">${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push('</code></pre>');

  function inline(s: string): string {
    let t = escapeHtml(s);
    // Links [text](url)
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}" style="color:#1a73e8">${label}</a>`);
    // Bold **text**
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic *text* or _text_
    t = t.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
    t = t.replace(/(^|[^_])_([^_]+)_([^_]|$)/g, '$1<em>$2</em>$3');
    // Inline code `code`
    t = t.replace(/`([^`]+)`/g, '<code style="background:#f3f3f0;padding:1px 4px;border-radius:3px;font-family:monospace">$1</code>');
    return t;
  }

  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#191919;max-width:640px;margin:0 auto;padding:24px">${out.join('\n')}</body></html>`;
}
