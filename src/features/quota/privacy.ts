/**
 * Privacy mode for the quota page: masks email addresses embedded in
 * credential names so the page can be screenshotted or shared.
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

const PRIVACY_STORAGE_KEY = 'quotaPage.privacy';

/** Persisted across sessions: a screenshot habit shouldn't need re-enabling every visit. */
export const readPrivacyMode = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(PRIVACY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

export const writePrivacyMode = (enabled: boolean) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PRIVACY_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
};
