import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Res,
} from '@nestjs/common';

import {
  ProcessBetUseCase,
} from '../application/use-cases/process-bet.use-case.js';

import {
  ProcessWinUseCase,
} from '../application/use-cases/process-win.use-case.js';

import {
  ProcessLossUseCase,
} from '../application/use-cases/process-loss.use-case.js';

import {
  ProcessRefundUseCase,
} from '../application/use-cases/process-refund.use-case.js';

import {
  ProcessRollbackUseCase,
} from '../application/use-cases/process-rollback.use-case.js';

type WagerKind =
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

interface WagerCommand {
  kind: WagerKind;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PostgreSQL numeric(19,2): at most 17 integer digits.
const AMOUNT_PATTERN =
  /^(?:0|[1-9]\d{0,16})\.\d{2}$/;

const ALLOWED_FIELDS = new Set([
  'kind',
  'providerId',
  'externalTransactionId',
  'walletId',
  'playerId',
  'roundId',
  'gameId',
  'money',
  // Legacy representation, temporarily supported.
  'amount',
  'currency',
  'referenceExternalTransactionId',
]);

const MONEY_FIELDS = new Set([
  'amount',
  'currency',
]);

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 255,
  label = field,
): string {
  const value = body[field];

  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    value.trim().length === 0
  ) {
    throw new BadRequestException(
      `${label} must be a non-empty string of at most ${maxLength} characters`,
    );
  }

  return value;
}

function parseMoney(
  body: Record<string, unknown>,
): {
  amount: string;
  currency: string;
} {
  const hasMoney = Object.hasOwn(
    body,
    'money',
  );

  const hasFlatAmount = Object.hasOwn(
    body,
    'amount',
  );

  const hasFlatCurrency = Object.hasOwn(
    body,
    'currency',
  );

  if (
    hasMoney &&
    (hasFlatAmount || hasFlatCurrency)
  ) {
    throw new BadRequestException(
      'Use money.amount and money.currency; do not mix money with top-level amount or currency',
    );
  }

  if (
    !hasMoney &&
    !hasFlatAmount &&
    !hasFlatCurrency
  ) {
    throw new BadRequestException(
      'money is required',
    );
  }

  let source: Record<string, unknown>;

  if (hasMoney) {
    if (!isRecord(body.money)) {
      throw new BadRequestException(
        'money must be a JSON object',
      );
    }

    source = body.money;

    for (const field of Object.keys(source)) {
      if (!MONEY_FIELDS.has(field)) {
        throw new BadRequestException(
          `Unknown money field: ${field}`,
        );
      }
    }
  } else {
    source = body;
  }

  const amount = requiredString(
    source,
    'amount',
    20,
    hasMoney ? 'money.amount' : 'amount',
  );

  if (
    !AMOUNT_PATTERN.test(amount) ||
    amount === '0.00'
  ) {
    throw new BadRequestException(
      'money.amount must be a positive decimal string with exactly two decimal places',
    );
  }

  const currency = requiredString(
    source,
    'currency',
    3,
    hasMoney ? 'money.currency' : 'currency',
  );

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BadRequestException(
      'money.currency must be a three-letter uppercase ISO currency code',
    );
  }

  return {
    amount,
    currency,
  };
}

function parseCommand(
  raw: unknown,
): WagerCommand {
  if (!isRecord(raw)) {
    throw new BadRequestException(
      'Request body must be a JSON object',
    );
  }

  const body = raw;

  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new BadRequestException(
        `Unknown field: ${field}`,
      );
    }
  }

  const kind = requiredString(
    body,
    'kind',
    16,
  );

  if (
    kind !== 'BET' &&
    kind !== 'WIN' &&
    kind !== 'LOSS' &&
    kind !== 'REFUND' &&
    kind !== 'ROLLBACK'
  ) {
    throw new BadRequestException(
      'kind must be BET, WIN, LOSS, REFUND or ROLLBACK',
    );
  }

  const providerId = requiredString(
    body,
    'providerId',
    100,
  );

  const externalTransactionId =
    requiredString(
      body,
      'externalTransactionId',
      255,
    );

  const roundId = requiredString(
    body,
    'roundId',
    255,
  );

  const gameId = requiredString(
    body,
    'gameId',
    255,
  );

  const walletId = requiredString(
    body,
    'walletId',
    36,
  );

  const playerId = requiredString(
    body,
    'playerId',
    36,
  );

  if (
    !UUID_PATTERN.test(walletId) ||
    !UUID_PATTERN.test(playerId)
  ) {
    throw new BadRequestException(
      'walletId and playerId must be valid UUIDs',
    );
  }

  const money = parseMoney(body);

  const requiresReference =
    kind === 'REFUND' ||
    kind === 'ROLLBACK';

  const reference =
    body.referenceExternalTransactionId;

  let referenceExternalTransactionId:
    | string
    | undefined;

  if (requiresReference) {
    referenceExternalTransactionId =
      requiredString(
        body,
        'referenceExternalTransactionId',
        255,
      );

    if (
      referenceExternalTransactionId ===
      externalTransactionId
    ) {
      throw new BadRequestException(
        'A transaction cannot reference itself',
      );
    }
  } else if (reference !== undefined) {
    // The current WIN use case does not support
    // an optional reference. Reject rather than
    // silently ignoring it.
    throw new BadRequestException(
      `${kind} does not accept referenceExternalTransactionId`,
    );
  }

  return {
    kind,
    providerId,
    externalTransactionId,
    walletId,
    playerId,
    roundId,
    gameId,
    amount: money.amount,
    currency: money.currency,
    ...(referenceExternalTransactionId
      ? {
        referenceExternalTransactionId,
      }
      : {}),
  };
}

const CONFLICT_ERROR_NAMES = new Set([
  'BetIdentityConflictError',
  'WinIdentityConflictError',
  'LossIdentityConflictError',
  'RefundIdentityConflictError',
  'RollbackIdentityConflictError',
  'RefundAlreadyAppliedError',
  'RollbackAlreadyAppliedError',
  'RollbackInsufficientFundsError',
]);

const INVALID_REFERENCE_ERROR_NAMES =
  new Set([
    'RefundInvalidReferenceError',
    'RollbackInvalidReferenceError',
  ]);

function handleBusinessError(
  error: unknown,
): never {
  if (error instanceof HttpException) {
    throw error;
  }

  if (!(error instanceof Error)) {
    throw new InternalServerErrorException(
      'Financial transaction processing failed',
    );
  }

  if (
    CONFLICT_ERROR_NAMES.has(error.name)
  ) {
    throw new ConflictException({
      code: error.name,
      message: error.message,
    });
  }

  if (
    INVALID_REFERENCE_ERROR_NAMES.has(
      error.name,
    )
  ) {
    throw new BadRequestException({
      code: error.name,
      message: error.message,
    });
  }

  if (
    error.name === 'WalletNotFoundError'
  ) {
    throw new NotFoundException(
      'Wallet not found',
    );
  }

  // Unexpected infrastructure failures must
  // remain server errors, not business errors.
  throw error;
}

/** Minimal response adapter for @Res({ passthrough: true }). */
interface HttpStatusWriter {
  status(code: number): unknown;
}

interface FinancialResult {
  status: string;
}

/** Preserve the original financial result body, including replay snapshots. */
function returnFinancialResult<T extends FinancialResult>(
  result: T,
  response: HttpStatusWriter,
): T {
  switch (result.status) {
    case 'PROCESSED':
      response.status(HttpStatus.OK);
      break;

    case 'PENDING':
    case 'PENDING_REFERENCE':
      response.status(HttpStatus.ACCEPTED);
      break;

    case 'REJECTED':
      response.status(HttpStatus.UNPROCESSABLE_ENTITY);
      break;

    case 'FAILED':
      response.status(HttpStatus.INTERNAL_SERVER_ERROR);
      break;

    default:
      throw new InternalServerErrorException(
        'Unexpected financial transaction status',
      );
  }

  return result;
}

@Controller('wagering/transactions')
export class WageringCommandController {
  constructor(
    private readonly bet: ProcessBetUseCase,
    private readonly win: ProcessWinUseCase,
    private readonly loss: ProcessLossUseCase,
    private readonly refund: ProcessRefundUseCase,
    private readonly rollback: ProcessRollbackUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async createTransaction(
    @Headers('idempotency-key')
    idempotencyKeyRaw: string | undefined,

    @Body()
    rawBody: unknown,

    @Res({ passthrough: true })
    response: HttpStatusWriter,
  ) {
    if (
      typeof idempotencyKeyRaw !== 'string' ||
      idempotencyKeyRaw.trim().length === 0 ||
      idempotencyKeyRaw !==
      idempotencyKeyRaw.trim() ||
      idempotencyKeyRaw.length > 255
    ) {
      throw new BadRequestException(
        'Idempotency-Key header is required and must contain 1 to 255 non-whitespace-padded characters',
      );
    }

    const command = parseCommand(rawBody);

    // Both accepted HTTP representations produce
    // exactly the same application command.
    const common = {
      providerId: command.providerId,
      externalTransactionId:
      command.externalTransactionId,
      idempotencyKey: idempotencyKeyRaw,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      amount: command.amount,
      currency: command.currency,
    };

    try {
      switch (command.kind) {
        case 'BET':
          return returnFinancialResult(
            await this.bet.execute(common),
            response,
          );

        case 'WIN':
          return returnFinancialResult(
            await this.win.execute(common),
            response,
          );

        case 'LOSS':
          return returnFinancialResult(
            await this.loss.execute(common),
            response,
          );

        case 'REFUND':
          return returnFinancialResult(
            await this.refund.execute({
              ...common,
              referenceExternalTransactionId:
                command.referenceExternalTransactionId!,
            }),
            response,
          );

        case 'ROLLBACK':
          return returnFinancialResult(
            await this.rollback.execute({
              ...common,
              referenceExternalTransactionId:
                command.referenceExternalTransactionId!,
            }),
            response,
          );
      }
    } catch (error) {
      return handleBusinessError(error);
    }
  }
}
