import * as llama from "./llama";

const EMBED_DIMS = 1024;
const BATCH_SIZE = 50;
const MAX_TEXT_LENGTH = 4000;

export { EMBED_DIMS, BATCH_SIZE, MAX_TEXT_LENGTH };
export const EMBED_MODEL = llama.LLAMA_EMBED_MODEL;

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

export async function embed(text: string): Promise<Float32Array> {
  return llama.embedDoc(truncate(text));
}

export async function embedQuery(text: string): Promise<Float32Array> {
  return llama.embedQuery(truncate(text));
}

export async function embedBatch(
  texts: string[],
  onSkip?: (index: number, error: string) => void
): Promise<(Float32Array | null)[]> {
  return llama.embedDocBatch(texts.map(truncate), onSkip);
}
