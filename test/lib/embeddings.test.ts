import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { embedBatch, BATCH_SIZE } from "../../src/lib/embeddings";

// We mock fetch to avoid hitting Ollama in tests
const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, opts: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = mock(handler as typeof fetch) as unknown as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function fakeEmbedding(dims: number = 1024): number[] {
  return Array.from({ length: dims }, () => Math.random());
}

function ollamaResponse(count: number) {
  return Response.json({
    embeddings: Array.from({ length: count }, () => fakeEmbedding()),
  });
}

function ollamaError(error: string) {
  return Response.json({ error });
}

describe("embedBatch", () => {
  beforeEach(() => {
    restoreFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it("should not send texts longer than 4000 chars to Ollama", async () => {
    const sentTexts: string[][] = [];

    mockFetch(async (_url, opts) => {
      const body = JSON.parse(opts.body as string);
      sentTexts.push(body.input);
      return ollamaResponse(body.input.length);
    });

    const shortText = "hello world";
    const longText = "x".repeat(5000);

    const results = await embedBatch([shortText, longText]);

    // Both should get embeddings
    expect(results).toHaveLength(2);

    // All texts sent to Ollama should be <= 4000 chars
    for (const batch of sentTexts) {
      for (const text of batch) {
        expect(text.length).toBeLessThanOrEqual(4000);
      }
    }
  });

  it("should not send texts longer than CHUNK_THRESHOLD to Ollama", async () => {
    const sentTexts: string[][] = [];

    mockFetch(async (_url, opts) => {
      const body = JSON.parse(opts.body as string);
      sentTexts.push(body.input);
      return ollamaResponse(body.input.length);
    });

    // 50K char message — should be truncated before sending
    const hugeText = "word ".repeat(10000);
    const results = await embedBatch([hugeText]);

    expect(results).toHaveLength(1);

    for (const batch of sentTexts) {
      for (const text of batch) {
        expect(text.length).toBeLessThanOrEqual(4000);
      }
    }
  });

  it("should not send multi-megabyte messages to Ollama", async () => {
    let totalPayloadSize = 0;

    mockFetch(async (_url, opts) => {
      const bodyStr = opts.body as string;
      totalPayloadSize += bodyStr.length;
      const body = JSON.parse(bodyStr);
      return ollamaResponse(body.input.length);
    });

    // Simulate the real-world case: messages up to 7MB
    const texts = [
      "short message",
      "a".repeat(100_000),   // 100KB
      "b".repeat(1_000_000), // 1MB
    ];

    await embedBatch(texts);

    // Total payload to Ollama should be reasonable (not megabytes)
    expect(totalPayloadSize).toBeLessThan(100_000);
  });

  it("should truncate long texts but still return embeddings for them", async () => {
    mockFetch(async (_url, opts) => {
      const body = JSON.parse(opts.body as string);
      return ollamaResponse(body.input.length);
    });

    const texts = [
      "short",
      "x".repeat(50_000),
    ];

    const results = await embedBatch(texts);

    expect(results).toHaveLength(2);
    expect(results[0]).not.toBeNull();
    expect(results[1]).not.toBeNull();
  });

  it("should handle a batch where all texts are long", async () => {
    const sentTexts: string[][] = [];

    mockFetch(async (_url, opts) => {
      const body = JSON.parse(opts.body as string);
      sentTexts.push(body.input);
      return ollamaResponse(body.input.length);
    });

    const texts = Array.from({ length: 5 }, (_, i) =>
      `message ${i} `.repeat(2000)
    );

    const results = await embedBatch(texts);

    expect(results).toHaveLength(5);
    results.forEach((r) => expect(r).not.toBeNull());

    // No text sent to Ollama should exceed 4000 chars
    for (const batch of sentTexts) {
      for (const text of batch) {
        expect(text.length).toBeLessThanOrEqual(4000);
      }
    }
  });
});
