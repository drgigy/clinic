export const assistantEndpoint = 'https://asia-south1-clinic-app-cccc0.cloudfunctions.net/doctorAssistant';

export async function assistantRequest(action, body = {}, credentials = {}) {
  const response = await fetch(assistantEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...credentials },
    body: JSON.stringify({ action, ...body }),
    signal: AbortSignal.timeout(120000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Doctor Assistant is unavailable. Please try again.');
  return result;
}
