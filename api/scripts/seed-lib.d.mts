// Type declarations for seed-lib.mjs (imported by the test/e2e harnesses).
export function hashPassword(plain: string): Promise<string>;
export function generateId(): string;
export function q(value: unknown): string;
export function adminUpsertSql(username: string, password: string, display: string, email: string, emailVerified?: boolean): Promise<string>;
