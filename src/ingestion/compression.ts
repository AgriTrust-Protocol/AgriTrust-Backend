export interface ZstdCompressionConfig {
  codec: 'zstd';
  level: number;
  targetRatio: number;
}

export const DEFAULT_RAW_PAYLOAD_COMPRESSION: ZstdCompressionConfig = {
  codec: 'zstd',
  level: 10,
  targetRatio: 5,
};

export function compressionMetadata(config: ZstdCompressionConfig = DEFAULT_RAW_PAYLOAD_COMPRESSION): Record<string, string> {
  if (config.codec !== 'zstd') throw new Error(`Unsupported raw payload compression codec: ${config.codec}`);
  if (!Number.isInteger(config.level) || config.level < 1 || config.level > 22) {
    throw new Error(`Zstd level must be an integer from 1 to 22, received ${config.level}`);
  }
  return {
    'parquet.compression': config.codec,
    'parquet.compression.level': String(config.level),
    'parquet.compression.target_ratio': `${config.targetRatio}:1`,
  };
}
