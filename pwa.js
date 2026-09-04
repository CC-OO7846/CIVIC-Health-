'use strict';

let deferredInstallPrompt=null;
let reloadingForUpdate=false;

window.addEventListener('beforeinstallprompt',event=>{
  event.preventDefault();
  deferredInstallPrompt=event;
  const button=document.getElementById('installPwaBtn');
  if(button)button.style.display='';
});

window.addEventListener('appinstalled',()=>{
  deferredInstallPrompt=null;
  const button=document.getElementById('installPwaBtn');
  if(button)button.style.display='none';
  showDbToast('Clean Garage installed');
});

async function installCleanGarage(){
  if(!deferredInstallPrompt){showDbToast('Use Add to Home Screen from the browser menu');return;}
  deferredInstallPrompt.prompt();
  try{await deferredInstallPrompt.userChoice;}catch(error){console.warn('Install prompt failed',error);}
  deferredInstallPrompt=null;
  const button=document.getElementById('installPwaBtn');
  if(button)button.style.display='none';
}

function showUpdateAvailable(registration){
  const banner=document.getElementById('updateBanner');
  if(!banner)return;
  banner.hidden=false;
  banner.dataset.updateReady='true';
  banner._registration=registration;
}

function dismissUpdateBanner(){
  const banner=document.getElementById('updateBanner');
  if(banner)banner.hidden=true;
}

function applyAppUpdate(){
  const banner=document.getElementById('updateBanner');
  const registration=banner?._registration;
  if(registration?.waiting){
    registration.waiting.postMessage({type:'SKIP_WAITING'});
  }else{
    window.location.reload();
  }
}

async function registerOfflineApp(){
  if(!('serviceWorker' in navigator))return;
  try{
    const registration=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
    if(registration.waiting)showUpdateAvailable(registration);
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;
      if(!worker)return;
      worker.addEventListener('statechange',()=>{
        if(worker.state==='installed'&&navigator.serviceWorker.controller)showUpdateAvailable(registration);
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(reloadingForUpdate)return;
      reloadingForUpdate=true;
      window.location.reload();
    });
    await registration.update();
    await navigator.serviceWorker.ready;
    updateStorageStatus();
  }catch(error){
    const status=document.getElementById('offlineStatus');
    if(navigator.serviceWorker.controller){
      if(status)status.textContent='Ready';
      updateStorageStatus();
      return;
    }
    console.error('Service worker registration failed',error);
    if(status)status.textContent='Setup failed';
  }
}
