const redis = require("../config/redis");
const crypto = require("crypto");
const { verifyToken } = require("../utils/jwt");

const getFileUploadIdentifier = (req) => {
  // Always use authenticated user for file uploads
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token) {
    try {
      const decoded = verifyToken(token);
      if (decoded && decoded.userId) {
        req.decodedToken = decoded;
        req.tokenVerified = true;
        return `file_upload:${decoded.userId}`;
      }
    } catch (error) {
      console.warn(
        "JWT verification failed in file upload rate limiter:",
        error.message
      );
    }
  }

  // Fallback to IP-based limiting for unauthenticated requests
  const fingerprint = crypto
    .createHash("sha256")
    .update([req.ip, req.get("User-Agent") || ""].join("|"))
    .digest("hex")
    .substring(0, 12);

  return `file_upload_ip:${req.ip}-${fingerprint}`;
};

const getFileUploadLimits = (identifier) => {
  const type = identifier.split(":")[0];

  const limits = {
    file_upload: {
      windowMs: 60 * 60 * 1000, // 1 hour window
      max: 20, // 20 file upload requests per hour per user
      maxFiles: 100, // Maximum 100 files per hour per user
      maxTotalSize: 500 * 1024 * 1024, // 500MB total per hour per user
    },
    file_upload_ip: {
      windowMs: 60 * 60 * 1000, // 1 hour window
      max: 5, // 5 file upload requests per hour per IP (unauthenticated)
      maxFiles: 20, // Maximum 20 files per hour per IP
      maxTotalSize: 50 * 1024 * 1024, // 50MB total per hour per IP
    },
  };

  return limits[type] || limits.file_upload_ip;
};

// Cache for file upload rate limit data
const fileUploadCache = new Map();
const CACHE_TTL = 60000; // 1 minute cache

const fileUploadRateLimiter = async (req, res, next) => {
  try {
    const identifier = getFileUploadIdentifier(req);
    const limits = getFileUploadLimits(identifier);

    const now = Date.now();
    const window = Math.floor(now / limits.windowMs);

    // Multiple Redis keys for different limits
    const requestKey = `rate_limit:${identifier}:requests:${window}`;
    const filesKey = `rate_limit:${identifier}:files:${window}`;
    const sizeKey = `rate_limit:${identifier}:size:${window}`;

    const cacheKey = `${identifier}:${window}`;

    // Calculate current request file count and size
    const currentFiles = req.files ? req.files.length : 0;
    const currentSize = req.files
      ? req.files.reduce((sum, file) => sum + file.size, 0)
      : 0;

    // Check cache first
    const cached = fileUploadCache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL) {
      // Check all limits
      if (cached.requests >= limits.max) {
        return res.status(429).json({
          error: "Too many file upload requests. Please try again later.",
          type: "file_upload_requests",
          limit: limits.max,
          retryAfter: Math.ceil(limits.windowMs / 1000),
        });
      }

      if (cached.files + currentFiles > limits.maxFiles) {
        return res.status(429).json({
          error: `File limit exceeded. You can upload ${limits.maxFiles} files per hour.`,
          type: "file_upload_files",
          limit: limits.maxFiles,
          current: cached.files,
          retryAfter: Math.ceil(limits.windowMs / 1000),
        });
      }

      if (cached.totalSize + currentSize > limits.maxTotalSize) {
        const limitMB = Math.round(limits.maxTotalSize / (1024 * 1024));
        const currentMB = Math.round(
          (cached.totalSize + currentSize) / (1024 * 1024)
        );
        return res.status(429).json({
          error: `Upload size limit exceeded. You can upload ${limitMB}MB per hour. Current: ${currentMB}MB`,
          type: "file_upload_size",
          limit: limits.maxTotalSize,
          current: cached.totalSize,
          retryAfter: Math.ceil(limits.windowMs / 1000),
        });
      }

      // Update cache
      cached.requests++;
      cached.files += currentFiles;
      cached.totalSize += currentSize;

      res.set({
        "X-FileUpload-Requests-Limit": limits.max,
        "X-FileUpload-Requests-Remaining": Math.max(
          0,
          limits.max - cached.requests
        ),
        "X-FileUpload-Files-Limit": limits.maxFiles,
        "X-FileUpload-Files-Remaining": Math.max(
          0,
          limits.maxFiles - cached.files
        ),
        "X-FileUpload-Size-Limit": limits.maxTotalSize,
        "X-FileUpload-Size-Remaining": Math.max(
          0,
          limits.maxTotalSize - cached.totalSize
        ),
      });

      return next();
    }

    // Cache miss - check Redis
    const [currentRequests, currentFilesCount, currentTotalSize] =
      await Promise.all([
        redis.incr(requestKey),
        redis.incrby(filesKey, currentFiles),
        redis.incrby(sizeKey, currentSize),
      ]);

    // Set expiry for all keys on first increment
    if (currentRequests === 1) {
      const expiry = Math.ceil(limits.windowMs / 1000);
      await Promise.all([
        redis.expire(requestKey, expiry),
        redis.expire(filesKey, expiry),
        redis.expire(sizeKey, expiry),
      ]);
    }

    // Update cache
    fileUploadCache.set(cacheKey, {
      requests: currentRequests,
      files: currentFilesCount,
      totalSize: currentTotalSize,
      timestamp: now,
    });

    // Clean old cache entries
    if (fileUploadCache.size > 500) {
      const cutoff = now - CACHE_TTL;
      for (const [key, value] of fileUploadCache.entries()) {
        if (value.timestamp < cutoff) {
          fileUploadCache.delete(key);
        }
      }
    }

    // Check limits
    if (currentRequests > limits.max) {
      return res.status(429).json({
        error: "Too many file upload requests. Please try again later.",
        type: "file_upload_requests",
        limit: limits.max,
        current: currentRequests,
        retryAfter: Math.ceil(limits.windowMs / 1000),
      });
    }

    if (currentFilesCount > limits.maxFiles) {
      return res.status(429).json({
        error: `File limit exceeded. You can upload ${limits.maxFiles} files per hour.`,
        type: "file_upload_files",
        limit: limits.maxFiles,
        current: currentFilesCount,
        retryAfter: Math.ceil(limits.windowMs / 1000),
      });
    }

    if (currentTotalSize > limits.maxTotalSize) {
      const limitMB = Math.round(limits.maxTotalSize / (1024 * 1024));
      const currentMB = Math.round(currentTotalSize / (1024 * 1024));
      return res.status(429).json({
        error: `Upload size limit exceeded. You can upload ${limitMB}MB per hour. Current: ${currentMB}MB`,
        type: "file_upload_size",
        limit: limits.maxTotalSize,
        current: currentTotalSize,
        retryAfter: Math.ceil(limits.windowMs / 1000),
      });
    }

    // Set response headers
    res.set({
      "X-FileUpload-Requests-Limit": limits.max,
      "X-FileUpload-Requests-Remaining": Math.max(
        0,
        limits.max - currentRequests
      ),
      "X-FileUpload-Files-Limit": limits.maxFiles,
      "X-FileUpload-Files-Remaining": Math.max(
        0,
        limits.maxFiles - currentFilesCount
      ),
      "X-FileUpload-Size-Limit": limits.maxTotalSize,
      "X-FileUpload-Size-Remaining": Math.max(
        0,
        limits.maxTotalSize - currentTotalSize
      ),
    });

    next();
  } catch (error) {
    console.error("File upload rate limiter error:", error);
    next(); // Fail open if Redis is down
  }
};

// Clean up cache periodically
setInterval(() => {
  const now = Date.now();
  const cutoff = now - CACHE_TTL;
  let cleaned = 0;

  for (const [key, value] of fileUploadCache.entries()) {
    if (value.timestamp < cutoff) {
      fileUploadCache.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired file upload cache entries`);
  }
}, 10 * 60 * 1000); // Clean every 10 minutes

module.exports = fileUploadRateLimiter;
