export function pairingDialog(api,refresh){
  const style=document.createElement('link');style.rel='stylesheet';style.href='assistant-pairing.css';document.head.append(style);
  const dialog=document.createElement('dialog');dialog.className='assistant-pair-dialog';dialog.setAttribute('aria-labelledby','assistantPairTitle');
  dialog.innerHTML='<div class="pair-head"><h2 id="assistantPairTitle">Connect Patient Device</h2><button class="pair-close" type="button" aria-label="Close">&times;</button></div><p class="pair-status" role="status"></p><div class="pair-devices"></div><div class="pair-actions"><button class="pair-disconnect" type="button" hidden>Disconnect device</button></div><p class="pair-error" role="alert"></p>';
  document.body.append(dialog);
  const get=selector=>dialog.querySelector(selector);
  let timer,working=false,syncing=false,previous=null;
  get('.pair-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>clearInterval(timer));
  async function sync(){
    if(!dialog.open||syncing||working)return;
    syncing=true;
    try{
      const status=await api('status');const result=await api('device-list');
      if(!dialog.open)return;
      previous=status.pairedDevice?.deviceCode||null;
      get('.pair-disconnect').hidden=!status.pairedDevice;
      get('.pair-disconnect').disabled=Boolean(status.active);
      get('.pair-status').textContent=status.pairedDevice?`Patient device remembered (${status.pairedDevice.online?'online':'offline'}). Approval is not needed again in the same browser.`:'Open patient.html on the patient device. Select its browser below to connect.';
      const list=get('.pair-devices');list.replaceChildren();
      if(!result.waiting.length){const empty=document.createElement('p');empty.textContent='No devices waiting for approval.';list.append(empty);}
      for(const device of result.waiting){
        const row=document.createElement('div');row.className='pair-device';
        const details=document.createElement('div');const label=document.createElement('strong');label.textContent=device.label;
        const time=document.createElement('small');time.textContent=`Opened ${new Date(device.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
        details.append(label,time);
        const connect=document.createElement('button');connect.type='button';connect.textContent='Connect';connect.dataset.connectDevice=device.deviceCode;connect.disabled=Boolean(status.active);
        connect.onclick=async()=>{
          if(working)return;
          if(previous&&!confirm('Replace the currently connected patient device with this device? Existing notes will not be changed.'))return;
          working=true;connect.disabled=true;get('.pair-error').textContent='';
          try{await api('device-approve',{deviceCode:device.deviceCode,expectedPrevious:previous});await refresh();}
          catch(error){get('.pair-error').textContent=error.message;}
          finally{working=false;await sync();}
        };
        row.append(details,connect);list.append(row);
      }
    }catch(error){get('.pair-error').textContent=error.message;}
    finally{syncing=false;}
  }
  get('.pair-disconnect').onclick=async()=>{
    if(working||!confirm('Disconnect the patient device? Existing notes will not be changed.'))return;
    working=true;get('.pair-error').textContent='';
    try{await api('pair-disconnect');await refresh();}
    catch(error){get('.pair-error').textContent=error.message;}
    finally{working=false;await sync();}
  };
  return async()=>{
    if(dialog.open)return;
    dialog.showModal();get('.pair-status').textContent='Checking connection...';get('.pair-error').textContent='';
    await sync();
    if(dialog.open){clearInterval(timer);timer=setInterval(sync,2000);}
  };
}
