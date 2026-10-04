/**
 * An AbortSignal that fires after `ms`, or as soon as `parent` does.
 * Same as AbortSignal.timeout and AbortSignal.any, which older Android WebViews lack.
 */
export function timeoutSignal(ms, parent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (parent) {
    const stop = () => {
      clearTimeout(timer);
      controller.abort();
    };
    if (parent.aborted) stop();
    else parent.addEventListener('abort', stop, { once: true });
  }
  return controller.signal;
}
