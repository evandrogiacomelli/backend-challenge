# Architecture — Distributed Wagering Processor

## Visão geral

```text
HTTP API ────────────────────┐
                            ├─> Use cases (BET / WIN / LOSS / REFUND / ROLLBACK)
SQS FIFO -> Consumer -> Inbox┘                      │
                                                    v
                                             PostgreSQL
                                         Wallet / Transaction
                                         Ledger / Inbox / Outbox
                                                    │
                                       Outbox dispatcher -> SQS FIFO

PENDING_REFERENCE -> Scheduler -> Claim/lease -> Recovery -> PostgreSQL
Reconciliation -> Ledger + Wallet
```

A API HTTP e o consumidor SQS utilizam os mesmos casos de uso. O sistema não depende da memória de uma instância para determinar saldo, idempotência ou recuperação.

## Decisões técnicas

| Decisão | Motivo / trade-off |
| --- | --- |
| **`Money` imutável com `decimal.js` e strings decimais** | Precisão monetária e escala de duas casas; evita `number` para valores financeiros. |
| **MikroORM + SQL transacional no PostgreSQL** | Entidades separadas do domínio e controle explícito de locks, constraints e escritas financeiras. |
| **`SELECT ... FOR UPDATE` por wallet** | Serializa operações sobre o mesmo saldo, sem lock global. Uma wallet muito disputada limita throughput próprio. |
| **Ledger imutável + saldo materializado** | Consultas eficientes e trilha auditável; requer transações atômicas e reconciliação. |
| **Inbox e Outbox persistentes** | Deduplicação e publicação após commit, sem transação distribuída com SQS. Publicação repetida ainda é possível. |
| **SQS FIFO + DLQ** | Ordenação/deduplicação de transporte e isolamento de falhas; PostgreSQL continua garantindo consistência. |
| **`PENDING_REFERENCE` + worker** | Aceita operações fora de ordem sem aplicar dinheiro antes da referência; adiciona latência e custo de recuperação. |

## Invariantes e transações

- Uma wallet é única por `(playerId, currency)`; o saldo não pode ser negativo.
- `wallet.version` começa em 1 e cresce somente quando ocorre movimentação financeira.
- `BET` debita; `WIN` credita; `LOSS` não movimenta; `REFUND` credita uma `BET`; `ROLLBACK` aplica o efeito inverso da referência.
- `REFUND` e `ROLLBACK` exigem referência compatível com provedor, wallet, jogador, rodada, jogo, moeda e valor; não permitem dupla reversão processada.
- Cada movimentação possui um lançamento contíguo no ledger. Ledger não pode ser alterado ou excluído; `LOSS`, rejeições e replays não criam lançamento financeiro.
- Transação, saldo, versão, ledger, Inbox (quando aplicável) e Outbox são persistidos no mesmo commit SQL. Uma falha cancela o conjunto.

O banco reforça invariantes com unicidade de identidade/idempotência, constraints monetárias, proteção de imutabilidade e restrições de reversões. O bloqueio de linha impede *lost updates* em instâncias diferentes.

### Idempotência

A identidade combina provedor, ID externo e chave de idempotência, com hash do payload. Uma repetição compatível retorna o snapshot original, inclusive o saldo observado naquela operação; payload conflitante retorna erro. O ACK da mensagem SQS ocorre depois do commit. Se houver falha entre commit e ACK, a mensagem pode reaparecer, mas não repete o efeito financeiro.

**Garantia:** efeito financeiro durável idempotente; **não** entrega exatamente uma vez pelo SQS.

## Referências fora de ordem

1. Sem referência válida disponível, `REFUND`/`ROLLBACK` é persistida como `PENDING_REFERENCE`, sem movimento financeiro.
2. O claimer busca operações vencidas com `FOR UPDATE SKIP LOCKED`, incrementa `attempts` e estabelece um lease.
3. A recuperação bloqueia a wallet antes da transação pendente e verifica o claim para evitar execução duplicada.
4. Uma referência processada e válida permite aplicar a compensação; referência ainda ausente ou não processada é reagendada com backoff exponencial.
5. Após **10 tentativas**, a recuperação rejeita a operação com `failureCode`, snapshot e evento de rejeição na Outbox. Reversão sem saldo suficiente também não gera débito negativo.

O limite de 10 tentativas está implementado no recovery; a suíte geral passou, mas **não há comprovação específica do cenário de esgotamento na décima tentativa**.

## Eventos e falhas

A Outbox mantém eventos duráveis para publicação por worker; publishers concorrentes usam claims/leases e retries. A fila de eventos pode receber publicação duplicada após falha de confirmação: consumidores devem deduplicar por `eventId`.

O desafio define quatro categorias mínimas: `WagerTransactionProcessed` (inclusive `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged` (somente com mudança de saldo) e `WagerTransactionPendingReference`. Os fluxos possuem integração com Outbox, mas **a uniformidade de todos os nomes/envelopes de evento ainda não foi auditada**; não se declara conformidade total com o contrato canônico de eventos.

SQS usa reentrega e DLQ para falhas; workers possuem tratamento de encerramento gracioso. Reprocessamentos de DLQ mantêm a identidade original e passam novamente pela idempotência no banco.

## Auditoria, observabilidade e testes

A reconciliação compara saldo e versão materializados com lançamentos e sequência do ledger, sinalizando divergências sem corrigir registros silenciosamente. `GET /health/live` e `GET /health/ready` separam liveness e readiness. `GET /metrics` expõe métricas Prometheus mediante `x-metrics-token`; contadores são locais à instância, não agregados globalmente.

A validação executada em **01/11/2026** passou em `bun run typecheck` e **391 testes** (56 arquivos), incluindo PostgreSQL e LocalStack reais, 50 operações concorrentes, idempotência, Inbox/Outbox, DLQ, crash antes do ACK e recuperação. O cenário de três processos independentes também foi exercitado manualmente durante o desenvolvimento.

## Limitações e evolução

- **Autenticação:** não implementada, conforme opção permitida pelo challenge. Em produção, integrar um IdP OIDC externo (ex.: Keycloak), validar identidade/escopo do provedor em um guard na borda HTTP e manter health sem autenticação. Mensagens SQS permanecem canal interno sujeito às validações de domínio.
- **Eventos:** revisar e padronizar todas as subclasses/envelopes canônicos antes de afirmar conformidade integral com os quatro eventos obrigatórios.
- **Cobertura adicional:** incluir teste PostgreSQL de expiração na décima tentativa, verificando `REJECTED`, `failureCode`, Outbox única, snapshot e ausência de movimento.
- **Operação:** armazenamento de métricas por processo, alertas, proteção de credenciais, backup, escalabilidade e controles de rede exigem configuração de implantação própria.
