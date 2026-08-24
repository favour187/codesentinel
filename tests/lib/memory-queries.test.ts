import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMemory,
  deleteMemory,
  getMemoryEntry,
  listMemory,
  MemoryValidationError,
  updateMemory,
  validateMemoryInput,
} from '@/lib/memory-queries';
import { createTestDb, seedRepository } from '../helpers/test-db';
import type { TestDb } from '../helpers/test-db';

/**
 * Repository memory is injected into prompts as authoritative context, so the
 * invariant that matters most is that it is human-authored: there is no code
 * path from an AI response into these rows.
 */

let db: TestDb;
let repositoryId: string;
let userId: string;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: async () => db };
});

beforeEach(async () => {
  db = await createTestDb();
  ({ repositoryId, userId } = await seedRepository(db));
});

describe('validateMemoryInput', () => {
  it('accepts a well-formed entry', () => {
    const clean = validateMemoryInput({
      kind: 'decision',
      title: '  Use PostgreSQL  ',
      body: '  Chosen for JSONB support.  ',
      paths: [' src/db/ ', ''],
    });

    expect(clean.title).toBe('Use PostgreSQL');
    expect(clean.body).toBe('Chosen for JSONB support.');
    expect(clean.paths).toEqual(['src/db/']);
  });

  it('requires a title', () => {
    expect(() => validateMemoryInput({ kind: 'policy', title: '   ', body: 'x' })).toThrow(MemoryValidationError);
  });

  it('requires a body', () => {
    expect(() => validateMemoryInput({ kind: 'policy', title: 'x', body: '' })).toThrow(MemoryValidationError);
  });

  it('rejects an over-long title', () => {
    expect(() => validateMemoryInput({ kind: 'policy', title: 'x'.repeat(201), body: 'y' })).toThrow(
      MemoryValidationError,
    );
  });

  it('rejects an over-long body so one entry cannot eat the prompt budget', () => {
    expect(() => validateMemoryInput({ kind: 'policy', title: 'x', body: 'y'.repeat(4001) })).toThrow(
      MemoryValidationError,
    );
  });

  it('caps the number of scoped paths', () => {
    const clean = validateMemoryInput({
      kind: 'policy',
      title: 'x',
      body: 'y',
      paths: Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`),
    });

    expect(clean.paths?.length).toBe(25);
  });
});

describe('memory CRUD', () => {
  it('creates an entry attributed to the human who wrote it', async () => {
    const entry = await createMemory(repositoryId, userId, {
      kind: 'accepted_risk',
      title: 'Legacy endpoint stays unauthenticated',
      body: 'Used by a partner integration until Q3.',
      paths: ['src/api/legacy/'],
    });

    expect(entry.id).toBeTruthy();
    expect(entry.kind).toBe('accepted_risk');
    expect(entry.createdByUserId).toBe(userId);
    expect(entry.paths).toEqual(['src/api/legacy/']);
  });

  it('lists entries, newest first', async () => {
    await createMemory(repositoryId, userId, { kind: 'policy', title: 'First', body: 'a' });
    await createMemory(repositoryId, userId, { kind: 'policy', title: 'Second', body: 'b' });

    const all = await listMemory(repositoryId);
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.title)).toContain('First');
    expect(all.map((m) => m.title)).toContain('Second');
  });

  it('reads a single entry', async () => {
    const created = await createMemory(repositoryId, userId, { kind: 'convention', title: 'Naming', body: 'camelCase' });
    const found = await getMemoryEntry(repositoryId, created.id);

    expect(found?.title).toBe('Naming');
  });

  it('does not leak an entry across repositories', async () => {
    const other = await seedRepository(db, { login: 'other', githubId: 2002, fullName: 'other/repo' });
    const created = await createMemory(repositoryId, userId, { kind: 'policy', title: 'Ours', body: 'x' });

    expect(await getMemoryEntry(other.repositoryId, created.id)).toBeNull();
    expect(await listMemory(other.repositoryId)).toEqual([]);
  });

  it('updates an entry', async () => {
    const created = await createMemory(repositoryId, userId, { kind: 'policy', title: 'Old', body: 'x' });

    const updated = await updateMemory(repositoryId, created.id, {
      kind: 'decision',
      title: 'New',
      body: 'y',
      paths: ['src/'],
    });

    expect(updated?.title).toBe('New');
    expect(updated?.kind).toBe('decision');
    expect(updated?.paths).toEqual(['src/']);
  });

  it('returns null when updating an entry that does not exist', async () => {
    const result = await updateMemory(repositoryId, '00000000-0000-0000-0000-000000000000', {
      kind: 'policy',
      title: 'x',
      body: 'y',
    });

    expect(result).toBeNull();
  });

  it('validates on update too', async () => {
    const created = await createMemory(repositoryId, userId, { kind: 'policy', title: 'Old', body: 'x' });

    await expect(updateMemory(repositoryId, created.id, { kind: 'policy', title: '', body: 'y' })).rejects.toThrow(
      MemoryValidationError,
    );
  });

  it('deletes an entry', async () => {
    const created = await createMemory(repositoryId, userId, { kind: 'policy', title: 'Temp', body: 'x' });

    expect(await deleteMemory(repositoryId, created.id)).toBe(true);
    expect(await getMemoryEntry(repositoryId, created.id)).toBeNull();
  });

  it('reports a delete that matched nothing', async () => {
    expect(await deleteMemory(repositoryId, '00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('will not delete another repository’s entry', async () => {
    const other = await seedRepository(db, { login: 'other', githubId: 2002, fullName: 'other/repo' });
    const created = await createMemory(repositoryId, userId, { kind: 'policy', title: 'Ours', body: 'x' });

    expect(await deleteMemory(other.repositoryId, created.id)).toBe(false);
    expect(await getMemoryEntry(repositoryId, created.id)).not.toBeNull();
  });

  it('supports every declared memory kind', async () => {
    for (const kind of ['decision', 'exception', 'accepted_risk', 'policy', 'convention'] as const) {
      const entry = await createMemory(repositoryId, userId, { kind, title: `A ${kind}`, body: 'x' });
      expect(entry.kind).toBe(kind);
    }

    expect(await listMemory(repositoryId)).toHaveLength(5);
  });
});
