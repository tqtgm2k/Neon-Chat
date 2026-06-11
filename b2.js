const axios = require('axios');
const crypto = require('crypto');

const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APP_KEY;
const B2_BUCKET = process.env.B2_BUCKET;
const B2_ENDPOINT = process.env.B2_ENDPOINT; // s3.us-east-005.backblazeb2.com

let _auth = null;
let _authExpiry = 0;

async function authorize() {
  if (_auth && Date.now() < _authExpiry) return _auth;
  const res = await axios.get('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    auth: { username: B2_KEY_ID, password: B2_APP_KEY }
  });
  _auth = res.data;
  _authExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
  return _auth;
}

async function getUploadUrl() {
  const auth = await authorize();
  const res = await axios.post(`${auth.apiUrl}/b2api/v2/b2_get_upload_url`, {
    bucketId: auth.allowed?.bucketId || await getBucketId(auth)
  }, { headers: { Authorization: auth.authorizationToken } });
  return res.data;
}

async function getBucketId(auth) {
  const res = await axios.post(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
    accountId: auth.accountId, bucketName: B2_BUCKET
  }, { headers: { Authorization: auth.authorizationToken } });
  return res.data.buckets[0].bucketId;
}

async function uploadFile(key, buffer, contentType) {
  const uploadInfo = await getUploadUrl();
  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
  await axios.post(uploadInfo.uploadUrl, buffer, {
    headers: {
      'Authorization': uploadInfo.authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(key),
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': buffer.length,
      'X-Bz-Content-Sha1': sha1
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
}

async function getPresignedUrl(key, expiresIn = 3600) {
  const auth = await authorize();
  const res = await axios.post(`${auth.apiUrl}/b2api/v2/b2_get_download_authorization`, {
    bucketId: auth.allowed?.bucketId || await getBucketId(auth),
    fileNamePrefix: key,
    validDurationInSeconds: expiresIn
  }, { headers: { Authorization: auth.authorizationToken } });
  const token = res.data.authorizationToken;
  const downloadUrl = auth.downloadUrl;
  return `${downloadUrl}/file/${B2_BUCKET}/${key}?Authorization=${token}`;
}

async function deleteFile(key) {
  const auth = await authorize();
  // Lấy fileId trước
  const res = await axios.post(`${auth.apiUrl}/b2api/v2/b2_list_file_names`, {
    bucketId: auth.allowed?.bucketId || await getBucketId(auth),
    prefix: key, maxFileCount: 1
  }, { headers: { Authorization: auth.authorizationToken } });
  const file = res.data.files[0];
  if (!file) return;
  await axios.post(`${auth.apiUrl}/b2api/v2/b2_delete_file_version`, {
    fileId: file.fileId, fileName: file.fileName
  }, { headers: { Authorization: auth.authorizationToken } });
}

module.exports = { uploadFile, getPresignedUrl, deleteFile };
