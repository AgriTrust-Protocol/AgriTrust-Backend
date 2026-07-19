import { createServer, IncomingMessage, ServerResponse } from 'http';

export interface AcmeChallengeStore {
  setToken(token: string, keyAuthorization: string, expiresAt: Date): Promise<void> | void;
  getToken(token: string): Promise<string | undefined> | string | undefined;
}

export class InMemoryAcmeChallengeStore implements AcmeChallengeStore {
  private readonly tokens = new Map<string, { value: string; expiresAt: Date }>();
  setToken(token: string, keyAuthorization: string, expiresAt: Date): void {
    this.tokens.set(token, { value: keyAuthorization, expiresAt });
  }
  getToken(token: string): string | undefined {
    const item = this.tokens.get(token);
    if (!item || item.expiresAt.getTime() <= Date.now()) return undefined;
    return item.value;
  }
}

export class AcmeHttp01Client {
  constructor(private readonly store: AcmeChallengeStore, private readonly challengeTtlMs = 10 * 60_000) {}

  async publishChallenge(token: string, keyAuthorization: string): Promise<void> {
    await this.store.setToken(token, keyAuthorization, new Date(Date.now() + this.challengeTtlMs));
  }

  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const token = req.url?.match(/^\/\.well-known\/acme-challenge\/([^/?#]+)$/)?.[1];
    if (!token) {
      res.writeHead(404).end();
      return;
    }
    const value = await this.store.getToken(token);
    if (!value) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end(value);
  };

  listen(port = 80, host = '0.0.0.0') {
    return createServer(this.handler).listen(port, host);
  }
}
