import { createHash, createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 统一基地址，REST 请求固定使用 /api/rest/。 */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/api\/rest\/?$/i, '').replace(/\/$/, '');
}

export function buildIssueViewUrl(baseUrl: string, issueId: number): string {
  return `${baseUrl}/view.php?id=${issueId}`;
}

export function buildNoteViewUrl(baseUrl: string, issueId: number, noteId: number): string {
  return `${baseUrl}/view.php?id=${issueId}#bugnote${noteId}`;
}

// ---------------------------------------------------------------------------
// MantisApiError
// ---------------------------------------------------------------------------

export class MantisApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(`MantisBT API error ${statusCode}: ${message}`);
    this.name = 'MantisApiError';
  }
}

// ---------------------------------------------------------------------------
// MantisClient
// ---------------------------------------------------------------------------

type Credentials = { baseUrl: string; apiKey: string };
type CredentialFactory = () => Promise<Credentials>;

export interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined>;
  ifMatch?: string;
  timeoutMs?: number;
}

export interface RestResponse<T> {
  status: number;
  headers: { etag: string | null; mantisVersion: string | null };
  body: T;
  requestSent: true;
}

/** 不保留响应正文或请求体，防止上传错误泄露 Base64 和凭据。 */
export class RestError extends Error {
  constructor(public readonly status: number | null, public readonly requestSent: boolean,
    public readonly definiteRejection: boolean, public readonly method?: string) {
    super(status === null ? 'Mantis 请求未取得可靠响应' : `Mantis 请求返回 HTTP ${status}`);
  }
}

export class MantisClient {
  private readonly credentialFactory?: CredentialFactory;
  private resolvedCredentials?: Credentials;

  constructor(baseUrl: string, apiKey: string);
  constructor(credentialFactory: CredentialFactory);
  constructor(
    baseUrlOrFactory: string | CredentialFactory,
    apiKey?: string,
  ) {
    if (typeof baseUrlOrFactory === 'string') {
      this.resolvedCredentials = {
        baseUrl: normalizeBaseUrl(baseUrlOrFactory),
        apiKey: apiKey!,
      };
    } else {
      this.credentialFactory = baseUrlOrFactory;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async getCredentials(): Promise<Credentials> {
    if (!this.resolvedCredentials) {
      const { baseUrl, apiKey } = await this.credentialFactory!();
      this.resolvedCredentials = { baseUrl: normalizeBaseUrl(baseUrl), apiKey };
    }
    return this.resolvedCredentials;
  }

  async getBaseUrl(): Promise<string> {
    return (await this.getCredentials()).baseUrl;
  }

  /** 仅供本地命名空间和不透明标识使用，不返回原始凭据。 */
  async getCredentialDomain(): Promise<{ instance: string; credential: string; key: Buffer }> {
    const { baseUrl, apiKey } = await this.getCredentials();
    return {
      instance: createHash('sha256').update(baseUrl).digest('hex'),
      credential: createHmac('sha256', apiKey).update(`mantis-workflow-scope:${baseUrl}`).digest('hex'),
      key: createHmac('sha256', apiKey).update(`mantis-workflow-token-v1:${baseUrl}`).digest(),
    };
  }

  /** 工作流专用元信息入口；所有写入只发送一次，未知结果交由执行账本核查。 */
  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string,
    body?: unknown, options: RequestOptions = {}): Promise<RestResponse<T>> {
    let url: string;
    let headers: Record<string, string>;
    let encoded: string | undefined;
    try {
      url = await this.buildUrl(path, options.params);
      headers = await this.headers();
      if (options.ifMatch) headers['If-Match'] = options.ifMatch;
      encoded = body === undefined ? undefined : JSON.stringify(body);
    } catch { throw new RestError(null, false, true, method); }
    let response: Response;
    try {
      response = await fetch(url, { method, headers, body: encoded,
        signal: AbortSignal.timeout(options.timeoutMs ?? MantisClient.TIMEOUT_MS), redirect: 'error' });
    } catch { throw new RestError(null, true, false, method); }
    if (!response.ok) {
      // 这些 REST 入口的输入、身份和权限拒绝；5xx 一律不假定尚未执行。
      const rejectedBeforeWrite = [401, 403, 404, 412, 413, 415].includes(response.status)
        || response.status === 400 && method === 'POST' && /^projects\/\d+\/versions$/.test(path);
      throw new RestError(response.status, true, rejectedBeforeWrite, method);
    }
    try {
      const raw = response.status === 204 ? '' : await response.text();
      return { status: response.status, requestSent: true,
        headers: { etag: response.headers.get('ETag'), mantisVersion: response.headers.get('X-Mantis-Version') },
        body: (raw ? JSON.parse(raw) : undefined) as T };
    } catch { throw new RestError(response.status, true, false, method); }
  }

  private async buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<string> {
    const { baseUrl } = await this.getCredentials();
    const url = new URL(`${baseUrl}/api/rest/${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async headers(): Promise<Record<string, string>> {
    const { apiKey } = await this.getCredentials();
    return {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
      // Some DELETE endpoints return 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }
      const text = await response.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    }

    let message = response.statusText;
    try {
      const body = await response.text();
      if (body) {
        const parsed = JSON.parse(body) as { message?: string };
        if (parsed.message) message = parsed.message;
        else message = body;
      }
    } catch {
      // ignore parse errors — keep statusText as message
    }

    throw new MantisApiError(response.status, message);
  }

  // ---------------------------------------------------------------------------
  // Public API methods
  // ---------------------------------------------------------------------------

  private static readonly TIMEOUT_MS = 30_000;

  async get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const response = await fetch(await this.buildUrl(path, params), {
      method: 'GET',
      headers: await this.headers(),
      signal: AbortSignal.timeout(MantisClient.TIMEOUT_MS),
    });
    return this.handleResponse<T>(response);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(await this.buildUrl(path), {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MantisClient.TIMEOUT_MS),
    });
    return this.handleResponse<T>(response);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(await this.buildUrl(path), {
      method: 'PATCH',
      headers: await this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MantisClient.TIMEOUT_MS),
    });
    return this.handleResponse<T>(response);
  }

  async delete<T>(path: string): Promise<T> {
    const response = await fetch(await this.buildUrl(path), {
      method: 'DELETE',
      headers: await this.headers(),
      signal: AbortSignal.timeout(MantisClient.TIMEOUT_MS),
    });
    return this.handleResponse<T>(response);
  }

  async getVersion(): Promise<string> {
    const response = await fetch(await this.buildUrl('users/me'), {
      method: 'GET',
      headers: await this.headers(),
      signal: AbortSignal.timeout(MantisClient.TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new MantisApiError(response.status, response.statusText);
    }
    return response.headers.get('X-Mantis-Version') ?? 'unknown';
  }
}
