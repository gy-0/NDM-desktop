// Synthetic fixtures shared by the real event/ownership harness.
export const coverageCases = [
  { name: 'named-iframe-zip', online: true, coverage: true, namedFrame: true, auth: true, deferred: true, requestType: 'sub_frame' },
  { name: 'iframe-download-attribute', online: true, coverage: true, frameDownload: true, download: true, auth: true, deferred: true, requestType: 'other' },
  { name: 'iframe-download-unsafe-host', online: true, coverage: true, frameDownload: true, download: true, auth: true, unsafeHost: true, browserOwned: true, requestType: 'other' },
  { name: 'iframe-download-store-failed', online: true, coverage: true, frameDownload: true, download: true, auth: true, deferredStoreFailure: true, browserOwned: true, requestType: 'other' },
  { name: 'iframe-download-attach-save-failed', online: true, coverage: true, frameDownload: true, download: true, auth: true, deferredStoreFailure: true, deferredStoreFailureAt: 2, browserOwned: true, requestType: 'other' },
  { name: 'iframe-download-pause-failed', online: true, coverage: true, frameDownload: true, download: true, auth: true, deferredPauseFailure: true, browserOwned: true, requestType: 'other' },
  { name: 'iframe-download-queue-full', online: true, coverage: true, frameDownload: true, download: true, auth: true, prepQueueFull: true, browserOwned: true, requestType: 'other' },
  { name: 'iframe-download-native-rejected', online: true, coverage: true, frameDownload: true, download: true, auth: true, rejectFirst: true, browserOwned: true, requestType: 'other' },
  { name: 'iframe-download-lost-ack', online: true, coverage: true, frameDownload: true, download: true, auth: true, lostAck: true, deferred: true, requestType: 'other' },
  { name: 'iframe-html-navigation', online: true, coverage: true, namedFrame: true, html: true, noItem: true, requestType: 'sub_frame' },
  { name: 'zip-fetch-without-item', online: true, coverage: true, fetchOnly: true, noItem: true, requestType: 'xmlhttprequest' },
  { name: 'zip-xhr-without-item', online: true, coverage: true, xhrOnly: true, noItem: true, requestType: 'xmlhttprequest' },
  { name: 'media-chunk-without-item', online: true, coverage: true, fetchOnly: true, mediaChunk: true, noItem: true, requestType: 'xmlhttprequest' },
  { name: 'media-resource-without-item', online: true, coverage: true, mediaResource: true, noItem: true, requestType: 'media' },
  { name: 'iframe-post-download', online: true, coverage: true, namedFrame: true, post: true, browserOwned: true, requestType: 'sub_frame' },
  { name: 'blob-download', online: true, coverage: true, blob: true, browserOwned: true },
  { name: 'iframe-download-offline', online: false, coverage: true, frameDownload: true, download: true, auth: true, browserOwned: true, requestType: 'other' },
  { name: 'iframe-download-noreferrer-attribute', online: true, coverage: true, frameDownload: true, download: true, noreferrer: true, auth: true, deferred: true, requestType: 'other' },
  { name: 'iframe-download-no-referrer-policy', online: true, coverage: true, frameDownload: true, download: true, frameNoReferrer: true, browserOwned: true, requestType: 'other' },
  { name: 'iframe-download-known-auth', online: true, coverage: true, frameDownload: true, download: true, auth: true, authHeader: true, noEarlyIntent: true, browserOwned: true, requestType: 'other' }
]
export function coverageHTML(scenario, target, frame = false) {
  const label = `Relay ${scenario.name}`
  const beginning = `<!doctype html><meta charset="utf-8"><title>${frame ? 'Synthetic frame' : label}</title><style>body{font:18px system-ui;margin:36px}a,button{padding:18px;display:inline-block}iframe{width:90%;height:260px;margin-top:28px}</style><h1>${label}</h1>`
  const link = `<a id="target" href="${scenario.blob ? '#' : target}" ${scenario.download ? 'download="frame-download.zip"' : ''} ${scenario.noreferrer ? 'rel="noreferrer"' : ''} ${scenario.namedFrame && !frame ? 'target="fixture-frame"' : ''}>Download file</a>`
  if (frame) return beginning + (scenario.frameDownload ? link : '<p>Named frame navigation target.</p>')
  let content = scenario.frameDownload ? '' : scenario.post ? `<form action="${target}" method="POST" target="fixture-frame"><input name="fixture" value="synthetic"><button id="target" type="submit">Download file</button></form>` : link
  if (scenario.namedFrame || scenario.frameDownload) content += '<iframe id="fixture-frame" name="fixture-frame" src="/frame.html"></iframe>'
  if (scenario.fetchOnly) content += `<script>document.querySelector('#target').addEventListener('click',async e=>{e.preventDefault();await (await fetch(${JSON.stringify(target)})).arrayBuffer();window.__fixtureDone=true})</script>`
  if (scenario.mediaResource) content += `<video id="fixture-media" src="${target}" preload="none" controls></video><script>document.querySelector('#target').addEventListener('click',e=>{e.preventDefault();const v=document.querySelector('#fixture-media');v.addEventListener('error',()=>window.__fixtureDone=true,{once:true});v.addEventListener('loadeddata',()=>window.__fixtureDone=true,{once:true});v.load()})</script>`
  if (scenario.xhrOnly) content += `<script>document.querySelector('#target').addEventListener('click',e=>{e.preventDefault();const x=new XMLHttpRequest();x.open('GET',${JSON.stringify(target)});x.responseType='arraybuffer';x.onload=()=>window.__fixtureDone=true;x.send()})</script>`
  if (scenario.blob) content += `<script>document.querySelector('#target').addEventListener('click',e=>{e.preventDefault();const b=new Uint8Array(2*1024*1024);for(let i=0;i<b.length;i++)b[i]=i%251;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([b],{type:'application/octet-stream'}));a.download='synthetic-blob.zip';a.click()})</script>`
  return beginning + content
}
