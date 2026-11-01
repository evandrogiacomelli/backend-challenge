import {
  afterEach,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  OutboxDispatchWorker,
} from '../../src/modules/messaging/outbox/infrastructure/workers/outbox-dispatch.worker.js';

import type {
  OutboxDispatcherService,
} from '../../src/modules/messaging/outbox/application/services/outbox-dispatcher.service.js';

const originalEnabled =
  process.env.OUTBOX_WORKER_ENABLED;

afterEach(() => {
  if (originalEnabled === undefined) {
    delete process.env.OUTBOX_WORKER_ENABLED;
  } else {
    process.env.OUTBOX_WORKER_ENABLED =
      originalEnabled;
  }
});

function makeWorker(
  dispatchOnce: (
    options?: unknown,
  ) => Promise<{
    claimed: number;
    published: number;
    failed: number;
    lostLease: number;
  }>,
): OutboxDispatchWorker {
  const dispatcher = {
    dispatchOnce,
  } as unknown as OutboxDispatcherService;

  return new OutboxDispatchWorker(dispatcher);
}

const emptyResult = {
  claimed: 0,
  published: 0,
  failed: 0,
  lostLease: 0,
};

describe('OutboxDispatchWorker', () => {
  test('does not dispatch when disabled', async () => {
    process.env.OUTBOX_WORKER_ENABLED = 'false';

    let calls = 0;

    const worker = makeWorker(async () => {
      calls++;
      return emptyResult;
    });

    await worker.poll();

    expect(calls).toBe(0);
  });

  test('dispatches when enabled', async () => {
    process.env.OUTBOX_WORKER_ENABLED = 'true';

    let calls = 0;
    let providedWorkerId: string | undefined;

    const worker = makeWorker(async (options) => {
      calls++;

      providedWorkerId = (
        options as { workerId: string }
      ).workerId;

      return emptyResult;
    });

    await worker.poll();

    expect(calls).toBe(1);
    expect(providedWorkerId).toBeTruthy();
  });

  test('does not overlap executions', async () => {
    process.env.OUTBOX_WORKER_ENABLED = 'true';

    let calls = 0;
    let complete: (() => void) | undefined;

    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });

    const worker = makeWorker(async () => {
      calls++;

      await gate;

      return emptyResult;
    });

    const first = worker.poll();
    const second = worker.poll();

    expect(calls).toBe(1);

    complete!();

    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });

  test('waits for active dispatch on shutdown', async () => {
    process.env.OUTBOX_WORKER_ENABLED = 'true';

    let complete: (() => void) | undefined;
    let finished = false;

    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });

    const worker = makeWorker(async () => {
      await gate;
      finished = true;

      return emptyResult;
    });

    const polling = worker.poll();

    let shutdownFinished = false;

    const shutdown = worker
      .onApplicationShutdown()
      .then(() => {
        shutdownFinished = true;
      });

    await Promise.resolve();

    expect(shutdownFinished).toBe(false);

    complete!();

    await Promise.all([polling, shutdown]);

    expect(finished).toBe(true);
    expect(shutdownFinished).toBe(true);
  });

  test('does not restart after shutdown', async () => {
    process.env.OUTBOX_WORKER_ENABLED = 'true';

    let calls = 0;

    const worker = makeWorker(async () => {
      calls++;
      return emptyResult;
    });

    await worker.onApplicationShutdown();
    await worker.poll();

    expect(calls).toBe(0);
  });
});
