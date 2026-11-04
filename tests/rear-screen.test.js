import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/rear-screen.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {isTeslaRearScreen,isTeslaBrowser}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const rear={userAgent:'Mozilla/5.0 (X11; Linux x86_64) Tesla/2026.32 Chrome/130',width:1280,height:800,pixelRatio:1};
test('rear mode requires both Tesla identity and a supported rear display size',()=>{
  assert.equal(isTeslaRearScreen(rear),true);
  assert.equal(isTeslaRearScreen({...rear,userAgent:'Mozilla/5.0 Macintosh Chrome/130'}),false);
  assert.equal(isTeslaRearScreen({...rear,userAgent:'NotTesla'}),false);
  assert.equal(isTeslaRearScreen({...rear,userAgent:'Mozilla/5.0 (X11; Linux) Chrome/148 Safari/537.36 QtCarBrowser'}),true);
  assert.equal(isTeslaBrowser('NotQtCarBrowser'),false);
  assert.equal(isTeslaRearScreen({...rear,userAgent:'QtCarBrowser',width:1920,height:1200}),false);
  for(const [width,height] of [[1920,1200],[1920,1080],[1366,768],[1280,719],[1280,721],[800,1280],[1279,800]])assert.equal(isTeslaRearScreen({...rear,width,height}),false);
  // A matching browser viewport on a larger physical display must not activate it.
  assert.equal(isTeslaRearScreen({...rear,pixelRatio:2}),false);
  assert.equal(isTeslaRearScreen({...rear,width:640,height:400,pixelRatio:2}),true);
  assert.equal(isTeslaRearScreen({...rear,width:1280/1.53,height:800/1.53,pixelRatio:1.53}),true);
  assert.equal(isTeslaRearScreen({...rear,width:837,height:523,pixelRatio:1.53}),true);
  for(const pixelRatio of [0,-1,NaN,Infinity])assert.equal(isTeslaRearScreen({...rear,pixelRatio}),false);
});

test('the actual Model 3 rear browser report activates remote-only mode',()=>{
  const measured={userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Tesla/2026.33.100 TESLA_AUTO_1960450_2025_TESLA_MODEL3',width:1280,height:720,pixelRatio:1};
  assert.equal(isTeslaRearScreen(measured),true);
  // Front display report Vr2TUdfIRIcG has the same UA, but a 1920 × 1200 screen.
  assert.equal(isTeslaRearScreen({...measured,width:1920,height:1200}),false);
  assert.equal(isTeslaRearScreen({...measured,userAgent:'Mozilla/5.0 Macintosh Chrome/148'}),false);
  assert.equal(isTeslaRearScreen({...measured,pixelRatio:2}),false);
  assert.equal(isTeslaRearScreen({...measured,width:640,height:360,pixelRatio:2}),true);
  assert.equal(isTeslaRearScreen({...measured,width:837,height:471,pixelRatio:1.53}),true);
});
