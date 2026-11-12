import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

const keyOf = (secret: string) => createHash('sha256').update(secret).digest();

/** AES-256-GCM for shard connection URIs stored in the control plane. */
export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${[iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.')}`;
}

/** Plain `postgres://` URIs pass through, so a developer can type one by hand. */
export function decryptSecret(stored: string, secret: string): string {
  if (/^postgres(ql)?:\/\//.test(stored)) return stored;
  if (!stored.startsWith(PREFIX)) throw new Error('Unreadable shard connection value');
  const [iv, tag, data] = stored.slice(PREFIX.length).split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Unreadable shard connection value');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
