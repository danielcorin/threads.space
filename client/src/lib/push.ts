import { API_BASE } from './api.js';

interface PushPreferences {
	enabled: number;
	notifyMentionsOnly: number;
}

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 15_000);
	try {
		const res = await fetch(`${API_BASE}${path}`, {
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json',
				...(options.headers as Record<string, string> | undefined)
			},
			...options,
			signal: options.signal ?? controller.signal
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: res.statusText }));
			const err = new Error(error.error || res.statusText) as Error & { status?: number };
			err.status = res.status;
			throw err;
		}
		return res.json();
	} catch (e: any) {
		if (e?.name === 'AbortError') {
			throw new Error('Timed out contacting the push notification server. Try refreshing Threads and enabling notifications again.', { cause: e });
		}
		throw e;
	} finally {
		clearTimeout(timeoutId);
	}
}

let vapidKeyPromise: Promise<string> | null = null;

export async function getVapidKey(): Promise<string> {
	vapidKeyPromise ??= requestJson<{ key?: string }>('/push/vapid-key')
		.then((data) => {
			if (!data.key) throw new Error('Push notifications are not configured');
			return data.key;
		})
		.catch((err) => {
			vapidKeyPromise = null;
			throw err;
		});
	return vapidKeyPromise;
}

export function preparePushNotifications(): void {
	if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
	if (getUnsupportedPushBrowserLabel()) return;
	void getVapidKey();
	void getServiceWorkerRegistration();
}

export function getUnsupportedPushBrowserMessage(): string | null {
	const browser = getUnsupportedPushBrowserLabel();
	if (!browser) return null;
	return `${browser} does not currently support Threads Web Push notifications reliably. Use Safari or Chrome for Threads push notifications, or try again after ${browser} fixes PushManager/Web Push support.`;
}

async function getPushPreferences(): Promise<PushPreferences> {
	return requestJson<PushPreferences>('/push/preferences');
}

async function setPushEnabled(enabled: boolean): Promise<void> {
	const prefs = await getPushPreferences();
	await requestJson<{ ok: boolean }>('/push/preferences', {
		method: 'PUT',
		body: JSON.stringify({
			enabled: enabled ? 1 : 0,
			notifyMentionsOnly: prefs.notifyMentionsOnly ?? 0
		})
	});
}

export async function subscribeToPush(): Promise<boolean> {
	if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;

	throwIfKnownUnsupportedPushBrowser();

	const registrationPromise = getServiceWorkerRegistration();
	const vapidKeyPromise = getVapidKey();

	const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
	if (permission !== 'granted') return false;

	throwIfKnownUnsupportedPushBrowser();

	const [registration, vapidKey] = await Promise.all([
		registrationPromise,
		vapidKeyPromise
	]);
	const applicationServerKey = urlBase64ToUint8Array(vapidKey);
	await assertPushPreflightReady(registration, applicationServerKey);
	let subscription = await withTimeout(
		registration.pushManager.getSubscription(),
		10_000,
		'Timed out checking the existing push subscription. Try refreshing Threads and enabling notifications again.'
	);

	// If the app server/VAPID key has changed, the browser can keep returning a
	// stale subscription that push services reject. Replace it before saving it.
	if (subscription && !subscriptionUsesKey(subscription, applicationServerKey)) {
		await withTimeout(
			subscription.unsubscribe(),
			10_000,
			'Timed out replacing a stale push subscription. Try refreshing Threads and enabling notifications again.'
		);
		subscription = null;
	}

	if (!subscription) {
		subscription = await subscribeWithRecovery(registration, applicationServerKey);
	}

	try {
		await registerSubscription(subscription);
	} catch (err) {
		// 409: the endpoint is registered to a different account (e.g. another
		// user previously used this browser). Drop the browser subscription and
		// create a fresh one — that mints a new endpoint we can own.
		if ((err as Error & { status?: number }).status !== 409) throw err;
		await withTimeout(
			subscription.unsubscribe(),
			10_000,
			'Timed out replacing a push subscription owned by another account. Try refreshing Threads and enabling notifications again.'
		);
		subscription = await subscribeWithRecovery(registration, applicationServerKey);
		await registerSubscription(subscription);
	}

	return true;
}

async function registerSubscription(subscription: PushSubscription): Promise<void> {
	const json = subscription.toJSON();
	await requestJson<{ ok: boolean }>('/push/subscribe', {
		method: 'POST',
		body: JSON.stringify({
			endpoint: json.endpoint,
			p256dh: json.keys?.p256dh,
			auth: json.keys?.auth,
			userAgent: navigator.userAgent
		})
	});
}

export async function unsubscribeFromPush(): Promise<void> {
	await setPushEnabled(false);

	const registration = await getServiceWorkerRegistration();
	const subscription = await withTimeout(
		registration.pushManager.getSubscription(),
		10_000,
		'Timed out checking the existing push subscription. Try refreshing Threads and trying again.'
	);
	if (subscription) {
		const json = subscription.toJSON();
		await requestJson<{ ok: boolean }>('/push/subscribe', {
			method: 'DELETE',
			body: JSON.stringify({ endpoint: json.endpoint })
		});
		await subscription.unsubscribe();
	}
}

export async function isPushSubscribed(): Promise<boolean> {
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
	try {
		const [registration, prefs] = await Promise.all([
			getServiceWorkerRegistration(),
			getPushPreferences()
		]);
		const subscription = await withTimeout(
			registration.pushManager.getSubscription(),
			10_000,
			'Timed out checking push subscription status.'
		);
		return subscription !== null && prefs.enabled !== 0;
	} catch {
		return false;
	}
}

let serviceWorkerRegistrationPromise: Promise<ServiceWorkerRegistration> | null = null;

async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
	serviceWorkerRegistrationPromise ??= (async () => {
		const registration = await navigator.serviceWorker.register('/sw.js');
		await registration.update().catch(() => undefined);
		const readyRegistration = await withTimeout(
			navigator.serviceWorker.ready,
			10_000,
			'Timed out waiting for the service worker. Try refreshing Threads and enabling notifications again.'
		);
		await waitForActivatedServiceWorker(readyRegistration);
		return readyRegistration;
	})().catch((err) => {
		serviceWorkerRegistrationPromise = null;
		throw err;
	});
	return serviceWorkerRegistrationPromise;
}

async function subscribeWithRecovery(
	registration: ServiceWorkerRegistration,
	applicationServerKey: Uint8Array
): Promise<PushSubscription> {
	try {
		return await subscribeWithTimeout(registration, applicationServerKey, subscribeTimeoutMs());
	} catch (err) {
		if (!isPushSubscribeTimeout(err)) throw err;

		// Desktop Chromium can occasionally take much longer than mobile to return
		// from PushManager.subscribe() while it talks to the browser push service.
		// Before resetting the service worker, give the original registration one
		// last chance to expose a subscription created by the pending browser task.
		const existing = await registration.pushManager.getSubscription().catch(() => null);
		if (existing) return existing;

		// If the browser still has no subscription, reset the registration and retry
		// once. This recovers stale desktop registrations without looping forever.
		serviceWorkerRegistrationPromise = null;
		await registration.unregister().catch(() => undefined);
		const freshRegistration = await getServiceWorkerRegistration();
		const freshExisting = await withTimeout(
			freshRegistration.pushManager.getSubscription(),
			10_000,
			'Timed out checking the existing push subscription. Try refreshing Threads and enabling notifications again.'
		);
		if (freshExisting) return freshExisting;
		try {
			await assertPushPreflightReady(freshRegistration, applicationServerKey);
			return await subscribeWithTimeout(freshRegistration, applicationServerKey, subscribeTimeoutMs());
		} catch (retryErr) {
			if (isPushSubscribeFailure(retryErr)) {
				throw new Error(await buildSubscribeFailureMessage(freshRegistration, applicationServerKey), { cause: retryErr });
			}
			throw retryErr;
		}
	}
}

function subscribeWithTimeout(
	registration: ServiceWorkerRegistration,
	applicationServerKey: Uint8Array,
	ms: number
): Promise<PushSubscription> {
	return withTimeout(
		registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: applicationServerKey as BufferSource
		}),
		ms,
		'Timed out enabling push notifications while waiting for this browser’s push service.'
	);
}

async function assertPushPreflightReady(
	registration: ServiceWorkerRegistration,
	applicationServerKey: Uint8Array
): Promise<void> {
	throwIfKnownUnsupportedPushBrowser();

	if (!registration.active) {
		throw new Error(await buildSubscribeFailureMessage(registration, applicationServerKey));
	}
}

function subscribeTimeoutMs(): number {
	// A very long desktop wait made Chromium forks such as Helium look totally
	// frozen when their PushManager never resolves. Keep this bounded so the UI
	// can surface a useful browser-specific failure instead of spinning forever.
	return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 20_000 : 30_000;
}

async function buildSubscribeFailureMessage(
	registration: ServiceWorkerRegistration,
	applicationServerKey: Uint8Array
): Promise<string> {
	const browser = getUnsupportedPushBrowserLabel();
	if (browser) {
		return `${browser} appears to grant notification permission but cannot create Web Push subscriptions. Use Safari or Chrome for Threads push notifications, or try again after ${browser} fixes PushManager/Web Push support.`;
	}

	const permissionState = await getPushPermissionState(registration, applicationServerKey);
	if (Notification.permission === 'granted' && permissionState === 'granted') {
		return 'This browser granted notification permission but did not finish creating a Web Push subscription. Check browser/OS notification settings, refresh Threads, and try again; if it still fails, use Safari or Chrome.';
	}

	return 'Timed out enabling push notifications while waiting for this browser’s push service. Check browser/OS notification settings, refresh Threads, and try again.';
}

async function getPushPermissionState(
	registration: ServiceWorkerRegistration,
	applicationServerKey: Uint8Array
): Promise<PermissionState | null> {
	try {
		return await registration.pushManager.permissionState({
			userVisibleOnly: true,
			applicationServerKey: applicationServerKey as BufferSource
		});
	} catch {
		return null;
	}
}

function throwIfKnownUnsupportedPushBrowser(): void {
	const message = getUnsupportedPushBrowserMessage();
	if (!message) return;
	throw new Error(message);
}

function getUnsupportedPushBrowserLabel(): string | null {
	const userAgent = navigator.userAgent.toLowerCase();
	const brands = getUserAgentBrands().map((brand) => brand.toLowerCase());
	if (userAgent.includes('helium') || brands.some((brand) => brand.includes('helium'))) return 'Helium';
	return null;
}

function getUserAgentBrands(): string[] {
	const userAgentData = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData;
	return userAgentData?.brands?.map(({ brand }) => brand) ?? [];
}

function isPushSubscribeTimeout(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith('Timed out enabling push notifications');
}

function isPushSubscribeFailure(err: unknown): boolean {
	return err instanceof Error && (
		isPushSubscribeTimeout(err) ||
		err.message.includes('no active Service Worker')
	);
}

async function waitForActivatedServiceWorker(registration: ServiceWorkerRegistration): Promise<void> {
	const worker = registration.active ?? registration.waiting ?? registration.installing;
	if (!worker || worker.state === 'activated') return;

	await withTimeout(
		new Promise<void>((resolve, reject) => {
			worker.addEventListener('statechange', () => {
				if (worker.state === 'activated') resolve();
				if (worker.state === 'redundant') reject(new Error('Service worker became redundant'));
			});
		}),
		10_000,
		'Timed out activating the service worker. Try refreshing Threads and enabling notifications again.'
	);
}

function subscriptionUsesKey(subscription: PushSubscription, applicationServerKey: Uint8Array): boolean {
	const currentKey = subscription.options?.applicationServerKey;
	if (!currentKey) return true;
	const currentBytes = bufferSourceToUint8Array(currentKey);
	if (currentBytes.byteLength !== applicationServerKey.byteLength) return false;
	return currentBytes.every((byte, index) => byte === applicationServerKey[index]);
}

function bufferSourceToUint8Array(source: BufferSource): Uint8Array {
	if (source instanceof ArrayBuffer) return new Uint8Array(source);
	return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = atob(base64);
	return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(message)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
