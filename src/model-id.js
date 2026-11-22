// Model constants. Kept free of imports so model-free code (doctor, setup) can use them.
export const MODEL_NAME = 'Xenova/bge-small-en-v1.5';
export const MODEL_DTYPE = 'q8';
export const MODEL_ID = `${MODEL_NAME}:${MODEL_DTYPE}`;
export const MODEL_DIM = 384;
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
