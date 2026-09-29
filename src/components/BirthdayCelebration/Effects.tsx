/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { useEffect, useRef } from "@webpack/common";

const colors = ["#ff478b", "#ffd95a", "#62ffb1", "#48dfff", "#bd80ff", "#ffffff", "#ff9348"];
const logger = new Logger("ClientEffects");

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    age: number;
    color: string;
    size: number;
    shape: number;
    spin: number;
}

export default function Effects({ sinkId }: { sinkId: string; }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const element = ref.current;
        if (!element || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const context = element.getContext("2d");
        if (!context) return;
        const canvas = element;
        const ctx = context;
        let width = innerWidth;
        let height = innerHeight;
        let stopped = false;
        const audio = new AudioContext();
        const master = audio.createGain();
        master.gain.value = 0.22;
        master.connect(audio.destination);
        async function routeAudio() {
            try {
                if ("setSinkId" in audio && typeof audio.setSinkId === "function") await audio.setSinkId(sinkId);
                if (!stopped) await audio.resume();
            } catch (error) {
                logger.warn("Could not start effect audio.", error);
            }
        }
        void routeAudio();
        const noise = audio.createBuffer(1, audio.sampleRate * 1.4, audio.sampleRate);
        const samples = noise.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

        function sound(boom: boolean) {
            if (audio.state !== "running") return;
            const now = audio.currentTime;
            const gain = audio.createGain();
            gain.connect(master);
            gain.gain.setValueAtTime(0.001, now);
            gain.gain.exponentialRampToValueAtTime(boom ? 0.8 : 0.06, now + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, now + (boom ? 1.3 : 0.7));
            if (boom) {
                const source = audio.createBufferSource();
                const filter = audio.createBiquadFilter();
                filter.type = "lowpass";
                filter.frequency.setValueAtTime(2800, now);
                filter.frequency.exponentialRampToValueAtTime(100, now + 1.2);
                source.buffer = noise;
                source.connect(filter).connect(gain);
                source.start();
                source.stop(now + 1.4);
                source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
            } else {
                const source = audio.createOscillator();
                source.frequency.setValueAtTime(450 + Math.random() * 250, now);
                source.frequency.exponentialRampToValueAtTime(1800, now + 0.65);
                source.connect(gain);
                source.start();
                source.stop(now + 0.7);
                source.onended = () => { source.disconnect(); gain.disconnect(); };
            }
        }

        function resize() {
            width = innerWidth;
            height = innerHeight;
            const scale = Math.min(devicePixelRatio, 1.5);
            canvas.width = width * scale;
            canvas.height = height * scale;
            ctx.setTransform(scale, 0, 0, scale, 0, 0);
        }
        resize();
        window.addEventListener("resize", resize);
        const sparks: Particle[] = [];
        const confetti: Particle[] = [];
        const rockets: { x: number; y: number; startX: number; startY: number; targetX: number; targetY: number; age: number; duration: number; color: string; }[] = [];

        function cannon(count: number) {
            for (let i = 0; i < count && confetti.length < 650; i++) {
                const side = i % 2;
                confetti.push({
                    x: side ? width : 0, y: height * (0.7 + Math.random() * 0.25),
                    vx: (side ? -1 : 1) * (160 + Math.random() * width * 0.7), vy: -350 - Math.random() * height,
                    life: 4 + Math.random() * 3, age: 0, color: colors[i % colors.length],
                    size: 4 + Math.random() * 7, shape: i % 4, spin: Math.random() * 12 - 6
                });
            }
        }

        function burst(x: number, y: number, color: string) {
            sound(true);
            for (let i = 0; i < 110 && sparks.length < 1600; i++) {
                const angle = i / 110 * Math.PI * 2;
                const speed = 80 + Math.random() * Math.min(width * 0.32, 300);
                sparks.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                    life: 1.2 + Math.random() * 1.4, age: 0, color: i % 5 === 0 ? "#ffffff" : color,
                    size: 1 + Math.random() * 2, shape: 0, spin: 0 });
            }
        }

        let elapsed = 0;
        let nextRocket = 0;
        let nextCannon = 1.5;
        let last = performance.now();
        let frame = 0;
        cannon(450);
        function tick(time: number) {
            const dt = Math.min((time - last) / 1000, 0.04);
            last = time;
            elapsed += dt;
            ctx.clearRect(0, 0, width, height);
            if (elapsed > nextRocket) {
                nextRocket = elapsed + 0.24 + Math.random() * 0.22;
                const side = Math.random() < 0.5;
                const x = width * (side ? Math.random() * 0.3 : 0.7 + Math.random() * 0.3);
                rockets.push({ x, y: height + 20, startX: x, startY: height + 20,
                    targetX: width * (side ? 0.03 + Math.random() * 0.32 : 0.65 + Math.random() * 0.32),
                    targetY: height * (0.06 + Math.random() * 0.5), age: 0, duration: 0.65 + Math.random() * 0.5,
                    color: colors[Math.floor(Math.random() * colors.length)] });
                sound(false);
            }
            if (elapsed > nextCannon) { cannon(180); nextCannon = elapsed + 1.5; }
            ctx.globalCompositeOperation = "lighter";
            for (let i = rockets.length - 1; i >= 0; i--) {
                const rocket = rockets[i];
                rocket.age += dt;
                const progress = Math.min(1, rocket.age / rocket.duration);
                const x = rocket.startX + (rocket.targetX - rocket.startX) * progress;
                const y = rocket.startY + (rocket.targetY - rocket.startY) * (1 - (1 - progress) ** 1.6);
                ctx.strokeStyle = rocket.color;
                ctx.lineWidth = 3;
                ctx.beginPath(); ctx.moveTo(rocket.x, rocket.y + 25); ctx.lineTo(x, y); ctx.stroke();
                if (sparks.length < 1600) sparks.push({ x, y, vx: Math.random() * 30 - 15, vy: 70, life: 0.35, age: 0, color: "#ffd95a", size: 2, shape: 0, spin: 0 });
                rocket.x = x; rocket.y = y;
                if (progress === 1) { burst(x, y, rocket.color); rockets.splice(i, 1); }
            }
            for (let i = sparks.length - 1; i >= 0; i--) {
                const p = sparks[i];
                p.age += dt;
                if (p.age > p.life) { sparks.splice(i, 1); continue; }
                const oldX = p.x; const oldY = p.y;
                p.vx *= Math.exp(-dt * 1.2); p.vy += 65 * dt;
                p.x += p.vx * dt; p.y += p.vy * dt;
                ctx.globalAlpha = (1 - p.age / p.life) * (p.age > p.life * 0.65 ? 0.4 + Math.random() * 0.6 : 1);
                ctx.strokeStyle = p.color; ctx.lineWidth = p.size;
                ctx.beginPath(); ctx.moveTo(oldX - p.vx * 0.035, oldY - p.vy * 0.035); ctx.lineTo(p.x, p.y); ctx.stroke();
            }
            ctx.globalCompositeOperation = "source-over";
            for (let i = confetti.length - 1; i >= 0; i--) {
                const p = confetti[i];
                p.age += dt;
                if (p.age > p.life || p.y > height + 40) { confetti.splice(i, 1); continue; }
                p.vx *= Math.exp(-dt * 0.4); p.vy += 260 * dt;
                p.x += p.vx * dt; p.y += p.vy * dt;
                ctx.save();
                ctx.globalAlpha = Math.min(1, (p.life - p.age) * 2);
                ctx.translate(p.x, p.y); ctx.rotate(p.age * p.spin);
                ctx.scale(1, 0.4 + Math.abs(Math.cos(p.age * 5)) * 0.6);
                ctx.fillStyle = p.color;
                if (p.shape === 0) {
                    ctx.beginPath();
                    for (let j = 0; j < 10; j++) {
                        const a = j * Math.PI / 5; const r = p.size * (j % 2 ? 0.45 : 1);
                        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
                    }
                    ctx.closePath(); ctx.fill();
                } else if (p.shape === 1) {
                    ctx.strokeStyle = p.color; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-p.size, 0);
                    ctx.bezierCurveTo(-p.size, -p.size * 3, p.size, p.size * 3, p.size, 0); ctx.stroke();
                } else ctx.fillRect(-p.size / 2, -p.size, p.size, p.shape === 2 ? p.size * 2 : p.size);
                ctx.restore();
            }
            ctx.globalAlpha = 1;
            frame = requestAnimationFrame(tick);
        }
        frame = requestAnimationFrame(tick);
        return () => {
            stopped = true;
            cancelAnimationFrame(frame);
            window.removeEventListener("resize", resize);
            void audio.close().catch(error => logger.warn("Could not close effect audio.", error));
        };
    }, [sinkId]);
    return <canvas ref={ref} className="vc-birthday-effects" aria-hidden="true" />;
}
