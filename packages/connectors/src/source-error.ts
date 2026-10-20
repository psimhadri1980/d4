/** What a source needs from its host: fetch, and the outbound URL check (private addresses etc.). */
export interface SourceDeps {
  fetch?: typeof fetch;
  /** Returns why a URL may not be fetched, or null. */
  checkUrl(url: string): Promise<string | null>;
}

/** The source refused or sent something unusable; retrying will not help. */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}
