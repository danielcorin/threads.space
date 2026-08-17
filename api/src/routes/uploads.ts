import type { Env, User } from '../types.js';
import { generateId, jsonResponse, errorResponse } from '../utils.js';
import { requireChannelMembership } from '../middleware.js';

// 25 MB max upload size
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// MIME types that can execute scripts when rendered in the browser (XSS risk)
const DANGEROUS_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
]);

/** Force dangerous content types to application/octet-stream to prevent XSS. */
export function sanitizeContentType(contentType: string): string {
  const mimeType = contentType.split(';')[0].trim().toLowerCase();
  if (DANGEROUS_MIME_TYPES.has(mimeType)) {
    return 'application/octet-stream';
  }
  return contentType;
}

export async function handleUpload(request: Request, env: Env, user: User): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return errorResponse('Expected multipart/form-data', 400);
  }

  // Check Content-Length header first (fast reject before reading body)
  const contentLength = parseInt(request.headers.get('content-length') ?? '0', 10);
  if (contentLength > MAX_UPLOAD_BYTES) {
    return errorResponse(`File too large. Maximum size is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413);
  }

  const formData = await request.formData();
  // Workers' FormData.get() returns `string | null`; runtime can also yield a File-like blob.
  const file = formData.get('file') as unknown as File | string | null;

  if (!file || typeof file === 'string') {
    return errorResponse('No file provided', 400);
  }

  const id = generateId();
  const r2Key = `${user.id}/${id}/${file.name}`;

  // Store in R2
  const arrayBuffer = await file.arrayBuffer();

  // Check actual file size (Content-Length can be missing or inaccurate)
  if (arrayBuffer.byteLength > MAX_UPLOAD_BYTES) {
    return errorResponse(`File too large. Maximum size is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413);
  }
  const fileContentType = sanitizeContentType(file.type || 'application/octet-stream');
  await env.UPLOADS.put(r2Key, arrayBuffer, {
    httpMetadata: {
      contentType: fileContentType,
    },
  });
  const sizeBytes = arrayBuffer.byteLength;
  await env.DB.prepare(
    'INSERT INTO attachments (id, message_id, r2_key, filename, content_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, null, r2Key, file.name, fileContentType, sizeBytes).run();

  return jsonResponse({
    id,
    filename: file.name,
    contentType: fileContentType,
    sizeBytes,
    url: `/uploads/${r2Key}`,
  }, 201);
}

export async function handleGetUpload(env: Env, user: User, key: string): Promise<Response> {
  // Scope access to the attachment's channel: members of the channel the
  // attachment's message lives in, or the uploader for not-yet-attached
  // uploads (drafts). R2 keys are <uploaderId>/<attachmentId>/<filename>.
  const attachment = await env.DB.prepare(
    'SELECT message_id FROM attachments WHERE r2_key = ?'
  ).bind(key).first<{ message_id: string | null }>();
  if (!attachment) {
    return errorResponse('File not found', 404);
  }
  if (attachment.message_id) {
    const msg = await env.DB.prepare('SELECT channel_id FROM messages WHERE id = ?')
      .bind(attachment.message_id).first<{ channel_id: string }>();
    if (msg) await requireChannelMembership(env, user.id, msg.channel_id);
  } else if (key.split('/')[0] !== user.id) {
    return errorResponse('File not found', 404);
  }

  const object = await env.UPLOADS.get(key);
  if (!object) {
    return errorResponse('File not found', 404);
  }

  const headers = new Headers();
  const contentType = sanitizeContentType(object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('content-type', contentType);
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  headers.set('content-length', String(object.size));

  return new Response(object.body, { headers });
}
