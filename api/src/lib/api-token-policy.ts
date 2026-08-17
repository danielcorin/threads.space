export const API_TOKEN_SCOPES = [
  'threads:read',
  'threads:write',
  'users:provision',
  'tokens:manage',
] as const;
export type ApiTokenScope = typeof API_TOKEN_SCOPES[number];

export interface ApiTokenPolicy {
  scopes: ApiTokenScope[];
  expiresAt: number | null;
}

export function parseApiTokenScopes(raw: string): ApiTokenScope[] {
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    return values.filter((value): value is ApiTokenScope =>
      API_TOKEN_SCOPES.includes(value as ApiTokenScope));
  } catch {
    return [];
  }
}

export function createApiTokenPolicy(input: {
  scopes?: unknown;
  expiresInDays?: unknown;
}): ApiTokenPolicy | { error: string } {
  const requestedScopes = input.scopes === undefined
    ? ['threads:read', 'threads:write']
    : input.scopes;
  if (!Array.isArray(requestedScopes)
    || requestedScopes.length === 0
    || requestedScopes.some((scope) => !API_TOKEN_SCOPES.includes(scope as ApiTokenScope))) {
    return { error: `scopes must contain one or more of: ${API_TOKEN_SCOPES.join(', ')}` };
  }
  const scopes = [...new Set(requestedScopes)] as ApiTokenScope[];

  const days = input.expiresInDays === undefined ? 90 : input.expiresInDays;
  if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650)) {
    return { error: 'expires_in_days must be null or an integer from 1 to 3650' };
  }
  return {
    scopes,
    expiresAt: days === null ? null : Math.floor(Date.now() / 1000) + days * 24 * 60 * 60,
  };
}
