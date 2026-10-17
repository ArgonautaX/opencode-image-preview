import { describe, expect, test } from "bun:test"
import { captionOf, messageImages, pendingImages, sessionImages, type SessionImage } from "../src/images"

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PNG_URI = `data:image/png;base64,${PNG_DATA}`

type FakeInput = {
  pending?: unknown[]
  messages?: unknown[]
}

const context = (input: FakeInput) =>
  ({
    data: {
      session: {
        pending: { list: () => input.pending ?? [] },
        message: { list: () => input.messages ?? [] },
      },
    },
  }) as never

describe("pendingImages", () => {
  test("reads user inbox attachments and numbers them", () => {
    const images = pendingImages(
      context({
        pending: [
          {
            type: "user",
            id: "inbox_1",
            payload: { text: "", files: [{ data: PNG_DATA, mime: "image/png", name: "a.png", source: { type: "inline" } }] },
          },
          { type: "compaction", payload: {} },
        ],
      }),
      "ses_1",
    )
    expect(images).toHaveLength(1)
    expect(images[0]!.number).toBe(1)
    expect(images[0]!.queued).toBe(true)
    expect(images[0]!.source).toBe(PNG_URI)
    expect(images[0]!.name).toBe("a.png")
  })

  test("keeps a data URI untouched and skips non-image files", () => {
    const images = pendingImages(
      context({
        pending: [
          {
            type: "user",
            id: "inbox_2",
            payload: {
              text: "",
              files: [
                { data: PNG_URI, mime: "image/png", source: { type: "inline" } },
                { data: "hello", mime: "text/plain", source: { type: "inline" } },
              ],
            },
          },
        ],
      }),
      "ses_1",
    )
    expect(images).toHaveLength(1)
    expect(images[0]!.source).toBe(PNG_URI)
  })
})

describe("messageImages", () => {
  test("reads sent user attachments and tool file results", () => {
    const images = messageImages(
      context({
        messages: [
          {
            type: "user",
            id: "msg_1",
            files: [{ data: PNG_DATA, mime: "image/png", name: "shot.png", source: { type: "inline" } }],
          },
          {
            type: "assistant",
            id: "msg_2",
            content: [
              { type: "text", text: "done" },
              {
                type: "tool",
                id: "tool_1",
                state: {
                  status: "completed",
                  content: [
                    { type: "file", uri: "file:///tmp/out.png", mime: "image/png", name: "out.png" },
                    { type: "file", uri: "file:///tmp/log.txt", mime: "text/plain" },
                  ],
                },
              },
              { type: "tool", id: "tool_2", state: { status: "running", content: [] } },
            ],
          },
        ],
      }),
      "ses_1",
    )
    expect(images).toHaveLength(2)
    expect(images[0]!.source).toBe(PNG_URI)
    expect(images[0]!.queued).toBe(false)
    expect(images[1]!.source).toBe("/tmp/out.png")
    expect(images[1]!.name).toBe("out.png")
  })

  test("resolves uri-sourced attachments to local paths", () => {
    const images = messageImages(
      context({
        messages: [
          {
            type: "user",
            id: "msg_3",
            files: [{ data: "", mime: "image/jpeg", source: { type: "uri", uri: "file:///Users/me/photo.jpg" } }],
          },
        ],
      }),
      "ses_1",
    )
    expect(images).toHaveLength(1)
    expect(images[0]!.source).toBe("/Users/me/photo.jpg")
  })
})

describe("sessionImages", () => {
  test("orders queued first, dedupes and numbers sequentially", () => {
    const images = sessionImages(
      context({
        pending: [
          {
            type: "user",
            id: "inbox_1",
            payload: { text: "", files: [{ data: PNG_DATA, mime: "image/png", source: { type: "inline" } }] },
          },
        ],
        messages: [
          {
            type: "user",
            id: "msg_1",
            files: [{ data: PNG_DATA, mime: "image/png", source: { type: "inline" } }],
          },
          {
            type: "user",
            id: "msg_2",
            files: [{ data: PNG_URI.replace("iVBOR", "JVBER"), mime: "image/png", source: { type: "inline" } }],
          },
        ],
      }),
      "ses_1",
    )
    expect(images.map((image: SessionImage) => image.number)).toEqual([1, 2])
    expect(images[0]!.queued).toBe(true)
    expect(images[1]!.queued).toBe(false)
  })
})

describe("captionOf", () => {
  test("formats number, mime and name", () => {
    expect(
      captionOf({ key: "k", number: 3, mime: "image/png", name: "shot.png", source: PNG_URI, queued: false }),
    ).toBe("[Image #3] PNG · shot.png")
    expect(captionOf({ key: "k", number: 1, mime: "image/jpeg", source: PNG_URI, queued: false })).toBe(
      "[Image #1] JPEG",
    )
  })
})
