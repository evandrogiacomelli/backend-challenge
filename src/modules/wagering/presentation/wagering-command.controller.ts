import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Body,
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

// PostgreSQL numeric(19,2): up to 17 integer digits.
const AMOUNT_PATTERN =
  /^(?:0|[1-9]\d{0,16})\.\d{2}$/;

const IDENTIFIER_FIELDS = [
  'providerId',
  'externalTransactionId',
  'roundId',
  'gameId',
] as const;

const ALLOWED_FIELDS = new Set([
  'kind',
  'providerId',
  'externalTransactionId',
  'walletId',
  'playerId',
  'roundId',
  'gameId',
  'amount',
  'currency',
  'referenceExternalTransactionId',
]);

function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 255,
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
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }

  return value;
}

function parseCommand(raw: unknown): WagerCommand {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw)
  ) {
    throw new BadRequestException(
      'Request body must be a JSON object',
    );
  }

  const body = raw as Record<string, unknown>;

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

  for (const field of IDENTIFIER_FIELDS) {
    requiredString(body, field, 255);
  }

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

  const amount = requiredString(
    body,
    'amount',
    20,
  );

  if (
    !AMOUNT_PATTERN.test(amount) ||
    /^0\.00$/.test(amount)
  ) {
    throw new BadRequestException(
      'amount must be a positive decimal string with exactly two decimal places',
    );
  }

  const currency = requiredString(
    body,
    'currency',
    3,
  );

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BadRequestException(
      'currency must be a three-letter uppercase ISO currency code',
    );
  }

  const requiresReference =
    kind === 'REFUND' ||
    kind === 'ROLLBACK';

  const reference =
    body.referenceExternalTransactionId;

  if (requiresReference) {
    requiredString(
      body,
      'referenceExternalTransactionId',
      255,
    );

    if (
      reference === body.externalTransactionId
    ) {
      throw new BadRequestException(
        'A transaction cannot reference itself',
      );
    }
  } else if (reference !== undefined) {
    // WIN reference validation is not implemented
    // by its use case. Do not silently discard it.
    throw new BadRequestException(
      `${kind} does not accept referenceExternalTransactionId`,
    );
  }

  return {
    kind,
    providerId: body.providerId as string,
    externalTransactionId:
      body.externalTransactionId as string,
    walletId,
    playerId,
    roundId: body.roundId as string,
    gameId: body.gameId as string,
    amount,
    currency,
    ...(requiresReference
      ? {
        referenceExternalTransactionId:
          reference as string,
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

const INVALID_REFERENCE_ERROR_NAMES = new Set([
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

  if (CONFLICT_ERROR_NAMES.has(error.name)) {
    throw new ConflictException({
      code: error.name,
      message: error.message,
    });
  }

  if (
    INVALID_REFERENCE_ERROR_NAMES.has(error.name)
  ) {
    throw new BadRequestException({
      code: error.name,
      message: error.message,
    });
  }

  if (error.name === 'WalletNotFoundError') {
    throw new NotFoundException(
      'Wallet not found',
    );
  }

  // Unknown application/database errors must not
  // be misrepresented as validation errors.
  throw error;
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
          return await this.bet.execute(common);

        case 'WIN':
          return await this.win.execute(common);

        case 'LOSS':
          return await this.loss.execute(common);

        case 'REFUND':
          return await this.refund.execute({
            ...common,
            referenceExternalTransactionId:
              command.referenceExternalTransactionId!,
          });

        case 'ROLLBACK':
          return await this.rollback.execute({
            ...common,
            referenceExternalTransactionId:
              command.referenceExternalTransactionId!,
          });
      }
    } catch (error) {
      return handleBusinessError(error);
    }
  }
}
