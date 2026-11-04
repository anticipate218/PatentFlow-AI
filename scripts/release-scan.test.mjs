import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentSecrets, scanContent, forbiddenPath } from './release-scan.mjs';

test('release scan rejects private inputs and historical backups', () => {
  for (const file of ['.env.local', '.env.deepseek-test.local', '.dev.vars', '.credentials.json', '.tmp-library/case.json', 'src/a.ts.pre-fix.bak', 'shots/customer.png', 'docs/references/paper.pdf']) {
    assert.equal(forbiddenPath(file), true, file);
  }
  for (const file of ['.env.example', 'src/App.tsx', 'worker/index.ts', 'public/sample-invention.pdf']) assert.equal(forbiddenPath(file), false, file);
});
test('release scan detects API tokens without including values in findings', () => {
  const secret = 'sk-' + 'a1b2c3d4'.repeat(4);
  const findings = scanContent('src/config.ts', 'const key = "' + secret + '";');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
  assert.equal(JSON.stringify(findings).includes(secret), false);
});
test('release scan detects known secrets even inside binary assets', () => {
  const secret = 'synthetic-private-value-012345';
  assert.equal(scanContent('dist/asset.bin', Buffer.concat([Buffer.from([0,255]), Buffer.from(secret)]), [secret]).length, 1);
});
test('release scan reads secret variables whose names contain digits', () => {
  const secret = 'synthetic-private-value-012345';
  const knownSecrets = environmentSecrets(`OPENAI_V2_API_KEY=${secret}`);
  const findings = scanContent('dist/asset.bin', Buffer.from(secret), knownSecrets);
  assert.deepEqual(findings, [{ file: 'dist/asset.bin', line: 0, kind: 'known local secret' }]);
  assert.equal(JSON.stringify(findings).includes(secret), false);
});

test('release scan detects search-provider tokens without local secret files',()=>{
  const secret='as_'+'sk_'+'a1b2c3d4'.repeat(4);
  const findings=scanContent('config.ts',secret);
  assert.equal(findings.length,1);
  assert.equal(JSON.stringify(findings).includes(secret),false);
});
test('release scan permits empty example variables and illustrative short tokens', () => {
  assert.deepEqual(scanContent('.env.example', 'AGNES_API_KEY=\nANYSEARCH_API_KEY=\n'), []);
  assert.deepEqual(scanContent('test.ts', 'mock-model-key sk-test'), []);
});
test('release scan detects fine-grained GitHub tokens without local secret configuration', () => {
  const token = 'github_' + 'pat_' + 'A1b2_'.repeat(17);
  const findings = scanContent('src/config.ts', '// synthetic fixture\nconst token = "' + token + '";');
  assert.deepEqual(findings, [{ file: 'src/config.ts', line: 2, kind: 'GitHub token' }]);
  assert.equal(JSON.stringify(findings).includes(token), false);
});
test('release scan retains classic GitHub detection and ignores abbreviated fine-grained examples', () => {
  const token = 'gh' + 'p_' + 'A1b2'.repeat(10);
  assert.equal(scanContent('src/config.ts', token)[0]?.kind, 'GitHub token');
  assert.deepEqual(scanContent('example.md', 'github_pat_example github_pat_...'), []);
});
