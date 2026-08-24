import { GITHUB_API, getInstallationToken } from './app-auth';
import { createLogger } from '@/lib/logger';

/**
 * Thin GitHub REST client scoped to what the guardian actually needs.
 *
 * Deliberately hand-rolled instead of pulling in Octokit: we use ~8 endpoints,
 * and this keeps the dependency surface (and the supply-chain risk a security
 * product should care about) small. It also lets every call be injected with a
 * fake `fetch` in tests.
 */

const log = createLogger('github:client');

export interface GitHubClientOptions {
  /** Installation token, or a user OAuth token for read-only flows. */
  token: string;
  fetchImpl?: typeof fetch;
  /** Retry budget for transient failures (5xx / secondary rate limits). */
  maxRetries?: number;
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export interface PullRequestFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface CheckRunOptions {
  name: string;
  headSha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required';
  detailsUrl?: string;
  output?: {
    title: string;
    summary: string;
    text?: string;
    annotations?: CheckAnnotation[];
  };
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
  raw_details?: string;
}

export class GitHubClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
  }

  /** Build a client authenticated as a GitHub App installation. */
  static async forInstallation(installationId: number, fetchImpl: typeof fetch = fetch): Promise<GitHubClient> {
    const token = await getInstallationToken(installationId, fetchImpl);
    return new GitHubClient({ token, fetchImpl });
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    accept = 'application/vnd.github+json',
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const response = await this.fetchImpl(`${GITHUB_API}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CodeSentinel',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return accept.includes('json') ? ((await response.json()) as T) : ((await response.text()) as T);
      }

      const text = await response.text().catch(() => '');

      // 403 with a rate-limit reset, or 5xx, are worth retrying; 4xx are not.
      const retryable = response.status >= 500 || response.status === 429 || isSecondaryRateLimit(response, text);
      lastError = new GitHubApiError(response.status, endpoint, `${response.status} ${text.slice(0, 200)}`);

      if (!retryable || attempt === this.maxRetries) throw lastError;

      const waitMs = retryAfterMs(response) ?? 2 ** attempt * 1000;
      log.warn('Retrying GitHub request', { endpoint, status: response.status, attempt, waitMs });
      await sleep(waitMs);
    }

    throw lastError ?? new Error('GitHub request failed');
  }

  /* ---------------------------------------------------------------------- */
  /* Repository & pull request reads                                        */
  /* ---------------------------------------------------------------------- */

  async getRepository(owner: string, repo: string): Promise<{
    id: number;
    full_name: string;
    default_branch: string;
    private: boolean;
    description: string | null;
    language: string | null;
    html_url: string;
  }> {
    return this.request('GET', `/repos/${owner}/${repo}`);
  }

  async getCommit(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<{
    sha: string;
    commit: {
      message: string;
      author: { name?: string; email?: string; date?: string } | null;
    };
    stats?: { additions?: number; deletions?: number };
    files?: Array<{ filename: string; status?: string; additions?: number; deletions?: number }>;
  }> {
    return this.request('GET', `/repos/${owner}/${repo}/commits/${sha}`);
  }

  async getPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{
    number: number;
    title: string | null;
    state: string;
    draft?: boolean;
    merged?: boolean;
    user?: { login: string } | null;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
    additions?: number;
    deletions?: number;
    changed_files?: number;
  }> {
    return this.request('GET', `/repos/${owner}/${repo}/pulls/${number}`);
  }

  /**
   * List files changed in a pull request.
   *
   * Paginated at 100/page; GitHub caps this endpoint at 3000 files, and very
   * large PRs are exactly the ones where a truncated diff would silently
   * under-report risk — so the caller is told via the `truncated` flag.
   */
  async listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
    maxPages = 10,
  ): Promise<{ files: PullRequestFile[]; truncated: boolean }> {
    const files: PullRequestFile[] = [];
    let page = 1;

    for (; page <= maxPages; page++) {
      const batch = await this.request<PullRequestFile[]>(
        'GET',
        `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      files.push(...batch);
      if (batch.length < 100) return { files, truncated: false };
    }

    return { files, truncated: true };
  }

  /** Raw file contents at a ref. Returns null for missing files (404 is normal). */
  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      return await this.request<string>(
        'GET',
        `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
        undefined,
        'application/vnd.github.raw',
      );
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Download a repository tarball at a ref, following GitHub's redirect. */
  async downloadTarball(owner: string, repo: string, ref: string): Promise<ArrayBuffer> {
    const response = await this.fetchImpl(
      `${GITHUB_API}/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'CodeSentinel',
        },
        redirect: 'follow',
      },
    );
    if (!response.ok) {
      throw new GitHubApiError(response.status, 'tarball', `Tarball download failed: ${response.status}`);
    }
    return response.arrayBuffer();
  }

  /* ---------------------------------------------------------------------- */
  /* Check runs                                                             */
  /* ---------------------------------------------------------------------- */

  async createCheckRun(owner: string, repo: string, options: CheckRunOptions): Promise<{ id: number }> {
    return this.request('POST', `/repos/${owner}/${repo}/check-runs`, {
      name: options.name,
      head_sha: options.headSha,
      status: options.status,
      ...(options.conclusion ? { conclusion: options.conclusion } : {}),
      ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
      ...(options.output ? { output: options.output } : {}),
    });
  }

  async updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: string | number,
    options: Partial<CheckRunOptions>,
  ): Promise<{ id: number }> {
    return this.request('PATCH', `/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
      ...(options.status ? { status: options.status } : {}),
      ...(options.conclusion ? { conclusion: options.conclusion } : {}),
      ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
      ...(options.output ? { output: options.output } : {}),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Issue comments                                                         */
  /* ---------------------------------------------------------------------- */

  async createIssueComment(owner: string, repo: string, number: number, body: string): Promise<{ id: number }> {
    return this.request('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  }

  async updateIssueComment(owner: string, repo: string, commentId: string | number, body: string): Promise<{ id: number }> {
    return this.request('PATCH', `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
  }

  async getIssueComment(owner: string, repo: string, commentId: string | number): Promise<{ id: number } | null> {
    try {
      return await this.request('GET', `/repos/${owner}/${repo}/issues/comments/${commentId}`);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Repositories visible to the current installation. */
  async listInstallationRepositories(): Promise<Array<{ id: number; full_name: string; default_branch: string }>> {
    const payload = await this.request<{
      repositories: Array<{ id: number; full_name: string; default_branch: string }>;
    }>('GET', '/installation/repositories?per_page=100');
    return payload.repositories;
  }
}

function isSecondaryRateLimit(response: Response, body: string): boolean {
  return response.status === 403 && /secondary rate limit|abuse detection/i.test(body);
}

function retryAfterMs(response: Response): number | null {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  }
  const reset = response.headers.get('x-ratelimit-reset');
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining === '0' && reset) {
    const resetMs = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(resetMs) && resetMs > 0) return Math.min(resetMs, 30_000);
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
