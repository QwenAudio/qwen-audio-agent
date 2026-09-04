export function gatewayBrowserPairingPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Connect qwen-audio-agent</title>
  <style>
    :root{font:16px/1.5 system-ui,sans-serif;color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}.card{width:min(32rem,calc(100% - 3rem));padding:2rem;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:1.25rem;box-shadow:0 1rem 3rem color-mix(in srgb,CanvasText 10%,transparent)}h1{margin:0 0 .75rem;font-size:1.4rem}p{margin:.5rem 0;color:color-mix(in srgb,CanvasText 72%,transparent)}button{margin-top:1rem;padding:.7rem 1rem;border:0;border-radius:.75rem;background:#1677ff;color:white;font:inherit;font-weight:600}button:disabled{opacity:.5}.error{color:#d33}</style>
</head>
<body><main class="card"><h1>Connect to Gateway</h1><p id="status">Ready to pair this browser.</p><button id="connect">Connect</button></main>
<script>
const statusNode=document.querySelector('#status');const button=document.querySelector('#connect');
function invitation(){try{return JSON.parse(decodeURIComponent(location.hash.slice(1)))}catch{return null}}
const value=invitation();if(!value?.pairing_code){statusNode.textContent='This invitation is invalid.';statusNode.className='error';button.disabled=true}
button.addEventListener('click',async()=>{button.disabled=true;statusNode.textContent='Connecting…';try{const response=await fetch('/api/access/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:value.pairing_code,device:{type:'web',label:'Remote WebUI'}})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||'Pairing failed');history.replaceState(null,'',location.pathname);location.replace('/')}catch(error){statusNode.textContent=error.message;statusNode.className='error';button.disabled=false}})
</script></body></html>`
}
