import 'dotenv/config';
import { getPresignedUploadUrl, getPresignedDownloadUrl, headR2Object, deleteR2Object, s3Client, isLocalStorage } from '../src/services/r2.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';

async function testLiveB2Storage() {
  console.log('--- Testing Backblaze B2 Cloud Storage ---');
  console.log(`isLocalStorage: ${isLocalStorage}`);

  if (isLocalStorage || !s3Client) {
    throw new Error('S3 client not initialized. Check .env settings.');
  }

  const testFileKey = `test-b2/verify-${Date.now()}.pdf`;
  const bucket = process.env.R2_BUCKET_NAME || 'printtestxyz';

  // 1. Direct PutObject check
  console.log(`1. Uploading test file to bucket "${bucket}" with key "${testFileKey}"...`);
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: testFileKey,
    Body: Buffer.from('%PDF-1.4 Mock PDF content for ShopPrint'),
    ContentType: 'application/pdf'
  }));
  console.log('✓ Upload to Backblaze B2: SUCCESS');

  // 2. HeadObject check
  console.log('2. Verifying object metadata via headR2Object...');
  const head = await headR2Object(testFileKey);
  console.log(`✓ headR2Object: exists=${head.exists}, size=${head.size} bytes, checksum=${head.checksum}`);
  if (!head.exists || !head.size) throw new Error('HeadObject failed to locate uploaded file');

  // 3. Presigned Download URL check
  console.log('3. Generating Presigned Download URL...');
  const downloadUrl = await getPresignedDownloadUrl(testFileKey, 300);
  console.log(`✓ Presigned Download URL generated (starts with: ${downloadUrl.slice(0, 50)}...)`);

  // 4. Presigned Upload URL check
  console.log('4. Generating Presigned Upload URL...');
  const upload = await getPresignedUploadUrl(`test-b2/incoming-${Date.now()}.pdf`, 'application/pdf', 300);
  console.log(`✓ Presigned Upload URL generated (starts with: ${upload.url.slice(0, 50)}...)`);

  // 5. Cleanup test object
  console.log('5. Cleaning up test file...');
  const deleted = await deleteR2Object(testFileKey);
  console.log(`✓ Cleanup deleteR2Object: ${deleted}`);

  console.log('\n==============================================');
  console.log('  BACKBLAZE B2 STORAGE FULLY OPERATIONAL');
  console.log('==============================================');
}

testLiveB2Storage().catch((err) => {
  console.error('B2 Storage Verification Error:', err);
  process.exit(1);
});
