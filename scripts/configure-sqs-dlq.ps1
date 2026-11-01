$region = "us-east-1"

$sourceUrl = "http://localhost.localstack.cloud:4566/queue/us-east-1/000000000000/wagers.fifo"

$dlqUrl = docker compose exec -T localstack awslocal sqs get-queue-url `
  --queue-name wagers-dlq.fifo `
  --region $region `
  --query QueueUrl `
  --output text

$dlqArn = docker compose exec -T localstack awslocal sqs get-queue-attributes `
  --queue-url $dlqUrl `
  --attribute-names QueueArn `
  --region $region `
  --query Attributes.QueueArn `
  --output text

if ($LASTEXITCODE -ne 0 -or -not $dlqArn) {
  throw "Nao foi possivel obter o ARN da DLQ"
}

$policy = @{
  deadLetterTargetArn = $dlqArn.Trim()
  maxReceiveCount = "3"
} | ConvertTo-Json -Compress

$attributes = @{
  RedrivePolicy = $policy
} | ConvertTo-Json -Compress

$file = Join-Path (Get-Location) "sqs-redrive.json"

[System.IO.File]::WriteAllText(
  $file,
  $attributes,
  [System.Text.UTF8Encoding]::new($false)
)

docker compose cp ./sqs-redrive.json localstack:/tmp/sqs-redrive.json

if ($LASTEXITCODE -ne 0) {
  throw "Falha ao copiar a configuracao"
}

docker compose exec -T localstack awslocal sqs set-queue-attributes `
  --queue-url $sourceUrl `
  --attributes file:///tmp/sqs-redrive.json `
  --region $region

if ($LASTEXITCODE -ne 0) {
  throw "Falha ao aplicar RedrivePolicy"
}

Remove-Item ./sqs-redrive.json

Write-Host "RedrivePolicy configurada."
