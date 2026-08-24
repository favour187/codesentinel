import { pythonParser } from './python';
import { typescriptParser } from './typescript';
import { emptyParsedFile, type LanguageParser, type ParsedFile } from './types';

/**
 * Parser registry.
 *
 * The one place that knows which languages have a parser. Adding Go or Ruby
 * means writing a module against `LanguageParser` and appending it here; no
 * caller changes, because callers only ever ask for "the parser for this
 * language" and handle the null case the same way they already do.
 */

export const PARSERS: readonly LanguageParser[] = [typescriptParser, pythonParser];

const BY_LANGUAGE = new Map<string, LanguageParser>();
for (const parser of PARSERS) {
  for (const language of parser.languages) {
    if (!BY_LANGUAGE.has(language)) BY_LANGUAGE.set(language, parser);
  }
}

/** Languages the twin can extract structure from. */
export const SUPPORTED_LANGUAGES: readonly string[] = [...BY_LANGUAGE.keys()].sort();

export function parserFor(language: string | null | undefined): LanguageParser | null {
  if (!language) return null;
  return BY_LANGUAGE.get(language) ?? null;
}

/**
 * Parse a file, or return an empty result when the language is unsupported.
 *
 * Unsupported files are still worth indexing — they exist, they have a size,
 * they can hold findings — they just contribute no symbols or edges. Returning
 * an empty ParsedFile rather than throwing keeps that distinction cheap for
 * the indexer.
 */
export function parseFile(path: string, content: string, language: string | null | undefined): ParsedFile {
  const parser = parserFor(language);
  if (!parser) return emptyParsedFile(path, language ?? 'unknown');
  return parser.parse(path, content);
}

export * from './types';
