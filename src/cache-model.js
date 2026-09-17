import { env, pipeline } from '@huggingface/transformers';

env.cacheDir = '/app/.cache/transformers';
await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
console.log('Model cached');
