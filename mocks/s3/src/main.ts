import { createS3Server } from './server';
import { FileStore } from './store';

/**
 * Development-only S3 for the local stack (replaces SeaweedFS and the aws-cli bucket job).
 *
 *   S3_ACCESS_KEY, S3_SECRET_KEY   the one accepted credential (as the services use it)
 *   S3_MOCK_DATA_DIR               where buckets and objects are kept (default /data)
 *   S3_MOCK_BUCKETS                comma-separated buckets created at start
 *   S3_MOCK_PUBLIC_BUCKETS         comma-separated buckets readable without signing (GET/HEAD)
 *   S3_MOCK_PORT                   default 8333
 */
async function main() {
  const { S3_ACCESS_KEY: accessKey, S3_SECRET_KEY: secretKey } = process.env;
  if (!accessKey || !secretKey) throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY are required');
  const store = await FileStore.open(process.env['S3_MOCK_DATA_DIR'] || '/data');
  const list = (v: string | undefined) => (v ?? '').split(',').map((b) => b.trim()).filter(Boolean);
  const buckets = list(process.env['S3_MOCK_BUCKETS']);
  for (const b of buckets) if (!store.hasBucket(b)) await store.createBucket(b);
  const port = Number(process.env['S3_MOCK_PORT'] || 8333);
  const publicReadBuckets = list(process.env['S3_MOCK_PUBLIC_BUCKETS']);
  const server = createS3Server({ store, credentials: { accessKey, secretKey }, publicReadBuckets, log });
  server.listen(port, '0.0.0.0', () => log('mock S3 ready', { port, buckets: store.listBuckets().map((b) => b.name) }));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

function log(message: string, fields: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), message, ...fields })}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
