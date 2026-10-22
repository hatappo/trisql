UPDATE users
SET
/*%for item in updates separating , */
  /*!item.name*/name = /*$item.value*/'sample'
/*%end */
WHERE email = /*$where.email*/'sample'
RETURNING *
