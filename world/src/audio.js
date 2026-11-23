// Tiny WebAudio synth: engine hum, horn, crash thumps and ocean surf. No audio files needed.
export class Sound {
  constructor() { this.ctx = null; this.muted = false; }
  start() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = (this.ctx = new AC());
    this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : 0.5; this.master.connect(c.destination);
    // engine: two detuned saws through a lowpass
    this.eng = c.createGain(); this.eng.gain.value = 0;
    this.lp = c.createBiquadFilter(); this.lp.type = "lowpass"; this.lp.frequency.value = 600;
    this.o1 = c.createOscillator(); this.o1.type = "sawtooth";
    this.o2 = c.createOscillator(); this.o2.type = "sawtooth"; this.o2.detune.value = 12;
    this.o1.connect(this.lp); this.o2.connect(this.lp); this.lp.connect(this.eng); this.eng.connect(this.master);
    this.o1.start(); this.o2.start();
    // horn
    this.horn = c.createGain(); this.horn.gain.value = 0; this.horn.connect(this.master);
    for (const f of [392, 494]) { const o = c.createOscillator(); o.type = "square"; o.frequency.value = f; o.connect(this.horn); o.start(); }
    // surf: filtered noise with slow swell
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = "lowpass"; bp.frequency.value = 500;
    this.surf = c.createGain(); this.surf.gain.value = 0;
    src.connect(bp); bp.connect(this.surf); this.surf.connect(this.master); src.start();
  }
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.5; }
  update({ driving, speed, throttle, horn, beach, t }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const rpm = 40 + Math.abs(speed) * 3.2 % 70 + Math.abs(speed) * 1.2 + Math.abs(throttle) * 25;
    this.o1.frequency.setTargetAtTime(rpm, now, 0.08);
    this.o2.frequency.setTargetAtTime(rpm * 1.5, now, 0.08);
    this.lp.frequency.setTargetAtTime(300 + Math.abs(throttle) * 900 + Math.abs(speed) * 10, now, 0.1);
    this.eng.gain.setTargetAtTime(driving ? 0.09 + Math.abs(throttle) * 0.06 : 0, now, 0.15);
    this.horn.gain.setTargetAtTime(horn ? 0.06 : 0, now, 0.02);
    this.surf.gain.setTargetAtTime(beach * (0.12 + 0.08 * Math.sin(t * 0.6)), now, 0.3);
  }
  crash(strength) {
    if (!this.ctx) return;
    const c = this.ctx, src = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter();
    src.buffer = this.noise; f.type = "lowpass"; f.frequency.value = 900;
    g.gain.setValueAtTime(Math.min(0.8, strength * 0.05), c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.4);
    src.connect(f); f.connect(g); g.connect(this.master); src.start(); src.stop(c.currentTime + 0.5);
  }
}
