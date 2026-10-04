import { useEffect } from 'react';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';

/**
 * In the Android app the map reaches under the status bar, and the phone draws the clock and the icons
 * there dark or light after its own theme, not after the map: a dark clock on the night map cannot be
 * read. This keeps them the opposite of the map shown.
 * It only acts where the page really is under the bar, which is where its top safe area is not zero:
 * elsewhere the bar has a background of its own and is left as the phone draws it.
 */
export function useSystemBars(theme) {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;
    // as tall as the status bar when the page is under it; the phone only says how tall a moment after the start
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:env(safe-area-inset-top);visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    const apply = () => {
      if (probe.offsetHeight === 0) return;
      SystemBars.setStyle({ style: theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
    };
    const observer = new ResizeObserver(apply);
    observer.observe(probe);
    apply();
    return () => {
      observer.disconnect();
      probe.remove();
    };
  }, [theme]);
}
