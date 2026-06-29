// AudioWorkletProcessor that runs the shared cdp-sampler WASM DSP (the same
// cubic-Hermite voice engine the native plugin compiles in). Loaded as a classic
// worklet module (no imports), it instantiates the standalone .wasm — passed in
// as bytes via processorOptions — right here in the AudioWorkletGlobalScope.
//
// Messages from the main thread (sampler.js):
//   { type:'sample', chans, frames, sr, pcm }   pcm = planar Float32Array (transferred)
//   { type:'noteOn', note, vel } | { type:'noteOff', note } | { type:'allOff' }

class CDPSamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;
    this.heap = null;          // Float32Array view over wasm memory
    const opts = options.processorOptions || {};
    try {
      const mod = new WebAssembly.Module(opts.wasmBytes);
      const inst = new WebAssembly.Instance(mod, {
        env: { emscripten_notify_memory_growth: () => this.refreshHeap() },
      });
      this.ex = inst.exports;
      this.ex._initialize && this.ex._initialize();   // WASI reactor init
      this.refreshHeap();
      this.ex.cdpsamp_init(opts.numVoices || 16, opts.sampleRate || sampleRate);
      this.maxBlock = this.ex.cdpsamp_max_block();
      this.ready = true;
    } catch (e) {
      this.port.postMessage({ type: 'error', message: String(e && e.message || e) });
    }
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  refreshHeap() { this.heap = new Float32Array(this.ex.memory.buffer); }

  onMessage(msg) {
    if (!this.ready) return;
    switch (msg.type) {
      case 'sample': {
        const ptr = this.ex.cdpsamp_alloc_sample(msg.chans, msg.frames);
        if (!ptr) return;
        this.refreshHeap();                              // malloc may have grown memory
        this.heap.set(msg.pcm, ptr >> 2);                // planar PCM into wasm heap
        this.ex.cdpsamp_commit_sample(msg.chans, msg.frames, msg.sr);
        break;
      }
      case 'noteOn':    this.ex.cdpsamp_note_on(msg.note, msg.vel | 0); break;
      case 'noteOff':   this.ex.cdpsamp_note_off(msg.note); break;
      case 'allOff':    this.ex.cdpsamp_all_notes_off(); break;
      case 'pitchBend': this.ex.cdpsamp_pitch_bend(msg.semis); break;
      case 'modWheel':  this.ex.cdpsamp_mod_wheel(msg.amt); break;
      case 'vibrato':   this.ex.cdpsamp_set_vibrato(msg.rate, msg.depth); break;
      case 'adsr':      this.ex.cdpsamp_set_adsr(msg.a, msg.d, msg.s, msg.r); break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.ready || !out || out.length === 0) return true;
    const nch = out.length;
    const n = out[0].length;
    this.ex.cdpsamp_process(nch, n);
    const base = this.ex.cdpsamp_out_ptr() >> 2;         // float index
    for (let c = 0; c < nch; c++) {
      const off = base + c * this.maxBlock;
      out[c].set(this.heap.subarray(off, off + n));
    }
    return true;
  }
}

registerProcessor('cdp-sampler', CDPSamplerProcessor);
