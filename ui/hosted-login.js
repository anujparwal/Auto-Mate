'use strict';
(() => {
  const byId = id => document.getElementById(id);
  let registering = false;
  let busy = false;
  function mode(next) {
    if (busy) return;
    registering = next;
    byId('auth-heading').textContent = next ? 'Create your account' : 'Sign in to Auto-Mate';
    byId('auth-submit').textContent = next ? 'Create account & sign in' : 'Sign in';
    byId('auth-key-label').textContent = next ? 'Choose your key / passphrase' : 'Your key / passphrase';
    byId('auth-key').autocomplete = next ? 'new-password' : 'current-password';
    byId('auth-key').value = '';
    byId('auth-error').hidden = true;
    byId('auth-login').setAttribute('aria-pressed', String(!next));
    byId('auth-register').setAttribute('aria-pressed', String(next));
  }
  byId('auth-login').addEventListener('click', () => mode(false));
  byId('auth-register').addEventListener('click', () => mode(true));
  byId('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const payload = { username: byId('auth-username').value, key: byId('auth-key').value };
    for (const control of document.querySelectorAll('input, button')) control.disabled = true;
    byId('auth-error').hidden = true;
    byId('auth-status').textContent = registering ? 'Creating encrypted vault…' : 'Verifying your key…';
    try {
      const response = await fetch(registering ? '/api/register' : '/api/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const messages = {
          400: 'Check the username and key requirements.',
          401: 'Username or key not accepted.',
          403: 'Registration code or request not accepted. Ask the operator for the current code.',
          409: 'That username is unavailable.',
          429: 'Too many attempts or active sessions. Wait before trying again.',
        };
        throw new Error(messages[response.status] || 'The host is not ready. Ask the operator to check its connection and capacity.');
      }
      byId('auth-status').textContent = 'Signed in. Opening your workspace…';
      window.location.replace('/');
    } catch (error) {
      byId('auth-error').textContent = error instanceof TypeError ? 'Cannot reach the host. No sign-in was confirmed.' : error.message;
      byId('auth-error').hidden = false;
      byId('auth-status').textContent = '';
    } finally {
      byId('auth-key').value = '';
      delete payload.key;
      busy = false;
      for (const control of document.querySelectorAll('input, button')) control.disabled = false;
    }
  });
})();
