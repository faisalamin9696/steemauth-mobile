/* global __dirname, Buffer */
/**
 * Generate every brand drawable from ONE source:
 * assets/images/logo-source.png — the SteemAuth artwork (phone + QR + shield
 * with the Steem mark), 1254² RGBA on transparency.
 *
 *   npm run brand:assets
 *
 * Background choice: the artwork is blue-on-white, so on a bright blue field
 * its blues melt into the field and on white its phone screen disappears.
 * A deep navy gradient (#0B2A6B -> #071B45) separates BOTH the white screen
 * and the blue elements — it is the treatment used for icon/favicon/mark, and
 * the launcher/splash background matches it (app.json).
 *
 * Outputs:
 *   icon.png                    1024² store/web icon (navy + artwork)
 *   android-icon-background.png  512² adaptive background (navy gradient)
 *   android-icon-foreground.png  512² adaptive foreground: artwork only,
 *                               66% of the canvas (inside the 66/108dp safe
 *                               zone, so circles/squircles never clip it)
 *   android-icon-monochrome.png  512² Android 13+ themed icon: SOLID white
 *                               silhouette, placed identically to the
 *                               foreground (a grey/soft one tints dim)
 *   splash-icon.png             512² artwork only, for the navy splash
 *   favicon.png                 48²
 *
 * Plus — when android/ exists — every native res drawable is regenerated
 * IN PLACE at its existing per-density size (launcher webp layers + splash
 * pngs), so the installed icon can never drift from this source.
 *
 * Sizes are chosen for Android's density buckets (432-512 covers xxxhdpi) and
 * the artwork is only ever DOWNSCALED from 1254², so nothing is upscaled soft.
 */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const IMG = path.join(ROOT, "assets", "images");
const SOURCE = path.join(IMG, "logo-source.png");

const NAVY = ["#0B2A6B", "#071B45"];
/** Fraction of the canvas the artwork occupies. */
const ICON_ART = 0.84; // full-bleed icon/mark: generous but never touching edges
const SAFE_ART = 0.66; // adaptive foreground: must live inside the safe zone
const SPLASH_ART = 0.55; // splash: smaller, centered on the background colour

function svgRect(size, from, to) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
      `</linearGradient></defs>` +
      `<rect width="${size}" height="${size}" fill="url(#g)"/></svg>`,
  );
}

/** Transparent `size`² canvas with the artwork centred at `fraction` of it. */
async function artLayer(size, fraction) {
  const target = Math.round(size * fraction);
  const art = await sharp(SOURCE)
    .resize(target, target, { kernel: "lanczos3" })
    .png()
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: art, gravity: "centre" }])
    .png()
    .toBuffer();
}

/** Artwork on the navy treatment — icon, mark, favicon. */
async function iconTile(size) {
  const bg = await sharp(svgRect(size, NAVY[0], NAVY[1])).png().toBuffer();
  const layer = await artLayer(size, ICON_ART);
  return sharp(bg).composite([{ input: layer }]).png().toBuffer();
}

/** Solid-white silhouette of the artwork, same placement as the foreground. */
async function monochrome(size) {
  const layer = await artLayer(size, SAFE_ART);
  const { data, info } = await sharp(layer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = 255;
    out[i + 1] = 255;
    out[i + 2] = 255;
    out[i + 3] = data[i + 3];
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Image width straight from the file header (PNG IHDR / WebP VP8, VP8L,
 * VP8X). Deliberately NOT sharp().metadata(): libvips keeps the file handle
 * open afterwards, which on Windows locks the very file this script is about
 * to replace (EPERM/EBUSY on rename).
 */
function imageWidth(file) {
  const b = fs.readFileSync(file);
  if (b.length > 24 && b.slice(1, 4).toString() === "PNG") {
    return b.readUInt32BE(16);
  }
  if (b.length > 30 && b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP") {
    const four = b.slice(12, 16).toString();
    if (four === "VP8X") return b.readUIntLE(24, 3) + 1;
    if (four === "VP8 ") return b.readUInt16LE(26) & 0x3fff;
    if (four === "VP8L") return 1 + (((b[22] & 0x3f) << 8) | b[21]);
  }
  throw new Error(`unsupported image for size probe: ${file}`);
}

/**
 * Windows can hold a transient lock on a just-written file (explorer
 * thumbnails, antivirus) — rename with a short synchronous backoff instead
 * of failing the whole run.
 */
function replaceFile(tmp, file) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch {
      if (i >= 8) {
        // Last resort: the .new file already holds the correct bytes — a
        // copy over usually succeeds once the transient reader releases.
        fs.copyFileSync(tmp, file);
        fs.unlinkSync(tmp);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1));
    }
  }
}

/**
 * Regenerate the NATIVE Android res drawables in place — the launcher webp
 * layers (legacy + adaptive background/foreground/monochrome) and the splash
 * pngs — each at the size the file already has, so density buckets and the
 * manifest never change. Skipped silently when android/ has not been
 * prebuilt yet.
 */
async function androidRes(report) {
  const RES = path.join(ROOT, "android", "app", "src", "main", "res");
  if (!fs.existsSync(RES)) return;
  const generators = {
    "ic_launcher.webp": (s) => iconTile(s),
    "ic_launcher_round.webp": (s) => iconTile(s),
    "ic_launcher_background.webp": (s) =>
      sharp(svgRect(s, NAVY[0], NAVY[1])).png().toBuffer(),
    "ic_launcher_foreground.webp": (s) => artLayer(s, SAFE_ART),
    "ic_launcher_monochrome.webp": (s) => monochrome(s),
    "splashscreen_logo.png": (s) => artLayer(s, SPLASH_ART),
  };
  for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
    for (const prefix of ["mipmap", "drawable"]) {
      const dir = path.join(RES, `${prefix}-${density}`);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const generate = generators[name];
        if (!generate) continue;
        const file = path.join(dir, name);
        const width = imageWidth(file); // header parse — sharp would lock it
        const tmp = `${file}.new`; // never read+write the same path
        // explicit format: the .new suffix carries no extension to infer from
        await sharp(await generate(width))
          .toFormat(path.extname(name).slice(1))
          .toFile(tmp);
        replaceFile(tmp, file);
        report.push(`  res/${prefix}-${density}/${name.padEnd(28)}${width}x${width}`);
      }
    }
  }
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`missing source logo: ${SOURCE}`);
  }
  fs.mkdirSync(IMG, { recursive: true });

  const jobs = [
    ["icon.png", iconTile(1024)],
    ["android-icon-background.png", sharp(svgRect(512, NAVY[0], NAVY[1])).png().toBuffer()],
    ["android-icon-foreground.png", artLayer(512, SAFE_ART)],
    ["android-icon-monochrome.png", monochrome(512)],
    ["splash-icon.png", artLayer(512, SPLASH_ART)],
    ["favicon.png", iconTile(48)],
  ];

  const report = [`source: ${SOURCE}`];
  for (const [name, promise] of jobs) {
    const buf = await promise;
    await sharp(buf).png().toFile(path.join(IMG, name));
    const m = await sharp(path.join(IMG, name)).metadata();
    const kb = (fs.statSync(path.join(IMG, name)).size / 1024).toFixed(1);
    report.push(`  ${name.padEnd(34)}${m.width}x${m.height}  ${kb} KB`);
  }
  await androidRes(report);
  console.log(report.join("\n"));
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
