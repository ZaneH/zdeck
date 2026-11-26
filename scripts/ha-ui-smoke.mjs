// Owned fixtures only. Start Vite on 1420 and Storybook on 6007 before running.
// Override with HA_APP_URL / HA_STORYBOOK_URL; no real native IPC or HA connection.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const appUrl = process.env.HA_APP_URL || 'http://127.0.0.1:1420';
const storybookUrl = process.env.HA_STORYBOOK_URL || 'http://localhost:6007';
const out = process.env.HA_ARTIFACT_DIR || '/tmp/zdeck-ha-refinement';
await mkdir(out, { recursive: true });
const manifest = JSON.parse(await readFile(new URL('../plugins/home-assistant/manifest.json', import.meta.url)));
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
const measurements = [];
async function fits(page, name) {
  const result = await page.evaluate(() => {
    const nodes = [document.documentElement, ...document.querySelectorAll('.workspace,.inspector-dock,.inspector-section-body,.native-control,.dropdown,.dropdown-menu,.dropdown-trigger,.control-tile')];
    return nodes.map(e => { const r = e.getBoundingClientRect(); return { node: e.className || e.tagName, client: e.clientWidth, scroll: e.scrollWidth, left: r.left, right: r.right, top: r.top, bottom: r.bottom, viewport: innerWidth, viewportHeight: innerHeight }; });
  });
  measurements.push({ name, result });
  for (const label of await page.locator('.dropdown-label').all()) {
    if (await label.textContent() === 'Entity') assert.equal(await label.evaluate(e => e.scrollWidth <= e.clientWidth + 1), true, `${name}: Entity label must not collapse`);
  }
  for (const r of result) { assert.ok(r.scroll <= r.client + 1, `${name}: ${r.node} scroll ${r.scroll}/${r.client}`); assert.ok(r.right <= r.viewport + 1 && r.left >= -1, `${name}: ${r.node} outside viewport`); if (String(r.node).includes('dropdown-menu')) assert.ok(r.top >= 0 && r.bottom <= r.viewportHeight, `${name}: menu outside vertical viewport`); }
}
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 1000 }, reducedMotion: 'reduce' });
  for (const [story, width] of [['selected-long-entity',960],['open-long-entity',960],['narrow-inspector',320],['explicit-on-off',960],['unavailable-toggle',320],['read-only-temperature',390],['fahrenheit',390],['unavailable-value',390]]) {
    await page.setViewportSize({ width, height: 1200 });
    await page.goto(`${storybookUrl}/iframe.html?id=controls-home-assistant--${story}&viewMode=story`);
    await page.waitForLoadState('networkidle');
    await page.locator('.panel').waitFor();
    await fits(page, story);
    await page.screenshot({ path: `${out}/${story}.png`, fullPage: true });
  }
  const desktop = await browser.newPage({ viewport: { width: 960, height: 680 }, reducedMotion: 'reduce' });
  await desktop.addInitScript(({ manifest }) => {
    localStorage.setItem('deck.setup.v1', 'done');
    const control = (id, pluginAction, presentation, pluginArgs, label) => ({ id, action: 'plugin', pluginId: 'home-assistant', pluginAction, presentation, pluginArgs, label });
    let deck = { version:3, theme:'dark', accent:'#4cc9f0', activePageId:'home', pages:[{id:'home',name:'Home',sections:[{id:'room',name:'Living room',controls:[
      control('power','power','toggle-switch',{entity:7,enabled:false},'Kitchen light'),
      control('fixed','power','button',{entity:7,enabled:true},'Always on'),
      control('reading','temperature','value',{entity:8},'Room temperature'),
      control('state','state','value',{entity:7},'Light state'),
    ]}]}] };
    let revision=1;
    let state = { entities:[{value:7,label:'Kitchen pendant beside the reading nook and the conservatory — '.repeat(5),description:'light.'+'kitchen_'.repeat(35),available:true,observation:{value:false,unit:'',observedAtMs:Date.now()}}],
      temperatures:[{value:8,label:'Living room temperature',description:'sensor.room_temperature',available:true,observation:{value:21.5,unit:'°C',observedAtMs:Date.now()}}] };
    state.entities.push({value:9,label:'A second wrapped option for the desk lamp in the corner of the conservatory',description:'light.desk_lamp',available:true,observation:{value:true,unit:'',observedAtMs:Date.now()}}, {value:10,label:'Porch',description:'switch.porch',available:false,observation:{value:null,unit:'',observedAtMs:Date.now()}});
    const snapshot = () => ({ status:'connected',manifest,state,lastError:null });
    window.isTauri = true;
    window.__haCalls = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (command, args) => {
      if(command==='plugin:event|listen')return 1;
      if(command==='plugin:event|unlisten')return null;
      if(command==='plugin_archive_view')return {busy:false,review:null,error:null,installedEpoch:0};
      window.__haCalls.push({command,args});
      if(command==='native_deck_load')return {exists:true,revision,deck};
      if(command==='native_deck_save'){deck=args.deck;window.__haSavedDeck=deck;revision++;return {exists:true,revision,deck};}
      if(command==='plugin_snapshots')return {'home-assistant':snapshot()};
      if(command==='plugin_state'){state.temperatures[0].observation={value:22,unit:'°C',observedAtMs:Date.now()};return snapshot();}
      if(command==='plugin_catalog')return {directory:'/fixture/plugins',node:{status:'detected',version:'22.18.0',path:'/fixture/node'},plugins:[]};
      if(command==='desktop_run_control'){state.entities[0].observation.value=args.value===1;return {id:args.commandId,state:'confirmed',message:'Fixture only'};}
      if(command==='desktop_close_to_tray')return false;
      if(command==='desktop_tray_notice'||command==='obs_load_preferences'||command==='remote_load_preferences')return null;
      if(command==='obs_snapshot')return {connected:false,host:'127.0.0.1',port:4455,scenes:[],currentScene:null,observedAtMs:Date.now()};
      if(command==='remote_status')return {running:false,mode:null,origin:null,port:null,pendingDevices:0,approvedDevices:0,connectedSockets:0};
      throw new Error('Unexpected fixture IPC: '+command);
    } };
  }, { manifest });
  await desktop.goto(`${appUrl}/`);
  await desktop.waitForLoadState('networkidle');
  await desktop.getByRole('button',{name:'Select Kitchen light',exact:true}).click();
  await desktop.getByRole('button',{name:/^Entity:/}).waitFor();
  for (const width of [960,760,390]) {
    await desktop.setViewportSize({width,height:800});
    await fits(desktop, `desktop-${width}`);
    await desktop.screenshot({path:`${out}/desktop-${width}.png`,fullPage:true});
    const entity=desktop.getByRole('button',{name:/^Entity:/});
    await entity.scrollIntoViewIfNeeded(); await entity.click();
    await fits(desktop,`desktop-open-${width}`);
    await desktop.screenshot({path:`${out}/desktop-open-${width}.png`,fullPage:true});
    await desktop.keyboard.press('Escape'); assert.equal(await entity.evaluate(e=>e===document.activeElement),true);
    await desktop.locator('.binding-details summary').click();
    await fits(desktop,`desktop-details-${width}`);
    assert.ok((await desktop.locator('.binding-details p').last().textContent()).length >= 250);
    await desktop.screenshot({path:`${out}/desktop-details-${width}.png`,fullPage:true});
    await desktop.locator('.binding-details summary').click();
  }
  await desktop.setViewportSize({width:960,height:800});
  await desktop.getByRole('button',{name:'Refresh Room temperature',exact:true}).click();
  await desktop.waitForFunction(()=>document.querySelector('[aria-label="Room temperature reading"]')?.textContent==='22°C');
  assert.equal(await desktop.evaluate(()=>window.__haCalls.filter(c=>['desktop_run_control','plugin_execute'].includes(c.command)).length),0);
  await desktop.getByRole('button',{name:'Run controls on this computer',exact:true}).click();
  const toggle=desktop.locator('.control-tile').getByRole('switch',{name:'Kitchen light',exact:true});
  await toggle.click(); await desktop.waitForFunction(()=>window.__haCalls.some(c=>c.command==='desktop_run_control'&&c.args.value===1));
  await desktop.waitForFunction(()=>document.querySelector('[role="switch"][aria-label="Kitchen light"]')?.getAttribute('aria-checked')==='true');
  await toggle.click(); await desktop.waitForFunction(()=>window.__haCalls.filter(c=>c.command==='desktop_run_control').length===2);
  assert.deepEqual(await desktop.evaluate(()=>window.__haCalls.filter(c=>c.command==='desktop_run_control').map(c=>c.args.value)),[1,0]);
  await desktop.screenshot({path:`${out}/desktop-live.png`,fullPage:true});
  await desktop.getByRole('button',{name:'Run controls on this computer',exact:true}).click();
  await desktop.setViewportSize({width:390,height:844});
  await desktop.goto(`${appUrl}/#/phone`);
  await desktop.reload();
  await desktop.waitForLoadState('networkidle');
  await desktop.locator('.phone-grid').waitFor();
  await fits(desktop,'phone-preview-390');
  assert.equal(await desktop.locator('.phone-header').count(),1);
  await desktop.screenshot({path:`${out}/phone-preview-390.png`,fullPage:true});
  await desktop.goto(`${appUrl}/`);
  await desktop.setViewportSize({width:960,height:800});
  await desktop.getByRole('button',{name:'Add control',exact:true}).click();
  await desktop.getByRole('button',{name:'Add Power (home-assistant) to Home',exact:true}).click();
  await desktop.waitForFunction(()=>window.__haSavedDeck?.pages[0].sections[0].controls.some(c=>c.label==='Power'&&c.presentation==='toggle-switch'));
  assert.equal(await desktop.getByRole('button',{name:/^On press:/}).count(),0);
  await desktop.getByRole('button',{name:'Add control',exact:true}).click();
  await desktop.getByRole('button',{name:'Add Temperature (home-assistant) to Home',exact:true}).click();
  await desktop.waitForFunction(()=>window.__haSavedDeck?.pages[0].sections[0].controls.some(c=>c.label==='Temperature'&&c.presentation==='value'));
  assert.equal(await desktop.getByRole('button',{name:'Run plugin action',exact:true}).count(),0);
  await writeFile(`${out}/measurements.json`,JSON.stringify(measurements,null,2));
  console.log(`PASS: ${measurements.length} layout cases, keyboard Escape/focus, observation-only refresh fixture, On→Off toggle targets and new-control defaults. Screenshots: ${out}`);
} finally { await browser.close(); }
