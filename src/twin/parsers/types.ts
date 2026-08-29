import type { EdgeConfidence, SymbolKind } from '@/db/schema';

















export interface ParsedSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly isExported: boolean;
  readonly isAsync: boolean;
  readonly parameters: readonly string[];

  readonly parentName: string | null;

  readonly complexity: number;

  readonly signature: string | null;
}


export interface ParsedImport {

  readonly specifier: string;

  readonly imported: readonly string[];
  readonly line: number;

  readonly isRelative: boolean;
}


export interface ParsedRoute {

  readonly method: string;
  readonly path: string;
  readonly line: number;

  readonly evidence: string;
}


export interface ParsedDatabaseUse {

  readonly target: string | null;

  readonly via: 'sql' | 'orm' | 'client';
  readonly line: number;
  readonly evidence: string;
}


export interface ParsedCall {

  readonly callee: string;

  readonly receiver: string | null;
  readonly line: number;

  readonly enclosingSymbol: string | null;
}


export interface ParsedFile {
  readonly path: string;
  readonly language: string;
  readonly symbols: readonly ParsedSymbol[];
  readonly imports: readonly ParsedImport[];
  readonly exports: readonly string[];
  readonly routes: readonly ParsedRoute[];
  readonly databaseUses: readonly ParsedDatabaseUse[];
  readonly calls: readonly ParsedCall[];

  readonly error?: string;
}

export interface LanguageParser {
  readonly id: string;

  readonly languages: readonly string[];
  parse(path: string, content: string): ParsedFile;
}


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


export const CERTAIN: EdgeConfidence = 'certain';

export const PROBABLE: EdgeConfidence = 'probable';
