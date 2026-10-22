INSERT INTO users (
  id,
  email,
  name,
  status
)
VALUES
/*%for row in rows separating , */
(
  /*$row.id default-to */DEFAULT,
  /*$row.email*/'sample',
  /*$row.name default-to */DEFAULT,
  /*$row.status default-to */DEFAULT
)
/*%end */
RETURNING *
