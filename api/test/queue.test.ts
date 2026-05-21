import { describe, expect, it, vi } from 'vitest';

import { TranscodeQueue } from '../src/transcode/queue.js';

/**
 * Drive the queue with a stubbed `runJob` to verify concurrency capping.
 * The real `runJob` does S3 + ffmpeg work; we only care about the scheduler.
 */
class TestableQueue extends TranscodeQueue {
  public observedMax = 0;
  public completed = 0;
  private resolvers = new Map<string, () => void>();

  // override the private runJob via a bracket access in TS:
  protected async runJobSpy(id: string): Promise<void> {
    return new Promise((resolve) => {
      this.resolvers.set(id, () => {
        resolve();
      });
    });
  }

  finish(id: string): void {
    const r = this.resolvers.get(id);
    if (!r) throw new Error(`no job ${id} in flight`);
    this.resolvers.delete(id);
    this.completed += 1;
    r();
  }
}

describe('TranscodeQueue', () => {
  it('never runs more than maxConcurrency jobs at once', async () => {
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), silent: vi.fn(), level: 'info', child: vi.fn() } as never;
    const queue = new TestableQueue(
      { db: {} as never, s3: {} as never, s3Config: {} as never, log },
      { maxConcurrency: 2 },
    );

    // Swap the private runJob with our spy.
    type WithRunJob = { runJob: (id: string) => Promise<void> };
    (queue as unknown as WithRunJob).runJob = (id) => queue.runJobSpy(id).then(() => undefined);

    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('c');
    queue.enqueue('d');

    await tick();
    expect(queue.stats.inflight).toBe(2);
    expect(queue.stats.pending).toBe(2);

    queue.finish('a');
    await tick();
    expect(queue.stats.inflight).toBe(2);
    expect(queue.stats.pending).toBe(1);

    queue.finish('b');
    queue.finish('c');
    await tick();
    expect(queue.stats.inflight).toBe(1);
    expect(queue.stats.pending).toBe(0);

    queue.finish('d');
    await tick();
    expect(queue.stats.inflight).toBe(0);
    expect(queue.completed).toBe(4);
  });
});

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
