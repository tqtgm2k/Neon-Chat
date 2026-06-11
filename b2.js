const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: 'us-east-005',
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY
  },
  forcePathStyle: true
});

const BUCKET = process.env.B2_BUCKET;

async function uploadFile(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType
  }));
}

async function getPresignedUrl(key, expiresIn = 3600) {
  const cmd = require('@aws-sdk/client-s3').GetObjectCommand
    ? new (require('@aws-sdk/client-s3').GetObjectCommand)({ Bucket: BUCKET, Key: key })
    : null;
  if (!cmd) return null;
  return getSignedUrl(s3, cmd, { expiresIn });
}

async function deleteFile(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { uploadFile, getPresignedUrl, deleteFile };
