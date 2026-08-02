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

  async function onDownload() {
    if (!state.img) return;
    const btn = document.getElementById('btnExport');
    btn.disabled = true;
    btn.textContent = 'Working…';
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
      btn.disabled = false;
      btn.textContent = 'Download';
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
    btn.textContent = 'Copying…';
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
      btn.disabled = false;
      btn.textContent = 'Copy';
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
