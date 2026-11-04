import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function forbiddenPath(file) {
  const value = file.replaceAll('\\', '/');
  if (value === '.env.example') return false;
  return /(^|\/)(?:\.env[^/]*|\.dev\.vars[^/]*|\.credentials[^/]*|\.backup|\.pf-patch|\.tmp(?:-library)?|\.wrangler|node_modules|shots(?:-explore)?|test-results|playwright-report)(?:\/|$)/i.test(value)
    || /(?:\.bak|\.backup|\.log|\.tsbuildinfo)$|\.pre-/i.test(value)
    || /^docs\/references\//i.test(value);
}

export function scanContent(file, input, knownSecrets = []) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const text = bytes.toString('utf8');
  const findings = [];
  const patterns = [
    ['API token', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
    ['search API token', /\bas_sk_[A-Za-z0-9_-]{24,}\b/g],
    ['GitHub token', /\b(?:gh[opusr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ];
  for (const [kind, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) findings.push({ file, line: text.slice(0, match.index).split('\n').length, kind });
  }
  for (const secret of new Set(knownSecrets.filter(value => typeof value === 'string' && value.length >= 12))) {
    if (bytes.includes(Buffer.from(secret)) && !findings.length) findings.push({ file, line: 0, kind: 'known local secret' });
  }
  return findings;
}

export function environmentSecrets(input) {
  const secrets = [];
  for (const line of input.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && /KEY|SECRET|TOKEN|ACCESS_CODES/.test(match[1])) {
      const value = match[2].replace(/^["']|["']$/g, '');
      secrets.push(...(match[1] === 'ACCESS_CODES' ? value.split(/[,\s]+/) : [value]));
    }
  }
  return secrets;
}

function localSecrets(root) {
  const secrets = [];
  for (const name of fs.readdirSync(root).filter(name => /^(?:\.env|\.dev\.vars)/.test(name) && name !== '.env.example')) {
    if (!fs.statSync(path.join(root, name)).isFile()) continue;
    secrets.push(...environmentSecrets(fs.readFileSync(path.join(root, name), 'utf8')));
  }
  const credentialPath = path.join(root, '.credentials.json');
  if (fs.existsSync(credentialPath)) {
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/secret|apiKey|token/i.test(key) && typeof child === 'string') secrets.push(child);
        else walk(child);
      }
    };
    walk(JSON.parse(fs.readFileSync(credentialPath, 'utf8')));
  }
  return secrets.filter(value => !['mock-model-key', 'mock-search-key'].includes(value));
}

function walkFiles(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not permitted in release assets');
    return entry.isDirectory() ? walkFiles(root, name) : [name];
  });
}

export function main(args = process.argv.slice(2)) {
  const root = process.cwd();
  const secrets = localSecrets(root);
  const dist = args.includes('--dist');
  const staged = args.includes('--staged');
  const git = (...values) => execFileSync('git', values, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const files = dist ? walkFiles(path.join(root, 'dist')).map(name => 'dist/' + name)
    : git('ls-files', '-z', ...(staged ? ['--cached'] : ['--cached', '--others', '--exclude-standard'])).toString('utf8').split('\0').filter(Boolean);
  if (!files.length) throw new Error('No files selected for release scan');
  const findings = [];
  for (const file of new Set(files)) {
    if (forbiddenPath(file)) findings.push({ file, line: 0, kind: 'private or generated path' });
    const absolute = path.join(root, file);
    if (fs.lstatSync(absolute).isSymbolicLink()) { findings.push({ file, line: 0, kind: 'symlink' }); continue; }
    const content = staged && !dist ? git('show', ':' + file) : fs.readFileSync(absolute);
    findings.push(...scanContent(file, content, secrets));
  }
  // Findings intentionally contain only path/line/type, never matching text.
  console.log(JSON.stringify({ mode: dist ? 'built-assets' : staged ? 'git-index' : 'working-source', files: new Set(files).size, findings }, null, 2));
  return findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch { console.error('Release scan failed; verify the selected files and Git checkout. No secret content was printed.'); process.exitCode = 1; }
}
