import apiWorker, {
	ChatRoom,
	PresenceRoom,
	UserEventsRoom
} from '../../api/src/index.js';
import type { Env as ApiEnv } from '../../api/src/types.js';
import { isClientRequest, requestForApi, shareTargetRedirect } from './routing.js';

export { ChatRoom, PresenceRoom, UserEventsRoom };

interface Env extends ApiEnv {
	ASSETS: Fetcher;
}

const worker: ExportedHandler<Env> = {
	async fetch(request, env, ctx) {
		if (isClientRequest(request)) return env.ASSETS.fetch(request);
		const shareRedirect = await shareTargetRedirect(request);
		if (shareRedirect) return shareRedirect;
		return apiWorker.fetch(requestForApi(request), env, ctx);
	},

	scheduled(event, env, ctx) {
		return apiWorker.scheduled(event, env, ctx);
	}
};

export default worker;
