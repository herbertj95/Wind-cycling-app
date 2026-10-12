import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';

/**
 * The back button (or gesture) of an Android phone. `onBack()` is asked to undo the last thing on the
 * screen and says with `true` that it did; when there is nothing left to undo, the app goes to the
 * background instead of being closed, so it comes back as it was.
 * Nothing happens in a browser, which has its own back button.
 */
export function useBackButton(onBack) {
  const handler = useRef(onBack);
  useEffect(() => {
    handler.current = onBack;
  });
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;
    const listening = CapacitorApp.addListener('backButton', () => {
      if (!handler.current()) CapacitorApp.minimizeApp();
    });
    return () => {
      listening.then((listener) => listener.remove());
    };
  }, []);
}
