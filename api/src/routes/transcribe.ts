import type { Env, User } from '../types.js';
import { jsonResponse, errorResponse } from '../utils.js';

// OpenAI Whisper large-v3-turbo on Workers AI: best-accuracy multilingual ASR,
// billed per audio-minute. Batch (not streaming) — a good fit for press-to-record
// voice memos from the composer. See api/openapi/threads.yaml POST /transcribe.
const TRANSCRIBE_MODEL = '@cf/openai/whisper-large-v3-turbo';

// Voice memos are short; cap the body so a bad/oversized upload can't run up
// Workers AI cost or latency. Matches the /uploads attachment ceiling (25 MB).
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * POST /transcribe — transcribe a short audio clip to text.
 *
 * Body: raw audio bytes (audio/webm, audio/mp4, audio/ogg, ...). The browser
 * MediaRecorder produces one of these depending on the platform; Whisper detects
 * the container itself, so we forward the bytes as-is (base64-encoded).
 * Response: { text } — the transcription, or "" when nothing intelligible was heard.
 */
export async function handleTranscribe(request: Request, env: Env, _user: User): Promise<Response> {
  // env.AI is unset in the test harness and on instances without a Workers AI
  // binding. Fail closed with a clear signal rather than throwing.
  if (!env.AI) {
    return errorResponse('Transcription is not available on this instance', 501);
  }

  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  // Accept audio/* plus the generic octet-stream some browsers emit when the
  // MediaRecorder mimeType is empty. Reject anything obviously non-audio early.
  if (!contentType.startsWith('audio/') && !contentType.startsWith('application/octet-stream')) {
    return errorResponse('Expected an audio/* request body', 415);
  }

  // Fast reject on the declared length before reading the body.
  const declaredLength = parseInt(request.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
    return errorResponse(`Audio too large. Maximum size is ${MAX_AUDIO_BYTES / 1024 / 1024} MB`, 413);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    return errorResponse('No audio provided', 400);
  }
  // Content-Length can be missing or wrong; enforce against the actual body too.
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    return errorResponse(`Audio too large. Maximum size is ${MAX_AUDIO_BYTES / 1024 / 1024} MB`, 413);
  }

  let text: string;
  try {
    const result = await env.AI.run(TRANSCRIBE_MODEL, { audio: toBase64(bytes) });
    text = (result.text ?? '').trim();
  } catch {
    // Model errors (bad audio, upstream 5xx) surface as a bad-gateway to the client.
    return errorResponse('Transcription failed', 502);
  }

  return jsonResponse({ text });
}

/**
 * Base64-encode audio bytes for the Whisper `audio` field. Built in chunks so a
 * multi-MB clip doesn't overflow the argument limit of String.fromCharCode.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000; // 32 KB per fromCharCode call
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
