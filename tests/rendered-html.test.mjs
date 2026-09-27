import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const outDir = join(process.cwd(), "out");

function readOutFile(path) {
  return readFileSync(join(outDir, path), "utf8");
}

test("static export emits the installable app shell", () => {
  const html = readOutFile("index.html");

  assert.match(html, /Friction Vault/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /apple-touch-icon\.png/);
  assert.match(html, /\/_next\/static\//);

  for (const path of [
    "manifest.webmanifest",
    "sw.js",
    "icon-192.png",
    "icon-512.png",
    "icon-512-maskable.png",
    "apple-touch-icon.png",
    "favicon.png",
    "og.png",
  ]) {
    const fullPath = join(outDir, path);
    assert.equal(existsSync(fullPath), true, `${path} should exist`);
    assert.ok(statSync(fullPath).size > 0, `${path} should not be empty`);
  }
});

test("manifest and service worker use relative scope-safe URLs", () => {
  const manifest = JSON.parse(readOutFile("manifest.webmanifest"));
  const worker = readOutFile("sw.js");

  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.id, "./");
  assert.ok(
    manifest.icons.every((icon) => icon.src.startsWith("./")),
    "icons should resolve under the installed app scope",
  );
  assert.match(worker, /self\.registration\.scope/);
  assert.match(worker, /CACHE_SHELL/);
});

