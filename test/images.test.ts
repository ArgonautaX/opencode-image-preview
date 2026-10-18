import { describe, expect, test } from "bun:test"
import {
  captionOf,
  displayWidth,
  findImageTokens,
  imageZones,
  isImagePath,
  parseCapture,
  pathFromText,
  type ZoneGeometry,
} from "../src/images"

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
    expect(zones).toEqual([{ text: "[Image 1]", number: 1, start: 0, end: 9, row: 5, col: 10, width: 9 }])
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
})
