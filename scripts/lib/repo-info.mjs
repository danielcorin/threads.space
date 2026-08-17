import { spawnSync } from 'node:child_process';

function runGit(repoRoot, args, { allowFailure = false } = {}) {
  const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (res.status !== 0 && !allowFailure) {
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    throw new Error(`git ${args.join(' ')} failed${out ? `: ${out}` : ''}`);
  }
  return (res.stdout ?? '').trim();
}

export function shortSha(sha) {
  return sha ? sha.slice(0, 7) : '';
}

export function repoCommit(repoRoot) {
  const full = runGit(repoRoot, ['rev-parse', 'HEAD']);
  return { short: shortSha(full), full };
}

export function normalizeGitHubRepoUrl(remoteUrl) {
  if (!remoteUrl) return null;
  let value = remoteUrl.trim();
  if (!value) return null;

  const gitSsh = value.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (gitSsh) return `https://github.com/${gitSsh[1]}`;

  const ssh = value.match(/^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1]}`;

  const https = value.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (https) return `https://github.com/${https[1]}`;

  return null;
}

export function githubRepoUrl(repoRoot) {
  if (process.env.PUBLIC_REPO_URL) return normalizeGitHubRepoUrl(process.env.PUBLIC_REPO_URL);
  if (process.env.GITHUB_REPOSITORY)
    return normalizeGitHubRepoUrl(`https://github.com/${process.env.GITHUB_REPOSITORY}`);

  const remote = runGit(repoRoot, ['remote', 'get-url', 'origin'], { allowFailure: true });
  return normalizeGitHubRepoUrl(remote);
}
