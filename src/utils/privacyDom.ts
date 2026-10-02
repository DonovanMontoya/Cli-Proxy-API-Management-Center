/**
 * Applies `maskPii` to everything rendered in the document (text, a few
 * attributes, and input values via a CSS blur) so privacy mode covers every
 * page without each component opting in. Only the DOM is touched: state,
 * cache keys and API calls keep the real values, and `stop()` restores them.
 */

import { maskPii } from './privacy';

const MASKED_ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt'] as const;
const ORIGINAL_ATTR_PREFIX = 'data-pii-original-';
const BLUR_ATTR = 'data-pii-blur';
const SKIP_SELECTOR = 'script, style, noscript, textarea, .cm-editor';
/** Code editors own their DOM and would read our edits as typing; they are blurred instead. */
const BLUR_SELECTOR = '.cm-editor .cm-content';
const PRUNE_THRESHOLD = 2000;

const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

export function startPiiMasking(root: HTMLElement = document.body): () => void {
  /** Text node → { original, masked }, so unchanged nodes are skipped and `stop()` can restore. */
  const texts = new Map<Text, { original: string; masked: string }>();

  const maskText = (node: Text) => {
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP_SELECTOR)) return;
    const data = node.data;
    const known = texts.get(node);
    if (known && known.masked === data) return;
    const masked = maskPii(data);
    if (masked === data) {
      texts.delete(node);
      return;
    }
    texts.set(node, { original: data, masked });
    node.data = masked;
  };

  const maskAttributes = (el: Element) => {
    for (const attr of MASKED_ATTRIBUTES) {
      const current = el.getAttribute(attr);
      if (current === null) continue;
      const originalAttr = `${ORIGINAL_ATTR_PREFIX}${attr}`;
      const original = el.getAttribute(originalAttr);
      if (original !== null && maskPii(original) === current) continue;
      const masked = maskPii(current);
      if (masked === current) {
        if (original !== null) el.removeAttribute(originalAttr);
        continue;
      }
      el.setAttribute(originalAttr, current);
      el.setAttribute(attr, masked);
    }
  };

  const blurIfSensitive = (el: Element) => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (maskPii(el.value) !== el.value) {
      el.setAttribute(BLUR_ATTR, '');
    } else {
      el.removeAttribute(BLUR_ATTR);
    }
  };

  const scanElement = (el: Element) => {
    if (el.closest('.cm-editor')) {
      if (el.matches(BLUR_SELECTOR)) el.setAttribute(BLUR_ATTR, '');
      return;
    }
    maskAttributes(el);
    blurIfSensitive(el);
  };

  const scan = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      maskText(node as Text);
      return;
    }
    if (!isElement(node)) return;
    scanElement(node);
    node.querySelectorAll('*').forEach(scanElement);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      maskText(current as Text);
    }
  };

  const prune = () => {
    if (texts.size < PRUNE_THRESHOLD) return;
    for (const node of texts.keys()) {
      if (!node.isConnected) texts.delete(node);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') {
        scan(record.target);
      } else if (record.type === 'attributes') {
        if (isElement(record.target)) scanElement(record.target);
      } else {
        record.addedNodes.forEach(scan);
      }
    }
    prune();
  });

  const onInput = (event: Event) => {
    if (event.target instanceof Element) blurIfSensitive(event.target);
  };

  scan(root);
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...MASKED_ATTRIBUTES, 'value', 'type'],
  });
  document.addEventListener('input', onInput, true);

  return () => {
    observer.disconnect();
    document.removeEventListener('input', onInput, true);
    for (const [node, { original, masked }] of texts) {
      if (node.data === masked) node.data = original;
    }
    texts.clear();
    for (const attr of MASKED_ATTRIBUTES) {
      const originalAttr = `${ORIGINAL_ATTR_PREFIX}${attr}`;
      root.querySelectorAll(`[${originalAttr}]`).forEach((el) => {
        const original = el.getAttribute(originalAttr);
        if (original !== null) el.setAttribute(attr, original);
        el.removeAttribute(originalAttr);
      });
    }
    root.querySelectorAll(`[${BLUR_ATTR}]`).forEach((el) => el.removeAttribute(BLUR_ATTR));
  };
}
