import { useEffect, useRef, useState } from 'react';

/**
 * Tracks an element's content width so SVG charts can draw in real pixels
 * (text must not stretch with the viewBox).
 */
export function useElementWidth<T extends HTMLElement>(initial = 800) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
