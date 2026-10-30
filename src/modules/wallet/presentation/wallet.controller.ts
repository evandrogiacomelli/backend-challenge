
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Post,
} from '@nestjs/common';

import {
  CreateWalletUseCase,
  type CreateWalletInput,
  type CreateWalletOutput,
} from '../application/use-cases/create-wallet.use-case.js';
import {
  WalletAlreadyExistsError,
} from '../infrastructure/persistence/mikro-orm-wallet-opening.persistence.js';

function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseInput(body: unknown): CreateWalletInput {
  if (!isObject(body)) {
    throw new BadRequestException('Invalid request body');
  }

  const { playerId, currency, initialBalance } = body;

  if (
    typeof playerId !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(playerId)
  ) {
    throw new BadRequestException('Invalid playerId');
  }

  if (
    currency !== undefined &&
    (
      typeof currency !== 'string' ||
      !/^[A-Z]{3}$/.test(currency)
    )
  ) {
    throw new BadRequestException('Invalid currency');
  }

  if (initialBalance === undefined) {
    if (typeof currency !== 'string') {
      throw new BadRequestException('Currency is required');
    }

    return { playerId, currency };
  }

  if (
    !isObject(initialBalance) ||
    typeof initialBalance.amount !== 'string' ||
    !/^\d+\.\d{2}$/.test(initialBalance.amount) ||
    typeof initialBalance.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(initialBalance.currency)
  ) {
    throw new BadRequestException('Invalid initialBalance');
  }

  if (
    currency !== undefined &&
    currency !== initialBalance.currency
  ) {
    throw new BadRequestException('Currency mismatch');
  }

  return {
    playerId,
    currency: initialBalance.currency,
    initialBalance: {
      amount: initialBalance.amount,
      currency: initialBalance.currency,
    },
  };
}

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
  ): Promise<CreateWalletOutput> {
    const input = parseInput(body);

    try {
      return await this.createWallet.execute(input);
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }
}
