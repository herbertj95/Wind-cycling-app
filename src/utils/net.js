/**
 * An AbortSignal that fires after `ms`. Same as AbortSignal.timeout, which older Android WebViews lack.
 */
export function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
