// Keyboard + mouse, gamepad, and on-screen touch controls (Kenney "Mobile Controls" sprites).
export class Input {
  constructor(canvas, ui) {
    this.keys = new Set();
    this.pressed = new Set();     // keys pressed since last frame
    this.look = { x: 0, y: 0 };   // accumulated look delta (pixels)
    this.zoom = 0;
    this.stick = { x: 0, y: 0 };  // touch joystick
    this.touchBtn = new Set();
    this.touchPressed = new Set();
    this.canvas = canvas;
    this.lastLook = -10;

    addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT") return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (["Space", "ArrowUp", "ArrowDown", "Tab"].includes(e.code)) e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());
    canvas.addEventListener("click", () => { if (!this.isTouch && canvas.requestPointerLock) canvas.requestPointerLock(); });
    addEventListener("mousemove", (e) => {
      if (document.pointerLockElement === canvas) { this.look.x += e.movementX; this.look.y += e.movementY; this.lastLook = performance.now(); }
    });
    addEventListener("mousedown", (e) => { if (document.pointerLockElement === canvas && e.button === 0) this.pressed.add("Mouse0"); });
    addEventListener("wheel", (e) => { if (document.pointerLockElement === canvas) this.zoom += Math.sign(e.deltaY); }, { passive: true });

    this.isTouch = matchMedia("(pointer: coarse)").matches;
    if (this.isTouch) this.setupTouch(ui);
  }

  setupTouch(ui) {
    ui.classList.add("touch");
    const pad = ui.querySelector("#t-pad"), nub = ui.querySelector("#t-nub");
    let stickId = null, lookId = null, lx = 0, ly = 0, cx = 0, cy = 0;
    const R = 56;
    pad.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0]; stickId = t.identifier;
      const r = pad.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      move(t); e.preventDefault();
    }, { passive: false });
    const move = (t) => {
      let dx = t.clientX - cx, dy = t.clientY - cy;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx *= R / d; dy *= R / d; }
      nub.style.transform = `translate(${dx}px, ${dy}px)`;
      this.stick.x = dx / R; this.stick.y = -dy / R;
    };
    addEventListener("touchmove", (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickId) move(t);
        else if (t.identifier === lookId) {
          this.look.x += (t.clientX - lx) * 1.6; this.look.y += (t.clientY - ly) * 1.6;
          lx = t.clientX; ly = t.clientY; this.lastLook = performance.now();
        }
      }
    }, { passive: true });
    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickId) { stickId = null; this.stick.x = this.stick.y = 0; nub.style.transform = ""; }
        if (t.identifier === lookId) lookId = null;
      }
    };
    addEventListener("touchend", end); addEventListener("touchcancel", end);
    this.canvas.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      if (t.clientX > innerWidth * 0.35 && lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
    }, { passive: true });
    for (const b of ui.querySelectorAll("[data-btn]")) {
      const name = b.dataset.btn;
      b.addEventListener("touchstart", (e) => { this.touchBtn.add(name); this.touchPressed.add(name); b.classList.add("down"); e.preventDefault(); }, { passive: false });
      const up = () => { this.touchBtn.delete(name); b.classList.remove("down"); };
      b.addEventListener("touchend", up); b.addEventListener("touchcancel", up);
    }
  }

  gamepad() {
    const gp = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
    if (!gp) return null;
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
    return { lx: dz(gp.axes[0]), ly: dz(gp.axes[1]), rx: dz(gp.axes[2]), ry: dz(gp.axes[3]), b: gp.buttons.map((b) => b.pressed), rt: gp.buttons[7]?.value || 0, lt: gp.buttons[6]?.value || 0 };
  }

  // Snapshot of the controls for this frame.
  read() {
    const k = (c) => this.keys.has(c);
    const p = (c) => this.pressed.has(c);
    const gp = this.gamepad();
    if (gp && !this.prevGp) this.prevGp = [];
    const gpPress = (i) => gp && gp.b[i] && !this.prevGp[i];
    let x = (k("KeyD") || k("ArrowRight") ? 1 : 0) - (k("KeyA") || k("ArrowLeft") ? 1 : 0);
    let y = (k("KeyW") || k("ArrowUp") ? 1 : 0) - (k("KeyS") || k("ArrowDown") ? 1 : 0);
    x += this.stick.x; y += this.stick.y;
    if (gp) {
      x += gp.lx; y += -gp.ly;
      if (gp.rt || gp.lt) y += gp.rt - gp.lt;
      this.look.x += gp.rx * 14; this.look.y += gp.ry * 10;
      if (gp.rx || gp.ry) this.lastLook = performance.now();
    }
    if (this.touchBtn.has("gas")) y = 1;
    if (this.touchBtn.has("brake")) y = -1;
    const out = {
      x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)),
      sprint: k("ShiftLeft") || k("ShiftRight") || (gp && gp.b[10]) || Math.hypot(this.stick.x, this.stick.y) > 0.95,
      jump: p("Space") || this.touchPressed.has("jump") || gpPress(0),
      handbrake: k("Space") || this.touchBtn.has("jump") || (gp && gp.b[0]),
      enter: p("KeyF") || p("KeyE") || this.touchPressed.has("enter") || gpPress(3),
      horn: k("KeyH") || (gp && gp.b[4]),
      camera: p("KeyV") || this.touchPressed.has("camera") || gpPress(11),
      crouch: p("KeyC") || p("ControlLeft") || this.touchPressed.has("crouch") || gpPress(1),
      attack: p("Mouse0") || p("KeyQ") || this.touchPressed.has("attack") || gpPress(2),
      map: p("KeyM") || p("Tab") || this.touchPressed.has("map") || gpPress(8),
      menu: p("Escape") || p("KeyP") || this.touchPressed.has("menu") || gpPress(9),
      time: p("KeyT"),
      look: { x: this.look.x, y: this.look.y },
      zoom: this.zoom,
      recentLook: performance.now() - this.lastLook < 1500,
    };
    this.look.x = this.look.y = 0; this.zoom = 0;
    this.pressed.clear(); this.touchPressed.clear();
    if (gp) this.prevGp = gp.b.slice();
    return out;
  }
}
