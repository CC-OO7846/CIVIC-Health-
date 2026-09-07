'use strict';

const CACHE_NAME='clean-garage-v10.18.7';
const CORE_ASSETS=[
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./service-engine.js",
  "./db.js",
  "./pm-engine.js",
  "./health-engine.js",
  "./budget-engine.js",
  "./backup.js",
  "./pwa.js",
  "./manifest.webmanifest",
  "./image-map.js",
  "./pm-data.js"
];
const OPTIONAL_ASSETS=[
  "./hero.webp",
  "./car-health-icon-v2-180.png",
  "./car-health-icon-v2-192.png",
  "./car-health-icon-v2-512.png"
];

async function cacheFreshAsset(cache,asset){
  const url=new URL(asset,self.location.href);
  url.searchParams.set('app-cache',CACHE_NAME);
  const response=await fetch(new Request(url,{cache:'reload',credentials:'same-origin'}));
  if(!response.ok)throw new Error('Could not cache '+asset);
  await cache.put(asset,response);
}

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(async cache=>{
    await Promise.all(CORE_ASSETS.map(asset=>cacheFreshAsset(cache,asset)));
    await Promise.allSettled(OPTIONAL_ASSETS.map(asset=>cacheFreshAsset(cache,asset)));
  }));
});

self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING')self.skipWaiting();
});

self.addEventListener('activate',event=>{
  event.waitUntil(Promise.all([
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('clean-garage-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))),
    self.clients.claim()
  ]));
});

async function networkFirst(request){
  const cache=await caches.open(CACHE_NAME);
  try{
    const response=await fetch(request);
    if(response?.ok)cache.put(request,response.clone());
    return response;
  }catch(error){
    return (await cache.match(request))||(await cache.match('./index.html'));
  }
}

async function cacheFirst(request){
  const cached=await caches.match(request);
  if(cached)return cached;
  const response=await fetch(request);
  if(response?.ok){const cache=await caches.open(CACHE_NAME);cache.put(request,response.clone());}
  return response;
}

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin)return;
  if(event.request.mode==='navigate'){event.respondWith(networkFirst(event.request));return;}
  event.respondWith(cacheFirst(event.request));
});
