import { spawn } from "node:child_process"

/** One `[Image N]` placeholder found in the composer text. */
export type ImageToken = { text: string; number: number; start: number; end: number }

/** A hoverable rectangle over one visible segment of an `[Image N]` token. */
export type ImageZone = ImageToken & { row: number; col: number; width: number }

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
 * Screen rectangles for every visible piece of every `[Image N]` token.
 * Tokens wrapped across visual lines produce one zone per visible segment;
 * tokens scrolled out of the editor are skipped.
 */
export function imageZones(geometry: ZoneGeometry): ImageZone[] {
  const zones: ImageZone[] = []
  const { text, lineSources, lineStartCols, lineWidthCols } = geometry
  if (lineSources.length === 0) return zones

  const lineStarts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1)
  }

  for (const token of findImageTokens(text)) {
    let logical = 0
    for (let index = 0; index < lineStarts.length; index += 1) {
      if (lineStarts[index]! <= token.start) logical = index
    }
    const lineStart = lineStarts[logical]!
    const tokenCol = displayWidth(text.slice(lineStart, token.start))
    const tokenWidth = displayWidth(token.text)

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
      zones.push({ ...token, row, col, width })
    }
  }
  return zones
}

/** True when the trimmed text looks like a path to an image file. */
export function isImagePath(value: string): boolean {
  return /\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(value.trim())
}

/**
 * The image path inside pasted clipboard text: a bare path, a quoted path, a
 * `file://` URL, or a newline separated list of any of those.
 */
export function pathFromText(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim().replace(/^"(.*)"$/, "$1")
    if (!candidate) continue
    let path = candidate
    if (candidate.startsWith("file://")) {
      try {
        path = decodeURIComponent(new URL(candidate).pathname)
      } catch {
        continue
      }
    }
    if (isImagePath(path)) return path
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
export function captionOf(zone: { number: number }, source: string | undefined): string {
  if (!source) return `[Image ${zone.number}]`
  if (source.startsWith("data:")) return `[Image ${zone.number}] clipboard`
  const name = source.split(/[\\/]/).pop() ?? source
  return `[Image ${zone.number}] ${name}`
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
