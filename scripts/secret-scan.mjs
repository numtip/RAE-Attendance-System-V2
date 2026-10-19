import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const blockedName = /(\.env$|\.pem$|\.key$|service-account|id_rsa|\.dump$)/i;

function isAllowedSqlPath(file) {
  return file.startsWith('database/migrations/')
    || file.startsWith('database/seeds/')
    || file.startsWith('database/rollbacks/');
}

function isBlockedSqlPath(file) {
  if (!/\.sql$/i.test(file)) return false;
  return !isAllowedSqlPath(file);
}
const blockedContent = [
  /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/,
  /AKIA[0-9A-Z]{16}/,
  /"private_key"\s*:\s*"-----BEGIN/,
];

function scanText(file, text) {
  const failures = [];
  if (blockedName.test(file) || isBlockedSqlPath(file)) {
    failures.push(`${file}: blocked filename`);
    return failures;
  }
  for (const pattern of blockedContent) {
    if (pattern.test(text)) {
      failures.push(`${file}: matched ${pattern}`);
    }
  }
  if (file.endsWith('.env.example')) {
    for (const line of text.split('\n')) {
      const match = line.match(/^(JWT_SECRET|DB_PASSWORD|SSO_CLIENT_SECRET|AGENT_CORE_PROJECT_TOKEN)=(.*)$/);
      if (match && match[2].trim() !== '') {
        failures.push(`${file}: ${match[1]} must stay empty`);
      }
    }
  }
  return failures;
}

function main() {
  const files = execSync('git ls-files', { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const failures = [];
  for (const file of files) {
    const text = isBlockedSqlPath(file) || blockedName.test(file) ? '' : readFileSync(file, 'utf8');
    failures.push(...scanText(file, text));
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`secret scan passed (${files.length} tracked files)`);
}

const invokedAsCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main();
}

export { isBlockedSqlPath, scanText };
