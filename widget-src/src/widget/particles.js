// Sistema particelle per l'animazione "shatter" della bolla.
// Porting 1:1 delle classi Shard/Spark dal widget.js originale (canvas 2D).

export class Shard {
  constructor(cx, cy, hue) {
    const angle = Math.random() * Math.PI * 2;
    const r = 20 + Math.random() * 22;
    this.x = cx + Math.cos(angle) * r;
    this.y = cy + Math.sin(angle) * r;
    const speed = 2.5 + Math.random() * 5.5;
    this.vx = Math.cos(angle) * speed + (Math.random() - 0.5) * 2;
    this.vy = Math.sin(angle) * speed + (Math.random() - 0.5) * 2;
    this.vr = (Math.random() - 0.5) * 0.25;
    this.size = 4 + Math.random() * 10;
    this.aspect = 0.35 + Math.random() * 0.6;
    this.rotation = Math.random() * Math.PI * 2;
    this.hue = hue + (Math.random() * 30 - 15);
    this.sat = 60 + Math.random() * 30;
    this.lit = 75 + Math.random() * 20;
    this.alpha = 0.7 + Math.random() * 0.3;
    this.life = 1.0;
    this.decay = 0.018 + Math.random() * 0.022;
    this.gravity = 0.08 + Math.random() * 0.06;
    this.drag = 0.97;
    this.glintPhase = Math.random() * Math.PI * 2;
    this.glintSpeed = 0.08 + Math.random() * 0.12;
    this.type = Math.random() > 0.35 ? 'shard' : 'droplet';
  }

  update() {
    this.vx *= this.drag;
    this.vy *= this.drag;
    this.vy += this.gravity;
    this.x += this.vx;
    this.y += this.vy;
    this.rotation += this.vr;
    this.life -= this.decay;
    this.glintPhase += this.glintSpeed;
  }

  draw(ctx) {
    if (this.life <= 0) return;
    const glint = (Math.sin(this.glintPhase) + 1) / 2;
    const alpha = Math.min(this.life, 1) * this.alpha;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);
    ctx.globalAlpha = alpha;
    if (this.type === 'shard') {
      const w = this.size * this.aspect;
      const h = this.size;
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.lineTo(w, h * 0.6);
      ctx.lineTo(-w * 0.4, h);
      ctx.closePath();
      const grd = ctx.createLinearGradient(0, -h, 0, h);
      grd.addColorStop(0, `hsla(${this.hue},${this.sat}%,${this.lit}%,${0.85 + glint * 0.15})`);
      grd.addColorStop(0.4, `hsla(${this.hue},${this.sat}%,${this.lit - 10}%,0.5)`);
      grd.addColorStop(1, `hsla(${this.hue},${this.sat}%,${this.lit}%,0.2)`);
      ctx.fillStyle = grd;
      ctx.fill();
      ctx.strokeStyle = `hsla(${this.hue},90%,95%,${0.4 + glint * 0.5})`;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    } else {
      const rad = this.size * 0.4;
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, Math.PI * 2);
      const grd = ctx.createRadialGradient(-rad * 0.3, -rad * 0.3, 0, 0, 0, rad);
      grd.addColorStop(0, `rgba(255,255,255,${0.7 + glint * 0.3})`);
      grd.addColorStop(0.4, `hsla(${this.hue},${this.sat}%,${this.lit}%,0.5)`);
      grd.addColorStop(1, `hsla(${this.hue},${this.sat}%,${this.lit}%,0.1)`);
      ctx.fillStyle = grd;
      ctx.fill();
    }
    ctx.restore();
  }

  get alive() {
    return this.life > 0;
  }
}

export class Spark {
  constructor(cx, cy, hue) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1 + Math.random() * 7;
    this.x = cx;
    this.y = cy;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.life = 0.6 + Math.random() * 0.4;
    this.decay = 0.035 + Math.random() * 0.04;
    this.size = 1 + Math.random() * 2;
    this.color = `hsl(${hue},90%,90%)`;
    this.gravity = 0.04;
  }

  update() {
    this.vx *= 0.96;
    this.vy *= 0.96;
    this.vy += this.gravity;
    this.x += this.vx;
    this.y += this.vy;
    this.life -= this.decay;
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, this.life);
    ctx.fillStyle = this.color;
    ctx.shadowBlur = 6;
    ctx.shadowColor = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  get alive() {
    return this.life > 0;
  }
}
