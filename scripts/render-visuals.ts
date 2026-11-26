// Re-exports every visual in assets/ from its source.
//   bun scripts/render-visuals.ts
// Layouts live in assets/src/*.html (fonts load from Google Fonts, so this needs network).
// The Even Hub icon is generated pixel by pixel, no browser involved.
import { chromium, type Page } from "playwright";
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const at = (p: string) => resolve(root, p);

// ---------- Even Hub icon (greyscale, 24×24) ----------

const CELLS: [number, number, number][] = [
  [0, 0, 1], [2, 0, 0.6], [1, 1, 0.6], [2, 1, 0.45], [3, 1, 0.3],
  [0, 2, 0.6], [1, 2, 0.45], [2, 2, 0.3], [3, 2, 0.15], [1, 3, 0.3], [2, 3, 1],
];
const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

export function evenHubMask(): boolean[][] {
  const lit = Array.from({ length: 24 }, () => Array<boolean>(24).fill(false));
  for (const [col, row, opacity] of CELLS) {
    for (let dy = 0; dy < 5; dy++) {
      for (let dx = 0; dx < 5; dx++) {
        const x = 2 + col * 5 + dx;
        const y = 2 + row * 5 + dy;
        lit[y][x] = opacity >= 1 || opacity * 16 > BAYER4[y % 4][x % 4] + 0.5;
      }
    }
  }
  return lit;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
// Greyscale + alpha PNG (colour type 4). pixels[y][x] = [grey, alpha].
function encodeGreyAlphaPng(pixels: [number, number][][]): Buffer {
  const h = pixels.length, w = pixels[0].length;
  const raw = Buffer.alloc(h * (1 + w * 2));
  pixels.forEach((row, y) => {
    const o = y * (1 + w * 2);
    raw[o] = 0; // filter: none
    row.forEach(([g, a], x) => { raw[o + 1 + x * 2] = g; raw[o + 2 + x * 2] = a; });
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 4; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array()),
  ]);
}

function write(path: string, data: Buffer) {
  mkdirSync(dirname(at(path)), { recursive: true });
  writeFileSync(at(path), data);
  console.log(`${path}  ${(statSync(at(path)).size / 1024).toFixed(1)} KB`);
}

const mask = evenHubMask();
write("assets/evenhub-icon-fg.png", encodeGreyAlphaPng(mask.map((r) => r.map((on) => (on ? [255, 255] : [0, 0])))));
write("assets/evenhub-icon-bg.png", encodeGreyAlphaPng(mask.map((r) => r.map(() => [0, 255]))));

// ---------- Browser renders ----------

const browser = await chromium.launch();

async function shoot(page: Page, path: string, transparent = false) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  mkdirSync(dirname(at(path)), { recursive: true });
  await page.screenshot({ path: at(path), omitBackground: transparent });
  console.log(`${path}  ${(statSync(at(path)).size / 1024).toFixed(1)} KB`);
}

async function layout(src: string, width: number, height: number, out: string) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`file://${at(src)}`);
  await shoot(page, out);
  await page.close();
}

async function icon(svg: string, size: number, out: string) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.goto(`file://${at("assets/src/social.html")}`); // any file:// HTML page, so the img may load a local file
  await page.setContent(
    `<style>*{margin:0}html,body{background:transparent}</style><img src="file://${at(svg)}" width="${size}" height="${size}" style="display:block">`,
  );
  await shoot(page, out, true);
  await page.close();
}

await icon("assets/app-icon-dark.svg", 512, "assets/app-icon-512.png");
await icon("assets/app-icon-green.svg", 512, "assets/app-icon-green-512.png");
await icon("assets/app-icon-dark.svg", 32, "glasses/public/favicon-32.png");
await icon("assets/app-icon-dark.svg", 180, "glasses/public/apple-touch-icon.png");

await layout("assets/src/social.html", 1280, 640, "assets/social-preview.png");
await layout("assets/src/social.html", 1280, 640, "assets/readme-hero.png");
await layout("assets/src/opening.html", 1920, 1080, "assets/video/opening.png");
await layout("assets/src/research.html", 1920, 1080, "assets/video/research.png");
await layout("assets/src/end.html", 1920, 1080, "assets/video/end.png");
await layout("assets/src/scenes.html", 1920, 1080, "assets/scenes.png");

await browser.close();
