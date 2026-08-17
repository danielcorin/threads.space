import { spawn, execSync, execFileSync, type ChildProcess } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API_PORT = 8788;
const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT || 5173);
const API_DIR = resolve(__dirname, '../../api');
const CLIENT_DIR = resolve(__dirname, '..');

let apiProcess: ChildProcess;
let clientProcess: ChildProcess;

async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res) return;
    } catch {
      // Connection refused, keep retrying
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms at ${url}`);
}

async function setup() {
  // 1. Wipe API state for a fresh database
  execSync('rm -rf .wrangler/state', { cwd: API_DIR, stdio: 'pipe' });

  // 2. Apply all migrations to local D1
  const migrationsDir = resolve(API_DIR, 'migrations');
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    execSync(`npx wrangler d1 execute threads --local --file=./migrations/${file}`, {
      cwd: API_DIR,
      stdio: 'pipe',
    });
  }

  // 2b. Seed the test users directly in local D1 (there is no admin HTTP
  // endpoint anymore). Done before the server starts to avoid a concurrent
  // sqlite writer.
  const { hashPassword, generateId, q } = await import('../../api/scripts/seed-lib.mjs');
  for (const user of [
    { username: 'testuser', password: 'testpass123', display_name: 'Test User' },
    { username: 'testuser2', password: 'testpass123', display_name: 'Test User 2' },
  ]) {
    const hash = await hashPassword(user.password);
    const email = `${user.username}@example.com`;
    const sql = `INSERT INTO users (id, username, password_hash, email, email_normalized, email_verified_at, display_name, role, is_admin) VALUES (${q(generateId())}, ${q(user.username)}, ${q(hash)}, ${q(email)}, ${q(email)}, unixepoch(), ${q(user.display_name)}, 'human', 0)`;
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'threads', '--local', '--command', sql], { cwd: API_DIR, stdio: 'pipe' });
  }

  // 3. Start the API server
  apiProcess = spawn('npx', ['wrangler', 'dev', '--port', String(API_PORT), '--local'], {
    cwd: API_DIR,
    stdio: 'pipe',
    env: { ...process.env },
  });

  apiProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString();
    if (msg.includes('ERROR') || msg.includes('error')) {
      console.error('[api stderr]', msg);
    }
  });

  apiProcess.on('error', (err) => {
    console.error('[api process error]', err);
  });

  await waitForServer(`http://localhost:${API_PORT}/channels`);

  // 4. Create a default "general" channel so tests have something to work with
  // First login as testuser to get a session cookie
  const loginRes = await fetch(`http://localhost:${API_PORT}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass123' }),
  });
  const cookies = loginRes.headers.getSetCookie();
  const sessionCookie = cookies.find((c) => c.startsWith('session='));
  const cookieValue = sessionCookie?.split(';')[0] || '';

  const channelRes = await fetch(`http://localhost:${API_PORT}/channels`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieValue,
    },
    body: JSON.stringify({ name: 'general', description: 'General discussion' }),
  });
  const channelData = (await channelRes.json()) as { id: string };

  // 6. Have testuser2 join the general channel
  const login2Res = await fetch(`http://localhost:${API_PORT}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'testuser2', password: 'testpass123' }),
  });
  const cookies2 = login2Res.headers.getSetCookie();
  const sessionCookie2 = cookies2.find((c) => c.startsWith('session='));
  const cookieValue2 = sessionCookie2?.split(';')[0] || '';

  await fetch(`http://localhost:${API_PORT}/channels/${channelData.id}/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieValue2,
    },
  });

  // 7. Start the client dev server
  clientProcess = spawn('npm', ['run', 'dev', '--', '--port', String(CLIENT_PORT), '--strictPort'], {
    cwd: CLIENT_DIR,
    stdio: 'pipe',
    env: { ...process.env },
  });

  clientProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString();
    if (msg.includes('ERROR')) {
      console.error('[client stderr]', msg);
    }
  });

  clientProcess.on('error', (err) => {
    console.error('[client process error]', err);
  });

  await waitForServer(`http://localhost:${CLIENT_PORT}`);
}

async function teardown() {
  for (const proc of [clientProcess, apiProcess]) {
    if (proc) {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1000));
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }
  }
}

export default async function globalSetup() {
  await setup();
  return teardown;
}
