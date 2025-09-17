const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");
const supabase = require("../config/supabase");
const multer = require("multer");
const path = require("path");

// Configure multer for memory storage (for Supabase upload)
const storage = multer.memoryStorage();
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
router.get("/:groupId", authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { page = 1, limit = 25 } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;
    const userOrgId = req.user.org_id;

    let targetUserId = userId;
    let targetOrgId = userOrgId;

    // For parents, validate child access
    if (userRole === "parent") {
      const { childId } = req.query;
      if (!childId) {
        return res.status(400).json({
          success: false,
          message: "Child ID is required for parent users",
        });
      }

      // Validate parent-child relationship
      const { data: childData, error: childError } = await supabase
        .from("users")
        .select("id, org_id, parent_id")
        .eq("id", childId)
        .eq("parent_id", userId)
        .single();

      if (childError || !childData) {
        return res.status(403).json({
          success: false,
          message: "Invalid child ID or access denied",
        });
      }

      targetUserId = childData.id;
      targetOrgId = childData.org_id;
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

    // Get messages with pagination
    const offset = (page - 1) * limit;
    const { data: messages, error: messagesError } = await supabase
      .from("messages")
      .select("*")
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

    res.json({
      success: true,
      messages: messages || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        hasMore: messages.length === parseInt(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Send message (faculty only)
router.post(
  "/:groupId",
  authenticateToken,
  upload.array("files", 10),
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { message_content } = req.body;
      const userRole = req.user.role;
      const userId = req.user.id;

      if (userRole !== "faculty") {
        return res.status(403).json({
          success: false,
          message: "Only faculty can send messages",
        });
      }

      if (!message_content || message_content.length > 10000) {
        return res.status(400).json({
          success: false,
          message:
            "Message content is required and must be less than 10000 characters",
        });
      }

      // Check if faculty has access to this group
      const { data: userGroup, error: userGroupError } = await supabase
        .from("user_groups")
        .select("id")
        .eq("user_id", userId)
        .eq("group_id", groupId)
        .eq("is_active", true)
        .single();

      if (userGroupError || !userGroup) {
        return res.status(403).json({
          success: false,
          message: "Access denied to this group",
        });
      }

      // Process files and upload to Supabase Storage
      const files = req.files || [];
      let fileUrls = [];
      let fileNames = [];
      let fileSizes = [];
      let totalFileSize = 0;
      let isContainsFile = false;

      if (files.length > 0) {
        isContainsFile = true;
        totalFileSize = files.reduce((sum, file) => sum + file.size, 0);

        if (totalFileSize > 50 * 1024 * 1024) {
          // 50MB limit
          return res.status(400).json({
            success: false,
            message: "Total file size cannot exceed 50MB",
          });
        }

        // Upload files to Supabase Storage
        for (const file of files) {
          const fileName = `${Date.now()}-${Math.round(
            Math.random() * 1e9
          )}${path.extname(file.originalname)}`;
          const filePath = `groups/${groupId}/${fileName}`;

          // Determine content type based on file extension
          let contentType = "application/pdf";
          if (file.mimetype.startsWith("image/")) {
            contentType = file.mimetype;
          }

          const { data: uploadData, error: uploadError } =
            await supabase.storage
              .from("group-files")
              .upload(filePath, file.buffer, {
                contentType: contentType,
                upsert: false,
              });

          if (uploadError) {
            return res.status(400).json({
              success: false,
              message: `Failed to upload file ${file.originalname}: ${uploadError.message}`,
            });
          }

          // Store file path instead of public URL
          fileUrls.push(filePath);
          fileNames.push(file.originalname);
          fileSizes.push(file.size);
        }
      }

      // Check for links in message content
      const linkRegex = /(https?:\/\/[^\s]+)/g;
      const isContainsLink = linkRegex.test(message_content);

      // Get faculty name
      const { data: facultyData, error: facultyError } = await supabase
        .from("users")
        .select("full_name")
        .eq("id", userId)
        .single();

      if (facultyError || !facultyData) {
        return res.status(500).json({
          success: false,
          message: "Error fetching faculty information",
        });
      }

      // Create message
      console.log("Creating message with data:", {
        group_id: groupId,
        user_id: userId,
        faculty_name: facultyData.full_name,
        message_content: message_content,
        is_contains_link: isContainsLink,
        is_contains_file: isContainsFile,
        file_urls: fileUrls,
        file_names: fileNames,
        file_sizes: fileSizes,
        total_file_size: totalFileSize,
      });

      const { data: message, error: messageError } = await supabase
        .from("messages")
        .insert({
          group_id: groupId,
          user_id: userId,
          faculty_name: facultyData.full_name,
          message_content: message_content,
          is_contains_link: isContainsLink,
          is_contains_file: isContainsFile,
          file_urls: fileUrls,
          file_names: fileNames,
          file_sizes: fileSizes,
          total_file_size: totalFileSize,
        })
        .select()
        .single();

      if (messageError) {
        console.error("Error creating message:", messageError);
        console.error("Message data that failed:", {
          group_id: groupId,
          user_id: userId,
          faculty_name: facultyData.full_name,
          message_content: message_content,
          is_contains_link: isContainsLink,
          is_contains_file: isContainsFile,
          file_urls: fileUrls,
          file_names: fileNames,
          file_sizes: fileSizes,
          total_file_size: totalFileSize,
        });
        return res.status(500).json({
          success: false,
          message: "Error creating message: " + messageError.message,
        });
      }

      console.log("Message created successfully:", message);

      res.json({
        success: true,
        message: message,
      });
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
  async (req, res) => {
    try {
      const { groupId, messageId } = req.params;
      const { fileIndex, childId } = req.query;

      // Validate parent-child relationship if childId provided
      if (childId) {
        await parentChildValidator(req, res, () => {});
      }

      // Check if user has access to this group
      const { data: userGroup, error: userGroupError } = await supabase
        .from("user_groups")
        .select("id")
        .eq("user_id", req.user.id)
        .eq("group_id", groupId)
        .eq("is_active", true)
        .single();

      if (userGroupError || !userGroup) {
        return res.status(403).json({
          success: false,
          message: "Access denied to this group",
        });
      }

      // Get message from database
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

      const fileIndexNum = parseInt(fileIndex);
      if (fileIndexNum < 0 || fileIndexNum >= message.file_urls.length) {
        return res.status(400).json({
          success: false,
          message: "Invalid file index",
        });
      }

      const filePath = message.file_urls[fileIndexNum];
      const fileName = message.file_names[fileIndexNum];

      // Generate signed URL (expires in 1 hour)
      const { data: signedUrl, error: urlError } = await supabase.storage
        .from("group-files")
        .createSignedUrl(filePath, 3600);

      if (urlError) {
        return res.status(500).json({
          success: false,
          message: "Failed to generate file URL",
        });
      }

      res.json({
        success: true,
        fileUrl: signedUrl.signedUrl,
        fileName: fileName,
      });
    } catch (error) {
      console.error("Error getting file URL:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

module.exports = router;
