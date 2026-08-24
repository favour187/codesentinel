import { NextResponse } from 'next/server';
import { assertRepositoryAccess, ForbiddenError, requireUser, UnauthorizedError } from '@/lib/auth/current-user';
import { createLogger } from '@/lib/logger';

/**
 * Shared plumbing for API route handlers.
 *
 * The AI features add a lot of routes that all need the same three things:
 * an authenticated user, a repository access check, and error handling that
 * never leaks an internal message to the client. Repeating that per route is
 * how one of them ends up missing the access check.
 */

const log = createLogger('api');

export interface RouteContext {
  readonly userId: string;
  readonly repositoryId: string;
}

/**
 * Run a handler with the caller authenticated and authorised for a repository.
 *
 * Any thrown error becomes a sanitised JSON response: the detail goes to the
 * server log, the client gets a status code and a generic message.
 */
export async function withRepositoryAccess(
  repositoryId: string,
  handler: (ctx: RouteContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const user = await requireUser();
    await assertRepositoryAccess(user.id, repositoryId);
    return await handler({ userId: user.id, repositoryId });
  } catch (err) {
    return errorResponse(err);
  }
}

/** As above, without a repository in scope. */
export async function withUser(handler: (userId: string) => Promise<NextResponse>): Promise<NextResponse> {
  try {
    const user = await requireUser();
    return await handler(user.id);
  } catch (err) {
    return errorResponse(err);
  }
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
  }

  if (err instanceof ForbiddenError) {
    // Deliberately the same shape as a 404: confirming that a repository
    // exists but is not yours is itself an information leak.
    return NextResponse.json({ ok: false, error: 'Repository not found' }, { status: 404 });
  }

  if (err instanceof BadRequestError) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
  }

  log.error('Unhandled API error', { error: err instanceof Error ? err.message : String(err) });
  return NextResponse.json({ ok: false, error: 'Something went wrong. Please try again.' }, { status: 500 });
}

/** A client-caused error whose message is safe to show. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** Parse a JSON body, rejecting anything that is not an object. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestError('Expected a JSON object.');
    }
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError('Invalid JSON body.');
  }
}

export function requireString(body: Record<string, unknown>, key: string, maxLength = 2000): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`"${key}" is required.`);
  }
  if (value.length > maxLength) {
    throw new BadRequestError(`"${key}" must be ${maxLength} characters or fewer.`);
  }
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, key: string, maxLength = 2000): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequestError(`"${key}" must be a string.`);
  if (value.length > maxLength) throw new BadRequestError(`"${key}" must be ${maxLength} characters or fewer.`);
  return value.trim();
}

export function optionalStringArray(body: Record<string, unknown>, key: string, maxItems = 50): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new BadRequestError(`"${key}" must be an array of strings.`);
  }
  if (value.length > maxItems) throw new BadRequestError(`"${key}" may contain at most ${maxItems} items.`);
  return value as string[];
}

/**
 * Translate an AI result into an HTTP response.
 *
 * "Unavailable" is deliberately 503 with an explanatory message rather than an
 * error: the user has done nothing wrong, the deterministic product still
 * works, and the UI shows this as an inline notice.
 */
export function aiErrorResponse(reason: string, message: string): NextResponse {
  const status = reason === 'unavailable' ? 503 : reason === 'ungrounded' ? 422 : 502;
  return NextResponse.json({ ok: false, error: message, reason }, { status });
}
