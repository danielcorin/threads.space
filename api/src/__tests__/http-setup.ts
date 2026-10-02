import { afterAll } from 'vitest';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

// Synchronous Wrangler D1 fixture commands block the test runner's event loop.
// The dev server can close an idle connection during that time, before fetch
// processes the close event. Use fresh connections instead of reusing stale
// sockets or retrying requests that may already have changed server state.
const previousDispatcher = getGlobalDispatcher();
const dispatcher = new Agent({ pipelining: 0 });
setGlobalDispatcher(dispatcher);

afterAll(async () => {
  setGlobalDispatcher(previousDispatcher);
  await dispatcher.destroy();
});
