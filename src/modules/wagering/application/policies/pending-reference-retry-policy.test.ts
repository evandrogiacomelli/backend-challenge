import {
  describe,
  expect,
  test,
} from 'bun:test';

import {
  pendingReferenceRetrySeconds,
  pendingReferenceNeedsAttention,
} from './pending-reference-retry-policy.js';

describe('Pending reference retry policy', () => {
  test('increases retry delay exponentially', () => {
    expect(pendingReferenceRetrySeconds(1)).toBe(10);
    expect(pendingReferenceRetrySeconds(2)).toBe(20);
    expect(pendingReferenceRetrySeconds(3)).toBe(40);
    expect(pendingReferenceRetrySeconds(4)).toBe(80);
  });

  test('caps retries at one hour', () => {
    expect(pendingReferenceRetrySeconds(10)).toBe(
      3600,
    );

    expect(pendingReferenceRetrySeconds(100)).toBe(
      3600,
    );
  });

  test('flags unresolved references for investigation', () => {
    expect(
      pendingReferenceNeedsAttention(7),
    ).toBe(false);

    expect(
      pendingReferenceNeedsAttention(8),
    ).toBe(true);

    expect(
      pendingReferenceNeedsAttention(20),
    ).toBe(true);
  });

  test('rejects invalid attempt counts', () => {
    expect(() =>
      pendingReferenceRetrySeconds(0),
    ).toThrow();

    expect(() =>
      pendingReferenceRetrySeconds(-1),
    ).toThrow();

    expect(() =>
      pendingReferenceRetrySeconds(1.5),
    ).toThrow();
  });
});
