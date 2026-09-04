const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// mimetype -> расширение сохранённого файла. НЕ берём расширение из file.originalname:
// это заголовок Content-Type многосоставной формы, который клиент выставляет сам —
// без этой карты злоумышленник мог пройти fileFilter, заявив "Content-Type: image/jpeg",
// но назвать файл "x.html" (или .svg) и получить исполняемый в браузере файл на
// публичном /uploads/ (express.static отдаёт по расширению, не по тому, что было
// заявлено при загрузке) — классический stored XSS через file upload.
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};
const ALLOWED_MIME = new Set(Object.keys(MIME_EXT));
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 5;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${MIME_EXT[file.mimetype] || ''}`);
  },
});

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error('Unsupported file type'));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
});

module.exports = { upload, UPLOAD_DIR };
