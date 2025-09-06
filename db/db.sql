CREATE TABLE organizations (
  id INTEGER PRIMARY KEY CHECK (id >= 100000 AND id <= 999999),
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);