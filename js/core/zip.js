// A minimal ZIP writer, so a batch comes back as one file instead of
// fifty download prompts.
//
// Entries are stored, not deflated. Images are already compressed, so
// deflating them again would burn CPU on every file to save almost nothing —
// and it keeps this to something small enough to read in full.
(function (N4DU) {

  // CRC-32, table built once. Every entry needs one and the ZIP central
  // directory is checked against it, so this cannot be skipped.
  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // MS-DOS date and time, which is what the ZIP header stores.
  function dosStamp(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) |
                 (Math.floor(date.getSeconds() / 2));
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) |
                date.getDate();
    return { time, day };
  }

  // Names inside the archive must be unique, or extracting silently loses
  // files. Collisions get a counter, the way a file manager would.
  function uniqueName(name, taken) {
    if (!taken.has(name)) { taken.add(name); return name; }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = 2;
    let candidate;
    do { candidate = `${stem} (${n++})${ext}`; } while (taken.has(candidate));
    taken.add(candidate);
    return candidate;
  }

  // files: [{ name, blob }] → a Blob of a valid .zip
  async function zip(files) {
    const encoder = new TextEncoder();
    const stamp = dosStamp(new Date());
    const parts = [];       // the archive body, in order
    const central = [];     // the directory written after it
    const taken = new Set();
    let offset = 0;

    for (const file of files) {
      const name = encoder.encode(uniqueName(file.name, taken));
      const bytes = new Uint8Array(await file.blob.arrayBuffer());
      const sum = crc32(bytes);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034B50, true);   // local file header
      local.setUint16(4, 20, true);           // version needed
      local.setUint16(6, 0x0800, true);       // UTF-8 names
      local.setUint16(8, 0, true);            // method 0: stored
      local.setUint16(10, stamp.time, true);
      local.setUint16(12, stamp.day, true);
      local.setUint32(14, sum, true);
      local.setUint32(18, bytes.length, true);
      local.setUint32(22, bytes.length, true);
      local.setUint16(26, name.length, true);
      parts.push(local.buffer, name, bytes);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014B50, true);   // central directory header
      entry.setUint16(4, 20, true);           // version made by
      entry.setUint16(6, 20, true);           // version needed
      entry.setUint16(8, 0x0800, true);
      entry.setUint16(10, 0, true);
      entry.setUint16(12, stamp.time, true);
      entry.setUint16(14, stamp.day, true);
      entry.setUint32(16, sum, true);
      entry.setUint32(20, bytes.length, true);
      entry.setUint32(24, bytes.length, true);
      entry.setUint16(28, name.length, true);
      entry.setUint32(42, offset, true);      // where the local header sits
      central.push(entry.buffer, name);

      offset += 30 + name.length + bytes.length;
    }

    const centralSize = central.reduce((n, part) => n + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true);       // end of central directory
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);          // where the directory starts

    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  N4DU.zip = { zip, crc32 };

})(window.N4DU ??= {});
