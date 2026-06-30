'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');

// Cấu trúc lưu (theo chuẩn dự án cũ): {UPLOAD_ROOT}/images/avatar/{userId}/{storedName}
// URL public: {PUBLIC_BASE_URL}/uploads/images/avatar/{userId}/{storedName}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function absDir(userId) {
  return path.join(env.upload.root, 'images', 'avatar', String(userId));
}

function relDir(userId) {
  return `/uploads/images/avatar/${userId}`;
}

// Xóa toàn bộ ảnh cũ của user (mỗi user chỉ giữ 1 avatar).
async function removeAvatarFiles(userId) {
  await fs.rm(absDir(userId), { recursive: true, force: true });
}

// Ghi file mới, trả về URL public đầy đủ để lưu vào nguoi_dung.avatar_url.
async function saveAvatarFile(userId, file) {
  const dir = absDir(userId);
  await fs.rm(dir, { recursive: true, force: true }); // dọn ảnh cũ
  await fs.mkdir(dir, { recursive: true });

  const ext = EXT_BY_MIME[(file.mimetype || '').toLowerCase()] || '.img';
  const storedName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  await fs.writeFile(path.join(dir, storedName), file.buffer);

  const storagePath = `${relDir(userId)}/${storedName}`;
  return { url: `${env.upload.publicBaseUrl}${storagePath}`, storagePath };
}

module.exports = { saveAvatarFile, removeAvatarFiles };
