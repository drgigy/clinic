export function deviceAvailable(device, now = Date.now()) {
  return Boolean(device && !device.revoked && (device.persistent === true || device.expiresAt > now));
}

export async function approveWaitingDevice(db, code, expectedPrevious, staffUid, now = Date.now()) {
  return db.runTransaction(async tx => {
    const controlRef=db.doc('assistantControl/device');
    const ref=db.doc(`assistantDevices/${code}`);
    const [control,lock,device]=await Promise.all([tx.get(controlRef),tx.get(db.doc('assistantControl/active')),tx.get(ref)]);
    const oldCode=control.data()?.deviceCode || null;
    const saved=device.data();
    if(oldCode===code&&deviceAvailable(saved,now)&&!saved.waiting)return;
    if(lock.data()?.sessionId)throw new Error('Patient conversation is active. Finish and save it before connecting another device.');
    if(oldCode!==(expectedPrevious || null))throw new Error('Patient device connection changed. Refresh the list and try again.');
    if(!deviceAvailable(saved,now)||!saved.waiting||saved.lastSeen<now-30000)throw new Error('Patient device is no longer waiting online. Reopen patient.html on that device.');
    const oldRef=oldCode?db.doc(`assistantDevices/${oldCode}`):null;
    const old=oldRef?await tx.get(oldRef):null;
    tx.update(ref,{waiting:false,persistent:true,approvedBy:staffUid,pairedAt:now});
    if(old?.exists)tx.update(oldRef,{revoked:true});
    tx.set(controlRef,{deviceCode:code,pendingHash:null});
  });
}

export async function createPairing(db, hash, deviceCode, staffUid, now = Date.now()) {
  return db.runTransaction(async tx => {
    const controlRef = db.doc('assistantControl/device');
    const [lock, control] = await Promise.all([tx.get(db.doc('assistantControl/active')), tx.get(controlRef)]);
    if (lock.data()?.sessionId) throw new Error('Patient conversation is active. Finish it before pairing another device.');
    tx.create(db.doc(`assistantPairings/${hash}`), {deviceCode, staffUid, expiresAt:now+300000, claimed:false});
    tx.set(controlRef, {...control.data(), pendingHash:hash});
    return {expiresAt:now+300000};
  });
}

export async function claimPairing(db, hash, tokenHash, now = Date.now()) {
  return db.runTransaction(async tx => {
    const pairRef = db.doc(`assistantPairings/${hash}`);
    const controlRef = db.doc('assistantControl/device');
    const [pair, control, lock] = await Promise.all([tx.get(pairRef), tx.get(controlRef), tx.get(db.doc('assistantControl/active'))]);
    const p = pair.data();
    if (!p || p.expiresAt <= now) throw new Error('Patient device QR expired. Ask staff for a new QR code.');
    const deviceRef = db.doc(`assistantDevices/${p.deviceCode}`);
    const saved = await tx.get(deviceRef);
    if (p.claimed) {
      if (saved.data()?.tokenHash === tokenHash && deviceAvailable(saved.data(), now) && control.data()?.deviceCode === p.deviceCode) return {deviceCode:p.deviceCode};
      throw new Error('Patient device QR has already been used. Ask staff for a new QR code.');
    }
    if (control.data()?.pendingHash !== hash) throw new Error('Patient device QR was replaced. Scan the latest QR code.');
    if (lock.data()?.sessionId) throw new Error('Patient conversation is active. Finish it before pairing another device.');
    const oldCode = control.data()?.deviceCode;
    const oldRef = oldCode ? db.doc(`assistantDevices/${oldCode}`) : null;
    const old = oldRef ? await tx.get(oldRef) : null;
    tx.create(deviceRef, {tokenHash, persistent:true, revoked:false, lastSeen:now, sessionId:null, pairedAt:now});
    if (old?.exists) tx.update(oldRef, {revoked:true});
    tx.update(pairRef, {claimed:true, claimedAt:now});
    tx.set(controlRef, {deviceCode:p.deviceCode, pendingHash:null});
    return {deviceCode:p.deviceCode};
  });
}

export async function disconnectDevice(db) {
  await db.runTransaction(async tx => {
    const controlRef = db.doc('assistantControl/device');
    const [control, lock] = await Promise.all([tx.get(controlRef), tx.get(db.doc('assistantControl/active'))]);
    if (lock.data()?.sessionId) throw new Error('Patient conversation is active. Finish and save it before disconnecting.');
    const code = control.data()?.deviceCode;
    const ref = code ? db.doc(`assistantDevices/${code}`) : null;
    const device = ref ? await tx.get(ref) : null;
    if (device?.exists) tx.update(ref, {revoked:true});
    tx.set(controlRef, {deviceCode:null, pendingHash:null});
  });
}
