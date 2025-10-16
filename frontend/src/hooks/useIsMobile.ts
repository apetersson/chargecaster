import { useEffect, useState } from "react";

export function useIsMobile(breakpointPx = 640): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= breakpointPx;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Initial
    setIsMobile(media.matches);
    // Subscribe (standards)
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
    } else {
      // Fallback for very old browsers
      media.onchange = onChange;
    }
    return () => {
      if (typeof media.removeEventListener === "function") {
        media.removeEventListener("change", onChange);
      } else {
        media.onchange = null;
      }
    };
  }, [breakpointPx]);

  return isMobile;
}
