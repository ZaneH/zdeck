// Owned browser fixtures only. No real native IPC, file picker, plugin directory or execution.
// Serve the app on 1421 and built Storybook on 6010 (override ZDX_APP_URL/ZDX_STORYBOOK_URL).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const appUrl = process.env.ZDX_APP_URL || 'http://127.0.0.1:1421';
const stories = process.env.ZDX_STORYBOOK_URL || 'http://127.0.0.1:6010';
const output = process.env.ZDX_ARTIFACT_DIR || '/tmp/zdeck-zdx-verification';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
const measurements = [];
async function fits(page, name) {
  const result = await page.locator('dialog[open]').evaluate((e) => { const r = e.getBoundingClientRect(); return { left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:e.scrollWidth,client:e.clientWidth }; });
  assert.ok(result.left >= 0 && result.right <= result.width + 1 && result.top >= 0 && result.bottom <= result.height + 1, `${name} outside viewport`);
  assert.ok(result.scroll <= result.client + 1, `${name} horizontal overflow`); measurements.push({ name, ...result });
}
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 800 }, reducedMotion:'reduce' });
  for (const state of ['inspect','invalid','replace','busy','error','runtime-missing']) {
    for (const width of [960,320]) {
      await page.setViewportSize({width,height:800});
      // Error has no auto-play: override its args to inspect each state without dismissing it.
      await page.goto(`${stories}/iframe.html?id=settings-local-archive--error&viewMode=story&args=state:${state}`);
      await page.waitForLoadState('networkidle'); await page.locator('dialog[open]').waitFor();
      await fits(page,`${state}-${width}`);
      if (state === 'inspect') { await page.getByText('Local integrity details').click(); await fits(page,`hashes-${width}`); }
      await page.screenshot({path:`${output}/${state}-${width}.png`,fullPage:true});
      if (state === 'busy') {
        await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog[open]').count(),1);
        await page.mouse.click(2,2); assert.equal(await page.locator('dialog[open]').count(),1);
      } else { await page.keyboard.press('Escape'); await page.locator('dialog[open]').waitFor({state:'detached'}); }
    }
  }
  const deck = {version:3,theme:'dark',accent:'#4cc9f0',activePageId:'fixture',pages:[{id:'fixture',name:'Fixture',sections:[{id:'section',name:'Controls',controls:[{id:'media',label:'Play / pause',action:'media-play-pause'}]}]}]};
  const app = await browser.newPage({ viewport: {width:960,height:800}, reducedMotion:'reduce' });
  await app.addInitScript(({deck}) => {
    localStorage.setItem('deck.setup.v1','done'); window.isTauri=true;
    const callbacks = new Map(); const listeners = new Set(); let next=0;
    let view={busy:false,review:null,error:null,installedEpoch:0}; let installed=false;
    const review={reviewId:'a'.repeat(32),id:'fixture',version:'1.2.3',protocolVersion:1,runtime:'node',identity:'b'.repeat(64),archiveSha256:'c'.repeat(64),files:2,bytes:300,collision:false,runtimeStatus:'detected',runtimeVersion:'22.18.0'};
    const changed=()=>{ for(const id of listeners)callbacks.get(id)?.({event:'plugin-archive-changed',id,payload:null}); };
    window.__zdxCalls=[]; window.__zdxCase='inspect';
    const select=()=>{
      if(view.busy||view.review)throw 'Finish or cancel the current review.';
      view={...view,error:null,review:window.__zdxCase==='invalid'?null:{...review,collision:window.__zdxCase==='replace',runtimeStatus:window.__zdxCase==='runtime-missing'?'not_found':'detected'}};
      if(window.__zdxCase==='invalid')view.error='Fixture invalid ZIP: no package was installed.';
      changed();
    };
    window.__zdxNativeDrop=select; // simulates a native notification, not a DOM/path installer
    window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(_event,id){listeners.delete(id);}};
    window.__TAURI_INTERNALS__={transformCallback(callback){const id=++next;callbacks.set(id,callback);return id;},invoke:async(command,args)=>{
      window.__zdxCalls.push({command,args});
      if(command==='plugin:event|listen'){listeners.add(args.handler);return args.handler;}
      if(command==='plugin:event|unlisten'){listeners.delete(args.eventId);return null;}
      if(command==='plugin_registry_website_status')return {available:false,explanation:'Registry website not configured for this build.'};
      if(command==='plugin_archive_view')return structuredClone(view);
      if(command==='plugin_archive_pick'){select();return null;}
      if(command==='plugin_archive_cancel'){if(args.reviewId!==(view.review?.reviewId??null))throw 'Stale review';view={...view,review:null,error:null};changed();return null;}
      if(command==='plugin_archive_install'){
        if(args.reviewId!==view.review?.reviewId||view.review.collision)throw 'Invalid review authorization';
        view.busy=true;changed();
        await new Promise(resolve=>{window.__zdxFinishInstall=resolve;});
        view.busy=false;view.review=null;
        if(window.__zdxCase==='command-lost'){changed();throw 'Fixture IPC response lost';}
        if(window.__zdxCase==='error')view.error='Fixture publication refused. Nothing was overwritten.';
        else {installed=true;view.installedEpoch++;}
        changed();return null;
      }
      if(command==='native_deck_load')return{exists:true,revision:1,deck};
      if(command==='plugin_catalog')return{directory:'/fixture/plugins',node:{status:'detected',version:'22.18.0',path:'/fixture/node'},plugins:installed?[{id:'fixture',name:'fixture',version:'1.2.3',protocolVersion:1,status:'ready',message:null,icon:null,trusted:false,identity:'b'.repeat(64)}]:[]};
      if(command==='plugin_snapshots')return{};
      if(command==='desktop_close_to_tray')return false;
      if(command==='desktop_tray_notice'||command==='obs_load_preferences')return null;
      if(command==='obs_snapshot')return{connected:false,host:'127.0.0.1',port:4455,scenes:[],currentScene:null,observedAtMs:Date.now()};
      if(command==='remote_status')return{running:false,mode:null,origin:null,port:null,pendingDevices:0,approvedDevices:0,connectedSockets:0};
      throw new Error('Unexpected fixture command: '+command);
    }};
  },{deck});
  await app.goto(`${appUrl}/#/settings/integrations`); await app.waitForLoadState('networkidle');
  const picker=app.getByRole('button',{name:'Install from…'});
  await picker.click();
  await app.getByRole('menuitem',{name:'Local .zdx'}).click(); await app.locator('dialog.archive-dialog[open]').waitFor();
  const picked=await app.locator('.archive-facts').first().textContent();
  await app.keyboard.press('Escape'); await app.locator('dialog.archive-dialog[open]').waitFor({state:'detached'});
  assert.equal(await picker.evaluate(e=>e===document.activeElement),true,'Escape restores picker focus');
  await app.evaluate(()=>window.__zdxNativeDrop()); await app.locator('dialog.archive-dialog[open]').waitFor();
  assert.equal(await app.locator('.archive-facts').first().textContent(),picked,'picker/drop share review UI');
  await app.getByRole('button',{name:'Cancel',exact:true}).click(); await app.locator('dialog.archive-dialog[open]').waitFor({state:'detached'});
  for(const state of ['invalid','replace','runtime-missing']){
    await app.evaluate(s=>{window.__zdxCase=s;window.__zdxNativeDrop();},state); await app.locator('dialog.archive-dialog[open]').waitFor();
    if(state!=='runtime-missing')assert.equal(await app.getByRole('button',{name:'Install disabled',exact:true}).isDisabled(),true);
    await app.keyboard.press('Escape');await app.locator('dialog.archive-dialog[open]').waitFor({state:'detached'});
  }
  await app.evaluate(()=>{window.__zdxCase='error';window.__zdxNativeDrop();});
  await app.getByRole('button',{name:'Install disabled',exact:true}).click();
  await app.waitForFunction(()=>typeof window.__zdxFinishInstall==='function');
  await app.keyboard.press('Escape'); assert.equal(await app.locator('dialog.archive-dialog[open]').count(),1);
  await app.evaluate(()=>window.__zdxFinishInstall());
  await app.getByRole('alert').filter({hasText:'Fixture publication refused'}).waitFor();
  await app.getByRole('button',{name:'Cancel',exact:true}).click();await app.locator('dialog.archive-dialog[open]').waitFor({state:'detached'});
  await app.evaluate(()=>{window.__zdxCase='command-lost';window.__zdxNativeDrop();});
  await app.getByRole('button',{name:'Install disabled',exact:true}).click();
  await app.waitForFunction(()=>document.querySelector('dialog.archive-dialog')?.getAttribute('aria-busy')==='true');
  await app.evaluate(()=>window.__zdxFinishInstall());
  await app.getByRole('alert').filter({hasText:'The install result could not be confirmed'}).waitFor();
  await app.getByRole('button',{name:'Cancel',exact:true}).click();await app.locator('dialog.archive-dialog[open]').waitFor({state:'detached'});
  await app.evaluate(()=>{location.hash='#/';window.__zdxCase='inspect';window.__zdxNativeDrop();});
  await app.getByRole('button',{name:'Install disabled',exact:true}).click();
  await app.waitForFunction(()=>document.querySelector('dialog.archive-dialog')?.getAttribute('aria-busy')==='true');
  await app.evaluate(()=>window.__zdxFinishInstall());
  await app.locator('[data-plugin-id=fixture]').waitFor();
  assert.ok((await app.locator('[data-plugin-id=fixture]').textContent()).includes('Disabled'));
  assert.equal(await app.getByRole('button',{name:'Enable fixture',exact:true}).count(),1);
  assert.equal(await app.locator('dialog.archive-dialog[open]').count(),0);
  const calls=await app.evaluate(()=>window.__zdxCalls);
  assert.equal(calls.some(c=>['plugin_enable','plugin_trust','plugin_execute','plugin_state'].includes(c.command)),false,'installation never runs or trusts');
  for(const call of calls.filter(c=>c.command.startsWith('plugin_archive_')))assert.ok(Object.keys(call.args??{}).every(k=>k==='reviewId'),'no renderer paths or targets');
  await app.screenshot({path:`${output}/installed-disabled.png`,fullPage:true});
  const preview=await browser.newPage();await preview.goto(`${appUrl}/#/settings/integrations`);await preview.waitForLoadState('networkidle');
  assert.equal(await preview.getByRole('button',{name:'Install from…'}).count(),0);
  assert.ok(await preview.getByText(/browser stays preview-only/).count());
  await writeFile(`${output}/results.json`,JSON.stringify({measurements,archiveCalls:calls.filter(c=>c.command.startsWith('plugin_archive_')),checks:'Storybook six states at 960/320, hashes, keyboard/backdrop busy, picker/drop parity, cancel/focus, collision, runtime missing, publication error, uncertain delivery, disabled install, no trust/enable, browser preview. All browser fakes; no native parity claim.'},null,2));
  console.log(`zdx UI checks passed; screenshots and results: ${output}`);
} finally {await browser.close();}
