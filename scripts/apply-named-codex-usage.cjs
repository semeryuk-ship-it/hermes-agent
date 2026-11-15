// Patch only the installed usage chip; leave unrelated pending source edits out.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const asar = require('@electron/asar')
const root = path.resolve(__dirname, '..')
const archive = path.join(root, 'apps/desktop/release/win-unpacked/resources/app.asar')
const entry = path.join('dist', 'assets', 'kbd-DF2jFXbs.js')
const target = path.join(archive + '.unpacked', entry)
const old = fs.readFileSync(target, 'utf8')
const anchor = 'function uS(e,t){let n=Tl(e);if(!n)return null;'
assert.equal(old.split(anchor).length, 2, 'installed component version changed')
const branch = 'const named=e.slug.startsWith(`codex-`)&&n.accounts.length===1?n.accounts[0]:null;const weekly=named&&(named.state===`ready`||named.state===`limited`)?named.windows.find(w=>w.label===`Weekly`):null;if(weekly&&named)return{label:weekly.label+` · `+t.usageLeft(weekly.remaining,null),remaining:weekly.remaining,tip:(0,R.jsx)(`span`,{className:`whitespace-pre-line`,children:named.windows.map(w=>t.usageWindow(w.label,w.remaining,w.resetMs===null?null:El(w.resetMs))).join(`\n`)}),warn:weekly.remaining<=10};'
const next = old.replace(anchor, anchor + branch)
// Exercise the exact generated branch, not a second handwritten formatter.
const probe = vm.runInNewContext('(function(e,t,n,R,El){' + branch + 'return null})')
const copy = { usageLeft: n => `${n}% left`, usageWindow: (l,n) => `${l}: ${n}% left` }
for (const remaining of [0, 61, 100]) {
  const result = probe({slug:'codex-ekaterina'}, copy, {accounts:[{state:remaining===0?'limited':'ready',windows:[{label:'Weekly',remaining,resetMs:null}]}]}, {jsx:(tag,props)=>props}, () => null)
  assert.equal(result.label, `Weekly · ${remaining}% left`)
}
assert.equal(probe({slug:'openai-codex'},copy,{accounts:[{state:'ready',windows:[]}]},{},()=>null),null)
assert.equal(probe({slug:'codex-ekaterina'},copy,{accounts:[{state:'unknown',windows:[]}]},{},()=>null),null)
const raw = asar.getRawHeader(archive)
const metadata = raw.header.files.dist.files.assets.files[path.basename(entry)]
assert.equal(metadata.unpacked,true)
const bytes = Buffer.from(next)
const hash = crypto.createHash('sha256').update(bytes).digest('hex')
metadata.size = bytes.length
metadata.integrity = {algorithm:'SHA256',hash,blockSize:4194304,blocks:[hash]}
const header = Buffer.from(JSON.stringify(raw.header))
const previous = Buffer.from(raw.headerString)
assert.equal(header.length, previous.length, 'header size changed; do not shift archive payload')
const archiveBytes = fs.readFileSync(archive)
const offset = archiveBytes.indexOf(previous)
assert.ok(offset > 0)
assert.equal(archiveBytes.indexOf(previous,offset+1),-1)
const backup = path.join(process.env.HERMES_HOME, 'backups', 'named-codex-weekly-' + Date.now())
fs.mkdirSync(backup,{recursive:true})
fs.copyFileSync(archive,path.join(backup,'app.asar'))
fs.copyFileSync(target,path.join(backup,path.basename(entry)))
header.copy(archiveBytes,offset)
try {
  fs.writeFileSync(target,bytes)
  fs.writeFileSync(archive,archiveBytes)
  asar.uncache(archive)
  assert.equal(asar.extractFile(archive,entry).toString(),next)
  assert.equal(asar.statFile(archive,entry).integrity.hash,crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'))
} catch(error) {
  fs.copyFileSync(path.join(backup,path.basename(entry)),target)
  fs.copyFileSync(path.join(backup,'app.asar'),archive)
  throw error
}
console.log(JSON.stringify({installed:target,sha256:hash,backup,branchTests:5,activation:'Desktop and gateway restart required'}))
