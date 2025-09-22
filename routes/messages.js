const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");
const rateLimiter = require("../middleware/rateLimiter");
const fileUploadRateLimiter = require("../middleware/fileUploadRateLimiter");
const supabase = require("../config/supabase");
const multer = require("multer");
const path = require("path");

// Configure multer for memory storage (for Supabase upload)
const storage = multer.memoryStorage();

// File signature validation
const fileSignatures = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "application/pdf": [0x25, 0x50, 0x44, 0x46],
};

function validateFileSignature(buffer, mimeType) {
  const signature = fileSignatures[mimeType];
  if (!signature) return false;

  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

function sanitizeFileName(originalName) {
  return originalName.replace(/[^a-zA-Z0-9.-]/g, "_").substring(0, 100); // Limit length
}

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per file
    files: 10, // Max 10 files per message
  },
  fileFilter: (req, file, cb) => {
    // Allow PDF, PNG, JPG, JPEG files
    const allowedTypes = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/jpg",
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, PNG, and JPG files are allowed"), false);
    }
  },
});

// Get messages for a group
router.get(
  "/:groupId",
  rateLimiter, // Regular rate limiter for GET requests
  authenticateToken,
  async (req, res, next) => {
    // Only apply parentChildValidator for parent users
    if (req.user.role === "parent") {
      return parentChildValidator(req, res, next);
    }
    next();
  },
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { page = 1, limit = 25 } = req.query;
      const userRole = req.user.role;
      const userId = req.user.id;

      let targetUserId = userId;

      // If user is a parent, use validated child
      if (userRole === "parent") {
        targetUserId = req.validatedChild.childId;
      }

      // Check if user has access to this group
      const { data: userGroup, error: userGroupError } = await supabase
        .from("user_groups")
        .select("id")
        .eq("user_id", targetUserId)
        .eq("group_id", groupId)
        .eq("is_active", true)
        .single();

      if (userGroupError || !userGroup) {
        return res.status(403).json({
          success: false,
          message: "Access denied to this group",
        });
      }

      const offset = (page - 1) * limit;

      // Get messages with pagination - FIXED: use user_id instead of sender_id
      const { data: messages, error: messagesError } = await supabase
        .from("messages")
        .select(
          `
        *,
        users!messages_user_id_fkey(full_name, role)
      `
        )
        .eq("group_id", groupId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (messagesError) {
        console.error("Error fetching messages:", messagesError);
        return res.status(500).json({
          success: false,
          message: "Error fetching messages",
        });
      }

      // Get total count for pagination
      const { count, error: countError } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("group_id", groupId);

      if (countError) {
        console.error("Error fetching message count:", countError);
      }

      res.json({
        success: true,
        messages: messages || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          totalPages: Math.ceil((count || 0) / limit),
        },
      });
    } catch (error) {
      console.error("Error in get messages:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Send message to group (faculty only) - WITH FILE UPLOAD RATE LIMITING
router.post(
  "/:groupId",
  authenticateToken,
  fileUploadRateLimiter, // Apply file upload rate limiter BEFORE multer
  upload.array("files", 10),
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { content } = req.body;
      const userId = req.user.id;
      const userRole = req.user.role;

      // Only faculty can send messages
      if (userRole !== "faculty") {
        return res.status(403).json({
          success: false,
          message: "Only faculty can send messages",
        });
      }

      // Check if user is a teacher in this group
      const { data: userGroup, error: userGroupError } = await supabase
        .from("user_groups")
        .select("id")
        .eq("user_id", userId)
        .eq("group_id", groupId)
        .eq("member_type", "teacher")
        .eq("is_active", true)
        .single();

      if (userGroupError || !userGroup) {
        return res.status(403).json({
          success: false,
          message: "Only teachers can send messages",
        });
      }

      if (!content || content.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Message content is required",
        });
      }

      // Pre-validate file sizes and count BEFORE upload
      if (req.files && req.files.length > 0) {
        // Check total file size limit BEFORE upload
        const totalSize = req.files.reduce((sum, file) => sum + file.size, 0);
        if (totalSize > 50 * 1024 * 1024) {
          return res.status(400).json({
            success: false,
            message: "Total file size cannot exceed 50MB",
          });
        }

        // Validate file signatures for security
        for (const file of req.files) {
          if (!validateFileSignature(file.buffer, file.mimetype)) {
            return res.status(400).json({
              success: false,
              message: `Invalid file format detected: ${file.originalname}`,
            });
          }
        }
      }

      // Handle file uploads
      let fileUrls = [];
      let fileNames = [];
      let fileSizes = [];
      let totalFileSize = 0;
      let uploadedFiles = []; // Track uploaded files for cleanup on error

      try {
        if (req.files && req.files.length > 0) {
          // Upload files to Supabase Storage
          for (const file of req.files) {
            const sanitizedName = sanitizeFileName(file.originalname);
            const fileName = `${Date.now()}-${Math.random()
              .toString(36)
              .substring(7)}-${sanitizedName}`;
            const filePath = `group-files/${groupId}/${fileName}`;

            const { data: uploadData, error: uploadError } =
              await supabase.storage
                .from("group-files")
                .upload(filePath, file.buffer, {
                  contentType: file.mimetype,
                });

            if (uploadError) {
              console.error("Error uploading file:", uploadError);

              // Cleanup already uploaded files
              for (const uploadedFile of uploadedFiles) {
                try {
                  await supabase.storage
                    .from("group-files")
                    .remove([uploadedFile]);
                } catch (cleanupError) {
                  console.error("Error cleaning up file:", cleanupError);
                }
              }

              return res.status(500).json({
                success: false,
                message: "Error uploading files",
              });
            }

            uploadedFiles.push(filePath);
            fileUrls.push(filePath);
            fileNames.push(file.originalname);
            fileSizes.push(file.size);
            totalFileSize += file.size;
          }
        }

        // Check for links in content
        const linkRegex = /(https?:\/\/[^\s]+)/g;
        const isContainsLink = linkRegex.test(content);

        // Create message
        const { data: message, error: messageError } = await supabase
          .from("messages")
          .insert({
            group_id: groupId,
            user_id: userId,
            faculty_name: req.user.full_name,
            message_content: content.trim(),
            is_contains_link: isContainsLink,
            is_contains_file: fileUrls.length > 0,
            file_urls: fileUrls,
            file_names: fileNames,
            file_sizes: fileSizes,
            total_file_size: totalFileSize,
          })
          .select(`*, users!messages_user_id_fkey(full_name, role)`)
          .single();

        if (messageError) {
          console.error("Error creating message:", messageError);

          // Cleanup uploaded files on database error
          for (const uploadedFile of uploadedFiles) {
            try {
              await supabase.storage.from("group-files").remove([uploadedFile]);
            } catch (cleanupError) {
              console.error("Error cleaning up file:", cleanupError);
            }
          }

          return res.status(500).json({
            success: false,
            message: "Error creating message",
          });
        }

        res.json({
          success: true,
          message: message,
        });
      } catch (uploadError) {
        console.error("File upload process error:", uploadError);

        // Cleanup uploaded files on any error
        for (const uploadedFile of uploadedFiles) {
          try {
            await supabase.storage.from("group-files").remove([uploadedFile]);
          } catch (cleanupError) {
            console.error("Error cleaning up file:", cleanupError);
          }
        }

        return res.status(500).json({
          success: false,
          message: "Error processing file uploads",
        });
      }
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Get file download URL
router.get(
  "/:groupId/files/:messageId",
  authenticateToken,
  async (req, res, next) => {
    // Only apply parentChildValidator for parent users
    if (req.user.role === "parent") {
      return parentChildValidator(req, res, next);
    }
    next();
  },
  async (req, res) => {
    try {
      const { groupId, messageId } = req.params;
      const { fileIndex } = req.query;
      const userRole = req.user.role;
      const userId = req.user.id;

      let targetUserId = userId;

      // If user is a parent, use validated child
      if (userRole === "parent") {
        targetUserId = req.validatedChild.childId;
      }

      // Check if user has access to this group
      const { data: userGroup, error: userGroupError } = await supabase
        .from("user_groups")
        .select("id")
        .eq("user_id", targetUserId)
        .eq("group_id", groupId)
        .eq("is_active", true)
        .single();

      if (userGroupError || !userGroup) {
        return res.status(403).json({
          success: false,
          message: "Access denied to this group",
        });
      }

      // Get message
      const { data: message, error: messageError } = await supabase
        .from("messages")
        .select("file_urls, file_names")
        .eq("id", messageId)
        .eq("group_id", groupId)
        .single();

      if (messageError || !message) {
        return res.status(404).json({
          success: false,
          message: "Message not found",
        });
      }

      if (!message.file_urls || !Array.isArray(message.file_urls)) {
        return res.status(404).json({
          success: false,
          message: "No files found in this message",
        });
      }

      const fileIndexNum = parseInt(fileIndex);
      if (fileIndexNum < 0 || fileIndexNum >= message.file_urls.length) {
        return res.status(400).json({
          success: false,
          message: "Invalid file index",
        });
      }

      const filePath = message.file_urls[fileIndexNum];
      const fileName = message.file_names[fileIndexNum];

      // Generate signed URL for file download
      const { data: signedUrlData, error: signedUrlError } =
        await supabase.storage
          .from("group-files")
          .createSignedUrl(filePath, 3600); // 1 hour expiry

      if (signedUrlError) {
        console.error("Error generating signed URL:", signedUrlError);
        return res.status(500).json({
          success: false,
          message: "Error generating download URL",
        });
      }

      res.json({
        success: true,
        fileUrl: signedUrlData.signedUrl,
        fileName: fileName,
      });
    } catch (error) {
      console.error("Error in get file download URL:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

module.exports = router;
