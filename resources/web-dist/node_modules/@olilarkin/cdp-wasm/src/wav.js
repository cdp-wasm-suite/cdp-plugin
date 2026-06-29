// Minimal WAV (RIFF) reader/writer for interop with CDP, which reads and writes
// WAVE files. Supports 16/24/32-bit PCM and 32-bit float on decode (including
// WAVE_FORMAT_EXTENSIBLE), and writes 32-bit float (CDP's native output format).

const FMT_PCM = 0x0001;
const FMT_FLOAT = 0x0003;
const FMT_EXTENSIBLE = 0xfffe;

/**
 * Decode a WAV file into planar float channel data.
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{sampleRate:number, numChannels:number, length:number, channelData:Float32Array[], bitDepth:number}}
 */
export function decodeWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (str(dv, 0, 4) !== 'RIFF' || str(dv, 8, 4) !== 'WAVE') {
    throw new Error('not a WAV file (missing RIFF/WAVE)');
  }
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;
  let pos = 12;
  while (pos + 8 <= dv.byteLength) {
    const id = str(dv, pos, 4);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      let tag = dv.getUint16(body, true);
      const numChannels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const bitsPerSample = dv.getUint16(body + 14, true);
      if (tag === FMT_EXTENSIBLE && size >= 24) {
        tag = dv.getUint16(body + 24, true); // first 2 bytes of SubFormat GUID
      }
      fmt = { tag, numChannels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
    }
    pos = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt) throw new Error('WAV has no fmt chunk');
  if (dataOffset < 0) throw new Error('WAV has no data chunk');

  const { tag, numChannels, sampleRate, bitsPerSample } = fmt;
  const bytesPerSample = bitsPerSample >> 3;
  const frameCount = Math.floor(dataLength / (bytesPerSample * numChannels));
  const channelData = Array.from({ length: numChannels }, () => new Float32Array(frameCount));

  const read = sampleReader(dv, tag, bitsPerSample);
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < numChannels; c++) {
      const o = dataOffset + (i * numChannels + c) * bytesPerSample;
      channelData[c][i] = read(o);
    }
  }
  return { sampleRate, numChannels, length: frameCount, channelData, bitDepth: bitsPerSample };
}

/**
 * Encode planar float channel data into a 32-bit float WAV file.
 * @param {{sampleRate:number, channelData:Float32Array[]}} audio
 * @returns {Uint8Array}
 */
export function encodeWav({ sampleRate, channelData }) {
  const numChannels = channelData.length;
  if (numChannels === 0) throw new Error('no channels');
  const frameCount = channelData[0].length;
  const bytesPerSample = 4;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLength);
  const dv = new DataView(buffer);

  writeStr(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataLength, true);
  writeStr(dv, 8, 'WAVE');
  writeStr(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, FMT_FLOAT, true);
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 32, true);
  writeStr(dv, 36, 'data');
  dv.setUint32(40, dataLength, true);

  let o = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < numChannels; c++) {
      dv.setFloat32(o, channelData[c][i], true);
      o += 4;
    }
  }
  return new Uint8Array(buffer);
}

/** Browser helper: decode a WAV byte array into a Web Audio AudioBuffer. */
export function wavToAudioBuffer(bytes, audioContext) {
  const { sampleRate, numChannels, length, channelData } = decodeAudio(bytes);
  const buf = audioContext.createBuffer(numChannels, length, sampleRate);
  for (let c = 0; c < numChannels; c++) buf.copyToChannel(channelData[c], c);
  return buf;
}

/** Browser helper: encode a Web Audio AudioBuffer into a 32-bit float WAV. */
export function audioBufferToWav(audioBuffer) {
  const channelData = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channelData.push(audioBuffer.getChannelData(c));
  }
  return encodeWav({ sampleRate: audioBuffer.sampleRate, channelData });
}

/**
 * Decode an AIFF or AIFF-C file into planar float channel data (same shape as
 * decodeWav). Supports PCM 8/16/24/32-bit and the common AIFF-C variants
 * 'NONE'/'twos' (big-endian), 'sowt' (little-endian) and 'fl32'/'fl64' (float).
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{sampleRate:number, numChannels:number, length:number, channelData:Float32Array[], bitDepth:number}}
 */
export function decodeAiff(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (str(dv, 0, 4) !== 'FORM') throw new Error('not an AIFF file (missing FORM)');
  const formType = str(dv, 8, 4);
  if (formType !== 'AIFF' && formType !== 'AIFC') throw new Error(`unsupported FORM type "${formType}"`);

  let comm = null;
  let ssndOffset = -1;
  let pos = 12;
  while (pos + 8 <= dv.byteLength) {
    const id = str(dv, pos, 4);
    const size = dv.getUint32(pos + 4, false); // AIFF is big-endian
    const body = pos + 8;
    if (id === 'COMM') {
      comm = {
        numChannels: dv.getInt16(body, false),
        numFrames: dv.getUint32(body + 2, false),
        sampleSize: dv.getInt16(body + 6, false),
        sampleRate: readExtended(dv, body + 8),
        compression: formType === 'AIFC' && size >= 22 ? str(dv, body + 18, 4) : 'NONE',
      };
    } else if (id === 'SSND') {
      const dataOffset = dv.getUint32(body, false); // bytes of padding before samples
      ssndOffset = body + 8 + dataOffset; // skip offset + blockSize longs
    }
    pos = body + size + (size & 1); // chunks are padded to an even length
  }
  if (!comm) throw new Error('AIFF has no COMM chunk');
  if (ssndOffset < 0) throw new Error('AIFF has no SSND chunk');

  const { numChannels, numFrames, sampleSize, sampleRate, compression } = comm;
  const read = aiffReader(dv, sampleSize, compression);
  const bytesPerSample = aiffBytesPerSample(sampleSize, compression);
  const channelData = Array.from({ length: numChannels }, () => new Float32Array(numFrames));
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      channelData[c][i] = read(ssndOffset + (i * numChannels + c) * bytesPerSample);
    }
  }
  return { sampleRate: Math.round(sampleRate), numChannels, length: numFrames, channelData, bitDepth: sampleSize };
}

/**
 * Decode a WAV or AIFF byte array (sniffed from the header) into planar float
 * channel data. Throws for other containers (decode those via Web Audio first).
 */
export function decodeAudio(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const tag = String.fromCharCode(bytes[0] || 0, bytes[1] || 0, bytes[2] || 0, bytes[3] || 0);
  if (tag === 'RIFF') return decodeWav(bytes);
  if (tag === 'FORM') return decodeAiff(bytes);
  throw new Error(`unsupported audio container (tag "${tag}"); expected WAV (RIFF) or AIFF (FORM)`);
}

// ---- internals --------------------------------------------------------------

function aiffBytesPerSample(bits, compression) {
  if (compression === 'fl32' || compression === 'FL32') return 4;
  if (compression === 'fl64' || compression === 'FL64') return 8;
  return Math.ceil(bits / 8);
}

function aiffReader(dv, bits, compression) {
  const c = compression;
  if (c === 'fl32' || c === 'FL32') return (o) => dv.getFloat32(o, false);
  if (c === 'fl64' || c === 'FL64') return (o) => dv.getFloat64(o, false);
  const le = c === 'sowt' || c === 'SOWT'; // byte-swapped (little-endian) PCM
  if (bits === 8) return (o) => dv.getInt8(o) / 128; // AIFF 8-bit is signed
  if (bits === 16) return (o) => dv.getInt16(o, le) / 32768;
  if (bits === 24)
    return (o) => {
      const b0 = dv.getUint8(o), b1 = dv.getUint8(o + 1), b2 = dv.getUint8(o + 2);
      const v = le ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
      return (v & 0x800000 ? v - 0x1000000 : v) / 0x800000;
    };
  if (bits === 32) return (o) => dv.getInt32(o, le) / 0x80000000;
  throw new Error(`unsupported AIFF sample format (${bits}-bit, '${compression}')`);
}

// Read an 80-bit IEEE 754 extended float (AIFF sample rate).
function readExtended(dv, off) {
  const expon = dv.getUint16(off, false);
  const hi = dv.getUint32(off + 2, false);
  const lo = dv.getUint32(off + 6, false);
  const sign = expon & 0x8000 ? -1 : 1;
  const e = expon & 0x7fff;
  if (e === 0 && hi === 0 && lo === 0) return 0;
  const mantissa = hi * 0x100000000 + lo; // explicit integer bit included
  return sign * mantissa * Math.pow(2, e - 16383 - 63);
}

function sampleReader(dv, tag, bits) {
  if (tag === FMT_FLOAT) {
    if (bits === 32) return (o) => dv.getFloat32(o, true);
    if (bits === 64) return (o) => dv.getFloat64(o, true);
  }
  if (tag === FMT_PCM) {
    if (bits === 16) return (o) => dv.getInt16(o, true) / 32768;
    if (bits === 8) return (o) => (dv.getUint8(o) - 128) / 128;
    if (bits === 24)
      return (o) => {
        const v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
        return (v & 0x800000 ? v - 0x1000000 : v) / 0x800000;
      };
    if (bits === 32) return (o) => dv.getInt32(o, true) / 0x80000000;
  }
  throw new Error(`unsupported WAV sample format (tag=${tag}, bits=${bits})`);
}

const str = (dv, off, len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
  return s;
};
const writeStr = (dv, off, s) => {
  for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
};
