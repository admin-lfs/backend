const bcrypt = require("bcryptjs");

const hashPassword = async (password) => {
  const hash = await bcrypt.hash(password, 10);
  console.log(`Password: ${password}`);
  console.log(`Hash: ${hash}`);
  return hash;
};

// Generate hash for password123
hashPassword("password");
