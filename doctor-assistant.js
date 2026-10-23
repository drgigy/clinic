import {assistantRequest} from './assistant-config.js';

let active = null;
let ready = false;
let busy = false;
let failure = '';
export function doctorAssistantButton(appointmentId) {
  const selected = active?.appointmentId === appointmentId;
  const disabled = busy || !ready || (active && !selected);
  const title = failure || (selected ? 'Finish the active conversation or release an empty session' : 'Start on the paired patient device');
  return `<button class="secondary" type="button" data-doctor-assistant="${appointmentId}" ${disabled ? 'disabled' : ''} title="${title.replace(/["<>]/g,'')}">${selected ? 'Assistant Active' : 'Doctor Assistant'}</button>`;
}

export function installDoctorAssistant({auth,render}) {
  const api = async (action,body) => {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('Please sign in to the clinic first.');
    return assistantRequest(action,body,{Authorization:`Bearer ${token}`});
  };
  let polling = false;
  async function refresh() {
    if (!auth.currentUser || polling || document.hidden) return;
    polling = true;
    try {
      const result = await api('status');
      const changed = !ready || JSON.stringify(active) !== JSON.stringify(result.active);
      active = result.active;
      // The backend returns the appointment binding; lock ownership is clinic-wide.
      ready = true; failure = '';
      if (changed) render();
    } catch {
      const changed = ready;
      ready = false;failure = 'Assistant connection unavailable. Use Home > Pair Patient Device to retry.';
      if (changed) render();
    } finally {polling = false;}
  }
  document.addEventListener('click',async event => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    if (button.id === 'pairPatientDeviceBtn') {
      const value = prompt('Open patient.html on the patient device, press Enable Device, and enter its pairing code here.',localStorage.getItem('clinicAssistantDevice') || '');
      if (value === null) return;
      const code = value.trim().toLowerCase();
      if (!/^[a-f0-9]{16}$/.test(code)) {alert('Enter the 16-character pairing code shown on the patient device.');return;}
      localStorage.setItem('clinicAssistantDevice',code);
      await refresh();
      return;
    }
    const appointmentId = button.dataset.doctorAssistant;
    if (!appointmentId) return;
    busy = true;render();
    try {
      if (active) {
        if (!confirm('Finish this patient conversation and save the captured answers as a new Assistant Note?')) return;
        let requested = false;
        try {requested = (await api('staff-finish',{sessionId:active.sessionId})).requested;}
        catch (error) {
          if (!error.message.startsWith('Invalid conversation') && !error.message.startsWith('No patient answers')) throw error;
          if (confirm('No patient answers have been captured. Release this empty session?')) await api('abandon',{sessionId:active.sessionId});
          else return;
        }
        alert(requested ? 'Stop requested on the patient device. The session will unlock after saving.' : 'The assistant session has ended. Existing records were not changed.');
      } else {
        let code = localStorage.getItem('clinicAssistantDevice');
        if (!code) code = prompt('Enter the pairing code shown on patient.html on the patient device.');
        if (!code) return;
        code = code.trim().toLowerCase();
        await api('start',{appointmentId,deviceCode:code});
        localStorage.setItem('clinicAssistantDevice',code);
      }
    } catch (error) {alert(error.message);}
    finally {busy = false;await refresh();render();}
  });
  setInterval(refresh,3000);
  document.addEventListener('visibilitychange',refresh);
  auth.onAuthStateChanged(() => {active = null;ready = false;render();refresh();});
}
