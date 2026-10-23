let library;
function loadQr(){
  if(window.qrcode)return Promise.resolve(window.qrcode);
  library ||= new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='vendor/qrcode-generator/qrcode.js';
    script.onload=()=>resolve(window.qrcode);script.onerror=()=>{library=null;script.remove();reject(new Error('Could not load QR code. Please retry.'));};
    document.head.append(script);
  });
  return library;
}

export function pairingDialog(api,refresh){
  const style=document.createElement('link');style.rel='stylesheet';style.href='assistant-pairing.css';document.head.append(style);
  const dialog=document.createElement('dialog');dialog.className='assistant-pair-dialog';dialog.setAttribute('aria-labelledby','assistantPairTitle');
  dialog.innerHTML='<div class="pair-head"><h2 id="assistantPairTitle">Connect Patient Device</h2><button class="pair-close" type="button" aria-label="Close">&times;</button></div><p class="pair-status" role="status"></p><div class="pair-qr"></div><p class="pair-expiry"></p><div class="pair-actions"><button class="pair-new" type="button">New QR code</button><button class="pair-disconnect" type="button">Disconnect device</button></div>';
  document.body.append(dialog);
  const get=selector=>dialog.querySelector(selector);
  let timer,expiresAt=0,claimedCode=null,working=false;
  get('.pair-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{clearInterval(timer);get('.pair-qr').replaceChildren();});
  async function sync(){
    if(!dialog.open)return;
    const result=await api('status');
    get('.pair-disconnect').hidden=!result.pairedDevice;
    if(result.pairedDevice&&result.pairedDevice.deviceCode!==claimedCode){
      get('.pair-qr').replaceChildren();expiresAt=0;claimedCode=result.pairedDevice.deviceCode;
      get('.pair-status').textContent='Patient device connected. This browser will remember the connection.';
      get('.pair-expiry').textContent='';await refresh();
    }else if(expiresAt){
      const remaining=Math.max(0,Math.ceil((expiresAt-Date.now())/1000));
      get('.pair-expiry').textContent=remaining?`QR expires in ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`:'QR expired. Create a new QR code.';
      if(!remaining)get('.pair-qr').replaceChildren();
    }
  }
  async function generate(){
    if(working)return;working=true;get('.pair-new').disabled=true;
    try{
      const qrFactory=await loadQr();
      const before=await api('status');claimedCode=before.pairedDevice?.deviceCode||null;
      const invitation=await api('pair-create');
      if(!dialog.open)return;
      expiresAt=invitation.expiresAt;
      const url=new URL('patient.html',location.href);url.search='';url.hash=`pair=${invitation.invitation}`;
      const qr=qrFactory(0,'M');qr.addData(url.href);qr.make();
      const size=qr.getModuleCount(),scale=6,margin=4;
      const canvas=document.createElement('canvas');canvas.width=canvas.height=(size+margin*2)*scale;canvas.setAttribute('role','img');canvas.setAttribute('aria-label','Scan to connect the patient device');
      const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#000';
      for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(qr.isDark(y,x))context.fillRect((x+margin)*scale,(y+margin)*scale,scale,scale);
      get('.pair-qr').replaceChildren(canvas);
      get('.pair-status').textContent='Scan with the patient device camera, then tap Enable Device. Scan only once for this browser.';
      await sync();
    }catch(error){get('.pair-status').textContent=error.message;}
    finally{working=false;get('.pair-new').disabled=false;}
  }
  get('.pair-new').onclick=generate;
  get('.pair-disconnect').onclick=async()=>{
    if(!confirm('Disconnect the paired patient device? Existing notes will not be changed.'))return;
    try{await api('pair-disconnect');claimedCode=null;expiresAt=0;get('.pair-qr').replaceChildren();get('.pair-expiry').textContent='';get('.pair-status').textContent='Device disconnected.';get('.pair-disconnect').hidden=true;await refresh();}
    catch(error){get('.pair-status').textContent=error.message;}
  };
  return async()=>{
    if(dialog.open)return;
    dialog.showModal();expiresAt=0;get('.pair-expiry').textContent='';get('.pair-status').textContent='Checking connection...';
    try{
      const result=await api('status');claimedCode=result.pairedDevice?.deviceCode||null;get('.pair-disconnect').hidden=!result.pairedDevice;
      if(result.pairedDevice)get('.pair-status').textContent=`Patient device remembered (${result.pairedDevice.online?'online':'offline'}). No new scan needed. Open patient.html on that device and tap Enable Device.`;
      else await generate();
      clearInterval(timer);timer=setInterval(()=>sync().catch(()=>{}),2000);
    }catch(error){get('.pair-status').textContent=error.message;}
  };
}
