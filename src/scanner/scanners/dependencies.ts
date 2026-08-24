import { createFinding } from '../finding';
import type { Finding, ParsedDependency, ScanContext, Scanner, SourceFile } from '../types';
import type { Severity } from '@/db/schema';

/**
 * Dependency scanner.
 *
 * Parses manifests (package.json, requirements.txt, pyproject.toml) and asks
 * the configured VulnerabilityProvider about each package. Manifest parsing and
 * vulnerability lookup are separate concerns: the parsers are pure and fully
 * testable, and the provider is swappable (offline dataset vs OSV.dev).
 */

const SCANNER_ID = 'dependencies';

/** Extracts a concrete version from a spec where one is determinable. */
export function concreteVersion(spec: string): string | null {
  const trimmed = spec.trim();
  // Ranges and wildcards have no single resolved version without a lockfile.
  if (!trimmed || trimmed === '*' || trimmed === 'latest' || trimmed.startsWith('workspace:')) return null;
  if (/^(?:git|github|file|link|npm):/i.test(trimmed) || trimmed.includes('://')) return null;
  const match = /(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/.exec(trimmed);
  return match?.[1] ?? null;
}

export function parsePackageJson(file: SourceFile): ParsedDependency[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return []; // malformed manifest — the quality scanner reports it separately
  }
  if (typeof parsed !== 'object' || parsed === null) return [];

  const manifest = parsed as Record<string, unknown>;
  const dependencies: ParsedDependency[] = [];

  for (const [field, isDev] of [
    ['dependencies', false],
    ['devDependencies', true],
    ['optionalDependencies', true],
  ] as const) {
    const section = manifest[field];
    if (typeof section !== 'object' || section === null) continue;

    for (const [name, spec] of Object.entries(section as Record<string, unknown>)) {
      if (typeof spec !== 'string') continue;
      const lineIndex = file.lines.findIndex((line) => line.includes(`"${name}"`));
      dependencies.push({
        ecosystem: 'npm',
        name,
        versionSpec: spec,
        version: concreteVersion(spec),
        isDev,
        isDirect: true,
        manifestPath: file.path,
        line: lineIndex >= 0 ? lineIndex + 1 : null,
      });
    }
  }

  return dependencies;
}

export function parseRequirementsTxt(file: SourceFile): ParsedDependency[] {
  const dependencies: ParsedDependency[] = [];

  file.lines.forEach((rawLine, index) => {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line || line.startsWith('-')) return; // flags like -r, -e, --index-url

    const match = /^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$/.exec(line);
    const name = match?.[1];
    if (!name) return;

    const spec = (match[3] ?? '').trim();
    dependencies.push({
      ecosystem: 'PyPI',
      name,
      versionSpec: spec || '*',
      // Only pinned (==) requirements have a definite installed version.
      version: spec.startsWith('==') ? concreteVersion(spec) : null,
      isDev: /dev|test/i.test(file.path),
      isDirect: true,
      manifestPath: file.path,
      line: index + 1,
    });
  });

  return dependencies;
}

export function parsePyprojectToml(file: SourceFile): ParsedDependency[] {
  const dependencies: ParsedDependency[] = [];
  let section = '';

  file.lines.forEach((rawLine, index) => {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) return;

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1];
      return;
    }

    // PEP 621: dependencies = ["requests>=2.28", ...]
    if (section === 'project' || section.endsWith('dependencies')) {
      const inline = /["']([A-Za-z0-9._-]+)\s*([<>=!~^][^"']*)?["']/.exec(line);
      if (inline?.[1] && !line.startsWith('[')) {
        const spec = (inline[2] ?? '').trim();
        dependencies.push({
          ecosystem: 'PyPI',
          name: inline[1],
          versionSpec: spec || '*',
          version: spec.startsWith('==') ? concreteVersion(spec) : null,
          isDev: /dev|test/i.test(section),
          isDirect: true,
          manifestPath: file.path,
          line: index + 1,
        });
        return;
      }
    }

    // Poetry: requests = "^2.28.0"
    if (section.includes('poetry.dependencies') || section.includes('poetry.group')) {
      const poetry = /^([A-Za-z0-9._-]+)\s*=\s*["']([^"']+)["']/.exec(line);
      if (poetry?.[1] && poetry[1].toLowerCase() !== 'python') {
        dependencies.push({
          ecosystem: 'PyPI',
          name: poetry[1],
          versionSpec: poetry[2] ?? '*',
          version: concreteVersion(poetry[2] ?? ''),
          isDev: section.includes('dev'),
          isDirect: true,
          manifestPath: file.path,
          line: index + 1,
        });
      }
    }
  });

  return dependencies;
}

export function parseManifests(files: readonly SourceFile[]): ParsedDependency[] {
  const dependencies: ParsedDependency[] = [];

  for (const file of files) {
    const base = file.path.split('/').pop()?.toLowerCase() ?? '';
    if (base === 'package.json') dependencies.push(...parsePackageJson(file));
    else if (base === 'requirements.txt' || /^requirements-[\w.]+\.txt$/.test(base)) {
      dependencies.push(...parseRequirementsTxt(file));
    } else if (base === 'pyproject.toml') dependencies.push(...parsePyprojectToml(file));
  }

  return dependencies;
}

/** Highest severity across a set of advisories. */
function worstSeverity(severities: readonly Severity[]): Severity {
  const order: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  for (const severity of order) {
    if (severities.includes(severity)) return severity;
  }
  return 'info';
}

export const dependencyScanner: Scanner = {
  id: SCANNER_ID,
  name: 'Dependency scanner',
  description: 'Parses dependency manifests and reports packages with known published vulnerabilities.',
  categories: ['dependencies'],
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async scan(ctx: ScanContext): Promise<Finding[]> {
    const dependencies = parseManifests(ctx.files);
    if (dependencies.length === 0) return [];

    const provider = ctx.vulnerabilityProvider;
    const vulnerabilities = await provider.lookup(dependencies);
    const findings: Finding[] = [];

    for (const dependency of dependencies) {
      const records = vulnerabilities.get(`${dependency.ecosystem}:${dependency.name}`);
      if (!records?.length) continue;

      const severity = worstSeverity(records.map((r) => r.severity));
      const fixedIn = records
        .map((r) => r.fixedIn)
        .filter((v): v is string => Boolean(v))
        .sort()
        .pop();

      findings.push(
        createFinding({
          ruleId: `dependency/vulnerable-package`,
          scannerId: SCANNER_ID,
          severity,
          category: 'dependencies',
          title: `${dependency.name}@${dependency.version ?? dependency.versionSpec} has ${records.length} known ${records.length === 1 ? 'vulnerability' : 'vulnerabilities'}`,
          description: records.map((r) => `${r.id}: ${r.summary}`).join('\n'),
          filePath: dependency.manifestPath,
          lineStart: dependency.line,
          evidence: `"${dependency.name}": "${dependency.versionSpec}"`,
          confidence: 0.95,
          whyItMatters:
            severity === 'critical' || severity === 'high'
              ? 'A published advisory means the exploit path is public knowledge and automated scanners are already probing for it. Vulnerable dependencies are one of the most common initial access vectors precisely because they need no bug in your own code.'
              : 'This package has a published advisory. Even lower-severity issues are worth clearing while the upgrade is small, before the version gap makes it a risky migration.',
          remediation: fixedIn
            ? `Upgrade ${dependency.name} to ${fixedIn} or later, then run your test suite to confirm nothing depended on the old behaviour.`
            : `Review the advisories for ${dependency.name} and upgrade to a patched release.`,
          references: records.map((record) => ({ label: record.id, url: record.url })),
          metadata: {
            ecosystem: dependency.ecosystem,
            package: dependency.name,
            version: dependency.version,
            versionSpec: dependency.versionSpec,
            isDev: dependency.isDev,
            fixedIn: fixedIn ?? null,
            advisories: records,
            provider: provider.name,
          },
          fingerprintSeed: `vulnerable-package:${dependency.ecosystem}:${dependency.name}`,
        }),
      );
    }

    return findings;
  },
};
