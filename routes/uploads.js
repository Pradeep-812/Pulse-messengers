const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '../uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (req, file, cb) => {
    // Allow images, audio, video, documents
    const allowed = /image\/|audio\/|video\/|application\/(pdf|msword|vnd\.|zip|x-zip)|text\//;
    if (allowed.test(file.mimetype)) return cb(null, true);
    cb(new Error('File type not allowed'));
  },
});

function detectType(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('audio/')) return 'voice';
  if (mimetype.startsWith('video/')) return 'video';
  return 'file';
}

// POST /api/uploads/file
router.post('/file', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const type = detectType(req.file.mimetype);
  const url = `/uploads/${req.file.filename}`;

  res.json({
    url,
    type,
    original_name: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
  });
});

// POST /api/uploads/avatar
router.post('/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.mimetype.startsWith('image/'))
    return res.status(400).json({ error: 'Must be an image' });

  const url = `/uploads/${req.file.filename}`;
  const db = require('../db');
  await db.users.update({ _id: req.userId }, { $set: { avatar: url } });

  res.json({ url });
});

module.exports = router;
