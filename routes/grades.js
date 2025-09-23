const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");
const supabase = require("../config/supabase");
const ExcelJS = require("exceljs");

// Get grades for a group
router.get(
  "/:groupId/grades",
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
        .select("id, member_type")
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

      // For students and parents, only show their own grades
      if (userRole === "student" || userRole === "parent") {
        const { data: grades, error: gradesError } = await supabase
          .from("grades")
          .select(
            `
          *,
          exams!grades_exam_id_fkey(
            id,
            title,
            total_marks,
            exam_components
          )
        `
          )
          .eq("student_id", targetUserId)
          .eq("exams.group_id", groupId)
          .order("created_at", { ascending: false });

        if (gradesError) {
          console.error("Error fetching grades:", gradesError);
          return res.status(500).json({
            success: false,
            message: "Error fetching grades",
          });
        }

        return res.json({
          success: true,
          grades: grades || [],
        });
      }

      // For teachers, show all grades in the group
      if (userRole === "faculty") {
        const { data: grades, error: gradesError } = await supabase
          .from("grades")
          .select(
            `
          *,
          exams!grades_exam_id_fkey(
            id,
            title,
            total_marks,
            exam_components
          ),
          users!grades_student_id_fkey(
            id,
            full_name,
            register_number
          )
        `
          )
          .eq("exams.group_id", groupId)
          .order("created_at", { ascending: false });

        if (gradesError) {
          console.error("Error fetching grades:", gradesError);
          return res.status(500).json({
            success: false,
            message: "Error fetching grades",
          });
        }

        return res.json({
          success: true,
          grades: grades || [],
        });
      }

      return res.status(403).json({
        success: false,
        message: "Invalid user role",
      });
    } catch (error) {
      console.error("Error in get grades:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Get grades for a specific exam
router.get(
  "/:groupId/exams/:examId/grades",
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
      const { groupId, examId } = req.params;
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
        .select("id, member_type")
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

      // Verify the exam belongs to this group
      const { data: exam, error: examError } = await supabase
        .from("exams")
        .select("id")
        .eq("id", examId)
        .eq("group_id", groupId)
        .eq("is_active", true)
        .single();

      if (examError || !exam) {
        return res.status(404).json({
          success: false,
          message: "Exam not found",
        });
      }

      // For students and parents, only show their own grades
      if (userRole === "student" || userRole === "parent") {
        const { data: grades, error: gradesError } = await supabase
          .from("grades")
          .select(
            `
            *,
            exams!grades_exam_id_fkey(
              id,
              exam_name,
              reduction_marks
            ),
            added_by_user:users!grades_added_by_fkey(full_name)
          `
          )
          .eq("student_id", targetUserId)
          .eq("exam_id", examId)
          .order("added_at", { ascending: false });

        if (gradesError) {
          console.error("Error fetching grades:", gradesError);
          return res.status(500).json({
            success: false,
            message: "Error fetching grades",
          });
        }

        return res.json({
          success: true,
          grades: grades || [],
        });
      }

      // For teachers, show all grades for this exam
      if (userRole === "faculty") {
        const { data: grades, error: gradesError } = await supabase
          .from("grades")
          .select(
            `
            *,
            exams!grades_exam_id_fkey(
              id,
              exam_name,
              reduction_marks
            ),
            student:users!grades_student_id_fkey(
              id,
              full_name,
              register_number
            ),
            added_by_user:users!grades_added_by_fkey(full_name)
          `
          )
          .eq("exam_id", examId)
          .order("added_at", { ascending: false });

        if (gradesError) {
          console.error("Error fetching grades:", gradesError);
          return res.status(500).json({
            success: false,
            message: "Error fetching grades",
          });
        }

        return res.json({
          success: true,
          grades: grades || [],
        });
      }

      return res.status(403).json({
        success: false,
        message: "Invalid user role",
      });
    } catch (error) {
      console.error("Error in get exam grades:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Add/update grades for students
router.post(
  "/:groupId/exams/:examId/grades",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId, examId } = req.params;
      const { grades } = req.body;

      // Check if user is a teacher in this group
      const { data: userGroup, error: userGroupError } = await supabase
        .from("user_groups")
        .select("id")
        .eq("user_id", req.user.id)
        .eq("group_id", groupId)
        .eq("member_type", "teacher")
        .eq("is_active", true)
        .single();

      if (userGroupError || !userGroup) {
        return res.status(403).json({
          success: false,
          message: "Only teachers can add grades",
        });
      }

      const gradesToUpsert = grades.map((grade) => ({
        exam_id: examId,
        student_id: grade.student_id,
        component_scores: grade.component_scores,
        total_marks: grade.total_marks,
        added_by: req.user.id,
        updated_at: new Date().toISOString(),
      }));

      const { data: savedGrades, error } = await supabase
        .from("grades")
        .upsert(gradesToUpsert, { onConflict: "exam_id,student_id" })
        .select();

      if (error) {
        console.error("Error saving grades:", error);
        return res.status(500).json({
          success: false,
          message: "Error saving grades",
        });
      }

      res.json({
        success: true,
        message: `Saved grades for ${savedGrades.length} students`,
        grades: savedGrades,
      });
    } catch (error) {
      console.error("Error saving grades:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Get statistics for a specific exam
router.get(
  "/:groupId/exams/:examId/statistics",
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
      const { groupId, examId } = req.params;
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
        .select("id, member_type")
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

      // Verify the exam belongs to this group
      const { data: exam, error: examError } = await supabase
        .from("exams")
        .select("id")
        .eq("id", examId)
        .eq("group_id", groupId)
        .eq("is_active", true)
        .single();

      if (examError || !exam) {
        return res.status(404).json({
          success: false,
          message: "Exam not found",
        });
      }

      // Get all grades for this exam
      const { data: grades, error: gradesError } = await supabase
        .from("grades")
        .select("total_marks")
        .eq("exam_id", examId);

      if (gradesError) {
        console.error("Error fetching grades for statistics:", gradesError);
        return res.status(500).json({
          success: false,
          message: "Error fetching grades for statistics",
        });
      }

      // Calculate statistics
      const totalStudents = grades.length;
      let average = 0;
      let highest = 0;
      let lowest = 0;

      if (totalStudents > 0) {
        const marks = grades.map((g) => g.total_marks);
        const sum = marks.reduce((acc, mark) => acc + mark, 0);
        average = sum / totalStudents;
        highest = Math.max(...marks);
        lowest = Math.min(...marks);
      }

      res.json({
        success: true,
        statistics: {
          total_students: totalStudents,
          average: average,
          highest: highest,
          lowest: lowest,
        },
      });
    } catch (error) {
      console.error("Error in get exam statistics:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Add this route after the existing routes
router.get(
  "/:groupId/exams/:examId/export",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId, examId } = req.params;
      const userRole = req.user.role;

      // Only teachers can export grades
      if (userRole !== "faculty") {
        return res.status(403).json({
          success: false,
          message: "Access denied. Only teachers can export grades.",
        });
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

      // Get exam details
      const { data: exam, error: examError } = await supabase
        .from("exams")
        .select(
          `
          id,
          exam_name,
          reduction_marks,
          exam_components (
            id,
            component_name,
            max_marks,
            component_order
          )
        `
        )
        .eq("id", examId)
        .eq("group_id", groupId)
        .single();

      if (examError || !exam) {
        return res.status(404).json({
          success: false,
          message: "Exam not found",
        });
      }

      // Get group details
      const { data: group, error: groupError } = await supabase
        .from("groups")
        .select("group_name")
        .eq("id", groupId)
        .single();

      if (groupError || !group) {
        return res.status(404).json({
          success: false,
          message: "Group not found",
        });
      }

      // Get grades with student details
      const { data: grades, error: gradesError } = await supabase
        .from("grades")
        .select(
          `
          id,
          student_id,
          component_scores,
          total_marks,
          students!grades_student_id_fkey (
            full_name,
            register_number
          ),
          added_by_user:users!grades_added_by_fkey (
            full_name
          )
        `
        )
        .eq("exam_id", examId)
        .eq("group_id", groupId);

      if (gradesError) {
        console.error("Error fetching grades:", gradesError);
        return res.status(500).json({
          success: false,
          message: "Failed to fetch grades",
        });
      }

      // Create Excel workbook
      const workbook = new ExcelJS.Workbook();

      // Calculate total marks
      const totalMarks = exam.exam_components.reduce(
        (sum, comp) => sum + comp.max_marks,
        0
      );
      const scalingFactor = exam.reduction_marks
        ? exam.reduction_marks / totalMarks
        : 1;

      // Sort components by order
      const sortedComponents = exam.exam_components.sort(
        (a, b) => a.component_order - b.component_order
      );

      // Sort grades by register number
      const sortedGrades = grades.sort((a, b) => {
        if (a.students.register_number && b.students.register_number) {
          return a.students.register_number.localeCompare(
            b.students.register_number
          );
        }
        if (a.students.register_number && !b.students.register_number)
          return -1;
        if (!a.students.register_number && b.students.register_number) return 1;
        return a.students.full_name.localeCompare(b.students.full_name);
      });

      // Sheet 1: Non-scaled grades
      const nonScaledSheet = workbook.addWorksheet("Original Grades");

      // Headers for non-scaled sheet
      const nonScaledHeaders = [
        "Student Name",
        "Register Number",
        ...sortedComponents.map((comp) => comp.component_name),
        "Total Marks",
        "Max Total",
        "Added By",
      ];

      nonScaledSheet.addRow(nonScaledHeaders);

      // Style headers
      nonScaledSheet.getRow(1).font = { bold: true };
      nonScaledSheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFE5E7EB" },
      };

      // Add data rows for non-scaled sheet
      sortedGrades.forEach((grade) => {
        const row = [
          grade.students.full_name,
          grade.students.register_number || "",
          ...sortedComponents.map(
            (comp) => grade.component_scores[comp.id] || 0
          ),
          grade.total_marks,
          totalMarks,
          grade.added_by_user.full_name,
        ];
        nonScaledSheet.addRow(row);
      });

      // Auto-fit columns
      nonScaledSheet.columns.forEach((column) => {
        column.width = 15;
      });

      // Sheet 2: Scaled grades (only if reduction_marks exists)
      if (exam.reduction_marks) {
        const scaledSheet = workbook.addWorksheet("Scaled Grades");

        // Headers for scaled sheet
        const scaledHeaders = [
          "Student Name",
          "Register Number",
          ...sortedComponents.map((comp) => comp.component_name),
          "Total Marks",
          "Max Total",
          "Added By",
        ];

        scaledSheet.addRow(scaledHeaders);

        // Style headers
        scaledSheet.getRow(1).font = { bold: true };
        scaledSheet.getRow(1).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFE5E7EB" },
        };

        // Add data rows for scaled sheet
        sortedGrades.forEach((grade) => {
          const row = [
            grade.students.full_name,
            grade.students.register_number || "",
            ...sortedComponents.map((comp) =>
              Math.round((grade.component_scores[comp.id] || 0) * scalingFactor)
            ),
            Math.round(grade.total_marks * scalingFactor),
            exam.reduction_marks,
            grade.added_by_user.full_name,
          ];
          scaledSheet.addRow(row);
        });

        // Auto-fit columns
        scaledSheet.columns.forEach((column) => {
          column.width = 15;
        });
      }

      // Set response headers
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${exam.exam_name}_${group.group_name}_Grades.xlsx"`
      );

      // Write workbook to response
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      console.error("Error exporting grades:", error);
      res.status(500).json({
        success: false,
        message: "Failed to export grades",
      });
    }
  }
);

module.exports = router;
