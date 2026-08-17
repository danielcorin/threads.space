import type { Hono } from 'hono';
import type { AuthPrincipal } from '../auth.js';
import type { Env, User } from '../types.js';

export type HonoEnv = { Bindings: Env; Variables: { user: User; principal: AuthPrincipal } };
export type ThreadsApp = Hono<HonoEnv>;
