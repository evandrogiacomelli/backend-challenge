#!/bin/sh
set -eu

echo "[localstack-init] Provisioning SQS queues"

ensure_queue() {
  name="$1"

  if awslocal sqs get-queue-url \
    --queue-name "$name" >/dev/null 2>&1; then
    echo "[localstack-init] Already exists: $name"
  else
    awslocal sqs create-queue \
      --queue-name "$name" \
      --attributes \
      FifoQueue=true,ContentBasedDeduplication=false
    echo "[localstack-init] Created: $name"
  fi
}

ensure_queue "wagers-dlq.fifo"
ensure_queue "wagers.fifo"
ensure_queue "wager-events.fifo"

dlq_url=$(awslocal sqs get-queue-url \
  --queue-name wagers-dlq.fifo \
  --query 'QueueUrl' --output text)

wager_url=$(awslocal sqs get-queue-url \
  --queue-name wagers.fifo \
  --query 'QueueUrl' --output text)

dlq_arn=$(awslocal sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

# Configure redrive after the DLQ exists.
cat > /tmp/wager-redrive-attributes.json <<EOF
{
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${dlq_arn}\",\"maxReceiveCount\":\"5\"}"
}
EOF

awslocal sqs set-queue-attributes \
  --queue-url "$wager_url" \
  --attributes file:///tmp/wager-redrive-attributes.json

echo "[localstack-init] SQS provisioned successfully"
