const express = require("express");
const supabase = require("../config/supabase");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// Middleware to ensure only admins can access
router.use(authenticateToken);
router.use((req, res, next) => {
  if (req.user.role !== "admin") {
    return res
      .status(403)
      .json({ error: "Access denied. Only admins can perform this action." });
  }
  next();
});

// Get all default groups for the organization
router.get("/groups", async (req, res) => {
  try {
    const orgId = req.user.org_id;

    const { data: groups, error } = await supabase
      .from("groups")
      .select("id, name, description, created_at")
      .eq("org_id", orgId)
      .eq("is_default", true)
      .eq("archived", false)
      .order("name");

    if (error) {
      console.error("Groups fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch groups" });
    }

    res.json({
      success: true,
      groups: groups || [],
    });
  } catch (error) {
    console.error("Get groups error:", error);
    res.status(500).json({ error: "Failed to fetch groups" });
  }
});

// Get subjects for the organization
router.get("/subjects", async (req, res) => {
  try {
    const orgId = req.user.org_id;

    const { data: subjects, error } = await supabase
      .from("subjects")
      .select("id, name, description, created_at")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .order("name");

    if (error) {
      console.error("Subjects fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch subjects" });
    }

    res.json({
      success: true,
      subjects: subjects || [],
    });
  } catch (error) {
    console.error("Get subjects error:", error);
    res.status(500).json({ error: "Failed to fetch subjects" });
  }
});

// Get fee categories for the organization
router.get("/categories", async (req, res) => {
  try {
    const orgId = req.user.org_id;

    const { data: categories, error } = await supabase
      .from("fee_categories")
      .select("id, name, description")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .order("name");

    if (error) {
      console.error("Categories fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch categories" });
    }

    res.json({
      success: true,
      categories: categories || [],
    });
  } catch (error) {
    console.error("Get categories error:", error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// Create new subject
router.post("/subjects", async (req, res) => {
  try {
    const { name, description } = req.body;
    const orgId = req.user.org_id;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: "Subject name is required" });
    }

    // Check if subject already exists
    const { data: existingSubject } = await supabase
      .from("subjects")
      .select("id")
      .eq("org_id", orgId)
      .eq("name", name.trim())
      .eq("is_active", true)
      .single();

    if (existingSubject) {
      return res
        .status(400)
        .json({ error: "Subject with this name already exists" });
    }

    const { data: subject, error } = await supabase
      .from("subjects")
      .insert([
        {
          org_id: orgId,
          name: name.trim(),
          description: description?.trim() || null,
          created_by: req.user.id,
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("Create subject error:", error);
      return res.status(500).json({ error: "Failed to create subject" });
    }

    res.status(201).json({
      success: true,
      message: "Subject created successfully",
      subject,
    });
  } catch (error) {
    console.error("Create subject error:", error);
    res.status(500).json({ error: "Failed to create subject" });
  }
});

// Get fees configuration for a specific group
router.get("/groups/:groupId/fees", async (req, res) => {
  try {
    const { groupId } = req.params;
    const orgId = req.user.org_id;

    // Verify group belongs to organization
    const { data: group, error: groupError } = await supabase
      .from("groups")
      .select("id, name")
      .eq("id", groupId)
      .eq("org_id", orgId)
      .eq("is_default", true)
      .single();

    if (groupError || !group) {
      return res.status(404).json({ error: "Group not found" });
    }

    // Get fees for this group
    const { data: fees, error } = await supabase
      .from("fees")
      .select(
        `
        id,
        subject_id,
        category_id,
        amount,
        due_date,
        is_active,
        created_at,
        subjects!inner(id, name, description),
        fee_categories!inner(id, name)
      `
      )
      .eq("org_id", orgId)
      .eq("group_id", groupId)
      .eq("is_active", true)
      .order("subjects.name");

    if (error) {
      console.error("Fees fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch fees" });
    }

    res.json({
      success: true,
      group,
      fees: fees || [],
    });
  } catch (error) {
    console.error("Get group fees error:", error);
    res.status(500).json({ error: "Failed to fetch group fees" });
  }
});

// Configure fees for a group
router.post("/groups/:groupId/fees", async (req, res) => {
  try {
    const { groupId } = req.params;
    const { subjectId, categoryId, amount, dueDate } = req.body;
    const orgId = req.user.org_id;

    // Validation
    if (!subjectId || !categoryId || !amount || amount <= 0) {
      return res.status(400).json({
        error: "Subject ID, Category ID and valid amount are required",
      });
    }

    // Verify group belongs to organization
    const { data: group, error: groupError } = await supabase
      .from("groups")
      .select("id, name")
      .eq("id", groupId)
      .eq("org_id", orgId)
      .eq("is_default", true)
      .single();

    if (groupError || !group) {
      return res.status(404).json({ error: "Group not found" });
    }

    // Verify subject belongs to organization
    const { data: subject, error: subjectError } = await supabase
      .from("subjects")
      .select("id, name")
      .eq("id", subjectId)
      .eq("org_id", orgId)
      .eq("is_active", true)
      .single();

    if (subjectError || !subject) {
      return res.status(404).json({ error: "Subject not found" });
    }

    // Verify category belongs to organization
    const { data: category, error: categoryError } = await supabase
      .from("fee_categories")
      .select("id, name")
      .eq("id", categoryId)
      .eq("org_id", orgId)
      .eq("is_active", true)
      .single();

    if (categoryError || !category) {
      return res.status(404).json({ error: "Fee category not found" });
    }

    // Check if fee already exists for this group-subject-category combination
    const { data: existingFee } = await supabase
      .from("fees")
      .select("id")
      .eq("group_id", groupId)
      .eq("subject_id", subjectId)
      .eq("category_id", categoryId)
      .eq("is_active", true)
      .single();

    if (existingFee) {
      return res.status(400).json({
        error:
          "Fee for this subject and category already exists for this group",
      });
    }

    // Generate due date if not provided
    let finalDueDate = dueDate;
    if (!finalDueDate && category.name === "Monthly") {
      // For monthly fees, set due date to 1st of next month if not provided
      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      nextMonth.setDate(1);
      finalDueDate = nextMonth.toISOString().split("T")[0];
    } else if (!finalDueDate && category.name === "Yearly") {
      // For yearly fees, set due date to same date next year if not provided
      const nextYear = new Date();
      nextYear.setFullYear(nextYear.getFullYear() + 1);
      finalDueDate = nextYear.toISOString().split("T")[0];
    }

    // Create fee
    const { data: fee, error } = await supabase
      .from("fees")
      .insert([
        {
          org_id: orgId,
          group_id: groupId,
          subject_id: subjectId,
          category_id: categoryId,
          amount: parseFloat(amount),
          due_date: finalDueDate,
          created_by: req.user.id,
        },
      ])
      .select(
        `
        id,
        subject_id,
        category_id,
        amount,
        due_date,
        subjects!inner(id, name, description),
        fee_categories!inner(id, name)
      `
      )
      .single();

    if (error) {
      console.error("Create fee error:", error);
      return res.status(500).json({ error: "Failed to create fee" });
    }

    res.status(201).json({
      success: true,
      message: "Fee configured successfully",
      fee,
    });
  } catch (error) {
    console.error("Configure fee error:", error);
    res.status(500).json({ error: "Failed to configure fee" });
  }
});

// Update fee configuration
router.put("/fees/:feeId", async (req, res) => {
  try {
    const { feeId } = req.params;
    const { amount, dueDate } = req.body;
    const orgId = req.user.org_id;

    if (amount !== undefined && amount <= 0) {
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }

    // Verify fee belongs to organization
    const { data: existingFee, error: fetchError } = await supabase
      .from("fees")
      .select("id, group_id, subject_id")
      .eq("id", feeId)
      .eq("org_id", orgId)
      .eq("is_active", true)
      .single();

    if (fetchError || !existingFee) {
      return res.status(404).json({ error: "Fee not found" });
    }

    // Update fee
    const updateData = {
      updated_at: new Date().toISOString(),
      updated_by: req.user.id,
    };
    if (amount !== undefined) updateData.amount = parseFloat(amount);
    if (dueDate !== undefined) updateData.due_date = dueDate || null;

    const { data: fee, error } = await supabase
      .from("fees")
      .update(updateData)
      .eq("id", feeId)
      .eq("org_id", orgId)
      .select(
        `
        id,
        subject_id,
        amount,
        due_date,
        subjects!inner(id, name, description)
      `
      )
      .single();

    if (error) {
      console.error("Update fee error:", error);
      return res.status(500).json({ error: "Failed to update fee" });
    }

    res.json({
      success: true,
      message: "Fee updated successfully",
      fee,
    });
  } catch (error) {
    console.error("Update fee error:", error);
    res.status(500).json({ error: "Failed to update fee" });
  }
});

// Delete fee configuration
router.delete("/fees/:feeId", async (req, res) => {
  try {
    const { feeId } = req.params;
    const orgId = req.user.org_id;

    // Verify fee belongs to organization
    const { data: existingFee, error: fetchError } = await supabase
      .from("fees")
      .select("id")
      .eq("id", feeId)
      .eq("org_id", orgId)
      .eq("is_active", true)
      .single();

    if (fetchError || !existingFee) {
      return res.status(404).json({ error: "Fee not found" });
    }

    // Soft delete fee
    const { error } = await supabase
      .from("fees")
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
        updated_by: req.user.id,
      })
      .eq("id", feeId)
      .eq("org_id", orgId);

    if (error) {
      console.error("Delete fee error:", error);
      return res.status(500).json({ error: "Failed to delete fee" });
    }

    res.json({
      success: true,
      message: "Fee deleted successfully",
    });
  } catch (error) {
    console.error("Delete fee error:", error);
    res.status(500).json({ error: "Failed to delete fee" });
  }
});

// Search students
router.get("/students/search", async (req, res) => {
  try {
    const { query } = req.query;
    const orgId = req.user.org_id;

    if (!query || query.trim().length < 2) {
      return res
        .status(400)
        .json({ error: "Search query must be at least 2 characters" });
    }

    const searchTerm = `%${query.trim()}%`;

    const { data: students, error } = await supabase
      .from("users")
      .select(
        `
        id,
        full_name,
        phone_number,
        register_number,
        role
      `
      )
      .eq("org_id", orgId)
      .eq("role", "student")
      .eq("is_active", true)
      .or(
        `full_name.ilike.${searchTerm},phone_number.ilike.${searchTerm},register_number.ilike.${searchTerm}`
      )
      .order("full_name")
      .limit(20);

    if (error) {
      console.error("Student search error:", error);
      return res.status(500).json({ error: "Failed to search students" });
    }

    res.json({
      success: true,
      students: students || [],
    });
  } catch (error) {
    console.error("Search students error:", error);
    res.status(500).json({ error: "Failed to search students" });
  }
});

// Get student fee details with overdue status
router.get("/students/:studentId/fees", async (req, res) => {
  try {
    const { studentId } = req.params;
    const orgId = req.user.org_id;

    // Verify student belongs to organization
    const { data: student, error: studentError } = await supabase
      .from("users")
      .select("id, full_name, phone_number, register_number")
      .eq("id", studentId)
      .eq("org_id", orgId)
      .eq("role", "student")
      .eq("is_active", true)
      .single();

    if (studentError || !student) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Get student's fees with overdue calculation
    const { data: studentFees, error } = await supabase
      .from("student_fees")
      .select(
        `
        id,
        total_amount,
        paid_amount,
        pending_amount,
        is_paid,
        created_at,
        updated_at,
        fees!inner(
          id,
          amount,
          due_date,
          created_at,
          subjects!inner(id, name, description),
          fee_categories!inner(id, name),
          groups!inner(id, name)
        )
      `
      )
      .eq("org_id", orgId)
      .eq("student_id", studentId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Student fees fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch student fees" });
    }

    // Calculate overdue status for each fee
    const feesWithOverdueStatus = studentFees.map((fee) => {
      const feeData = fee.fees;
      const category = feeData.fee_categories.name;
      const dueDate = feeData.due_date;
      const feeCreatedAt = new Date(feeData.created_at);
      const today = new Date();

      let isOverdue = false;
      let overdueMonths = 0;
      let nextDueDate = null;

      if (category === "Monthly" && dueDate) {
        // For monthly fees, check all months from creation to current month
        const dueDay = new Date(dueDate).getDate();
        const currentYear = today.getFullYear();
        const currentMonth = today.getMonth();
        const startYear = feeCreatedAt.getFullYear();
        const startMonth = feeCreatedAt.getMonth();

        // Count overdue months
        for (let year = startYear; year <= currentYear; year++) {
          const monthStart = year === startYear ? startMonth : 0;
          const monthEnd = year === currentYear ? currentMonth : 11;

          for (let month = monthStart; month <= monthEnd; month++) {
            const monthDueDate = new Date(year, month, dueDay);
            if (monthDueDate < today) {
              overdueMonths++;
            }
          }
        }

        isOverdue = overdueMonths > 0;

        // Calculate next due date
        const nextMonth = new Date(today);
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        nextMonth.setDate(dueDay);
        nextDueDate = nextMonth.toISOString().split("T")[0];
      } else if (category === "Yearly" && dueDate) {
        // For yearly fees, check if current year's due date has passed
        const dueDateObj = new Date(dueDate);
        const currentYearDueDate = new Date(
          today.getFullYear(),
          dueDateObj.getMonth(),
          dueDateObj.getDate()
        );

        isOverdue = currentYearDueDate < today;

        // Calculate next due date
        const nextYear = new Date(today);
        nextYear.setFullYear(nextYear.getFullYear() + 1);
        nextYear.setMonth(dueDateObj.getMonth());
        nextYear.setDate(dueDateObj.getDate());
        nextDueDate = nextYear.toISOString().split("T")[0];
      } else if (category === "One-time" && dueDate) {
        // For one-time fees, simple date comparison
        isOverdue = new Date(dueDate) < today;
        nextDueDate = dueDate;
      }

      return {
        ...fee,
        isOverdue,
        overdueMonths,
        nextDueDate,
        effectiveDueDate: dueDate,
      };
    });

    // Calculate totals including overdue amounts
    const totals = feesWithOverdueStatus.reduce(
      (acc, fee) => ({
        total: acc.total + parseFloat(fee.total_amount),
        paid: acc.paid + parseFloat(fee.paid_amount),
        pending: acc.pending + parseFloat(fee.pending_amount),
        overdue:
          acc.overdue + (fee.isOverdue ? parseFloat(fee.pending_amount) : 0),
      }),
      { total: 0, paid: 0, pending: 0, overdue: 0 }
    );

    res.json({
      success: true,
      student,
      fees: feesWithOverdueStatus,
      totals,
    });
  } catch (error) {
    console.error("Get student fees error:", error);
    res.status(500).json({ error: "Failed to fetch student fees" });
  }
});

// Make payment for student
router.post("/students/:studentId/payments", async (req, res) => {
  try {
    const { studentId } = req.params;
    const { feeId, amount, paymentMethod = "cash", notes } = req.body;
    const orgId = req.user.org_id;

    // Validation
    if (!feeId || !amount || amount <= 0) {
      return res.status(400).json({
        error: "Fee ID and valid amount are required",
      });
    }

    // Verify student belongs to organization
    const { data: student, error: studentError } = await supabase
      .from("users")
      .select("id, full_name")
      .eq("id", studentId)
      .eq("org_id", orgId)
      .eq("role", "student")
      .eq("is_active", true)
      .single();

    if (studentError || !student) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Verify fee belongs to student
    const { data: studentFee, error: feeError } = await supabase
      .from("student_fees")
      .select("id, total_amount, paid_amount, pending_amount")
      .eq("org_id", orgId)
      .eq("student_id", studentId)
      .eq("fee_id", feeId)
      .single();

    if (feeError || !studentFee) {
      return res.status(404).json({ error: "Fee not found for this student" });
    }

    // Check if payment amount exceeds pending amount
    const paymentAmount = parseFloat(amount);
    const pendingAmount = parseFloat(studentFee.pending_amount);

    if (paymentAmount > pendingAmount) {
      return res.status(400).json({
        error: `Payment amount (${paymentAmount}) cannot exceed pending amount (${pendingAmount})`,
      });
    }

    // Create payment record
    const { data: payment, error } = await supabase
      .from("fee_payments")
      .insert([
        {
          org_id: orgId,
          student_id: studentId,
          fee_id: feeId,
          amount: paymentAmount,
          payment_method: paymentMethod,
          notes: notes?.trim() || null,
          created_by: req.user.id,
        },
      ])
      .select(
        `
        id,
        amount,
        payment_date,
        payment_method,
        notes,
        fees!inner(
          id,
          subjects!inner(id, name),
          groups!inner(id, name)
        )
      `
      )
      .single();

    if (error) {
      console.error("Create payment error:", error);
      return res.status(500).json({ error: "Failed to create payment" });
    }

    res.status(201).json({
      success: true,
      message: "Payment recorded successfully",
      payment,
    });
  } catch (error) {
    console.error("Create payment error:", error);
    res.status(500).json({ error: "Failed to create payment" });
  }
});

// Get payment history for a student
router.get("/students/:studentId/payments", async (req, res) => {
  try {
    const { studentId } = req.params;
    const orgId = req.user.org_id;

    // Verify student belongs to organization
    const { data: student, error: studentError } = await supabase
      .from("users")
      .select("id, full_name")
      .eq("id", studentId)
      .eq("org_id", orgId)
      .eq("role", "student")
      .eq("is_active", true)
      .single();

    if (studentError || !student) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Get payment history
    const { data: payments, error } = await supabase
      .from("fee_payments")
      .select(
        `
        id,
        amount,
        payment_date,
        payment_method,
        notes,
        created_at,
        fees!inner(
          id,
          subjects!inner(id, name),
          groups!inner(id, name)
        )
      `
      )
      .eq("org_id", orgId)
      .eq("student_id", studentId)
      .order("payment_date", { ascending: false });

    if (error) {
      console.error("Payment history fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch payment history" });
    }

    res.json({
      success: true,
      student,
      payments: payments || [],
    });
  } catch (error) {
    console.error("Get payment history error:", error);
    res.status(500).json({ error: "Failed to fetch payment history" });
  }
});

module.exports = router;
