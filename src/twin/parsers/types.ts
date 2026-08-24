import type { EdgeConfidence, SymbolKind } from '@/db/schema';

/**
 * The language-parser contract.
 *
 * Adding a language means adding one module that implements `LanguageParser`
 * and registering it — nothing else in the twin changes. The indexer, the
 * graph builder, component grouping, blast radius and the UI all consume
 * `ParsedFile` and never branch on language.
 *
 * SECURITY: a parser reads text and returns data. It must never execute,
 * evaluate, require or import the code it is given. Repository content is
 * untrusted input, and the only safe way to analyse it is statically. Every
 * parser here works on the source text (TypeScript's own AST for TS/JS, a
 * line-oriented reader for Python) and spawns nothing.
 */

/** A declaration worth reasoning about. Bodies are never captured. */
export interface ParsedSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly isExported: boolean;
  readonly isAsync: boolean;
  readonly parameters: readonly string[];
  /** Declaring class/interface for methods, else null. */
  readonly parentName: string | null;
  /** Branch count inside the declaration — feeds test-gap scenarios. */
  readonly complexity: number;
  /** Declaration text with the body removed. */
  readonly signature: string | null;
}

/** A module specifier as written in the source, before resolution. */
export interface ParsedImport {
  /** Exactly as written: './auth', 'express', '../lib/db'. */
  readonly specifier: string;
  /** Named bindings pulled in — used to resolve calls to a source file. */
  readonly imported: readonly string[];
  readonly line: number;
  /** False for bare specifiers, which resolve to a package rather than a file. */
  readonly isRelative: boolean;
}

/** An HTTP endpoint detected from a routing call or decorator. */
export interface ParsedRoute {
  /** Upper-case verb, or 'ANY' when the framework call does not name one. */
  readonly method: string;
  readonly path: string;
  readonly line: number;
  /** The source text that produced this route — shown as evidence. */
  readonly evidence: string;
}

/** Evidence that a file talks to a database. */
export interface ParsedDatabaseUse {
  /** Table/collection/model name when recoverable, else null. */
  readonly target: string | null;
  /** sql | orm | client — how the access was detected. */
  readonly via: 'sql' | 'orm' | 'client';
  readonly line: number;
  readonly evidence: string;
}

/** An unresolved call site. The graph builder resolves these against imports. */
export interface ParsedCall {
  /** Callee name: `foo` for foo(), `bar` for obj.bar(). */
  readonly callee: string;
  /** Receiver for a member call (`obj` in obj.bar()), else null. */
  readonly receiver: string | null;
  readonly line: number;
  /** Enclosing symbol name, when the call sits inside one. */
  readonly enclosingSymbol: string | null;
}

/** Everything one parser extracts from one file. */
export interface ParsedFile {
  readonly path: string;
  readonly language: string;
  readonly symbols: readonly ParsedSymbol[];
  readonly imports: readonly ParsedImport[];
  readonly exports: readonly string[];
  readonly routes: readonly ParsedRoute[];
  readonly databaseUses: readonly ParsedDatabaseUse[];
  readonly calls: readonly ParsedCall[];
  /** Set when parsing failed; the file is still indexed, just with no detail. */
  readonly error?: string;
}

export interface LanguageParser {
  readonly id: string;
  /** Language ids from scanner/discovery this parser handles. */
  readonly languages: readonly string[];
  parse(path: string, content: string): ParsedFile;
}

/** An empty result — used for unsupported languages and parse failures. */
export function emptyParsedFile(path: string, language: string, error?: string): ParsedFile {
  return {
    path,
    language,
    symbols: [],
    imports: [],
    exports: [],
    routes: [],
    databaseUses: [],
    calls: [],
    ...(error ? { error } : {}),
  };
}

/** Confidence for an edge derived from a resolved import. */
export const CERTAIN: EdgeConfidence = 'certain';
/** Confidence for an edge derived from a name match rather than a resolution. */
export const PROBABLE: EdgeConfidence = 'probable';
