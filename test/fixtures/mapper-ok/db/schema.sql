CREATE TYPE status AS ENUM ('active', 'inactive');
CREATE TABLE users (
  id bigserial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  status status NOT NULL DEFAULT 'active'
);
