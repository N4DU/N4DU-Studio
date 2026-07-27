// Notificaciones flotantes.
(function (N4DU) {

  let timer = null;

  function toast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(timer);
    timer = setTimeout(() => { el.className = 'toast'; }, 3500);
  }

  N4DU.toast = toast;

})(window.N4DU ??= {});
