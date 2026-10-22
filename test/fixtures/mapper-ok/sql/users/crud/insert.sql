INSERT INTO users (
  id,
  email,
  name,
  status
)
VALUES (
  /*$id default-to */DEFAULT,
  /*$email*/'sample',
  /*$name default-to */DEFAULT,
  /*$status default-to */DEFAULT
)
RETURNING *
