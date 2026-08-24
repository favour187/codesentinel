import { describe, expect, it } from 'vitest';

import {
  TwinGraph,
  fileOfKey,
  isDatabaseKey,
  isFileKey,
  isPackageKey,
  isRouteKey,
  isSymbolKey,
  labelOfKey,
  parseRouteKey,
  symbolNameOfKey,
} from '@/twin/graph';
import type { GraphEdge } from '@/twin/graph';
import type { EdgeType } from '@/db/schema';

/**
 * The graph read layer is pure over an edge list, so these tests construct the
 * edges directly. Database-backed behaviour is covered by the impact, gap and
 * prioritization suites.
 */

function edge(type: EdgeType, fromKey: string, toKey: string, evidence = 'e'): GraphEdge {
  return {
    type,
    fromKey,
    toKey,
    confidence: 'certain',
    evidence,
    lineNumber: 1,
  };
}

describe('edge key vocabulary', () => {
  it('recognises each endpoint form', () => {
    expect(isFileKey('src/a.ts')).toBe(true);
    expect(isSymbolKey('src/a.ts#foo')).toBe(true);
    expect(isPackageKey('pkg:react')).toBe(true);
    expect(isRouteKey('api:GET /users')).toBe(true);
    expect(isDatabaseKey('db:users')).toBe(true);
  });

  it('does not confuse the forms with one another', () => {
    expect(isFileKey('pkg:react')).toBe(false);
    // A symbol key still addresses a file in the repository, so it is a file key.
    expect(isFileKey('src/a.ts#foo')).toBe(true);
    expect(isSymbolKey('src/a.ts')).toBe(false);
    expect(isRouteKey('db:users')).toBe(false);
  });

  it('extracts the owning file from a symbol key', () => {
    expect(fileOfKey('src/a.ts#foo')).toBe('src/a.ts');
    expect(fileOfKey('src/a.ts')).toBe('src/a.ts');
    expect(fileOfKey('pkg:react')).toBeNull();
  });

  it('extracts the symbol name only from a symbol key', () => {
    expect(symbolNameOfKey('src/a.ts#foo')).toBe('foo');
    expect(symbolNameOfKey('src/a.ts')).toBeNull();
  });

  it('parses a route key into method and path', () => {
    expect(parseRouteKey('api:GET /users/:id')).toEqual({ method: 'GET', path: '/users/:id' });
    expect(parseRouteKey('src/a.ts')).toBeNull();
  });

  it('labels every key form readably', () => {
    expect(labelOfKey('pkg:react')).toContain('react');
    expect(labelOfKey('api:GET /users')).toContain('/users');
    expect(labelOfKey('db:users')).toContain('users');
    expect(labelOfKey('src/a.ts#foo')).toContain('foo');
  });
});

describe('TwinGraph traversal', () => {
  /**
   *   a.ts <- b.ts <- c.ts
   *        <- d.ts
   */
  const graph = new TwinGraph([
    edge('imports', 'src/b.ts', 'src/a.ts', "imports './a'"),
    edge('imports', 'src/c.ts', 'src/b.ts'),
    edge('imports', 'src/d.ts', 'src/a.ts'),
    edge('imports', 'src/b.ts', 'pkg:lodash'),
    edge('exposes_api', 'src/c.ts', 'api:GET /things'),
    edge('uses_database', 'src/a.ts', 'db:things'),
    edge('tests', 'tests/a.test.ts', 'src/a.ts'),
    edge('calls', 'src/b.ts#run', 'src/a.ts#helper', 'run() line 3'),
  ]);

  it('lists direct dependents and dependencies', () => {
    expect(graph.dependentsOf('src/a.ts').sort()).toEqual(['src/b.ts', 'src/d.ts']);
    expect(graph.dependenciesOf('src/b.ts')).toContain('src/a.ts');
  });

  it('excludes external packages from file dependencies', () => {
    expect(graph.dependenciesOf('src/b.ts')).not.toContain('pkg:lodash');
  });

  it('walks dependents outward with increasing depth', () => {
    const reached = graph.reachableDependents(['src/a.ts'], { maxDepth: 3, maxNodes: 50 });
    const byPath = new Map(reached.map((r) => [r.path, r.depth]));

    expect(byPath.get('src/b.ts')).toBe(1);
    expect(byPath.get('src/d.ts')).toBe(1);
    expect(byPath.get('src/c.ts')).toBe(2);
  });

  it('excludes the origin, which is changed rather than affected', () => {
    const reached = graph.reachableDependents(['src/a.ts'], { maxDepth: 3, maxNodes: 50 });
    expect(reached.map((r) => r.path)).not.toContain('src/a.ts');
  });

  it('records the hop each file was reached through', () => {
    const reached = graph.reachableDependents(['src/a.ts'], { maxDepth: 3, maxNodes: 50 });
    expect(reached.find((r) => r.path === 'src/c.ts')?.via).toBe('src/b.ts');
  });

  it('respects maxDepth', () => {
    const reached = graph.reachableDependents(['src/a.ts'], { maxDepth: 1, maxNodes: 50 });
    expect(reached.map((r) => r.path)).not.toContain('src/c.ts');
  });

  it('respects maxNodes', () => {
    const reached = graph.reachableDependents(['src/a.ts'], { maxDepth: 3, maxNodes: 2 });
    expect(reached.length).toBeLessThanOrEqual(2);
  });

  it('terminates on a cycle', () => {
    const cyclic = new TwinGraph([
      edge('imports', 'src/x.ts', 'src/y.ts'),
      edge('imports', 'src/y.ts', 'src/x.ts'),
    ]);
    const reached = cyclic.reachableDependents(['src/x.ts'], { maxDepth: 5, maxNodes: 50 });
    // y depends on x; x is the origin and is never re-emitted.
    expect(reached).toEqual([{ path: 'src/y.ts', depth: 1, via: 'src/x.ts' }]);
  });

  it('finds routes and databases for a set of files', () => {
    expect(graph.routesOf(['src/c.ts'])).toEqual([
      expect.objectContaining({ route: 'GET /things', filePath: 'src/c.ts' }),
    ]);
    expect(graph.databasesOf(['src/a.ts'])).toEqual([
      expect.objectContaining({ target: 'things', filePath: 'src/a.ts' }),
    ]);
  });

  it('reports tests covering a file and the set of tested files', () => {
    expect(graph.testsCovering(['src/a.ts'])).toEqual([
      expect.objectContaining({ testPath: 'tests/a.test.ts', covers: 'src/a.ts' }),
    ]);
    expect(graph.testedFiles().has('src/a.ts')).toBe(true);
    expect(graph.testedFiles().has('src/b.ts')).toBe(false);
  });

  it('resolves symbol callers back to their file with evidence', () => {
    const callers = graph.callersOfSymbol('src/a.ts#helper');
    expect(callers).toHaveLength(1);
    expect(callers[0]?.filePath).toBe('src/b.ts');
    expect(callers[0]?.evidence).toBe('run() line 3');
  });

  it('lists only real file nodes', () => {
    const files = graph.files();
    expect(files).toContain('src/a.ts');
    expect(files).not.toContain('pkg:lodash');
    expect(files).not.toContain('api:GET /things');
  });

  it('filters edges by type', () => {
    expect(graph.edgesFrom('src/b.ts', 'imports')).toHaveLength(2);
    expect(graph.edgesTo('src/a.ts', 'tests')).toHaveLength(1);
  });

  it('handles an empty graph without throwing', () => {
    const empty = new TwinGraph([]);
    expect(empty.files()).toEqual([]);
    expect(empty.dependentsOf('src/a.ts')).toEqual([]);
    expect(empty.reachableDependents(['src/a.ts'], { maxDepth: 3, maxNodes: 10 })).toEqual([]);
  });
});
