/**
 * Privacy mode: masks emails, account IDs, tokens and IP addresses embedded in
 * credential names, account fields and log lines so any page can be screenshotted or shared.
 *
 * `claude-sam.lee@example.dev.json` → `claude-s•••@e•••.dev.json`
 * `codex-sam@gmail.com-plus.json`   → `codex-s•••@g•••.com-plus.json`
 *
 * The local part stops at `-` so filename prefixes like `claude-` stay
 * readable; the top-level domain and anything after it stay visible so
 * accounts remain distinguishable at a glance.
 */

const MASK = '•••';
const EMAIL_PATTERN = /([A-Za-z0-9._%+]+)@([A-Za-z0-9.-]+)/g;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const SECRET_PATTERN = /\b(sk-(?:[a-z]+-)*|AIza|gh[pousr]_|xox[abprs]-)[A-Za-z0-9_-]{12,}/g;
const UUID_PATTERN =
  /\b([0-9a-f]{4})[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Credential filenames carry an 8-hex account hash: `claude-1215c1a7-…`. */
const FILE_HASH_PATTERN = /\b([a-z][a-z0-9]*-)([0-9a-f])[0-9a-f]{7}(?![0-9A-Za-z])/g;
const IPV4_PATTERN = /\b(?!127\.|0\.0\.0\.0)(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

const maskDomain = (domain: string): string => {
  const extMatch = domain.match(/\.json$/i);
  const ext = extMatch ? extMatch[0] : '';
  const body = ext ? domain.slice(0, -ext.length) : domain;
  const lastDot = body.lastIndexOf('.');
  if (lastDot <= 0) return `${body.slice(0, 1)}${MASK}${ext}`;
  const afterDot = body.slice(lastDot + 1);
  const tld = afterDot.match(/^[A-Za-z]+/)?.[0] ?? '';
  const suffix = afterDot.slice(tld.length);
  return `${body.slice(0, 1)}${MASK}.${tld}${suffix}${ext}`;
};

export function maskEmails(value: string): string {
  return value.replace(
    EMAIL_PATTERN,
    (_, local: string, domain: string) => `${local.slice(0, 1)}${MASK}@${maskDomain(domain)}`
  );
}

/** Masks emails, account hashes/UUIDs, tokens and non-loopback IPv4 addresses. */
export function maskPii(value: string): string {
  if (!value) return value;
  return maskEmails(
    value
      .replace(JWT_PATTERN, `eyJ${MASK}`)
      .replace(SECRET_PATTERN, (_, prefix: string) => `${prefix}${MASK}`)
      .replace(UUID_PATTERN, (_, head: string) => `${head}${MASK}`)
      .replace(FILE_HASH_PATTERN, (_, prefix: string, first: string) => `${prefix}${first}${MASK}`)
      .replace(IPV4_PATTERN, (_, first: string) => `${first}.${MASK}.${MASK}.${MASK}`)
  );
}

/** Key used when privacy mode was a quota-page-only setting; read once to migrate. */
const LEGACY_PRIVACY_STORAGE_KEY = 'quotaPage.privacy';

export const readLegacyPrivacyMode = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(LEGACY_PRIVACY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};
