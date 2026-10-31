# DLQ Runbook — Wager ingress

## Filas

- Entrada financeira: `wager-transactions.fifo`
- DLQ da entrada: `wager-transactions-dlq.fifo`
- Saída de eventos: `wager-events.fifo` — não reprocessar nessa fila envelopes de entrada.

## Condição de DLQ

O consumer **não confirma (DeleteMessage)** mensagens cuja validação ou transação falha. O SQS incrementa o contador de recebimentos e, ao ultrapassar `maxReceiveCount` da redrive policy, encaminha a mensagem para a DLQ FIFO.

O teste `test/integration/wager-dlq.integration.test.ts` usa filas temporárias e `maxReceiveCount=3`. Em produção, há configuração independente e backoff exponencial; o teste reduz o tempo de invisibilidade apenas no transporte de testes.

## Triagem operacional

1. Verificar alertas de tamanho e idade da DLQ, logs por motivo e janela de falha.
2. Distinguir **falha transitória** (banco/rede/SQS indisponível) de **mensagem inválida** (formato, tipo, identidade ou regra de negócio).
3. Antes de qualquer replay, confirmar se o processamento anterior foi persistido na Inbox, na WagerTransaction e no ledger.
4. Mensagem inválida que nunca poderá passar na validação **não deve ser reenviada em loop**; quarentenar e corrigir o problema na origem. A correção do payload configura uma **nova mensagem/identidade**, sujeita à política de negócio e auditoria; não fazer edição silenciosa da mensagem anterior.
5. Para falha transitória já resolvida, reenviar **o corpo original sem modificações**, preservando `messageId`, `providerId`, `externalTransactionId` e `idempotencyKey` no envelope.
6. No reenfileiramento manual, usar `MessageGroupId` da wallet, e **um novo `MessageDeduplicationId` do SQS** para que o reenvio intencional não seja suprimido na janela de cinco minutos; a Inbox continua garantindo que os efeitos financeiros sejam únicos.
7. Só excluir da DLQ depois de confirmação do envio à fila correta. Registrar operador, motivo, horário, IDs SQS de origem/destino e resultado da validação/replay.
8. Verificar o saldo, ledger, transação, Inbox e eventual evento Outbox após o reprocessamento.

## Precauções

- Não usar `PurgeQueue` nas filas compartilhadas.
- Não considerar SQS FIFO uma garantia de *exactly-once processing* fora de sua janela de deduplicação.
- DLQ em FIFO pode interromper a ordem lógica de processamento de eventos de uma wallet. Mensagens causalmente dependentes precisam de política de referência pendente ou bloqueio operacional explícito.
- O replay manual do teste representa recuperação após falha operacional; a implementação de um comando administrativo com autenticação, trilha de auditoria e aprovação fica para uma etapa posterior.
