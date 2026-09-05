'use strict';

const CACHE_NAME='clean-garage-v10.17.1-imagefix';
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
  "./data/image-map.js",
  "./data/pm-data.js",
  "./car-health-icon-v2-180.png",
  "./car-health-icon-v2-192.png",
  "./car-health-icon-v2-512.png"
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(CORE_ASSETS)));
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
