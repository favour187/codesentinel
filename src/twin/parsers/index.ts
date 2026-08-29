import { pythonParser } from './python';
import { typescriptParser } from './typescript';
import { emptyParsedFile, type LanguageParser, type ParsedFile } from './types';










export const PARSERS: readonly LanguageParser[] = [typescriptParser, pythonParser];

const BY_LANGUAGE = new Map<string, LanguageParser>();
for (const parser of PARSERS) {
  for (const language of parser.languages) {
    if (!BY_LANGUAGE.has(language)) BY_LANGUAGE.set(language, parser);
  }
}


export const SUPPORTED_LANGUAGES: readonly string[] = [...BY_LANGUAGE.keys()].sort();

export function parserFor(language: string | null | undefined): LanguageParser | null {
  if (!language) return null;
  return BY_LANGUAGE.get(language) ?? null;
}









export function parseFile(path: string, content: string, language: string | null | undefined): ParsedFile {
  const parser = parserFor(language);
  if (!parser) return emptyParsedFile(path, language ?? 'unknown');
  return parser.parse(path, content);
}

export * from './types';
