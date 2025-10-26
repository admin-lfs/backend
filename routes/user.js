const express = require("express");
const supabase = require("../config/supabase");
const { generateToken } = require("../utils/jwt");
const { hashPassword } = require("../utils/password");
const { authenticateToken } = require("../middleware/auth");
const multer = require("multer");
const xlsx = require("xlsx");
const { generateOTP } = require("../utils/otp");

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel files are allowed"), false);
    }
  },
});

// Generate random 8-digit password
const generateRandomPassword = () => {
  // return Math.floor(10000000 + Math.random() * 90000000).toString();
  return "12345678";
};

// Validate Indian phone number
const validatePhoneNumber = (phoneNumber) => {
  return /^[6-9]\d{9}$/.test(phoneNumber);
};

// Manual user creation
router.post("/create-user", authenticateToken, async (req, res) => {
  try {
    const {
      full_name,
      username,
      password,
      role,
      phone_number,
      register_number,
      parent_phone,
      group_id,
    } = req.body;
    const orgId = req.user.org_id;

    // Validate required fields
    if (!full_name || !role) {
      return res.status(400).json({ error: "Full name and role are required" });
    }

    // Validate role
    if (!["student", "parent", "faculty", "admin"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    // For faculty, username is required (password will be auto-generated)
    if (role === "faculty" && !username) {
      return res
        .status(400)
        .json({ error: "Username is required for faculty" });
    }

    // Validate phone number if provided
    if (phone_number && !validatePhoneNumber(phone_number)) {
      return res.status(400).json({ error: "Invalid phone number format" });
    }

    // Check if username already exists in this organization (for faculty)
    if (role === "faculty" && username) {
      const { data: existingUser } = await supabase
        .from("users")
        .select("id")
        .eq("username", username.toLowerCase())
        .eq("org_id", orgId)
        .single();

      if (existingUser) {
        return res
          .status(400)
          .json({ error: "Username already exists in your organization" });
      }
    }

    // Check if phone number already exists in this organization with the same role
    if (phone_number) {
      const { data: existingPhone } = await supabase
        .from("users")
        .select("id, role")
        .eq("phone_number", phone_number)
        .eq("org_id", orgId)
        .eq("role", role)
        .single();

      if (existingPhone) {
        return res.status(400).json({
          error: `Phone number already exists for a ${role} in your organization`,
        });
      }
    }

    // Find parent if parent_phone provided (for students)
    let parentId = null;
    if (role === "student" && parent_phone) {
      const { data: parent } = await supabase
        .from("users")
        .select("id")
        .eq("phone_number", parent_phone)
        .eq("role", "parent")
        .eq("org_id", orgId)
        .single();

      if (parent) {
        parentId = parent.id;
      }
    }

    // Prepare user data
    const userData = {
      org_id: orgId,
      full_name,
      role,
      phone_number: phone_number || null,
      register_number: register_number || null,
      parent_id: parentId || null,
    };

    // Add username and auto-generated password for faculty
    let generatedPassword = null;
    if (role === "faculty") {
      generatedPassword = generateRandomPassword();
      userData.username = username.toLowerCase();
      userData.password_hash = await hashPassword(generatedPassword);
    }

    // Create user
    const { data: newUser, error } = await supabase
      .from("users")
      .insert([userData])
      .select()
      .single();

    if (error) {
      console.error("Error creating user:", error);
      return res.status(500).json({ error: "Failed to create user" });
    }

    // Add student to group if group_id provided
    if (role === "student" && group_id) {
      await supabase.from("user_groups").insert([
        {
          user_id: newUser.id,
          group_id: group_id,
          member_type: "student",
        },
      ]);
    }

    // Send password via SMS for faculty (dummy for now)
    if (role === "faculty" && phone_number && generatedPassword) {
      // TODO: Implement actual SMS sending
      console.log(
        `📱 Faculty password for ${phone_number}: ${generatedPassword}`
      );
    }

    res.json({
      message: "User created successfully",
      user: {
        id: newUser.id,
        full_name: newUser.full_name,
        role: newUser.role,
        phone_number: newUser.phone_number,
        register_number: newUser.register_number,
      },
    });
  } catch (error) {
    console.error("Create user error:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
});

// Excel bulk upload
router.post(
  "/bulk-upload",
  authenticateToken,
  upload.single("excelFile"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Excel file is required" });
      }

      const orgId = req.user.org_id;
      const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
      const results = {
        teachers: { success: 0, errors: [] },
        students: { success: 0, errors: [] },
        parents: { success: 0, errors: [] },
      };

      // Process teachers first
      if (workbook.SheetNames.includes("teachers")) {
        const teachersSheet = workbook.Sheets["teachers"];
        const teachersData = xlsx.utils.sheet_to_json(teachersSheet);

        for (let i = 0; i < teachersData.length; i++) {
          const row = teachersData[i];
          try {
            const { full_name, username, phone_number } = row;

            if (!full_name || !username) {
              results.teachers.errors.push({
                row: i + 2,
                error: "Full name and username are required",
                data: row,
              });
              continue;
            }

            // Check if username exists in this organization
            const { data: existingUser } = await supabase
              .from("users")
              .select("id")
              .eq("username", username.toLowerCase())
              .eq("org_id", orgId)
              .single();

            if (existingUser) {
              results.teachers.errors.push({
                row: i + 2,
                error: "Username already exists in this organization",
                data: row,
              });
              continue;
            }

            // Check if phone number exists in this organization
            if (phone_number) {
              const { data: existingPhone } = await supabase
                .from("users")
                .select("id")
                .eq("phone_number", phone_number)
                .eq("org_id", orgId)
                .single();

              if (existingPhone) {
                results.teachers.errors.push({
                  row: i + 2,
                  error: "Phone number already exists in this organization",
                  data: row,
                });
                continue;
              }
            }

            // Generate random password
            const password = generateRandomPassword();

            // Create teacher
            const { data: newUser, error } = await supabase
              .from("users")
              .insert([
                {
                  org_id: orgId,
                  full_name,
                  username: username.toLowerCase(),
                  password_hash: await hashPassword(password),
                  role: "faculty",
                  phone_number: phone_number || null,
                },
              ])
              .select()
              .single();

            if (error) {
              results.teachers.errors.push({
                row: i + 2,
                error: error.message,
                data: row,
              });
            } else {
              results.teachers.success++;
              // TODO: Send password via SMS
              console.log(
                `📱 Teacher password for ${phone_number}: ${password}`
              );
            }
          } catch (error) {
            results.teachers.errors.push({
              row: i + 2,
              error: error.message,
              data: row,
            });
          }
        }
      }

      // Process parents
      if (workbook.SheetNames.includes("parents")) {
        const parentsSheet = workbook.Sheets["parents"];
        const parentsData = xlsx.utils.sheet_to_json(parentsSheet);

        for (let i = 0; i < parentsData.length; i++) {
          const row = parentsData[i];
          try {
            const { full_name, phone_number } = row;

            if (!full_name || !phone_number) {
              results.parents.errors.push({
                row: i + 2,
                error: "Full name and phone number are required",
                data: row,
              });
              continue;
            }

            // Check if phone number exists in this organization
            const { data: existingPhone } = await supabase
              .from("users")
              .select("id")
              .eq("phone_number", phone_number)
              .eq("org_id", orgId)
              .single();

            if (existingPhone) {
              results.parents.errors.push({
                row: i + 2,
                error: "Phone number already exists in this organization",
                data: row,
              });
              continue;
            }

            // Create parent
            const { data: newUser, error } = await supabase
              .from("users")
              .insert([
                {
                  org_id: orgId,
                  full_name,
                  role: "parent",
                  phone_number,
                },
              ])
              .select()
              .single();

            if (error) {
              results.parents.errors.push({
                row: i + 2,
                error: error.message,
                data: row,
              });
            } else {
              results.parents.success++;
            }
          } catch (error) {
            results.parents.errors.push({
              row: i + 2,
              error: error.message,
              data: row,
            });
          }
        }
      }

      // Process students (after parents are created)
      if (workbook.SheetNames.includes("students")) {
        const studentsSheet = workbook.Sheets["students"];
        const studentsData = xlsx.utils.sheet_to_json(studentsSheet);

        for (let i = 0; i < studentsData.length; i++) {
          const row = studentsData[i];
          try {
            const {
              full_name,
              phone_number,
              register_number,
              parent_phone,
              default_group_name,
            } = row;

            if (!full_name || !phone_number) {
              results.students.errors.push({
                row: i + 2,
                error: "Full name and phone number are required",
                data: row,
              });
              continue;
            }

            // Check if phone number exists in this organization
            const { data: existingPhone } = await supabase
              .from("users")
              .select("id")
              .eq("phone_number", phone_number)
              .eq("org_id", orgId)
              .single();

            if (existingPhone) {
              results.students.errors.push({
                row: i + 2,
                error: "Phone number already exists in this organization",
                data: row,
              });
              continue;
            }

            // Find parent if parent_phone provided (must be in same organization)
            let parentId = null;
            if (parent_phone) {
              const { data: parent } = await supabase
                .from("users")
                .select("id")
                .eq("phone_number", parent_phone)
                .eq("role", "parent")
                .eq("org_id", orgId)
                .single();

              if (parent) {
                parentId = parent.id;
              }
            }

            // Create student
            const { data: newUser, error } = await supabase
              .from("users")
              .insert([
                {
                  org_id: orgId,
                  full_name,
                  role: "student",
                  phone_number,
                  register_number: register_number || null,
                  parent_id: parentId,
                },
              ])
              .select()
              .single();

            if (error) {
              results.students.errors.push({
                row: i + 2,
                error: error.message,
                data: row,
              });
            } else {
              results.students.success++;

              // Add to default group if specified
              if (default_group_name) {
                // Find or create group
                let { data: group } = await supabase
                  .from("groups")
                  .select("id")
                  .eq("name", default_group_name)
                  .eq("org_id", orgId)
                  .single();

                if (!group) {
                  // Create group
                  const { data: newGroup } = await supabase
                    .from("groups")
                    .insert([
                      {
                        name: default_group_name,
                        org_id: orgId,
                        description: `Default group for ${default_group_name}`,
                        is_default: true,
                      },
                    ])
                    .select()
                    .single();

                  if (newGroup) {
                    group = newGroup;
                  }
                }

                // Add student to group
                if (group) {
                  await supabase.from("user_groups").insert([
                    {
                      user_id: newUser.id,
                      group_id: group.id,
                      member_type: "student",
                    },
                  ]);
                }
              }
            }
          } catch (error) {
            results.students.errors.push({
              row: i + 2,
              error: error.message,
              data: row,
            });
          }
        }
      }

      res.json({
        message: "Bulk upload completed",
        results,
      });
    } catch (error) {
      console.error("Bulk upload error:", error);
      res.status(500).json({ error: "Failed to process Excel file" });
    }
  }
);

// Get organization info for admin
router.get("/organization", authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.org_id;

    const { data: organization, error } = await supabase
      .from("organizations")
      .select("id, name, is_active")
      .eq("id", orgId)
      .single();

    if (error) {
      console.error("Organization fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch organization" });
    }

    if (!organization) {
      return res.status(404).json({ error: "Organization not found" });
    }

    res.json({
      success: true,
      organization: {
        id: organization.id,
        name: organization.name,
        is_active: organization.is_active,
      },
    });
  } catch (error) {
    console.error("Get organization error:", error);
    res.status(500).json({ error: "Failed to fetch organization" });
  }
});

// Get default groups for organization
router.get("/default-groups", authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.org_id;

    const { data: groups, error } = await supabase
      .from("groups")
      .select("id, name, description")
      .eq("org_id", orgId)
      .eq("is_default", true)
      .eq("archived", false)
      .order("name");

    if (error) {
      console.error("Default groups fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch default groups" });
    }

    res.json({
      success: true,
      groups: groups || [],
    });
  } catch (error) {
    console.error("Get default groups error:", error);
    res.status(500).json({ error: "Failed to fetch default groups" });
  }
});

// Download sample Excel template
router.get("/download-template", (req, res) => {
  try {
    // Create sample data
    const teachersData = [
      {
        full_name: "John Smith",
        username: "john.smith",
        phone_number: "9876543210",
      },
      {
        full_name: "Jane Doe",
        username: "jane.doe",
        phone_number: "9876543211",
      },
      {
        full_name: "Mike Johnson",
        username: "mike.johnson",
        phone_number: "9876543212",
      },
    ];

    const parentsData = [
      { full_name: "Robert Wilson", phone_number: "9876543213" },
      { full_name: "Sarah Brown", phone_number: "9876543214" },
      { full_name: "David Davis", phone_number: "9876543215" },
    ];

    const studentsData = [
      {
        full_name: "Alice Wilson",
        phone_number: "9876543216",
        register_number: "STU001",
        parent_phone: "9876543213",
        default_group_name: "Grade 10A",
      },
      {
        full_name: "Bob Brown",
        phone_number: "9876543217",
        register_number: "STU002",
        parent_phone: "9876543214",
        default_group_name: "Grade 10A",
      },
      {
        full_name: "Charlie Davis",
        phone_number: "9876543218",
        register_number: "STU003",
        parent_phone: "9876543215",
        default_group_name: "Grade 9B",
      },
    ];

    // Create workbook
    const workbook = xlsx.utils.book_new();

    // Add sheets
    const teachersSheet = xlsx.utils.json_to_sheet(teachersData);
    const parentsSheet = xlsx.utils.json_to_sheet(parentsData);
    const studentsSheet = xlsx.utils.json_to_sheet(studentsData);

    xlsx.utils.book_append_sheet(workbook, teachersSheet, "teachers");
    xlsx.utils.book_append_sheet(workbook, parentsSheet, "parents");
    xlsx.utils.book_append_sheet(workbook, studentsSheet, "students");

    // Generate buffer
    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=user_onboarding_template.xlsx"
    );
    res.send(buffer);
  } catch (error) {
    console.error("Template download error:", error);
    res.status(500).json({ error: "Failed to generate template" });
  }
});

module.exports = router;
