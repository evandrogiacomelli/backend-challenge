# Distributed Wagering Processor

Serviço financeiro distribuído para processar operações de apostas de múltiplos provedores, com **idempotência persistente, concorrência por wallet, ledger imutável e recuperação de falhas**.

**Stack:** Bun 1.x, TypeScript, NestJS, MikroORM, PostgreSQL 17, SQS FIFO (LocalStack) e Docker Compose.

## Execução local

Requisitos: Bun, Docker e Docker Compose.

```powershell
bun install --frozen-lockfile
Copy-Item env.example .env
docker compose up -d
bun run db:migrate
bun src/main.ts
```

Revise o `.env` antes de iniciar. As filas de entrada, DLQ e eventos precisam existir no LocalStack e as URLs configuradas devem corresponder às filas criadas pelo ambiente. Consulte os scripts de inicialização do Compose caso necessário.

Configurações relevantes:

| Variáveis | Uso |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | PostgreSQL |
| `AWS_REGION`, `SQS_ENDPOINT` | SQS / LocalStack |
| `SQS_WAGER_QUEUE_URL` | Fila FIFO de entrada |
| `SQS_QUEUE_URL` | Publicação de eventos da Outbox |
| `SQS_WAGER_WORKER_ENABLED` | Consumo automático da fila |
| `PENDING_REFERENCE_WORKER_ENABLED` | Recuperação de referências pendentes |
| `METRICS_TOKEN` | Proteção do endpoint de métricas |
| `PORT` | Porta HTTP (padrão local: 3000) |

Não versione `.env` ou credenciais reais.

## API HTTP

| Método | Rota | Função |
| --- | --- | --- |
| `POST` | `/wallets` | Criar carteira, com lançamento `OPENING` se houver saldo inicial |
| `GET` | `/wallets/:walletId` | Consultar saldo e versão |
| `GET` | `/wallets/:walletId/ledger?limit=50&cursor=...` | Consultar ledger com cursor opaco |
| `POST` | `/wagering/transactions` | Processar `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` |
| `GET` | `/wagering/transactions/:transactionId` | Consultar operação pelo ID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar pela identidade do provedor |
| `POST` | `/wallets/:walletId/reconciliation` | Auditar saldo contra o ledger |
| `GET` | `/health/live`, `/health/ready` | Liveness e readiness |
| `GET` | `/metrics` | Métricas; exige `x-metrics-token` |

Exemplo de requisição financeira (substitua os UUIDs pelos IDs de uma carteira criada):

```http
POST /wagering/transactions
Idempotency-Key: provider-a:bet-001
Content-Type: application/json

{
  "providerId": "provider-a",
  "externalTransactionId": "bet-001",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-001",
  "gameId": "game-001",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

O header `Idempotency-Key` é obrigatório. O resultado é persistido e reproduzido em reenvios idênticos. Respostas HTTP distinguem `PROCESSED` (`200`), `PENDING_REFERENCE` (`202`), `REJECTED` (`422`), payload inválido (`400`) e conflito (`409`).

## Regras financeiras

| Operação | Efeito |
| --- | --- |
| `BET` | Débito, se houver saldo |
| `WIN` | Crédito |
| `LOSS` | Sem movimentação financeira |
| `REFUND` | Crédito compensatório de `BET` processada |
| `ROLLBACK` | Movimento inverso de `BET`, `WIN` ou `REFUND` processada |

`REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`. Referências ausentes ficam em `PENDING_REFERENCE` até recuperação ou rejeição terminal. Nenhum movimento é aplicado antecipadamente. Rejeições e replays não geram novos lançamentos no ledger.

## Testes

Com PostgreSQL e LocalStack disponíveis:

```powershell
bun run typecheck
bun run build
bun test
```

**Última execução registrada (01/11/2026): 391 testes aprovados, 0 falhas, em 56 arquivos.** Inclui testes reais de PostgreSQL/SQS, 50 requisições concorrentes, conflitos de idempotência, DLQ, falhas entre commit e ACK, reconciliação e recuperação de referências. O esgotamento exato das 10 tentativas ainda requer um teste específico.

## Decisões e limites

O PostgreSQL é a fonte de verdade; SQS FIFO auxilia na ordenação, mas não substitui locks e constraints. A entrega é *at-least-once*, com efeitos financeiros idempotentes. Autenticação de provedores não foi implementada neste escopo; consulte as decisões e extensões em [ARCHITECTURE.md](ARCHITECTURE.md).
