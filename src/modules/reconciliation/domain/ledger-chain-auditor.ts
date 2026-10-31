import { Decimal } from 'decimal.js';

export interface LedgerChainEntry {
  id: string;
  transactionId: string | null;
  currency: string;
  direction: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
}

export type LedgerChainIssueCode =
  | 'INVALID_MOVEMENT'
  | 'DISCONNECTED_CHAIN'
  | 'INVALID_CHAIN_DEGREES'
  | 'INVALID_CHAIN_ENDPOINT';

export interface LedgerChainIssue {
  code: LedgerChainIssueCode;
  description: string;
  ledgerIds: string[];
  transactionIds: string[];
}

export interface LedgerChainReport {
  walletId: string;
  entryCount: number;
  validMovementCount: number;
  chainFeasible: boolean;
  issues: LedgerChainIssue[];
}

interface Edge {
  entry: LedgerChainEntry;
  from: string;
  to: string;
}

const ZERO = '0.00';

function money(value: string): Decimal {
  const number = new Decimal(value);

  if (!number.isFinite() || number.decimalPlaces() > 2) {
    throw new Error('Invalid monetary precision');
  }

  return number;
}

function issue(
  code: LedgerChainIssueCode,
  description: string,
  entries: LedgerChainEntry[],
): LedgerChainIssue {
  return {
    code,
    description,
    ledgerIds: entries.map((e) => e.id),
    transactionIds: [
      ...new Set(
        entries
          .map((e) => e.transactionId)
          .filter((id): id is string => id !== null),
      ),
    ],
  };
}

export function auditLedgerChain(input: {
  walletId: string;
  currency: string;
  actualBalance: string;
  entries: LedgerChainEntry[];
}): LedgerChainReport {
  const issues: LedgerChainIssue[] = [];
  const edges: Edge[] = [];

  for (const entry of input.entries) {
    try {
      const amount = money(entry.amount);
      const before = money(entry.balanceBefore);
      const after = money(entry.balanceAfter);

      if (
        amount.lte(0) ||
        before.isNegative() ||
        after.isNegative() ||
        entry.currency !== input.currency ||
        !['CREDIT', 'DEBIT'].includes(entry.direction)
      ) {
        throw new Error('Invalid ledger values');
      }

      const calculated =
        entry.direction === 'CREDIT'
          ? before.plus(amount)
          : before.minus(amount);

      if (!calculated.eq(after)) {
        throw new Error('Incorrect balance transition');
      }

      edges.push({
        entry,
        from: before.toFixed(2),
        to: after.toFixed(2),
      });
    } catch {
      issues.push(
        issue(
          'INVALID_MOVEMENT',
          'Invalid amount, currency, direction or balance transition',
          [entry],
        ),
      );
    }
  }

  let finalBalance: string;

  try {
    finalBalance = money(
      input.actualBalance,
    ).toFixed(2);
  } catch {
    issues.push(
      issue(
        'INVALID_CHAIN_ENDPOINT',
        'Invalid materialized wallet balance',
        input.entries,
      ),
    );

    return {
      walletId: input.walletId,
      entryCount: input.entries.length,
      validMovementCount: edges.length,
      chainFeasible: false,
      issues,
    };
  }

  const degree = new Map<string, number>();
  const neighbors = new Map<string, Set<string>>();
  const entriesAtNode =
    new Map<string, LedgerChainEntry[]>();

  function addNeighbor(a: string, b: string): void {
    if (!neighbors.has(a)) {
      neighbors.set(a, new Set());
    }

    neighbors.get(a)!.add(b);
  }

  function addEntry(
    node: string,
    entry: LedgerChainEntry,
  ): void {
    if (!entriesAtNode.has(node)) {
      entriesAtNode.set(node, []);
    }

    entriesAtNode.get(node)!.push(entry);
  }

  for (const edge of edges) {
    degree.set(
      edge.from,
      (degree.get(edge.from) ?? 0) + 1,
    );

    degree.set(
      edge.to,
      (degree.get(edge.to) ?? 0) - 1,
    );

    // Undirected connectivity is necessary
    // for an Euler trail over directed edges.
    addNeighbor(edge.from, edge.to);
    addNeighbor(edge.to, edge.from);

    addEntry(edge.from, edge.entry);
    addEntry(edge.to, edge.entry);
  }

  const nodes = new Set([
    ...degree.keys(),
    ZERO,
    finalBalance,
  ]);

  const invalidDegreeNodes: string[] = [];

  for (const node of nodes) {
    const expected =
      ZERO === finalBalance
        ? 0
        : node === ZERO
          ? 1
          : node === finalBalance
            ? -1
            : 0;

    if ((degree.get(node) ?? 0) !== expected) {
      invalidDegreeNodes.push(node);
    }
  }

  if (invalidDegreeNodes.length > 0) {
    const affected = invalidDegreeNodes.flatMap(
      (node) => entriesAtNode.get(node) ?? [],
    );

    issues.push(
      issue(
        'INVALID_CHAIN_DEGREES',
        `Unbalanced ledger transitions at balances: ${invalidDegreeNodes.join(', ')}`,
        [...new Map(
          affected.map((e) => [e.id, e]),
        ).values()],
      ),
    );
  }

  const visited = new Set<string>([ZERO]);
  const queue = [ZERO];

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const next of neighbors.get(current) ?? []) {
      if (visited.has(next)) continue;

      visited.add(next);
      queue.push(next);
    }
  }

  const disconnected = edges
    .filter(
      (edge) =>
        !visited.has(edge.from) ||
        !visited.has(edge.to),
    )
    .map((edge) => edge.entry);

  if (disconnected.length > 0) {
    issues.push(
      issue(
        'DISCONNECTED_CHAIN',
        'Ledger movements cannot all be connected to the opening balance',
        disconnected,
      ),
    );
  }

  if (
    edges.length === 0 &&
    finalBalance !== ZERO
  ) {
    issues.push(
      issue(
        'INVALID_CHAIN_ENDPOINT',
        'Nonzero wallet balance without ledger movements',
        [],
      ),
    );
  }

  return {
    walletId: input.walletId,
    entryCount: input.entries.length,
    validMovementCount: edges.length,
    chainFeasible: issues.length === 0,
    issues,
  };
}
