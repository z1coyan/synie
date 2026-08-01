const input = await Bun.stdin.text()
const configuredSecrets = [
  process.env.AWS_ACCESS_KEY_ID,
  process.env.AWS_SECRET_ACCESS_KEY,
  process.env.CONVEX_POSTGRES_PASSWORD,
  process.env.CONVEX_SELF_HOSTED_ADMIN_KEY,
].filter((value): value is string => Boolean(value && value.length >= 8))

let output = input
for (const secret of configuredSecrets) output = output.replaceAll(secret, '<redacted>')
output = output.replace(/[A-Za-z0-9_-]{3,}\|[A-Za-z0-9_+./=-]{20,}/g, '<redacted-admin-key>')
output = output.replace(
  /(AWS_SECRET_ACCESS_KEY|CONVEX_SELF_HOSTED_ADMIN_KEY|CONVEX_POSTGRES_PASSWORD)=\S+/g,
  '$1=<redacted>',
)
output = output.replace(
  /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/gi,
  '$1<redacted>@',
)
output = output.replace(
  /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s]+/gi,
  '$1<redacted>',
)
process.stdout.write(output)

export {}
