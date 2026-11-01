import {
  Controller,
  Get,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';

import {
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

type DependencyStatus = 'up' | 'down';

interface ReadinessResult {
  status: 'ok' | 'unavailable';
  checks: {
    postgres: DependencyStatus;
    sqsInput: DependencyStatus;
    sqsOutput: DependencyStatus;
  };
}

@Injectable()
@Controller('health')
export class HealthController
  implements OnModuleDestroy
{
  private readonly logger =
    new Logger(HealthController.name);

  private readonly sqs: SQSClient;

  constructor(
    private readonly em: EntityManager,
  ) {
    const endpoint = process.env.SQS_ENDPOINT;

    this.sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      maxAttempts: 1,
      ...(endpoint
        ? {
          endpoint,
          credentials: {
            accessKeyId: 'test',
            secretAccessKey: 'test',
          },
        }
        : {}),
    });
  }

  @Get('live')
  live() {
    // Liveness does not depend on PostgreSQL
    // or SQS. It confirms the HTTP process
    // is alive and responding.
    return {
      status: 'ok',
    };
  }

  @Get('ready')
  async ready(): Promise<ReadinessResult> {
    const [postgres, sqsInput, sqsOutput] =
      await Promise.all([
        this.checkPostgres(),

        this.checkQueue(
          process.env.SQS_WAGER_QUEUE_URL,
          'sqsInput',
        ),

        this.checkQueue(
          process.env.SQS_QUEUE_URL,
          'sqsOutput',
        ),
      ]);

    const available =
      postgres === 'up' &&
      sqsInput === 'up' &&
      sqsOutput === 'up';

    const result: ReadinessResult = {
      status: available ? 'ok' : 'unavailable',
      checks: {
        postgres,
        sqsInput,
        sqsOutput,
      },
    };

    if (!available) {
      throw new ServiceUnavailableException(result);
    }

    return result;
  }

  private async checkPostgres():
    Promise<DependencyStatus> {
    try {
      await this.em.execute(
        'SELECT 1 AS health_check',
      );

      return 'up';
    } catch (error) {
      this.logDependencyFailure(
        'postgres',
        error,
      );

      return 'down';
    }
  }

  private async checkQueue(
    queueUrl: string | undefined,
    dependency: string,
  ): Promise<DependencyStatus> {
    if (!queueUrl) {
      this.logger.warn(
        `${dependency}: queue URL not configured`,
      );

      return 'down';
    }

    try {
      await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['QueueArn'],
        }),
        {
          abortSignal: AbortSignal.timeout(3000),
        },
      );

      return 'up';
    } catch (error) {
      this.logDependencyFailure(
        dependency,
        error,
      );

      return 'down';
    }
  }

  private logDependencyFailure(
    dependency: string,
    error: unknown,
  ): void {
    this.logger.warn(
      JSON.stringify({
        event: 'health.dependency.failed',
        dependency,
        errorType:
          error instanceof Error
            ? error.name
            : 'UnknownError',
      }),
    );
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
