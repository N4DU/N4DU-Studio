// Taking the result away: to the Downloads folder, or to the clipboard.
//
// Two buttons that do the same job by different routes, and both have to be
// honest about failing — an export that came out over the weight limit is
// not a success, and a clipboard that cannot take an image should say so
// rather than appear to work.
(function (N4DU) {

  const { state, toast } = N4DU;
  const { exportBlob, download } = N4DU.exporter;

  // Repainted after either one finishes; installed by main.js so this module
  // does not need to know what a button looks like.
  let syncButtons = () => {};

  // Both buttons say what they are doing while they do it, and both are an
  // icon followed by a word. Writing the word with textContent threw the
  // icon away — permanently, because nothing put it back — so Download and
  // Copy lost their pictures the first time you pressed them and never got
  // them back. The icon element is kept and only the words are replaced.
  function saying(btn, words) {
    const before = btn.innerHTML;
    const icon = btn.querySelector('svg');
    btn.textContent = ' ' + words;
    if (icon) btn.prepend(icon);
    return () => { btn.innerHTML = before; };
  }

  async function onDownload() {
    if (!state.img) return;
    const btn = document.getElementById('btnExport');
    btn.disabled = true;
    const restore = saying(btn, 'Working…');
    try {
      const { blob, filename, limit } = await exportBlob(state);
      download(blob, filename);
      if (limit && !limit.ok) {
        // Never present an oversized file as a success.
        toast(`Downloaded ${filename} · ${sizeLabel(blob.size)} — could not get under ${N4DU.controls.limitLabel()}`, 'err');
      } else {
        toast(`Downloaded ${filename} · ${sizeLabel(blob.size)}`, 'ok');
      }
    } catch (err) {
      toast('Export failed: ' + err.message, 'err');
    } finally {
      restore();
      btn.disabled = false;
      syncButtons();
    }
  }

  // ── Copy to clipboard ─────────────────────────────────────────────
  // Writing images to the clipboard needs a secure context (https or
  // localhost). Opening the file directly from disk does not qualify, so the
  // failure is explained instead of silently doing nothing.
  async function onCopy() {
    if (!state.img) return;
    const btn = document.getElementById('btnCopy');
    btn.disabled = true;
    const restore = saying(btn, 'Copying…');
    try {
      if (!navigator.clipboard || !window.ClipboardItem) {
        throw new Error('this browser cannot copy images');
      }
      // PNG is the only format clipboards accept reliably, so the copy is
      // always PNG regardless of the chosen export format.
      const canvas = N4DU.render.renderOutput(state, ...outputSize());
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(`Copied to clipboard · PNG · ${sizeLabel(blob.size)}`, 'ok');
    } catch (err) {
      const secure = window.isSecureContext;
      toast(secure
        ? 'Could not copy: ' + err.message
        : 'Copying needs the desktop version (or an https page)', 'err');
    } finally {
      restore();
      btn.disabled = false;
      syncButtons();
    }
  }

  function outputSize() {
    const { W, H } = N4DU.exporter.outputDims(state);
    return [W, H];
  }

  function sizeLabel(bytes) {
    const kb = bytes / 1024;
    return kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB';
  }

  N4DU.deliver = {
    onDownload, onCopy, outputSize, sizeLabel,
    setSyncButtons(fn) { syncButtons = fn || (() => {}); },
  };

})(window.N4DU ??= {});
