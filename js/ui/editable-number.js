// Editable slider readouts.
//
// Every number shown next to a slider can be clicked and typed into, so a
// precise value does not require dragging. The readout swaps itself for a
// small input, commits on Enter or blur, and cancels on Escape.
(function (N4DU) {

  // Turns a readout element into a click-to-type field bound to a range input.
  //   valueEl : the <span> showing the value
  //   rangeEl : the <input type=range> it reflects
  //   onCommit: called with the accepted number
  // scale lets a readout use different units from the slider (the zoom
  // slider runs 1–5 but reads as 100–500%).
  function makeEditable(valueEl, rangeEl, onCommit, scale = 1) {
    if (!valueEl || !rangeEl) return;
    valueEl.classList.add('editable');
    valueEl.title = 'Click to type a value';

    valueEl.addEventListener('click', () => open());

    function open() {
      if (valueEl.querySelector('input')) return;      // already editing
      const min = Number(rangeEl.min || 0) * scale;
      const max = Number(rangeEl.max || 100) * scale;
      const current = Math.round(Number(rangeEl.value) * scale);
      const previous = valueEl.textContent;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'inline-number';
      input.value = String(current);
      input.setAttribute('inputmode', 'numeric');
      valueEl.textContent = '';
      valueEl.appendChild(input);
      input.focus();
      input.select();

      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        const typed = parseFloat(input.value.replace(',', '.'));
        input.remove();
        if (commit && Number.isFinite(typed)) {
          const clamped = Math.max(min, Math.min(max, typed));
          rangeEl.value = String(clamped / scale);
          // Let the normal slider handler do the formatting and state update.
          rangeEl.dispatchEvent(new Event('input', { bubbles: true }));
          if (onCommit) onCommit(clamped);
        } else {
          valueEl.textContent = previous;
        }
      };

      input.addEventListener('keydown', e => {
        e.stopPropagation();                 // do not trigger app shortcuts
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('click', e => e.stopPropagation());
    }
  }

  N4DU.editableNumber = { makeEditable };

})(window.N4DU ??= {});
