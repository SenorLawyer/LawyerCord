import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import puppeteer from "puppeteer-core";

const execFileAsync = promisify(execFile);
const WIDTH = 1920;
const HEIGHT = 1080;
const SLIDE_SECONDS = 4.2;
const TRANSITION_SECONDS = 0.7;
const outputPath = resolve(process.argv[2] ?? "../DiscordMCP-Overview.mp4");
const workDirectory = resolve(process.env.DISCORD_MCP_VIDEO_TEMP ?? "C:/tmp/discord-mcp-video");
const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe";

interface Slide {
    eyebrow: string;
    title: string;
    subtitle: string;
    body: string;
    accent: string;
}

const chatIcon = `
<svg viewBox="0 0 64 64" aria-hidden="true">
  <path d="M13 12h38a7 7 0 0 1 7 7v22a7 7 0 0 1-7 7H31L18 57v-9h-5a7 7 0 0 1-7-7V19a7 7 0 0 1 7-7Z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/>
  <circle cx="22" cy="30" r="3" fill="currentColor"/><circle cx="32" cy="30" r="3" fill="currentColor"/><circle cx="42" cy="30" r="3" fill="currentColor"/>
</svg>`;

const slides: Slide[] = [
    {
        eyebrow: "LAWYERCORD PRESENTS",
        title: "Discord MCP",
        subtitle: "Your Discord. Agent-ready. Quietly.",
        accent: "#62e8ff",
        body: `
          <div class="hero-lockup">
            <div class="hero-icon">${chatIcon}</div>
            <div class="orbit orbit-one"></div><div class="orbit orbit-two"></div>
          </div>
          <div class="pill-row"><span>LOCAL</span><span>SILENT</span><span>EVENT-DRIVEN</span></div>
          <p class="hero-note">A fixed, auditable MCP surface inside your authenticated desktop client.</p>`,
    },
    {
        eyebrow: "LOCAL ARCHITECTURE",
        title: "Your session stays in Discord",
        subtitle: "No listening web server. No token export. No UI automation.",
        accent: "#8b9cff",
        body: `
          <div class="flow">
            <div class="flow-node"><b>AI agent</b><small>MCP client</small></div><i>→</i>
            <div class="flow-node"><b>stdio server</b><small>15 focused tools</small></div><i>→</i>
            <div class="flow-node secure"><b>private queue</b><small>local + authenticated</small></div><i>→</i>
            <div class="flow-node"><b>LawyerCord</b><small>Discord APIs + events</small></div>
          </div>
          <div class="boundary"><span>LOCAL TRUST BOUNDARY</span></div>
          <div class="metric-row"><div><strong>0</strong><span>network ports</span></div><div><strong>0</strong><span>exported tokens</span></div><div><strong>1</strong><span>authenticated client</span></div></div>`,
    },
    {
        eyebrow: "FOCUSED TOOLING",
        title: "Everything agents need. Nothing generic.",
        subtitle: "Every operation is named, validated, and visible in the schema.",
        accent: "#b779ff",
        body: `
          <div class="tool-grid">
            <div class="tool-card"><em>DISCOVER</em><b>Servers · Channels · DMs</b><p>Resolve Discord structure without touching the active view.</p></div>
            <div class="tool-card"><em>READ</em><b>Search · Single · Bulk · Media</b><p>Headless Discord search plus structured messages and attachments.</p></div>
            <div class="tool-card"><em>ACT</em><b>Send · Delete-own</b><p>Mentions disabled. Deletion requires the MCP sent ledger.</p></div>
            <div class="tool-card hot"><em>SUBSCRIBE</em><b>Subscribe · Wait · List · Stop</b><p>Receive new messages from Discord's native event stream.</p></div>
          </div>
          <div class="big-caption"><strong>15</strong> scoped tools <span>•</span> <strong>0</strong> arbitrary REST calls</div>`,
    },
    {
        eyebrow: "NEW: CHANNEL SUBSCRIPTIONS",
        title: "Wait for messages without polling",
        subtitle: "Subscribe once. Let Discord's MESSAGE_CREATE event do the work.",
        accent: "#43f0b8",
        body: `
          <div class="subscription-panel">
            <div class="step"><span>01</span><b>Subscribe</b><p>Any channel visible to the account</p></div>
            <div class="step-arrow">→</div>
            <div class="step"><span>02</span><b>Wait</b><p>1–300 seconds per call</p></div>
            <div class="step-arrow">→</div>
            <div class="step pulse"><span>03</span><b>Receive</b><p>Buffered, structured message data</p></div>
          </div>
          <div class="subscription-badges"><span>Native events</span><span>100-message buffer</span><span>100 subscriptions</span><span>Active view unchanged</span></div>
          <div class="event-code"><i></i><code>MESSAGE_CREATE  →  subscription  →  waiting agent</code></div>`,
    },
    {
        eyebrow: "MEDIA-AWARE",
        title: "Messages are more than text",
        subtitle: "Images and voice messages arrive in formats agents can actually use.",
        accent: "#ffb85c",
        body: `
          <div class="media-grid">
            <div class="media-card image-card"><div class="mock-image"><span></span><span></span><span></span></div><h3>Images</h3><p>Native MCP image blocks<br/>MIME + size + SHA-256</p></div>
            <div class="media-card voice-card"><div class="wave">${Array.from({ length: 32 }, (_, index) => `<i style="height:${20 + (index * 17) % 72}%"></i>`).join("")}</div><h3>Voice</h3><p>Playable audio blocks<br/>Duration + generated waveform</p></div>
            <div class="media-card file-card"><div class="file-icon">↓</div><h3>Files</h3><p>Private local download<br/>25 MB hard cap</p></div>
          </div>`,
    },
    {
        eyebrow: "SAFETY BY CONSTRUCTION",
        title: "Powerful where you asked. Closed everywhere else.",
        subtitle: "The safest capability is the one that does not exist.",
        accent: "#ff718d",
        body: `
          <div class="safety-grid">
            <div class="safety-card can"><h3>CAN</h3><ul><li>Use every visible channel</li><li>Search messages headlessly</li><li>Subscribe and wait silently</li><li>Send explicit plain-text messages</li><li>Delete messages the MCP sent</li></ul></div>
            <div class="safety-card cannot"><h3>CANNOT</h3><ul><li>Add, remove, or block users</li><li>Change membership or roles</li><li>Perform moderation actions</li><li>Make arbitrary Discord requests</li><li>Navigate your active view</li></ul></div>
          </div>`,
    },
    {
        eyebrow: "LIVE-TESTED",
        title: "Fast. Silent. Controlled.",
        subtitle: "Built for agents—without getting in your way.",
        accent: "#62e8ff",
        body: `
          <div class="proof-grid"><div><strong>46 ms</strong><span>status response</span></div><div><strong>457 ms</strong><span>two-channel bulk read</span></div><div><strong>100</strong><span>messages sampled live</span></div><div><strong>✓</strong><span>subscription delivered</span></div></div>
          <div class="final-lockup"><div class="mini-icon">${chatIcon}</div><div><b>Discord MCP</b><small>Running locally in LawyerCord</small></div></div>
          <p class="final-note">Your Discord stays yours. Agents simply get a better interface.</p>`,
    },
];

function renderSlide(slide: Slide, index: number): string {
    const dots = slides.map((_, dotIndex) => `<i class="${dotIndex === index ? "active" : ""}"></i>`).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#07101c;color:#f7fbff;font-family:"Segoe UI",Arial,sans-serif}
      body{position:relative;background:radial-gradient(circle at 78% 18%,${slide.accent}20 0,transparent 28%),radial-gradient(circle at 18% 86%,#3557ff18 0,transparent 30%),linear-gradient(135deg,#07101c,#0c1727 55%,#0a1320)}
      body:before{content:"";position:absolute;inset:0;background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);background-size:64px 64px;mask-image:linear-gradient(to bottom,#0008,transparent 88%)}
      .glow{position:absolute;width:620px;height:620px;border-radius:50%;right:-230px;top:-260px;border:1px solid ${slide.accent}40;box-shadow:0 0 160px ${slide.accent}22,inset 0 0 120px ${slide.accent}18}
      .frame{position:relative;width:100%;height:100%;padding:74px 104px 58px;display:flex;flex-direction:column;z-index:1}
      header{display:flex;align-items:center;justify-content:space-between}.brand{display:flex;align-items:center;gap:16px;font-weight:800;letter-spacing:.04em}.brand svg{width:40px;height:40px;color:${slide.accent}}.status{display:flex;align-items:center;gap:12px;color:#a8b6c8;font-size:18px}.status i{width:10px;height:10px;background:#43f0b8;border-radius:50%;box-shadow:0 0 18px #43f0b8}
      main{flex:1;display:flex;flex-direction:column;justify-content:center}.eyebrow{font-size:19px;letter-spacing:.22em;color:${slide.accent};font-weight:800;margin-bottom:20px}.title{font-size:76px;line-height:1.03;letter-spacing:-.045em;margin:0;max-width:1520px}.subtitle{font-size:29px;line-height:1.35;color:#b9c7d8;margin:18px 0 38px;max-width:1400px}.content{min-height:480px;display:flex;flex-direction:column;justify-content:center}
      footer{display:flex;align-items:center;justify-content:space-between;color:#7f91a8;font-size:16px}.dots{display:flex;gap:10px}.dots i{width:24px;height:4px;border-radius:4px;background:#ffffff22}.dots i.active{width:54px;background:${slide.accent};box-shadow:0 0 16px ${slide.accent}88}.page{font-variant-numeric:tabular-nums}
      .hero-lockup{position:absolute;right:170px;top:250px;width:410px;height:410px;display:grid;place-items:center}.hero-icon{width:220px;height:220px;display:grid;place-items:center;border-radius:52px;background:linear-gradient(145deg,${slide.accent}28,#ffffff08);border:1px solid ${slide.accent}66;box-shadow:0 30px 100px #0008,0 0 90px ${slide.accent}22}.hero-icon svg{width:130px;color:${slide.accent}}.orbit{position:absolute;border:1px solid ${slide.accent}44;border-radius:50%}.orbit-one{inset:15px}.orbit-two{inset:-45px;border-style:dashed}.pill-row{display:flex;gap:14px;margin-top:24px}.pill-row span,.subscription-badges span{padding:12px 18px;border-radius:999px;border:1px solid ${slide.accent}55;background:${slide.accent}12;color:#dffaff;font-weight:700;letter-spacing:.08em}.hero-note{font-size:23px;color:#8fa1b6;margin-top:24px;max-width:780px}
      .flow{display:flex;align-items:center;justify-content:center;gap:24px}.flow i{font-size:40px;color:${slide.accent}}.flow-node{width:325px;height:155px;border:1px solid #ffffff1f;border-radius:24px;background:#ffffff0b;display:flex;flex-direction:column;justify-content:center;padding:30px;box-shadow:0 24px 60px #0004}.flow-node b{font-size:29px}.flow-node small{font-size:19px;color:#91a3b7;margin-top:12px}.flow-node.secure{border-color:${slide.accent}77;background:${slide.accent}16}.boundary{height:48px;border-bottom:1px dashed ${slide.accent}55;margin:10px 120px 0;display:flex;justify-content:center}.boundary span{align-self:flex-end;transform:translateY(12px);background:#0a1524;padding:0 18px;color:${slide.accent};font-size:14px;letter-spacing:.18em}.metric-row,.proof-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin:48px auto 0;width:1080px}.metric-row div,.proof-grid div{text-align:center}.metric-row strong,.proof-grid strong{display:block;font-size:46px;color:${slide.accent}}.metric-row span,.proof-grid span{color:#8fa1b5;font-size:17px}
      .tool-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.tool-card{border:1px solid #ffffff1c;background:#ffffff09;border-radius:22px;padding:27px 30px}.tool-card.hot{border-color:${slide.accent}77;background:${slide.accent}12}.tool-card em{font-style:normal;font-size:14px;letter-spacing:.17em;color:${slide.accent};font-weight:800}.tool-card b{display:block;font-size:27px;margin:10px 0}.tool-card p{margin:0;color:#95a6ba;font-size:18px}.big-caption{text-align:center;color:#8fa0b4;font-size:22px;margin-top:22px}.big-caption strong{color:#fff;font-size:30px}.big-caption span{color:${slide.accent};margin:0 12px}
      .subscription-panel{display:flex;align-items:center;justify-content:center;gap:24px}.step{width:390px;height:210px;padding:28px;border-radius:26px;background:#ffffff0a;border:1px solid #ffffff20}.step span{font-size:16px;color:${slide.accent};font-weight:800}.step b{display:block;font-size:36px;margin:19px 0 10px}.step p{color:#96a7ba;font-size:19px;margin:0}.step.pulse{border-color:${slide.accent};box-shadow:0 0 60px ${slide.accent}20}.step-arrow{font-size:42px;color:${slide.accent}}.subscription-badges{display:flex;gap:12px;justify-content:center;margin-top:30px}.subscription-badges span{font-size:15px}.event-code{margin:28px auto 0;border:1px solid #ffffff1c;background:#030a12aa;border-radius:14px;padding:15px 22px;width:max-content;color:#b9c8d9}.event-code i{display:inline-block;width:9px;height:9px;border-radius:50%;background:#43f0b8;margin-right:12px;box-shadow:0 0 16px #43f0b8}.event-code code{font-size:18px}
      .media-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.media-card{height:365px;border:1px solid #ffffff1e;border-radius:28px;background:#ffffff09;padding:30px;display:flex;flex-direction:column;justify-content:flex-end}.media-card h3{font-size:32px;margin:20px 0 8px}.media-card p{color:#91a4b9;font-size:19px;line-height:1.5;margin:0}.mock-image{height:155px;border-radius:18px;background:linear-gradient(145deg,#1e3352,#14233a);position:relative;overflow:hidden}.mock-image:before{content:"";position:absolute;width:240px;height:140px;background:${slide.accent}55;transform:rotate(-16deg);left:-20px;top:75px;border-radius:30px}.mock-image span{position:absolute;width:22px;height:22px;background:#fff9;border-radius:50%;right:32px;top:26px}.wave{height:155px;display:flex;align-items:center;gap:7px;padding:0 8px}.wave i{flex:1;border-radius:8px;background:linear-gradient(to top,${slide.accent},#fff);box-shadow:0 0 12px ${slide.accent}33}.file-icon{height:155px;width:130px;border-radius:24px;border:2px solid ${slide.accent};display:grid;place-items:center;font-size:70px;color:${slide.accent};background:${slide.accent}12}
      .safety-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.safety-card{height:430px;border-radius:28px;padding:34px 42px;border:1px solid #ffffff20;background:#ffffff08}.safety-card.can{border-color:#43f0b866}.safety-card.cannot{border-color:#ff718d66}.safety-card h3{font-size:18px;letter-spacing:.2em;margin:0 0 20px}.can h3{color:#43f0b8}.cannot h3{color:#ff718d}.safety-card ul{padding:0;margin:0;list-style:none}.safety-card li{font-size:23px;padding:13px 0 13px 38px;border-bottom:1px solid #ffffff12;position:relative}.safety-card li:before{position:absolute;left:0;font-weight:900}.can li:before{content:"✓";color:#43f0b8}.cannot li:before{content:"×";color:#ff718d}
      .proof-grid{grid-template-columns:repeat(4,1fr);width:100%;margin-top:5px}.proof-grid div{border:1px solid #ffffff1b;background:#ffffff08;border-radius:20px;padding:25px 12px}.proof-grid strong{font-size:39px}.final-lockup{display:flex;align-items:center;justify-content:center;gap:22px;margin-top:42px}.mini-icon{width:84px;height:84px;border-radius:22px;background:${slide.accent}18;border:1px solid ${slide.accent}66;display:grid;place-items:center}.mini-icon svg{width:50px;color:${slide.accent}}.final-lockup b{display:block;font-size:38px}.final-lockup small{font-size:19px;color:#91a3b7}.final-note{text-align:center;color:#8fa2b7;font-size:21px;margin-top:25px}
    </style></head><body><div class="glow"></div><div class="frame">
      <header><div class="brand">${chatIcon}<span>DISCORD MCP</span></div><div class="status"><i></i>LOCAL BRIDGE ONLINE</div></header>
      <main><div class="eyebrow">${slide.eyebrow}</div><h1 class="title">${slide.title}</h1><p class="subtitle">${slide.subtitle}</p><div class="content">${slide.body}</div></main>
      <footer><span>LAWYERCORD · LOCAL AGENT INTERFACE</span><div class="dots">${dots}</div><span class="page">0${index + 1} / 0${slides.length}</span></footer>
    </div></body></html>`;
}

async function renderSlides(): Promise<string[]> {
    await mkdir(workDirectory, { recursive: true });
    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: ["--disable-gpu", "--hide-scrollbars", "--no-first-run"],
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
        const paths: string[] = [];
        for (let index = 0; index < slides.length; index++) {
            await page.setContent(renderSlide(slides[index], index), { waitUntil: "load" });
            const path = join(workDirectory, `slide-${String(index + 1).padStart(2, "0")}.png`);
            await page.screenshot({ path, type: "png" });
            paths.push(path);
        }
        return paths;
    } finally {
        await browser.close();
    }
}

async function encodeVideo(slidePaths: string[]): Promise<void> {
    const inputArguments = slidePaths.flatMap(path => ["-loop", "1", "-t", String(SLIDE_SECONDS), "-i", path]);
    const normalized = slidePaths.map((_, index) => `[${index}:v]fps=30,format=yuv420p,setsar=1[v${index}]`);
    const transitions: string[] = [];
    let previous = "v0";
    for (let index = 1; index < slidePaths.length; index++) {
        const output = `x${index}`;
        const offset = index * (SLIDE_SECONDS - TRANSITION_SECONDS);
        transitions.push(`[${previous}][v${index}]xfade=transition=fade:duration=${TRANSITION_SECONDS}:offset=${offset.toFixed(2)}[${output}]`);
        previous = output;
    }
    const duration = slidePaths.length * SLIDE_SECONDS - (slidePaths.length - 1) * TRANSITION_SECONDS;
    const filter = [...normalized, ...transitions].join(";");

    await execFileAsync(ffmpegPath, [
        "-y",
        ...inputArguments,
        "-f", "lavfi", "-t", duration.toFixed(2), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-filter_complex", filter,
        "-map", `[${previous}]`,
        "-map", `${slidePaths.length}:a`,
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        "-shortest",
        outputPath,
    ], { maxBuffer: 8 * 1024 * 1024, timeout: 180_000 });
}

async function main() {
    const slidePaths = await renderSlides();
    await encodeVideo(slidePaths);
    const { stdout } = await execFileAsync(ffprobePath, [
        "-v", "error",
        "-show_entries", "format=duration,size:stream=codec_name,width,height,r_frame_rate",
        "-of", "json",
        outputPath,
    ]);
    console.log(JSON.stringify({ outputPath, slides: slidePaths, probe: JSON.parse(stdout) }, null, 2));
}

void main();
