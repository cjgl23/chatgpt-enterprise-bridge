// Optional browser regression checks: node scripts/verify-chatgpt-connector.cjs
// Uses only local HTML fixtures; no ChatGPT session or network is needed.
const assert=require('node:assert/strict');
const {launchBrowser}=require('../src/browser');
const fixtureWarnings = [];
require('../src/logger').child = () => ({
  info() {},
  warn(details) { fixtureWarnings.push(details); },
  error(details) { fixtureWarnings.push(details); },
});
const client=require('../src/chatgptClient');
(async()=>{
 const {browser}=await launchBrowser({headless:true});
 try {
 const p=await browser.newPage();
 for(const variant of ['data-message-author-role','data-turn','data-role', 'data-markdown-text-style']) {
 await p.setContent(`<article data-turn="user"><div class="markdown">prompt JSON</div></article><article ${variant}="${variant === "data-markdown-text-style" ? "assistant-message" : "assistant"}" data-testid="conversation-turn-1"><div class="markdown">{"title":"IVR hours"}</div><button>Copy</button></article>`);
 assert.deepEqual(await client.readAssistantSnapshot(p),{count:1,text:'{"title":"IVR hours"}'});
 }
 for(const kind of ['native','current']) for(const effort of ['instant','medium','high']) {
 await p.setContent(`<form><button aria-label="Thinking effort" aria-haspopup="menu" type="button" onclick="toggle()">Thinking effort</button></form>
 <div data-radix-popper-content-wrapper hidden id="picker" data-model-picker-view="simple"><div role="menuitem" tabindex="0" data-model-picker-view-toggle="true" onclick="models()"><span id="effort" data-effort-only="true">Instant</span></div>${kind==='native' ? '<input type="range" role="slider" id="slider" min="0" max="5" value="0" aria-valuenow="0" aria-valuetext="Instant">' : '<div id="slider" role="menuitem" tabindex="-1" data-reasoning-slider="true" aria-label="Power"></div>'}</div>
 <div role="menu" id="models" hidden><button role="menuitemradio" aria-checked="false" onclick="window.chosen=this.textContent;this.setAttribute('aria-checked','true');document.querySelector('#picker').setAttribute('data-model-picker-view','simple');document.querySelector('#picker').hidden=true;document.querySelector('#models').hidden=true">GPT-5.6 Sol</button><button role="menuitemradio">GPT-5.5</button></div>
 <script>
 var levels=['Instant','Low','Medium','High','Extra High','Pro'];
 function toggle(){document.querySelector('#picker').hidden=!document.querySelector('#picker').hidden;document.querySelector('#models').hidden=true}
 function models(){var picker=document.querySelector('#picker');var advanced=picker.getAttribute('data-model-picker-view')==='advanced';picker.setAttribute('data-model-picker-view',advanced?'simple':'advanced');document.querySelector('#models').hidden=advanced}
 document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.shiftKey&&e.key.toLowerCase()==='m'){e.preventDefault();toggle()}if(e.key==='Escape'){document.querySelector('#picker').hidden=true;document.querySelector('#models').hidden=true}});
 document.querySelector('#slider').addEventListener('input',e=>{const slider=e.target;slider.setAttribute('aria-valuenow',slider.value);slider.setAttribute('aria-valuetext',levels[slider.value]);document.querySelector('#effort').textContent=levels[slider.value]});
 document.querySelector('[data-model-picker-view-toggle]').addEventListener('keydown',e=>{if(e.key==='Enter')models()});
 var current=0;
 document.querySelector('#slider').addEventListener('keydown',e=>{if(!e.target.hasAttribute('data-reasoning-slider'))return;if(e.key==='ArrowRight')current=Math.min(5,current+1);if(e.key==='ArrowLeft')current=Math.max(0,current-1);document.querySelector('#effort').textContent=levels[current]});
 </script>`);
 await client.selectLatestModel(p,effort).catch(async e=>{console.log('STATE',await p.locator('#slider').evaluate(e=>({value:e.value,html:e.outerHTML})));throw e});
 assert.equal(await p.locator('#effort').innerText(),client.thinkingLevelLabel(effort));
 assert.equal(await p.evaluate(()=>window.chosen),'GPT-5.6 Sol');
 }
 // Legacy flat menus still choose the requested effort before the model.
 for (const effort of ['instant', 'medium', 'high']) {
   await p.setContent(`<form><button type="button" aria-label="Thinking effort" aria-haspopup="menu" onclick="picker.hidden=!picker.hidden">Thinking effort</button></form>
     <div id="picker" role="menu" hidden>${['Instant','Medium','High','GPT-5.6 Sol'].map(label => `<button role="menuitemradio" aria-checked="false" onclick="window.choices.push(this.textContent);picker.hidden=true">${label}</button>`).join('')}</div>
     <script>window.choices=[];document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.shiftKey&&e.key.toLowerCase()==='m')picker.hidden=!picker.hidden;if(e.key==='Escape')picker.hidden=true});</script>`);
   await client.selectLatestModel(p, effort);
   assert.deepEqual(await p.evaluate(() => window.choices), [client.thinkingLevelLabel(effort), 'GPT-5.6 Sol']);
 }
 assert.deepEqual(fixtureWarnings, [], 'fixture selection must succeed without falling back');
 console.log('PASS: legacy/current response wrappers and native/current effort controls and Instant/Medium/High slider + nested model menu');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
