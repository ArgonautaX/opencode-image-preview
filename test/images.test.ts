import { describe, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import {
  captionOf,
  clipboardCommand,
  describeSource,
  displayWidth,
  extensionFor,
  findImagePaths,
  findImageTargets,
  findImageTokens,
  formatBytes,
  imageSize,
  imageZones,
  infoLine,
  isImagePath,
  materialize,
  parseCapture,
  pathFromText,
  resolveImagePath,
  type ZoneGeometry,
} from "../src/images"

const PNG_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const geometry = (overrides: Partial<ZoneGeometry>): ZoneGeometry => ({
  text: "",
  screenX: 10,
  screenY: 5,
  width: 80,
  height: 3,
  scrollY: 0,
  offsetX: 0,
  lineStartCols: [0],
  lineWidthCols: [0],
  lineSources: [0],
  ...overrides,
})

describe("findImageTokens", () => {
  test("finds a single token with its offsets", () => {
    expect(findImageTokens("hello [Image 1] world")).toEqual([
      { text: "[Image 1]", number: 1, start: 6, end: 15 },
    ])
  })

  test("finds several tokens in order", () => {
    const tokens = findImageTokens("[Image 1] and [Image 2]")
    expect(tokens.map((token) => token.number)).toEqual([1, 2])
    expect(tokens[1]!.start).toBe(14)
  })

  test("ignores lookalikes and malformed tokens", () => {
    expect(findImageTokens("[Image ] [Image one] image 1 [Image 12x]")).toEqual([])
  })

  test("handles multi-digit numbers", () => {
    expect(findImageTokens("[Image 12]")[0]!.number).toBe(12)
  })
})

describe("displayWidth", () => {
  test("counts ascii characters as one cell", () => {
    expect(displayWidth("[Image 1]")).toBe(9)
  })

  test("counts wide characters as two cells", () => {
    expect(displayWidth("日本語")).toBe(6)
    expect(displayWidth("a日b")).toBe(4)
  })
})

describe("imageZones", () => {
  test("places a token on the editor's first row", () => {
    const zones = imageZones(geometry({ text: "[Image 1] hello", lineWidthCols: [14] }))
    expect(zones).toEqual([
      { text: "[Image 1]", number: 1, start: 0, end: 9, kind: "token", row: 5, col: 10, width: 9 },
    ])
  })

  test("offsets columns by the text before the token", () => {
    const zones = imageZones(geometry({ text: "look: [Image 1]", lineWidthCols: [15] }))
    expect(zones[0]!.col).toBe(16)
  })

  test("splits a token wrapped across two visual lines", () => {
    const zones = imageZones(
      geometry({
        text: "aaaaa[Image 1]bbb",
        lineStartCols: [0, 12],
        lineWidthCols: [12, 6],
        lineSources: [0, 0],
      }),
    )
    expect(zones).toHaveLength(2)
    expect(zones[0]!).toMatchObject({ row: 5, col: 15, width: 7 })
    expect(zones[1]!).toMatchObject({ row: 6, col: 10, width: 2 })
  })

  test("maps tokens on later logical lines through lineSources", () => {
    const zones = imageZones(
      geometry({
        text: "first\nsecond [Image 3]",
        lineStartCols: [0, 0],
        lineWidthCols: [5, 17],
        lineSources: [0, 1],
      }),
    )
    expect(zones[0]!).toMatchObject({ row: 6, col: 17, width: 9 })
  })

  test("skips tokens scrolled out of the editor", () => {
    const zones = imageZones(
      geometry({
        text: "[Image 1]\nsecond",
        height: 1,
        scrollY: 1,
        lineStartCols: [0, 0],
        lineWidthCols: [9, 6],
        lineSources: [0, 1],
      }),
    )
    expect(zones).toEqual([])
  })

  test("clamps the zone to the editor's right edge", () => {
    const zones = imageZones(
      geometry({
        text: "[Image 1]",
        width: 5,
        lineWidthCols: [9],
      }),
    )
    expect(zones[0]!.width).toBe(5)
  })

  test("returns nothing without tokens", () => {
    expect(imageZones(geometry({ text: "just text" }))).toEqual([])
  })
})

describe("isImagePath", () => {
  test("accepts common image extensions case-insensitively", () => {
    expect(isImagePath("/tmp/shot.png")).toBe(true)
    expect(isImagePath("/tmp/SHOT.JPG")).toBe(true)
    expect(isImagePath("/tmp/pic.webp")).toBe(true)
  })

  test("rejects other files and plain text", () => {
    expect(isImagePath("/tmp/notes.txt")).toBe(false)
    expect(isImagePath("hello world")).toBe(false)
  })
})

describe("pathFromText", () => {
  test("accepts a bare path and a quoted path", () => {
    expect(pathFromText("/tmp/shot.png")).toBe("/tmp/shot.png")
    expect(pathFromText('"/tmp/my shot.png"')).toBe("/tmp/my shot.png")
  })

  test("decodes file URLs and picks the first image line", () => {
    expect(pathFromText("file:///tmp/a%20b.png")).toBe("/tmp/a b.png")
    expect(pathFromText("/tmp/notes.txt\n/tmp/photo.jpeg")).toBe("/tmp/photo.jpeg")
  })

  test("returns undefined when no line looks like an image", () => {
    expect(pathFromText("hello\nworld")).toBeUndefined()
  })
})

describe("parseCapture", () => {
  test("turns png payloads into a data URI", () => {
    const capture = parseCapture(JSON.stringify({ kind: "png", b64: "AAAA" }))
    expect(capture).toEqual({ kind: "image", source: "data:image/png;base64,AAAA" })
  })

  test("turns clipboard text into a file source when it is an image path", () => {
    const capture = parseCapture(JSON.stringify({ kind: "text", text: "/tmp/shot.png" }))
    expect(capture).toEqual({ kind: "path", source: "/tmp/shot.png" })
  })

  test("reports none for unusable payloads", () => {
    expect(parseCapture(JSON.stringify({ kind: "text", text: "hello" }))).toEqual({ kind: "none" })
    expect(parseCapture(JSON.stringify({ kind: "none" }))).toEqual({ kind: "none" })
    expect(parseCapture("not json")).toEqual({ kind: "none" })
  })
})

describe("captionOf", () => {
  test("labels clipboard images and file paths", () => {
    expect(captionOf({ number: 2 }, "data:image/png;base64,AAAA")).toBe("[Image 2] clipboard")
    expect(captionOf({ number: 3 }, "/tmp/my shot.png")).toBe("[Image 3] my shot.png")
    expect(captionOf({ number: 1 }, undefined)).toBe("[Image 1]")
  })

  test("labels path targets by file name", () => {
    expect(captionOf({ text: "~/shots/a.png" }, "/home/me/shots/a.png")).toBe("a.png")
  })
})

describe("extensionFor", () => {
  test("maps mime types to file extensions", () => {
    expect(extensionFor("image/png")).toBe(".png")
    expect(extensionFor("image/jpeg")).toBe(".jpg")
    expect(extensionFor("image/svg+xml")).toBe(".svg")
  })

  test("falls back to .png without a usable subtype", () => {
    expect(extensionFor("image")).toBe(".png")
  })
})

describe("materialize", () => {
  test("returns file paths untouched", async () => {
    expect(await materialize("/tmp/shot.png")).toBe("/tmp/shot.png")
  })

  test("writes an inline image to a temp file, reusing it per payload", async () => {
    const source = `data:image/png;base64,${PNG_DATA}`
    const file = await materialize(source)
    expect(file?.endsWith(".png")).toBe(true)
    expect(file !== undefined && existsSync(file)).toBe(true)
    expect(await materialize(source)).toBe(file)
    if (file) rmSync(file, { force: true })
  })

  test("rejects malformed or empty data URIs", async () => {
    expect(await materialize("data:image/png;base64")).toBeUndefined()
    expect(await materialize("data:image/png;base64,")).toBeUndefined()
  })
})

describe("resolveImagePath", () => {
  test("resolves bare, quoted and file URL paths", () => {
    expect(resolveImagePath("/tmp/shot.png")).toBe("/tmp/shot.png")
    expect(resolveImagePath('"/tmp/my shot.png"')).toBe("/tmp/my shot.png")
    expect(resolveImagePath("file:///tmp/a%20b.png")).toBe("/tmp/a b.png")
  })

  test("expands the home shortcut", () => {
    expect(resolveImagePath("~/shots/a.png", "/home/me")).toBe("/home/me/shots/a.png")
    expect(resolveImagePath("~", "/home/me")).toBe("/home/me")
  })

  test("rejects relative paths and broken URLs", () => {
    expect(resolveImagePath("shots/a.png")).toBeUndefined()
    expect(resolveImagePath("file://%zz")).toBeUndefined()
  })
})

describe("findImagePaths", () => {
  test("finds absolute paths and strips trailing punctuation", () => {
    const paths = findImagePaths("see (/tmp/shot.png) and /tmp/other.jpg.")
    expect(paths.map((target) => ({ text: target.text, path: target.path }))).toEqual([
      { text: "/tmp/shot.png", path: "/tmp/shot.png" },
      { text: "/tmp/other.jpg", path: "/tmp/other.jpg" },
    ])
  })

  test("resolves home and file URL paths", () => {
    const [home, file] = findImagePaths("~/pics/a.png file:///tmp/b%20c.webp")
    expect(home!.path?.endsWith("/pics/a.png")).toBe(true)
    expect(file!.path).toBe("/tmp/b c.webp")
  })

  test("ignores URLs, relative paths and other files", () => {
    expect(findImagePaths("https://x.com/a.png shots/a.png /tmp/notes.txt")).toEqual([])
  })
})

describe("findImageTargets", () => {
  test("mixes tokens and paths in text order", () => {
    const targets = findImageTargets("[Image 2] then /tmp/a.png")
    expect(targets.map((target) => target.kind)).toEqual(["token", "path"])
    expect(targets[0]!.number).toBe(2)
    expect(targets[1]!.path).toBe("/tmp/a.png")
  })
})

describe("imageSize", () => {
  test("reads PNG dimensions", () => {
    expect(imageSize(Buffer.from(PNG_DATA, "base64"))).toEqual({ width: 1, height: 1 })
  })

  test("reads GIF dimensions", () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x03, 0x00, 0x02, 0x00])
    expect(imageSize(gif)).toEqual({ width: 3, height: 2 })
  })

  test("reads JPEG dimensions from the frame header", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03])
    expect(imageSize(jpeg)).toEqual({ width: 3, height: 2 })
  })

  test("returns undefined for unknown formats", () => {
    expect(imageSize(Buffer.from("not an image at all"))).toBeUndefined()
  })
})

describe("describeSource", () => {
  test("measures an inline capture", async () => {
    const info = await describeSource(`data:image/png;base64,${PNG_DATA}`)
    expect(info).toEqual({ bytes: Buffer.from(PNG_DATA, "base64").length, width: 1, height: 1 })
  })

  test("measures a file and tolerates missing ones", async () => {
    const file = await materialize(`data:image/png;base64,${PNG_DATA}`)
    expect(await describeSource(file!)).toMatchObject({ width: 1, height: 1 })
    expect(await describeSource("/tmp/does-not-exist-opencode.png")).toEqual({})
    if (file) rmSync(file, { force: true })
  })
})

describe("formatBytes", () => {
  test("scales to B, KB and MB", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(151 * 1024)).toBe("151 KB")
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB")
  })
})

describe("infoLine", () => {
  test("joins dimensions and size, omitting unknowns", () => {
    expect(infoLine({ width: 1920, height: 1080, bytes: 151 * 1024 })).toBe("1920×1080 · 151 KB")
    expect(infoLine({ bytes: 512 })).toBe("512 B")
    expect(infoLine({})).toBe("")
  })
})

describe("clipboardCommand", () => {
  test("uses osascript for a PNG on macOS", () => {
    const command = clipboardCommand("/tmp/a.png", "darwin")!
    expect(command[0]).toBe("osascript")
    expect(command.join(" ")).toContain("/tmp/a.png")
  })

  test("uses wl-copy and xclip on Linux and Set-Clipboard on Windows", () => {
    expect(clipboardCommand("/tmp/a.png", "linux")!.join(" ")).toContain("wl-copy")
    expect(clipboardCommand("/tmp/a.png", "linux")!.join(" ")).toContain("xclip")
    expect(clipboardCommand("/tmp/a.png", "win32")!.join(" ")).toContain("Set-Clipboard")
  })

  test("returns undefined on unknown platforms", () => {
    expect(clipboardCommand("/tmp/a.png", "aix")).toBeUndefined()
  })
})
