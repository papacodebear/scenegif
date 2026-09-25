import { env, pipeline } from '@huggingface/transformers';

env.cacheDir = '/app/.cache/transformers';

let extractor = null;

export default async function embed(texts) {
  if (!extractor) extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  return output.tolist();
}
