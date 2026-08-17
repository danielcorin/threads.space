// Local "agent" that receives Threads webhook deliveries and responds over REST.
//
// Stands in for a serverless bot: it has no persistent WebSocket. It verifies the
// HMAC signature on each delivery (Stripe/GitHub-style), then - for `message`
// events from someone other than itself - posts an echo reply back to the
// channel using its bearer token. The bot is self-echo-excluded from webhook
// delivery, so its own reply does not loop back.
//
// Driven by scripts/webhook-e2e.sh, which mints the token + webhook and exposes
// this server through a cloudflared tunnel. Config comes from env:
//   PORT               local port to listen on
//   WEBHOOK_SECRET     HMAC signing key returned at webhook creation
//   THREADS_API_URL    e.g. http://localhost:8788
//   THREADS_BOT_TOKEN  bearer token to respond with
//   BOT_USER_ID        this bot's user id (to skip its own messages)
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import process from 'node:process';

const PORT = Number(process.env.PORT ?? 9099);
const SECRET = process.env.WEBHOOK_SECRET ?? '';
const API_URL = (process.env.THREADS_API_URL ?? 'http://localhost:8788').replace(/\/$/, '');
const BOT_TOKEN = process.env.THREADS_BOT_TOKEN ?? '';
const BOT_USER_ID = process.env.BOT_USER_ID ?? '';

function verifySignature(timestamp, rawBody, header) {
  if (!SECRET || !header) return false;
  const expected = createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  const got = header.replace(/^sha256=/, '');
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

async function postReply(channelId, content) {
  const res = await fetch(`${API_URL}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BOT_TOKEN}` },
    body: JSON.stringify({ content }),
  });
  const body = await res.text();
  console.log(`  -> replied via REST: ${res.status} ${res.ok ? 'OK' : body}`);
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const eventId = req.headers['x-threads-event-id'];
    const timestamp = req.headers['x-threads-timestamp'];
    const signature = req.headers['x-threads-signature'];

    const valid = verifySignature(timestamp, rawBody, signature);
    console.log(`\n<- webhook ${eventId} (sig ${valid ? 'VALID' : 'INVALID'})`);

    if (!valid) {
      res.writeHead(401).end('bad signature');
      return;
    }

    // Ack immediately so a slow reply can't trip the delivery timeout.
    res.writeHead(200).end('ok');

    let envelope;
    try {
      envelope = JSON.parse(rawBody);
    } catch {
      console.log('  (unparseable body)');
      return;
    }
    const { type, channel_id: channelId, data } = envelope;
    console.log(`  type=${type} channel=${channelId} from=@${data?.username ?? '?'}: ${JSON.stringify(data?.content ?? '')}`);

    if (type === 'message' && data?.userId && data.userId !== BOT_USER_ID) {
      await postReply(channelId, `echo: ${data.content}`).catch((err) => console.error('  reply failed:', err));
    }
  });
});

server.listen(PORT, () => {
  console.log(`webhook receiver listening on :${PORT} (bot ${BOT_USER_ID || '?'})`);
});
