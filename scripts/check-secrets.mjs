#!/usr/bin/env node
// Fails if anything that looks like a secret is tracked (or about to be committed).
// Checks: committed .env files, PEM private keys, hex private keys next to key-like names, mnemonics,
// and a non-placeholder ADMIN_API_TOKEN / PRIVATE_KEY in .env.example.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const findings = [];
const KEY_CONTEXT =
  /(private[_-]?key|secret|signing[_-]?key|PRIVATE_KEY|privKey|pk)\s*["'`]?\s*[:=]\s*["'`]?(0x)?[0-9a-fA-F]{64}\b/;
const PEM = /-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const MNEMONIC = /(mnemonic|seed[_ ]?phrase)\s*[:=]\s*["'`]?([a-z]+ ){11,23}[a-z]+/i;

for (const file of files) {
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith('.env.example'))
    findings.push(`${file}: environment file must not be committed`);
  if (/\.(png|jpg|ico|woff2?|lock)$/.test(file) || file === 'package-lock.json') continue;
  let text;
  try {
    if (statSync(file).size > 2_000_000) continue;
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (KEY_CONTEXT.test(line))
      findings.push(`${file}:${i + 1}: hex private key assigned to a key-like name`);
    if (PEM.test(line)) findings.push(`${file}:${i + 1}: PEM private key`);
    if (MNEMONIC.test(line)) findings.push(`${file}:${i + 1}: possible mnemonic phrase`);
  });
  if (file.endsWith('.env.example')) {
    for (const line of text.split('\n')) {
      const [k, v] = line.split('=', 2);
      if (k === 'PRIVATE_KEY' && v && v.trim() !== '')
        findings.push(`${file}: PRIVATE_KEY must be empty in the example`);
      if (k === 'ADMIN_API_TOKEN' && v && !/REPLACE/i.test(v))
        findings.push(`${file}: ADMIN_API_TOKEN must be a placeholder`);
    }
  }
}

if (findings.length > 0) {
  console.error(`Secret scan failed (${findings.length}):\n${findings.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} files checked).`);
