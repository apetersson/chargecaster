import { useEffect, useState } from "react";

export function useIsMobile(breakpointPx = 640): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= breakpointPx;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(("matches" in e ? e.matches : (e as MediaQueryList).matches));
    };
    // Initial
    handler(media);
    // Subscribe
    media.addEventListener?.("change", handler as (ev: MediaQueryListEvent) => void);
    // Fallback for older browsers
    media.addListener?.(handler);
    return () => {
      media.removeEventListener?.("change", handler as (ev: MediaQueryListEvent) => void);
      media.removeListener?.(handler);
    };
  }, [breakpointPx]);

  return isMobile;
}

