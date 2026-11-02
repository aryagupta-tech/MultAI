import { describe, expect, test, vi } from 'vitest';
import { DRAFT_LIMIT } from '../model/composer';
import { AttachmentQueue, composeAttachmentText, readTextAttachments } from './attachments';

const file = (name: string, text = 'hello') => new File([text], name);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('text attachments', () => {
  test('sends filenames and full UTF-8 contents in the existing text payload', async () => {
    const attachments = await readTextAttachments([file('notes.md', '# Café\nNext step'), file('data.csv', 'a,b\n1,2')], [], 'Review these');
    const payload = composeAttachmentText('Review these', attachments);
    expect(payload).toContain('Review these');
    expect(payload).toContain('name="notes.md"');
    expect(payload).toContain('# Café\nNext step');
    expect(payload).toContain('a,b\n1,2');
    expect(composeAttachmentText('original')).toBe('original');
  });

  test('allows a file without extra message text and preserves existing attachments', async () => {
    const existing = [{ name: 'first.txt', text: 'one' }];
    const next = await readTextAttachments([file('second.ts', 'export const two = 2;')], existing, '');
    expect(next).toHaveLength(2);
    expect(existing).toHaveLength(1);
    expect(composeAttachmentText('', next).length).toBeGreaterThan(0);
  });

  test.each(['report.pdf', 'document.docx', 'archive.zip', '.env.local', '.npmrc', '.netrc', '.git-credentials', 'credentials.json', 'id_rsa', 'server.key', '../notes.txt'])('rejects unsupported or private file %s', async (name) => {
    await expect(readTextAttachments([file(name)], [], '')).rejects.toThrow();
  });

  test('explains PDF support honestly', async () => {
    await expect(readTextAttachments([file('report.pdf', '%PDF-')], [], '')).rejects.toThrow('PDF, Word and binary files are not supported');
  });

  test('rejects binary data, invalid UTF-8, private keys and known credentials', async () => {
    await expect(readTextAttachments([file('bad.txt', 'one\u0000two')], [], '')).rejects.toThrow('binary data');
    await expect(readTextAttachments([new File([new Uint8Array([0xff, 0xfe])], 'bad.txt')], [], '')).rejects.toThrow('UTF-8');
    await expect(readTextAttachments([file('notes.txt', '-----BEGIN RSA PRIVATE KEY-----')], [], '')).rejects.toThrow('credential or private key');
    await expect(readTextAttachments([file('notes.txt', 'sk-1234567890abcdef')], [], '')).rejects.toThrow('credential or private key');
  });

  test('bounds file count, file bytes and the combined serialized payload', async () => {
    await expect(readTextAttachments(Array.from({ length: 5 }, (_, i) => file(`${i}.txt`)), [], '')).rejects.toThrow('up to 4');
    await expect(readTextAttachments([file('big.txt', 'x'.repeat(12_001))], [], '')).rejects.toThrow('12 KB');
    await expect(readTextAttachments([file('unicode.txt', 'é'.repeat(6_001))], [], '')).rejects.toThrow('12 KB');
    await expect(readTextAttachments([file('notes.txt')], [], 'x'.repeat(DRAFT_LIMIT - 5))).rejects.toThrow('16,000-character');
    await expect(readTextAttachments([file('a.txt', 'x'.repeat(9_000)), file('b.txt', 'y'.repeat(9_000))], [], '')).rejects.toThrow('16,000-character');
  });

  test('a failed selection does not partially append or replace duplicate filenames', async () => {
    const existing = [{ name: 'old.txt', text: 'keep' }];
    await expect(readTextAttachments([file('new.txt'), file('old.txt')], existing, '')).rejects.toThrow('already attached');
    expect(existing).toEqual([{ name: 'old.txt', text: 'keep' }]);
  });
});

describe('attachment preparation races', () => {
  test('a newer image/file selection wins even when the first conversion finishes last', async () => {
    const queue = new AttachmentQueue();
    const first = deferred<string>();
    const second = deferred<string>();
    const apply = vi.fn();
    const error = vi.fn();
    const settled = vi.fn();
    const firstRun = queue.run(() => first.promise, () => true, apply, error, settled);
    const secondRun = queue.run(() => second.promise, () => true, apply, error, settled);
    second.resolve('new screenshot');
    await secondRun;
    first.resolve('old screenshot');
    await firstRun;
    expect(apply.mock.calls).toEqual([['new screenshot']]);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  test('account/session navigation and removed attachments prevent late changes', async () => {
    const queue = new AttachmentQueue();
    const navigation = deferred<string>();
    let current = true;
    const apply = vi.fn();
    const error = vi.fn();
    const run = queue.run(() => navigation.promise, () => current, apply, error);
    current = false;
    navigation.resolve('wrong account');
    await run;
    const removed = deferred<string>();
    const afterRemove = queue.run(() => removed.promise, () => true, apply, error);
    queue.cancel();
    removed.resolve('revived attachment');
    await afterRemove;
    expect(apply).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test('only current failures are reported and completion runs after applying changes', async () => {
    const queue = new AttachmentQueue();
    const failure = deferred<string>();
    const error = vi.fn();
    const stale = queue.run(() => failure.promise, () => true, vi.fn(), error);
    queue.cancel();
    failure.reject(new Error('stale failure'));
    await stale;
    expect(error).not.toHaveBeenCalled();
    const settled = vi.fn();
    let current = true;
    await queue.run(async () => 'ready', () => current, () => { current = false; }, error, settled);
    expect(settled).toHaveBeenCalledOnce();
    await queue.run(async () => { throw new Error('read failed'); }, () => true, vi.fn(), error);
    expect(error).toHaveBeenCalledOnce();
  });
});
