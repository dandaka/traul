import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

const fakeVector = new Float32Array(1024).fill(0.42);
const fakeVector2 = new Float32Array(1024).fill(0.84);

const mockLlama = {
  embedDoc: mock(() => Promise.resolve(fakeVector)),
  embedQuery: mock(() => Promise.resolve(fakeVector)),
  embedDocBatch: mock(() => Promise.resolve([fakeVector, fakeVector2])),
  LLAMA_EMBED_MODEL: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
};

mock.module("../../src/lib/llama", () => mockLlama);

const { embed, embedQuery, embedBatch, MAX_TEXT_LENGTH } = await import("../../src/lib/embeddings");

describe("embeddings -- llama primary path", () => {
  beforeEach(() => {
    mockLlama.embedDoc.mockClear();
    mockLlama.embedQuery.mockClear();
    mockLlama.embedDocBatch.mockClear();
    mockLlama.embedDoc.mockImplementation(() => Promise.resolve(fakeVector));
    mockLlama.embedQuery.mockImplementation(() => Promise.resolve(fakeVector));
    mockLlama.embedDocBatch.mockImplementation(() => Promise.resolve([fakeVector, fakeVector2]));
  });

  it("embed() calls llama.embedDoc and returns Float32Array", async () => {
    const result = await embed("hello");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(1024);
    expect(mockLlama.embedDoc).toHaveBeenCalledWith("hello");
  });

  it("embedQuery() calls llama.embedQuery and returns Float32Array", async () => {
    const result = await embedQuery("search term");
    expect(result).toBeInstanceOf(Float32Array);
    expect(mockLlama.embedQuery).toHaveBeenCalledWith("search term");
  });

  it("embedBatch() calls llama.embedDocBatch", async () => {
    const results = await embedBatch(["a", "b"]);
    expect(results).toHaveLength(2);
    expect(mockLlama.embedDocBatch).toHaveBeenCalled();
  });

  it("embed() pre-truncates text > MAX_TEXT_LENGTH", async () => {
    const longText = "x".repeat(5000);
    await embed(longText);
    const calledWith = (mockLlama.embedDoc.mock.calls as unknown[][])[0][0] as string;
    expect(calledWith.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
  });
});
