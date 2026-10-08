/**
 * Watchlists: the one piece of state this server keeps.
 *
 * The MCP transport is stateless — a fresh server per request — so anything
 * that has to outlive a conversation lives here instead. A watchlist is keyed
 * by an unguessable id handed to the caller on creation. There are no
 * accounts: holding the id is what grants access, the same model as an
 * unlisted link. A list stores currency pairs and thresholds and nothing
 * about who asked, so a leaked id leaks someone's interest in USD/ZWG and
 * nothing more.
 *
 * Storage is one JSON file, rewritten atomically (temp file + rename) and
 * serialised through a single promise chain so two concurrent requests cannot
 * interleave their writes. The volumes involved — a few thousand small lists
 * at most — do not justify a database.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Condition =
  | { kind: 'above'; value: number }
  | { kind: 'below'; value: number }
  /** Fires on a move of at least `value` percent either way from the baseline. */
  | { kind: 'moves'; value: number };

export interface Observation {
  rate: number;
  /** The rate's own publication date, YYYY-MM-DD. */
  as_of: string;
  /** When we read it, ISO timestamp. */
  at: string;
}

export interface Watch {
  id: string;
  from: string;
  to: string;
  country: string | null;
  condition: Condition;
  /** The rate when the watch was set. `moves` measures from here. */
  baseline: Observation;
  /** The rate at the most recent check, so the next one can say what changed since. */
  last: Observation;
  /** First time the condition was seen to hold; null until then. */
  fired_at: string | null;
  /**
   * The condition already held at the moment the watch was set. When it then
   * "fires", nothing moved — and saying it "just crossed" would be invented.
   * Absent on watches stored before this field existed; read as false.
   */
  held_when_set?: boolean;
  created_at: string;
}

export interface Watchlist {
  id: string;
  created_at: string;
  used_at: string;
  next_watch: number;
  watches: Watch[];
}

export const MAX_WATCHES_PER_LIST = 10;
export const MAX_LISTS = 2000;
/** A list nobody has touched in this long is dropped on the next write. */
export const LIST_EXPIRY_DAYS = 90;

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const ID_PATTERN = /^wl_[a-z2-9]{10}$/;

function newListId(): string {
  const bytes = randomBytes(10);
  let id = 'wl_';
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

export function isListId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export class WatchStore {
  private lists = new Map<string, Watchlist>();
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'watches.json');
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as { lists?: Watchlist[] };
        for (const list of raw.lists ?? []) this.lists.set(list.id, list);
      } catch (err) {
        // A missing file is a fresh install. Anything else — a corrupt file —
        // must not be silently replaced by an empty one on the next write.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    })();
    return this.loaded;
  }

  private prune(now: Date): void {
    const cutoff = now.getTime() - LIST_EXPIRY_DAYS * 86_400_000;
    for (const [id, list] of this.lists) {
      if (Date.parse(list.used_at) < cutoff) this.lists.delete(id);
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, lists: [...this.lists.values()] });
    this.writing = this.writing.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  async get(id: string): Promise<Watchlist | undefined> {
    if (!isListId(id)) return undefined;
    await this.load();
    return this.lists.get(id);
  }

  /** A new, empty list. Throws when the store is full of lists still in use. */
  async create(now: Date = new Date()): Promise<Watchlist> {
    await this.load();
    this.prune(now);
    if (this.lists.size >= MAX_LISTS) {
      throw new Error('The watch service is at capacity. Try again later.');
    }
    let id = newListId();
    while (this.lists.has(id)) id = newListId();
    const stamp = now.toISOString();
    const list: Watchlist = { id, created_at: stamp, used_at: stamp, next_watch: 1, watches: [] };
    this.lists.set(id, list);
    return list;
  }

  /** Write a list back, marking it used. An emptied list is kept: its id is still the user's. */
  async save(list: Watchlist, now: Date = new Date()): Promise<void> {
    await this.load();
    list.used_at = now.toISOString();
    this.lists.set(list.id, list);
    this.prune(now);
    await this.persist();
  }

  get size(): number {
    return this.lists.size;
  }
}
