import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function keyFromHex(hex: string): Buffer {
  if (hex.length !== 64) throw new Error('encryption key must be 64-char hex (32 bytes)');
  return Buffer.from(hex, 'hex');
}

export function encryptToken(plaintext: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: <iv:hex>.<ciphertext:hex>.<tag:hex>
  return `${iv.toString('hex')}.${enc.toString('hex')}.${tag.toString('hex')}`;
}

export function decryptToken(payload: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('malformed ciphertext');
  const [ivHex, encHex, tagHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}
