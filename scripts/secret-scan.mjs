import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const blockedName = /(\.env$|\.pem$|\.key$|service-account|id_rsa|\.dump$)/i;

function isBlockedSqlPath(file) {
  if (!/\.sql$/i.test(file)) return false;
  if (file.startsWith('database/migrations/')) return false;
  if (file.startsWith('database/seeds/')) return false;
  return true;
}
const blockedContent = [
  /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/,
  /AKIA[0-9A-Z]{16}/,
  /"private_key"\s*:\s*"-----BEGIN/,
];

const failures = [];

for (const file of files) {
  if (blockedName.test(file) || isBlockedSqlPath(file)) {
    failures.push(`${file}: blocked filename`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  for (const pattern of blockedContent) {
    if (pattern.test(text)) {
      failures.push(`${file}: matched ${pattern}`);
    }
  }
  if (file.endsWith('.env.example')) {
    for (const line of text.split('\n')) {
      const match = line.match(/^(JWT_SECRET|DB_PASSWORD|SSO_CLIENT_SECRET|OPENROUTER_API_KEY)=(.*)$/);
      if (match && match[2].trim() !== '') {
        failures.push(`${file}: ${match[1]} must stay empty`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`secret scan passed (${files.length} tracked files)`);
