import { Module } from '@nestjs/common';

import {
  PENDING_REFERENCE_CLAIMER,
} from './application/ports/pending-reference-claimer.js';

import {
  PENDING_REFERENCE_RECOVERY,
} from './application/ports/pending-reference-recovery.js';

import {
  RecoverPendingReferencesUseCase,
} from './application/use-cases/recover-pending-references.use-case.js';

import {
  MikroOrmPendingReferenceClaimer,
} from './infrastructure/persistence/mikro-orm-pending-reference-claimer.js';

import {
  MikroOrmPendingReferenceRecovery,
} from './infrastructure/persistence/mikro-orm-pending-reference-recovery.js';

import {
  PendingReferenceWorker,
} from './infrastructure/workers/pending-reference.worker.js';

@Module({
  providers: [
    {
      provide: PENDING_REFERENCE_CLAIMER,
      useClass: MikroOrmPendingReferenceClaimer,
    },
    {
      provide: PENDING_REFERENCE_RECOVERY,
      useClass: MikroOrmPendingReferenceRecovery,
    },
    RecoverPendingReferencesUseCase,
    PendingReferenceWorker,
  ],
  exports: [
    RecoverPendingReferencesUseCase,
  ],
})
export class PendingReferenceModule {}
