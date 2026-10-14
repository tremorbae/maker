import posthog from 'posthog-js';

const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com';

/** Tagged onto every event, like the original's `app: 'derpetual-maker'`. */
const APP_NAME = 'derpetual-maker';

export function initAnalytics() {
  if (!key) return;
  posthog.init(key, {
    api_host: host,
    defaults: '2026-05-30',
    capture_exceptions: true,
    debug: false,
    before_send: (event) => {
      if (event) event.properties.app = APP_NAME;
      return event;
    },
  });
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (key) posthog.capture(event, properties);
}

export function captureError(error: unknown, componentStack?: string) {
  console.error(error);
  if (key) posthog.captureException(error, { componentStack });
}
