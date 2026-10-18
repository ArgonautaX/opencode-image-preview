import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/** One `[Image N]` placeholder found in the composer text. */
export type ImageToken = { text: string; number: number; start: number; end: number }

/** A previewable span of composer text: an `[Image N]` token or a path to an image file. */
export type ImageTarget = {
  text: string
  start: number
  end: number
  kind: "token" | "path"
  number?: number
  /** Resolved absolute path, only for path targets. */
  path?: string
}

/** A hoverable rectangle over one visible segment of an image target. */
export type ImageZone = ImageTarget & { row: number; col: number; width: number }

const TOKEN = /\[Image (\d+)\]/g

/** Every `[Image N]` token in the text, in order. */
export function findImageTokens(text: string): ImageToken[] {
  const tokens: ImageToken[] = []
  TOKEN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN.exec(text))) {
    tokens.push({
      text: match[0],
      number: Number(match[1]),
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return tokens
}

const PATH = /(?:file:\/\/|~\/|(?<![:/.\w])\/)[^\s]*/g
const TRAILING = /[),.;:!?'"`]+$/

/**
 * Every path to an image file in the text: absolute, `~`-prefixed or a
 * `file://` URL, with trailing punctuation stripped. URLs to other hosts and
 * relative paths are ignored.
 */
export function findImagePaths(text: string): ImageTarget[] {
  const paths: ImageTarget[] = []
  PATH.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PATH.exec(text))) {
    const candidate = match[0].replace(TRAILING, "")
    const path = resolveImagePath(candidate)
    if (!path || !isImagePath(path)) continue
    paths.push({ text: candidate, start: match.index, end: match.index + candidate.length, kind: "path", path })
  }
  return paths
}

/** Every `[Image N]` token and every image path in the text, in order. */
export function findImageTargets(text: string): ImageTarget[] {
  const targets: ImageTarget[] = findImageTokens(text).map((token) => ({
    text: token.text,
    start: token.start,
    end: token.end,
    kind: "token" as const,
    number: token.number,
  }))
  targets.push(...findImagePaths(text))
  return targets.sort((a, b) => a.start - b.start)
}

/**
 * Terminal display width: wide CJK/emoji code points take two cells, everything
 * else one. Good enough for prompt text, which is ASCII most of the time.
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    width +=
      code >= 0x1100 &&
      (code <= 0x115f ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe4f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x20000 && code <= 0x3fffd))
        ? 2
        : 1
  }
  return width
}

/** Snapshot of the composer editor needed to place zones on screen. */
export type ZoneGeometry = {
  text: string
  screenX: number
  screenY: number
  width: number
  height: number
  scrollY: number
  offsetX: number
  lineStartCols: readonly number[]
  lineWidthCols: readonly number[]
  lineSources: readonly number[]
}

/**
 * Screen rectangles for every visible piece of every image target: `[Image N]`
 * tokens and image paths. Targets wrapped across visual lines produce one zone
 * per visible segment; targets scrolled out of the editor are skipped.
 */
export function imageZones(geometry: ZoneGeometry): ImageZone[] {
  const zones: ImageZone[] = []
  const { text, lineSources, lineStartCols, lineWidthCols } = geometry
  if (lineSources.length === 0) return zones

  const lineStarts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1)
  }

  for (const target of findImageTargets(text)) {
    let logical = 0
    for (let index = 0; index < lineStarts.length; index += 1) {
      if (lineStarts[index]! <= target.start) logical = index
    }
    const lineStart = lineStarts[logical]!
    const tokenCol = displayWidth(text.slice(lineStart, target.start))
    const tokenWidth = displayWidth(target.text)

    for (let visual = 0; visual < lineSources.length; visual += 1) {
      if (lineSources[visual] !== logical) continue
      const startCol = lineStartCols[visual] ?? 0
      const endCol = startCol + Math.max(lineWidthCols[visual] ?? 0, 1)
      const from = Math.max(tokenCol, startCol)
      const to = Math.min(tokenCol + tokenWidth, endCol)
      if (to <= from) continue
      const row = geometry.screenY + (visual - geometry.scrollY)
      if (row < geometry.screenY || row >= geometry.screenY + geometry.height) continue
      const col = geometry.screenX + (from - startCol) - geometry.offsetX
      const width = Math.min(to - from, geometry.screenX + geometry.width - col)
      if (width <= 0 || col < geometry.screenX) continue
      zones.push({ ...target, row, col, width })
    }
  }
  return zones
}

/** True when the trimmed text looks like a path to an image file. */
export function isImagePath(value: string): boolean {
  return /\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(value.trim())
}

/**
 * Absolute file path for a pasted or typed image reference: a bare or quoted
 * path, a `~` prefix, or a `file://` URL. Returns undefined for anything else.
 */
export function resolveImagePath(raw: string, home = homedir()): string | undefined {
  let path = raw.trim().replace(/^"(.*)"$/, "$1")
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      return undefined
    }
  }
  if (path === "~") return home
  if (path.startsWith("~/")) path = join(home, path.slice(2))
  if (!path.startsWith("/")) return undefined
  return path
}

/**
 * The image path inside pasted clipboard text: a bare path, a quoted path, a
 * `file://` URL, or a newline separated list of any of those.
 */
export function pathFromText(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const path = resolveImagePath(line)
    if (path && isImagePath(path)) return path
  }
  return undefined
}

export type ClipboardCapture = { kind: "image"; source: string } | { kind: "path"; source: string } | { kind: "none" }

/** Parses the JSON emitted by the macOS capture script. */
export function parseCapture(raw: string): ClipboardCapture {
  try {
    const parsed = JSON.parse(raw) as { kind?: string; b64?: string; text?: string }
    if (parsed.kind === "png" && typeof parsed.b64 === "string" && parsed.b64.length > 0) {
      return { kind: "image", source: `data:image/png;base64,${parsed.b64}` }
    }
    if (parsed.kind === "text" && typeof parsed.text === "string") {
      const source = pathFromText(parsed.text)
      if (source) return { kind: "path", source }
    }
  } catch {}
  return { kind: "none" }
}

/** Human label for the preview card caption. */
export function captionOf(zone: { number?: number; text?: string }, source: string | undefined): string {
  if (zone.number === undefined) {
    const file = source ?? zone.text ?? ""
    return file.split(/[\\/]/).pop() ?? file
  }
  const label = `[Image ${zone.number}]`
  if (!source) return label
  if (source.startsWith("data:")) return `${label} clipboard`
  const name = source.split(/[\\/]/).pop() ?? source
  return `${label} ${name}`
}

/** Runs a command and resolves its stdout, or undefined on error, timeout or empty output. */
function run(command: string, args: string[], timeoutMs = 3000): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] })
    const chunks: Buffer[] = []
    let settled = false
    const finish = (value: Buffer | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(undefined)
    }, timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.on("error", () => finish(undefined))
    child.on("close", (code) => {
      const output = chunks.length > 0 ? Buffer.concat(chunks) : undefined
      finish(code === 0 && output && output.length > 0 ? output : undefined)
    })
  })
}

/**
 * macOS: read the pasteboard as PNG (converting TIFF when needed), or fall back
 * to its text so a pasted image path can be used as the source.
 */
const MACOS_SCRIPT = `
ObjC.import("AppKit");
function run() {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  let data = pasteboard.dataForType("public.png");
  if (data.isNil()) {
    const tiff = pasteboard.dataForType("public.tiff");
    if (!tiff.isNil()) {
      const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
      if (!rep.isNil()) data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
    }
  }
  if (data && !data.isNil()) {
    return JSON.stringify({ kind: "png", b64: ObjC.unwrap(data.base64EncodedStringWithOptions(0)) });
  }
  const text = pasteboard.stringForType("public.utf8-plain-text");
  if (!text.isNil()) return JSON.stringify({ kind: "text", text: ObjC.unwrap(text) });
  return JSON.stringify({ kind: "none" });
}
run();
`

async function captureMacOS(): Promise<string | undefined> {
  const raw = await run("osascript", ["-l", "JavaScript", "-e", MACOS_SCRIPT])
  if (!raw) return undefined
  const capture = parseCapture(raw.toString("utf8"))
  return capture.kind === "none" ? undefined : capture.source
}

async function captureLinux(): Promise<string | undefined> {
  const image =
    (await run("wl-paste", ["--no-newline", "--type", "image/png"])) ??
    (await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]))
  if (image) return `data:image/png;base64,${image.toString("base64")}`
  const text =
    (await run("wl-paste", ["--no-newline"])) ?? (await run("xclip", ["-selection", "clipboard", "-o"]))
  if (!text) return undefined
  return pathFromText(text.toString("utf8"))
}

/**
 * The image that was just pasted, read from the system clipboard while the
 * paste is happening: PNG bytes when the clipboard holds an image, or the file
 * path when the clipboard holds pasted path text.
 */
export async function captureClipboard(): Promise<string | undefined> {
  try {
    if (process.platform === "darwin") return await captureMacOS()
    if (process.platform === "linux") return await captureLinux()
  } catch {}
  return undefined
}

/** File extension for an image MIME type: image/jpeg becomes .jpg. */
export function extensionFor(mime: string): string {
  const subtype = mime.split("/")[1]?.split("+")[0] ?? "png"
  return `.${subtype === "jpeg" ? "jpg" : subtype}`
}

/**
 * The image as a local file so external programs can open it: paths are
 * returned as they are, inline data URIs are written to a temp file named
 * after the payload, so repeated clicks on the same capture reuse one file.
 */
export async function materialize(source: string): Promise<string | undefined> {
  if (!source.startsWith("data:")) return source
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(source)
  if (!match) return undefined
  const [, mime, base64, payload] = match
  if (!payload) return undefined
  const directory = join(tmpdir(), "opencode-image-preview")
  await mkdir(directory, { recursive: true })
  const digest = createHash("sha1").update(payload).digest("hex").slice(0, 12)
  const file = join(directory, `${digest}${extensionFor(mime ?? "image/png")}`)
  await writeFile(file, Buffer.from(payload, base64 ? "base64" : "utf8"))
  return file
}

/**
 * Opens the image in the system viewer, with the same commands better-claude
 * uses: Preview on macOS, Explorer on Windows and xdg-open elsewhere.
 */
export async function openInViewer(source: string): Promise<void> {
  const file = await materialize(source).catch(() => undefined)
  if (!file) return
  const command =
    process.platform === "darwin"
      ? ["open", "-a", "Preview", file]
      : process.platform === "win32"
        ? ["explorer", file]
        : ["xdg-open", file]
  const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore" })
  child.unref()
}

/** Size in bytes and pixel dimensions of an image source. */
export type SourceInfo = { bytes?: number; width?: number; height?: number }

/** Pixel dimensions from the PNG, GIF or JPEG header, when readable. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const isPng = bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (isPng) return { width: view.getUint32(16), height: view.getUint32(20) }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1]!
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
      if (length < 2) return undefined
      offset += 2 + length
    }
  }
  return undefined
}

/** Dimensions and size for the card caption, read lazily when the card opens. */
export async function describeSource(source: string): Promise<SourceInfo> {
  try {
    if (source.startsWith("data:")) {
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(source)
      const payload = match?.[3]
      if (!payload) return {}
      const bytes = Buffer.from(payload, match[2] ? "base64" : "utf8")
      return { bytes: bytes.length, ...imageSize(bytes) }
    }
    const bytes = await readFile(source)
    return { bytes: bytes.length, ...imageSize(bytes) }
  } catch {
    return {}
  }
}

/** Human byte size: `512 B`, `151 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** `1920×1080 · 151 KB`, omitting whatever is unknown. */
export function infoLine(info: SourceInfo): string {
  const parts: string[] = []
  if (info.width && info.height) parts.push(`${info.width}×${info.height}`)
  if (info.bytes !== undefined) parts.push(formatBytes(info.bytes))
  return parts.join(" · ")
}

/** macOS needs a real PNG on the clipboard, so convert anything else first. */
async function toPng(file: string): Promise<string | undefined> {
  if (file.toLowerCase().endsWith(".png")) return file
  const out = `${file}.clipboard.png`
  await run("sips", ["-s", "format", "png", file, "--out", out])
  return existsSync(out) ? out : undefined
}

/** Platform command that puts a PNG file on the system clipboard. */
export function clipboardCommand(file: string, platform = process.platform): string[] | undefined {
  if (platform === "darwin") {
    const escaped = file.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    return ["osascript", "-e", `set the clipboard to (read (POSIX file "${escaped}") as «class PNGf»)`]
  }
  if (platform === "linux") {
    const escaped = file.replace(/'/g, "'\\''")
    return [
      "bash",
      "-c",
      `wl-copy --type image/png < '${escaped}' 2>/dev/null || xclip -selection clipboard -t image/png -i '${escaped}'`,
    ]
  }
  if (platform === "win32") return ["powershell", "-NoProfile", "-Command", `Set-Clipboard -Path "${file}"`]
  return undefined
}

/** Copies the image to the system clipboard. */
export async function copyImageToClipboard(source: string): Promise<boolean> {
  const file = await materialize(source).catch(() => undefined)
  if (!file) return false
  const target = process.platform === "darwin" ? await toPng(file).catch(() => undefined) : file
  if (!target) return false
  const command = clipboardCommand(target)
  if (!command) return false
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "ignore" })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
  })
}
