import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/phone-device.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {isPhoneBrowser}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('phone remote is available on iPhone and Android phones, including landscape browsers',()=>{
  assert.equal(isPhoneBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'),true);
  assert.equal(isPhoneBrowser('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130.0 Mobile Safari/537.36'),true);
  assert.equal(isPhoneBrowser('Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Safari/537.36',true),true);
});
test('tablet and desktop identities stay out of phone mode even in a narrow browser',()=>{
  for(const ua of ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15','Mozilla/5.0 (Linux; Android 15; SM-X810) Safari/537.36','Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130'])assert.equal(isPhoneBrowser(ua),false);
  assert.equal(isPhoneBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',true),false);
});
test('Tesla front and rear browsers never expose the phone remote navigation',()=>{
  for(const ua of ['Mozilla/5.0 (X11; Linux x86_64) Chrome/148.0 Tesla/2026.33.100 TESLA_AUTO_1960450_2025_TESLA_MODEL3','Mozilla/5.0 (X11; Linux) Chrome/148.0 QtCarBrowser']){
    assert.equal(isPhoneBrowser(ua),false);assert.equal(isPhoneBrowser(ua,true),false);
  }
});
