// Notificaciones flotantes.

let timer = null;

export function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(timer);
  timer = setTimeout(() => { el.className = 'toast'; }, 3000);
}
