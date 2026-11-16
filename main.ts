// Entrypoint for the forge: bring the app server up, tell the trial env
// where to find it, then sit tight until the env reports the suite is done.
//
// The env lives at MAKEFUN_ENV_URL. Without that variable there is nobody
// to talk to, so the process bails out right away instead of serving into
// the void.

import { createApp } from './app.ts';

// How long a single HTTP call to the env may take before we give up on it.
const CALL_BUDGET_MS = 30_000;
// Backoff ladder for retries: start small, double each time, stop growing here.
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

const envOrigin = process.env.MAKEFUN_ENV_URL;

if (envOrigin === undefined || envOrigin === '') {
  console.error('MAKEFUN_ENV_URL is not set; cannot register with the trial env.');
  process.exit(1);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One fetch against the env that never hangs longer than CALL_BUDGET_MS. */
async function envCall(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${envOrigin}${path}`, {
    ...init,
    signal: AbortSignal.timeout(CALL_BUDGET_MS),
  });
}

/**
 * Announce our listening port to the env. A 200 means the env recorded us;
 * a 409 means somebody already registered (first registration wins) and our
 * address is already known, so that is fine too. A 400 or 405 means the env
 * rejected the registration outright and retrying would be pointless.
 * Anything else — a 5xx, a dropped connection, a timeout — is worth another
 * try after a growing pause.
 */
async function announce(port: number): Promise<void> {
  let wait = FIRST_PAUSE_MS;
  for (;;) {
    let reply: Response;
    try {
      reply = await envCall('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch (err) {
      console.error(`register attempt failed (${err}); retrying in ${wait} ms`);
      await pause(wait);
      wait = Math.min(wait * 2, LONGEST_PAUSE_MS);
      continue;
    }
    if (reply.status === 200 || reply.status === 409) return;
    if (reply.status === 400 || reply.status === 405) {
      console.error(`register rejected by env with HTTP ${reply.status}; giving up.`);
      process.exit(1);
    }
    console.error(`register answered HTTP ${reply.status}; retrying in ${wait} ms`);
    await pause(wait);
    wait = Math.min(wait * 2, LONGEST_PAUSE_MS);
  }
}

/**
 * Keep asking the env whether the suite has finished. The env answers
 * immediately either way, so this is a plain poll, not a held-open request.
 * A hiccup talking to the env just means waiting a little longer and asking
 * again; only {"done": true} ends the loop.
 */
async function waitForSuite(): Promise<void> {
  let wait = FIRST_PAUSE_MS;
  for (;;) {
    let reply: Response;
    try {
      reply = await envCall('/done', { method: 'GET' });
    } catch (err) {
      console.error(`done poll failed (${err}); retrying in ${wait} ms`);
      await pause(wait);
      wait = Math.min(wait * 2, LONGEST_PAUSE_MS);
      continue;
    }
    if (reply.ok) {
      const payload = (await reply.json()) as { done?: unknown };
      if (payload.done === true) return;
      wait = FIRST_PAUSE_MS;
    } else {
      console.error(`done poll answered HTTP ${reply.status}; retrying in ${wait} ms`);
    }
    await pause(wait);
    wait = Math.min(wait * 2, LONGEST_PAUSE_MS);
  }
}

const server = createApp();

server.listen(0, () => {
  const bound = server.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : 0;
  console.log(`forge listening on port ${port}`);
  void (async () => {
    await announce(port);
    await waitForSuite();
    server.close(() => {
      process.exit(0);
    });
  })();
});

server.on('error', (err) => {
  console.error(`server error: ${err}`);
  process.exit(1);
});
