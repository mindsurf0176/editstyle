/* Browser UI + real loopback engine/media. Host SDK is explicitly a test double. */
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'out', 'plugin-qa');
fs.mkdirSync(out, { recursive: true });
const source = path.join(out, 'source.mp4');
execFileSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','testsrc2=s=320x180:r=30:d=3',
  '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3', '-c:v','libx264','-pix_fmt','yuv420p',
  '-c:a','aac','-shortest',source]);
const port = 18472;
let output = '', engine, browser;
(async () => {
  engine = spawn(path.join(root, '.venv/bin/python'), ['-m','editstyle.app','--plugins','--no-browser',
    '--port',String(port),'--data-dir',path.join(out,'workspace')], { cwd: root, stdio: ['ignore','pipe','pipe'] });
  engine.stdout.on('data', chunk => { output += chunk; });
  engine.stderr.on('data', chunk => { if (!String(chunk).includes('INFO:')) process.stderr.write(chunk); });
  let token;
  for (let i = 0; i < 100; i++) {
    token = output.match(/변경\): ([\w-]+)/)?.[1];
    if (token) {
      try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch (_) { /* startup */ }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(token, 'paired engine must start');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 380, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('engineRequest', async (url, options) => {
    assert.ok(url.startsWith('http://127.0.0.1:18470/bridge/'));
    const response = await fetch(url.replace(':18470', ':' + port), options);
    return { ok: response.ok, value: await response.json() };
  });
  const html = fs.readFileSync(path.join(root, 'plugins/premiere/index.html'), 'utf8')
    .replace('<script src="index.js"></script>', '').replace('<link rel="stylesheet" href="panel.css">', '');
  await page.route(`http://127.0.0.1:${port}/panel-test`, route => route.fulfill({ contentType:'text/html', body:html }));
  await page.goto(`http://127.0.0.1:${port}/panel-test`);
  await page.addStyleTag({ content: fs.readFileSync(path.join(root,'plugins/premiere/panel.css'),'utf8') });
  for (const module of ['bridge','panel']) {
    await page.addScriptTag({ content: `{ const module = { exports: {} }; ${fs.readFileSync(path.join(root,`plugins/premiere/${module}.js`),'utf8')}; window.${module}Module = module.exports; }` });
  }
  await page.evaluate(sourcePath => {
    window.hostFixture = { host:'premiere', project_id:'qa-project', sequence_id:'qa-sequence', name:'패널 QA · 호스트 대역',
      fps:30, width:320, height:180, clips:[{id:'v0-0',name:'첫 장면',path:sourcePath,timeline_in:0,source_in:0,duration:30,source_frames:90,audio:true},
      {id:'v0-1',name:'두 번째 장면',path:sourcePath,timeline_in:30,source_in:30,duration:60,source_frames:90,audio:true}] };
    window.imports = [];
    const host = { snapshot: async () => JSON.parse(JSON.stringify(window.hostFixture)),
      apply: async prepared => { window.imports.push(prepared); return prepared.name; } };
    const bridge = window.bridgeModule.createBridge(async (url, options) => {
      const response = await window.engineRequest(url, options);
      return { ok: response.ok, json: async () => response.value };
    });
    window.panelModule.startPanel(document, host, bridge);
  }, source);
  await page.locator('#pair-code').fill('invalid-code'); await page.locator('#pair').click();
  await page.waitForFunction(() => document.getElementById('status').classList.contains('error'));
  await page.locator('#pair-code').fill(token); await page.locator('#pair').click();
  await page.waitForFunction(() => !document.getElementById('capture').disabled);
  assert.equal(await page.locator('#pair-code').inputValue(), '');
  await page.locator('#settings-toggle').click();
  await page.locator('#capture').click(); await page.waitForFunction(() => !document.getElementById('manual').disabled);
  await page.locator('#generate').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('모델을 연결'));
  await page.locator('#manual').click();
  await page.getByLabel('1번 컷 끝 프레임', { exact: true }).fill('15');
  await page.getByLabel('2번 컷 시작 프레임', { exact: true }).fill('15');
  await page.getByLabel('2번 컷 끝 프레임', { exact: true }).fill('45');
  assert.equal(await page.locator('#apply').isDisabled(), true);
  await page.locator('#acknowledge').check();
  await page.screenshot({ path:path.join(out,'premiere-panel-380.png'),fullPage:true });
  await page.setViewportSize({ width:320,height:900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path:path.join(out,'premiere-panel-320.png'),fullPage:true});
  await page.evaluate(() => { window.hostFixture.sequence_id = 'changed'; });
  await page.locator('#apply').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('바뀌었습니다'));
  assert.equal(await page.evaluate(() => window.imports.length), 0);
  await page.evaluate(() => { window.hostFixture.sequence_id = 'qa-sequence'; });
  await page.locator('#apply').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('새 시퀀스를 만들었습니다'));
  const imports = await page.evaluate(() => window.imports);
  assert.equal(imports.length, 1); assert.ok(fs.existsSync(imports[0].path));
  assert.equal(await page.locator('#apply').isDisabled(), true);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed:true, host:'explicit SDK test double, NOT Premiere runtime',
    engine:'real loopback API', media:'real FFmpeg source + XML', screenshots:out, browserErrors:errors }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (engine) engine.kill('SIGTERM');
});
